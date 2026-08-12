import { Sub2ApiClient } from "./sub2api-client.js";
import { createNotifier } from "./notifier.js";
import { discoverSubscriptionGroupIds, listActiveSubscriptions } from "./subscriber-preview.js";

const FIVE_HOURS_SECONDS = 5 * 60 * 60;
const SEVEN_DAYS_SECONDS = 7 * 24 * 60 * 60;

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function approximateWindowName(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return undefined;
  if (Math.abs(seconds - FIVE_HOURS_SECONDS) <= 30 * 60) return "5h";
  if (Math.abs(seconds - SEVEN_DAYS_SECONDS) <= 6 * 60 * 60) return "7d";
  return undefined;
}

function toSnapshot(role, rateLimit, window, fetchedAt) {
  if (!window || typeof window !== "object") return undefined;
  const usedPercent = Number(window.used_percent);
  const resetAt = Number(window.reset_at);
  const windowSeconds = Number(window.limit_window_seconds);
  if (!Number.isFinite(usedPercent)) return undefined;
  return {
    role,
    canonicalName: approximateWindowName(windowSeconds),
    usedPercent,
    resetAt: Number.isFinite(resetAt) && resetAt > 0 ? resetAt : 0,
    windowSeconds: Number.isFinite(windowSeconds) ? windowSeconds : 0,
    allowed: rateLimit.allowed !== false,
    limitReached: rateLimit.limit_reached === true,
    fetchedAt: Number.isFinite(Number(fetchedAt)) ? Number(fetchedAt) : 0,
  };
}

export function extractSnapshots(quota) {
  if (!quota || typeof quota !== "object" || !quota.rate_limit) {
    throw new Error("Codex quota response does not contain rate_limit");
  }
  const rateLimit = quota.rate_limit;
  const snapshots = [
    toSnapshot("primary", rateLimit, rateLimit.primary_window, quota.fetched_at),
    toSnapshot("secondary", rateLimit, rateLimit.secondary_window, quota.fetched_at),
  ].filter(Boolean);
  if (!snapshots.length) throw new Error("Codex quota response does not contain usable windows");
  return snapshots;
}

export function selectSnapshot(snapshots, selector) {
  if (selector === "primary" || selector === "secondary") {
    return snapshots.find((snapshot) => snapshot.role === selector);
  }
  return snapshots.find((snapshot) => snapshot.canonicalName === selector);
}

export function isFreshSnapshot(snapshot, config, nowSeconds = Date.now() / 1000) {
  if (!snapshot || snapshot.fetchedAt <= 0) return false;
  const maximumAge = Math.max(300, config.pollIntervalSeconds * 2);
  return Math.abs(nowSeconds - snapshot.fetchedAt) <= maximumAge;
}

export function isNaturalReset(baseline, current, config, nowSeconds = Date.now() / 1000) {
  if (!baseline || !isFreshSnapshot(current, config, nowSeconds)) return false;
  // A window with actual usage reports a fixed absolute boundary, so a reset
  // advances it even before the old boundary elapses. An unused window instead
  // reports a rolling boundary (~now + window seconds) that moves forward on
  // every read; requiring prior usage keeps rolling timestamps from creating
  // false events.
  const cycleHadUsage = Number(baseline.usedPercent) > 0;
  const resetAdvanced =
    cycleHadUsage &&
    baseline.resetAt > 0 &&
    current.resetAt > baseline.resetAt + config.resetGraceSeconds;
  if (resetAdvanced) return true;

  const oldWindowElapsed =
    baseline.resetAt > 0 && nowSeconds >= baseline.resetAt + config.resetGraceSeconds;
  return (
    oldWindowElapsed &&
    current.resetAt === 0 &&
    current.usedPercent <= config.resetMaxUsedPercent &&
    current.usedPercent < baseline.usedPercent
  );
}

function eventKey(config, selector, baseline) {
  return `${config.id}:${config.sourceAccountId}:${selector}:${baseline.resetAt || baseline.fetchedAt}`;
}

