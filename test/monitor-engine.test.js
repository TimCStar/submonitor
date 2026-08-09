import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ConfigStore } from "../src/server/config-store.js";
import { AppDatabase } from "../src/server/database.js";
import { isNaturalReset, MonitorEngine } from "../src/server/monitor-engine.js";
import { createSecretBox } from "../src/server/secrets.js";

const now = Math.floor(Date.now() / 1000);
const detectionConfig = {
  pollIntervalSeconds: 300,
  resetGraceSeconds: 60,
  resetMaxUsedPercent: 20,
};

function snapshot(usedPercent, resetAt, fetchedAt = now) {
  return { usedPercent, resetAt, fetchedAt };
}

test("reset_at advancement detects used cycles but ignores unused zero-use cycles", () => {
  const oldBoundary = now - 120;
  const newBoundary = oldBoundary + 7 * 24 * 60 * 60;
  assert.equal(
    isNaturalReset(snapshot(5, oldBoundary, now - 300), snapshot(0, newBoundary), detectionConfig, now),
    true,
  );
  assert.equal(
    isNaturalReset(snapshot(0, oldBoundary, now - 300), snapshot(0, newBoundary), detectionConfig, now),
    false,
  );
  assert.equal(
    isNaturalReset(snapshot(5, oldBoundary, now - 300), snapshot(0, oldBoundary), detectionConfig, now),
    false,
  );
  assert.equal(
    isNaturalReset(snapshot(5, oldBoundary, now - 300), snapshot(0, newBoundary, now - 1000), detectionConfig, now),
    false,
  );
});

test("future rolling boundaries from an unused account do not trigger a reset", () => {
  const oldBoundary = now + 5 * 60 * 60;
  const movingBoundary = oldBoundary + 300;
  assert.equal(
    isNaturalReset(snapshot(0, oldBoundary, now - 30), snapshot(0, movingBoundary), detectionConfig, now),
    false,
  );
});

test("confirmed reset recovers source, target and active subscription exactly once", async (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "submonitor-test-"));
  const database = new AppDatabase(path.join(directory, "test.sqlite"));
  t.after(() => {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const store = new ConfigStore(database, createSecretBox("test-master-key-with-at-least-32-characters"));
  const monitor = store.create({
    name: "Production Codex",
    baseUrl: "https://sub2api.example.test",
    authType: "apiKey",
    authSecret: "secret",
    sourceAccountId: 12,
    targetAccountIds: [34],
    monitorWindows: ["7d"],
    pollIntervalSeconds: 300,
    requestTimeoutSeconds: 45,
    confirmationsRequired: 2,
    resetGraceSeconds: 60,
    resetMaxUsedPercent: 20,
    subscriptionGroupMode: "explicit",
    subscriptionGroupIds: [10],
    subscriptionResetWindows: ["weekly"],
    dryRun: false,
    enabled: false,
  });

  const oldBoundary = now - 120;
  const newBoundary = oldBoundary + 7 * 24 * 60 * 60;
  let quotaCalls = 0;
  const counts = { recover: 0, target: 0, subscription: 0 };
  const client = {
    async queryCodexQuota() {
      quotaCalls += 1;
      const next = quotaCalls === 1
        ? { usedPercent: 5, resetAt: oldBoundary }
        : { usedPercent: 0, resetAt: newBoundary };
      return {
        fetched_at: Math.floor(Date.now() / 1000),
        rate_limit: {
          allowed: true,
          limit_reached: false,
          secondary_window: {
            used_percent: next.usedPercent,
            reset_at: next.resetAt,
            limit_window_seconds: 7 * 24 * 60 * 60,
          },
        },
      };
    },
    async recoverSourceAccount() { counts.recover += 1; },
    async resetTargetAccount() { counts.target += 1; },
    async listSubscriptions() {
      return { items: [{ id: 77, user_id: 9, status: "active", expires_at: null }], pages: 1 };
    },
    async resetSubscription(_id, body) {
      assert.deepEqual(body, { daily: false, weekly: true, monthly: false });
      counts.subscription += 1;
    },
  };
  const engine = new MonitorEngine({
    database,
    configStore: store.forMonitor(monitor.id),
    monitorId: monitor.id,
    clientFactory: () => client,
  });

  await engine.pollOnce();
  await engine.pollOnce();
  await engine.pollOnce();
  await engine.pollOnce();

  assert.deepEqual(counts, { recover: 1, target: 1, subscription: 1 });
  const events = database.listEventPayloads(100, monitor.id);
  assert.equal(events.length, 1);
  assert.equal(events[0].status, "complete");
  assert.equal(events[0].baseline.usedPercent, 5);
  assert.equal(events[0].resetSnapshot.usedPercent, 0);
});

test("dry-run event is archived as preview and is never written later", async (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "submonitor-preview-"));
  const database = new AppDatabase(path.join(directory, "test.sqlite"));
  t.after(() => {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const store = new ConfigStore(database, createSecretBox("another-master-key-with-at-least-32-characters"));
  const monitor = store.create({
    name: "Preview Codex",
    baseUrl: "https://sub2api.example.test",
    authType: "apiKey",
    authSecret: "secret",
    sourceAccountId: 12,
    targetAccountIds: [34],
    monitorWindows: ["7d"],
    pollIntervalSeconds: 300,
    requestTimeoutSeconds: 45,
    confirmationsRequired: 1,
    resetGraceSeconds: 60,
    resetMaxUsedPercent: 20,
    subscriptionGroupMode: "none",
    subscriptionGroupIds: [],
    subscriptionResetWindows: ["weekly"],
    dryRun: true,
    enabled: false,
  });
  const oldBoundary = now - 120;
  let call = 0;
  let writes = 0;
  const client = {
    async queryCodexQuota() {
      call += 1;
      return {
        fetched_at: Math.floor(Date.now() / 1000),
        rate_limit: { allowed: true, secondary_window: {
          used_percent: call === 1 ? 5 : 0,
          reset_at: call === 1 ? oldBoundary : oldBoundary + 604800,
          limit_window_seconds: 604800,
        } },
      };
    },
    async recoverSourceAccount() { writes += 1; },
    async resetTargetAccount() { writes += 1; },
  };
  const engine = new MonitorEngine({
    database,
    configStore: store.forMonitor(monitor.id),
    monitorId: monitor.id,
    clientFactory: () => client,
  });
  await engine.pollOnce();
  await engine.pollOnce();
  store.update(monitor.id, { ...store.getPublic(monitor.id), authSecret: "", dryRun: false });
  await engine.pollOnce();
  assert.equal(writes, 0);
  assert.equal(database.listEventPayloads(100, monitor.id)[0].status, "preview");
});
