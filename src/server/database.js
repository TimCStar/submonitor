import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const DEFAULT_CONFIG = Object.freeze({
  baseUrl: "",
  authType: "apiKey",
  authSecretCipher: "",
  sourceAccountId: null,
  targetAccountIds: [],
  monitorWindows: ["7d"],
  pollIntervalSeconds: 300,
  requestTimeoutSeconds: 45,
  confirmationsRequired: 2,
  resetGraceSeconds: 60,
  resetMaxUsedPercent: 20,
  subscriptionGroupMode: "none",
  subscriptionGroupIds: [],
  subscriptionResetWindows: ["weekly"],
  dryRun: true,
  enabled: false,
});

function parseJson(value, fallback) {
  if (!value) return structuredClone(fallback);
  try {
    return JSON.parse(value);
  } catch {
    return structuredClone(fallback);
  }
}

export class AppDatabase {
  constructor(filename) {
    mkdirSync(path.dirname(filename), { recursive: true });
    this.db = new DatabaseSync(filename);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
    this.migrate();
  }

  migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS quota_snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        selector TEXT NOT NULL,
        role TEXT NOT NULL,
        canonical_name TEXT,
        used_percent REAL NOT NULL,
        reset_at INTEGER NOT NULL,
        window_seconds INTEGER NOT NULL,
        allowed INTEGER NOT NULL,
        limit_reached INTEGER NOT NULL,
        fetched_at INTEGER NOT NULL,
        observed_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_snapshots_selector_id
        ON quota_snapshots(selector, id DESC);
      CREATE TABLE IF NOT EXISTS reset_events (
        id TEXT PRIMARY KEY,
        source_account_id INTEGER NOT NULL,
        window TEXT NOT NULL,
        old_reset_at INTEGER NOT NULL,
        new_reset_at INTEGER NOT NULL,
        old_used_percent REAL NOT NULL,
        new_used_percent REAL NOT NULL,
        status TEXT NOT NULL,
        payload TEXT NOT NULL,
        confirmed_at TEXT NOT NULL,
        completed_at TEXT,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_events_updated
        ON reset_events(updated_at DESC);
      CREATE TABLE IF NOT EXISTS audit_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        level TEXT NOT NULL,
        action TEXT NOT NULL,
        message TEXT NOT NULL,
        details TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_audit_created
        ON audit_logs(created_at DESC);
    `);

    if (!this.getSetting("config")) this.setSetting("config", DEFAULT_CONFIG);
    if (!this.getSetting("monitor_state")) {
      this.setSetting("monitor_state", { sourceAccountId: null, windows: {} });
    }
  }

  getSetting(key) {
    const row = this.db.prepare("SELECT value FROM settings WHERE key = ?").get(key);
    return row ? parseJson(row.value, null) : null;
  }

  setSetting(key, value) {
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO settings(key, value, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).run(key, JSON.stringify(value), now);
  }

  getConfig() {
    return { ...structuredClone(DEFAULT_CONFIG), ...(this.getSetting("config") || {}) };
  }

  saveConfig(config) {
    this.setSetting("config", config);
  }

  getMonitorState() {
    return this.getSetting("monitor_state") || { sourceAccountId: null, windows: {} };
  }

  saveMonitorState(state) {
    this.setSetting("monitor_state", state);
  }

  clearMonitorState(sourceAccountId = null) {
    this.saveMonitorState({ sourceAccountId, windows: {} });
  }

  addSnapshot(selector, snapshot) {
    this.db.prepare(`
      INSERT INTO quota_snapshots(
        selector, role, canonical_name, used_percent, reset_at, window_seconds,
        allowed, limit_reached, fetched_at, observed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      selector,
      snapshot.role,
      snapshot.canonicalName || null,
      snapshot.usedPercent,
      snapshot.resetAt,
      snapshot.windowSeconds,
      snapshot.allowed ? 1 : 0,
      snapshot.limitReached ? 1 : 0,
      snapshot.fetchedAt,
      new Date().toISOString(),
    );
    this.db.prepare(`
      DELETE FROM quota_snapshots
      WHERE id NOT IN (SELECT id FROM quota_snapshots ORDER BY id DESC LIMIT 5000)
    `).run();
  }