function createEvent(config, selector, pending, current) {
  const now = new Date().toISOString();
  return {
    id: pending.eventId,
    monitorId: config.id,
    monitorName: config.name,
    status: "pending",
    sourceAccountId: config.sourceAccountId,
    window: selector,
    baseline: pending.baseline,
    resetSnapshot: current,
    confirmations: pending.confirmations,
    confirmedAt: now,
    dryRun: config.dryRun,
    plan: {
      targetAccountIds: [...config.targetAccountIds],
      subscriptionGroupMode: config.subscriptionGroupMode,
      subscriptionGroupIds: [...config.subscriptionGroupIds],
      subscriptionResetWindows: [...config.subscriptionResetWindows],
    },
    subscriptionDiscoveryComplete: false,
    actions: {
      sourceRecovery: { status: "pending" },
      targetAccounts: Object.fromEntries(
        config.targetAccountIds.map((id) => [String(id), { status: "pending" }]),
      ),
      subscriptions: {},
    },
  };
}

function subscriptionResetBody(event) {
  const selected = new Set(event.plan.subscriptionResetWindows);
  return {
    daily: selected.has("daily"),
    weekly: selected.has("weekly"),
    monthly: selected.has("monthly"),
  };
}

export class MonitorEngine {
  constructor({ database, configStore, monitorId = null, emit = () => {}, clientFactory, notifier }) {
    this.database = database;
    this.configStore = configStore;
    this.monitorId = monitorId;
    this.emit = emit;
    this.clientFactory = clientFactory || ((config) => new Sub2ApiClient(config));
    this.notifier = notifier || createNotifier();
  }

  audit(level, action, message, details = {}) {
    const scopedDetails = { monitorId: this.monitorId, ...details };
    this.database.addAudit(level, action, message, scopedDetails);
    this.emit("audit", { level, action, message, details: scopedDetails, createdAt: new Date().toISOString() });
  }

  async notifyReset(config, event) {
    const results = await this.notifier.notifyReset(config, event);
    for (const result of results) {
      this.audit(result.ok ? "info" : "warn", "notify.sent", `Reset notification sent via ${result.channel}`, {
        eventId: event.id,
        channel: result.channel,
        error: result.error || null,
      });
    }
  }

  async maybeUsageAlert(config, state, selector, snapshot) {
    if (config.usageAlertPercent <= 0) return;
    const triggered = snapshot.limitReached || snapshot.usedPercent >= config.usageAlertPercent;
    if (!triggered) return;
    const now = Math.floor(Date.now() / 1000);
    // ponytail: 2h throttle per window, state survives restarts via monitor state
    if (state.usageAlertAt?.[selector] && now - state.usageAlertAt[selector] < 2 * 60 * 60) return;
    state.usageAlertAt = { ...state.usageAlertAt, [selector]: now };
    const results = await this.notifier.notifyUsageAlert(config, {
      monitorName: config.name,
      selector,
      usedPercent: snapshot.usedPercent,
      limitReached: snapshot.limitReached,
      resetAt: snapshot.resetAt,
    });
    for (const result of results) {
      this.audit(result.ok ? "info" : "warn", "usage.alert_sent", `Usage threshold alert sent via ${result.channel}`, {
        selector,
        channel: result.channel,
        error: result.error || null,
      });
    }
  }

  async notifyActionFailure(config, event, label, error) {
    if (!config.notifyEnabled) return;
    const state = this.database.getMonitorState(config.id);
    const now = Math.floor(Date.now() / 1000);
    // ponytail: 2h throttle per event, failed actions retry every poll otherwise
    if (state.failureAlertAt?.[event.id] && now - state.failureAlertAt[event.id] < 2 * 60 * 60) return;
    state.failureAlertAt = { ...state.failureAlertAt, [event.id]: now };
    this.database.saveMonitorState(config.id, state);
    const results = await this.notifier.notifyActionFailure(config, {
      monitorName: event.monitorName,
      eventId: event.id,
      action: label,
      error,
    });
    for (const result of results) {
      this.audit(result.ok ? "info" : "warn", "notify.action_failed_alert", `Action failure alert sent via ${result.channel}`, {
        eventId: event.id,
        channel: result.channel,
        error: result.error || null,
      });
    }
  }

  async readConcurrency(client, accountId) {
    try {
      const account = await client.getAccount(accountId);
      const current = Number(account?.current_concurrency);
      const max = Number(account?.concurrency);
      if (!Number.isFinite(current) || !Number.isFinite(max)) return null;
      return { current, max, updatedAt: new Date().toISOString() };
    } catch (error) {
      this.audit("warn", "concurrency.read_failed", "Failed to read account concurrency", {
        error: errorMessage(error),
      });
      return null;
    }
  }

  async pollOnce() {
    const config = this.configStore.getPrivate();
    if (!this.configStore.isRunnable(config)) throw new Error("Monitor configuration is incomplete");
    const client = this.clientFactory(config);
    await this.resumePendingEvents(config, client);

    const concurrencyPromise = this.readConcurrency(client, config.sourceAccountId);
    const quota = await client.queryCodexQuota(config.sourceAccountId);
    const snapshots = extractSnapshots(quota);
    const state = this.database.getMonitorState(config.id);
    if (state.sourceAccountId !== config.sourceAccountId) {
      state.sourceAccountId = config.sourceAccountId;
      state.windows = {};
    }
    const concurrency = await concurrencyPromise;
    if (concurrency) state.concurrency = concurrency;
    const newEvents = [];

    for (const selector of config.monitorWindows) {
      const snapshot = selectSnapshot(snapshots, selector);
      if (!snapshot) {
        this.audit("warn", "quota.window_missing", `Configured window ${selector} was not present`, {
          selector,
        });
        continue;
      }
      this.database.addSnapshot(config.id, selector, snapshot);
      await this.maybeUsageAlert(config, state, selector, snapshot);
      const event = this.processWindow(config, state, selector, snapshot);
      if (event) newEvents.push(event);
    }
    this.database.saveMonitorState(config.id, state);
    this.emit("snapshot", { snapshots: this.database.listSnapshots(config.id, 20) });

    for (const event of newEvents) {
      await this.notifyReset(config, event);
      await this.executeEvent(config, client, event);
    }
    this.audit("info", "quota.checked", "Codex quota check completed", {
      sourceAccountId: config.sourceAccountId,
      windows: config.monitorWindows,
    });
    return {
      snapshots: this.database.listSnapshots(config.id, 20),
      newEvents: newEvents.map((item) => item.id),
      hasPendingCandidate: Object.values(state.windows).some((window) => window.pending),
    };
  }

  processWindow(config, state, selector, current) {
    const windowState = (state.windows[selector] ||= { last: null, pending: null });
    if (!windowState.last) {
      windowState.last = current;
      this.audit("info", "quota.baseline", `Baseline recorded for ${selector}`, {
        selector,
        usedPercent: current.usedPercent,
        resetAt: current.resetAt,
      });
      return null;
    }

    let event = null;
    if (windowState.pending) {
      if (isNaturalReset(windowState.pending.baseline, current, config)) {
        windowState.pending.confirmations += 1;
        windowState.pending.lastConfirmedAt = new Date().toISOString();
        this.audit("info", "reset.confirmation", `Reset confirmation for ${selector}`, {
          eventId: windowState.pending.eventId,
          confirmations: windowState.pending.confirmations,
          required: config.confirmationsRequired,
        });
        if (windowState.pending.confirmations >= config.confirmationsRequired) {
          event = createEvent(config, selector, windowState.pending, current);
          windowState.pending = null;
        }
      } else {
        this.audit("warn", "reset.candidate_cancelled", `Reset candidate cancelled for ${selector}`, {
          eventId: windowState.pending.eventId,
        });
        windowState.pending = null;
      }
    } else if (isNaturalReset(windowState.last, current, config)) {
      const eventId = eventKey(config, selector, windowState.last);
      if (!this.database.getEvent(eventId)) {
        windowState.pending = {
          eventId,
          baseline: windowState.last,
          confirmations: 1,
          firstConfirmedAt: new Date().toISOString(),
        };
        this.audit("info", "reset.candidate", `Natural reset candidate detected for ${selector}`, {
          eventId,
          confirmations: 1,
          required: config.confirmationsRequired,
        });
        if (config.confirmationsRequired === 1) {
          event = createEvent(config, selector, windowState.pending, current);
          windowState.pending = null;
        }
      }
    }

    windowState.last = current;
    if (event) {
      if (!this.database.createEvent(event)) return this.database.getEvent(event.id);
      this.audit("info", "reset.confirmed", `Natural reset confirmed for ${selector}`, {
        eventId: event.id,
        oldUsedPercent: event.baseline.usedPercent,
        newUsedPercent: event.resetSnapshot.usedPercent,
        oldResetAt: event.baseline.resetAt,
        newResetAt: event.resetSnapshot.resetAt,
        dryRun: event.dryRun,
      });
      this.emit("event", event);
    }
    return event;
  }

  async discoverGroupIds(client, event) {
    return discoverSubscriptionGroupIds(client, {
      sourceAccountId: event.sourceAccountId,
      subscriptionGroupMode: event.plan.subscriptionGroupMode,
      subscriptionGroupIds: event.plan.subscriptionGroupIds,
    });
  }