  listSnapshots(limit = 240) {
    return this.db.prepare(`
      SELECT id, selector, role, canonical_name AS canonicalName,
             used_percent AS usedPercent, reset_at AS resetAt,
             window_seconds AS windowSeconds, allowed, limit_reached AS limitReached,
             fetched_at AS fetchedAt, observed_at AS observedAt
      FROM quota_snapshots ORDER BY id DESC LIMIT ?
    `).all(limit).map((row) => ({
      ...row,
      allowed: Boolean(row.allowed),
      limitReached: Boolean(row.limitReached),
    }));
  }

  createEvent(event) {
    const now = new Date().toISOString();
    const result = this.db.prepare(`
      INSERT OR IGNORE INTO reset_events(
        id, source_account_id, window, old_reset_at, new_reset_at,
        old_used_percent, new_used_percent, status, payload,
        confirmed_at, completed_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      event.id,
      event.sourceAccountId,
      event.window,
      event.baseline.resetAt || 0,
      event.resetSnapshot.resetAt || 0,
      event.baseline.usedPercent,
      event.resetSnapshot.usedPercent,
      event.status,
      JSON.stringify(event),
      event.confirmedAt,
      event.completedAt || null,
      now,
    );
    return result.changes > 0;
  }

  updateEvent(event) {
    this.db.prepare(`
      UPDATE reset_events
      SET status = ?, payload = ?, completed_at = ?, updated_at = ?
      WHERE id = ?
    `).run(
      event.status,
      JSON.stringify(event),
      event.completedAt || null,
      new Date().toISOString(),
      event.id,
    );
  }

  getEvent(id) {
    const row = this.db.prepare("SELECT payload FROM reset_events WHERE id = ?").get(id);
    return row ? parseJson(row.payload, null) : null;
  }

  listEventPayloads(limit = 100) {
    return this.db.prepare(`
      SELECT payload FROM reset_events ORDER BY confirmed_at DESC LIMIT ?
    `).all(limit).map((row) => parseJson(row.payload, null)).filter(Boolean);
  }

  listPendingEvents() {
    return this.db.prepare(`
      SELECT payload FROM reset_events WHERE status = 'pending' ORDER BY confirmed_at ASC
    `).all().map((row) => parseJson(row.payload, null)).filter(Boolean);
  }

  cancelPendingEvents(reason) {
    const events = this.listPendingEvents();
    for (const event of events) {
      event.status = "cancelled";
      event.cancellationReason = reason;
      event.completedAt = new Date().toISOString();
      const actions = [
        event.actions?.sourceRecovery,
        ...Object.values(event.actions?.targetAccounts || {}),
        ...Object.values(event.actions?.subscriptions || {}),
      ].filter(Boolean);
      for (const action of actions) {
        if (!['success', 'preview', 'skipped'].includes(action.status)) action.status = "skipped";
      }
      this.updateEvent(event);
    }
    return events.length;
  }

  addAudit(level, action, message, details = {}) {
    this.db.prepare(`
      INSERT INTO audit_logs(level, action, message, details, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(level, action, message, JSON.stringify(details), new Date().toISOString());
    this.db.prepare(`
      DELETE FROM audit_logs
      WHERE id NOT IN (SELECT id FROM audit_logs ORDER BY id DESC LIMIT 5000)
    `).run();
  }

  listAudit(limit = 200) {
    return this.db.prepare(`
      SELECT id, level, action, message, details, created_at AS createdAt
      FROM audit_logs ORDER BY id DESC LIMIT ?
    `).all(limit).map((row) => ({ ...row, details: parseJson(row.details, {}) }));
  }

  close() {
    this.db.close();
  }
}

export { DEFAULT_CONFIG };