  async listActiveSubscriptions(client, groupId) {
    return listActiveSubscriptions(client, groupId);
  }

  async prepareSubscriptionActions(client, event) {
    if (event.subscriptionDiscoveryComplete) return true;
    try {
      const groupIds = await this.discoverGroupIds(client, event);
      event.subscriptionGroupIds = groupIds;
      for (const groupId of groupIds) {
        const subscriptions = await this.listActiveSubscriptions(client, groupId);
        for (const subscription of subscriptions) {
          const id = String(subscription.id);
          event.actions.subscriptions[id] ||= {
            status: "pending",
            groupId,
            userId: subscription.user_id,
          };
        }
      }
      event.subscriptionDiscoveryComplete = true;
      event.subscriptionDiscoveryAt = new Date().toISOString();
      delete event.subscriptionDiscoveryError;
      this.database.updateEvent(event);
      return true;
    } catch (error) {
      event.subscriptionDiscoveryError = errorMessage(error);
      this.database.updateEvent(event);
      this.audit("error", "subscription.discovery_failed", "Subscription discovery failed", {
        eventId: event.id,
        error: event.subscriptionDiscoveryError,
      });
      return false;
    }
  }

  async runAction(config, event, action, label, request) {
    if (["success", "preview", "skipped"].includes(action.status)) return true;
    action.status = "in_progress";
    action.lastAttemptAt = new Date().toISOString();
    delete action.error;
    this.database.updateEvent(event);
    try {
      await request();
      action.status = "success";
      action.completedAt = new Date().toISOString();
      this.database.updateEvent(event);
      this.audit("info", "action.completed", label, { eventId: event.id });
      this.emit("event", event);
      return true;
    } catch (error) {
      action.status = "failed";
      action.error = errorMessage(error);
      this.database.updateEvent(event);
      this.audit("error", "action.failed", label, { eventId: event.id, error: action.error });
      this.emit("event", event);
      await this.notifyActionFailure(config, event, label, action.error);
      return false;
    }
  }

  async executeEvent(config, client, event) {
    if (["complete", "preview"].includes(event.status)) return;

    if (event.dryRun) {
      if (!(await this.prepareSubscriptionActions(client, event))) return;
      event.actions.sourceRecovery.status = "preview";
      for (const action of Object.values(event.actions.targetAccounts)) action.status = "preview";
      for (const action of Object.values(event.actions.subscriptions)) action.status = "preview";
      event.status = "preview";
      event.completedAt = new Date().toISOString();
      this.database.updateEvent(event);
      this.audit("warn", "event.preview", "Dry-run event archived without write actions", {
        eventId: event.id,
        targets: Object.keys(event.actions.targetAccounts).length,
        subscriptions: Object.keys(event.actions.subscriptions).length,
      });
      this.emit("event", event);
      return;
    }

    const sourceRecovered = await this.runAction(
      config,
      event,
      event.actions.sourceRecovery,
      `Recovered source account ${event.sourceAccountId}`,
      () => client.recoverSourceAccount(event.sourceAccountId),
    );
    if (!sourceRecovered) return;

    for (const [id, action] of Object.entries(event.actions.targetAccounts)) {
      await this.runAction(config, event, action, `Reset target account ${id}`, () =>
        client.resetTargetAccount(id));
    }

    if (!(await this.prepareSubscriptionActions(client, event))) return;
    const resetBody = subscriptionResetBody(event);
    for (const [id, action] of Object.entries(event.actions.subscriptions)) {
      await this.runAction(config, event, action, `Reset subscription ${id}`, () =>
        client.resetSubscription(id, resetBody));
    }

    const actions = [
      event.actions.sourceRecovery,
      ...Object.values(event.actions.targetAccounts),
      ...Object.values(event.actions.subscriptions),
    ];
    if (actions.every((action) => ["success", "skipped"].includes(action.status))) {
      event.status = "complete";
      event.completedAt = new Date().toISOString();
      this.database.updateEvent(event);
      this.audit("info", "event.completed", "Reset event completed", {
        eventId: event.id,
        targets: Object.keys(event.actions.targetAccounts).length,
        subscriptions: Object.keys(event.actions.subscriptions).length,
      });
      this.emit("event", event);
    }
  }

  async resumePendingEvents(config, client) {
    for (const event of this.database.listPendingEvents(config.id)) {
      await this.executeEvent(config, client, event);
    }
  }
}
