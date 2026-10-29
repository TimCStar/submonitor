import { MonitorEngine } from "./monitor-engine.js";

export class MonitorScheduler {
  constructor({ engine, configStore, emit = () => {} }) {
    this.engine = engine;
    this.configStore = configStore;
    this.emit = emit;
    this.timer = null;
    this.runningPromise = null;
    this.runtime = {
      status: "starting",
      startedAt: new Date().toISOString(),
      lastPollAt: null,
      lastSuccessAt: null,
      lastError: null,
      nextPollAt: null,
      nextQuotaSharingAt: null,
    };
    this.pollDueAt = null;
  }

  snapshot() {
    return { ...this.runtime, running: Boolean(this.runningPromise) };
  }

  publish() {
    this.emit("runtime", this.snapshot());
  }

  start() {
    this.reschedule(true);
  }

  stop() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.pollDueAt = null;
    this.runtime.status = "stopped";
    this.runtime.nextPollAt = null;
    this.runtime.nextQuotaSharingAt = null;
    this.publish();
  }

  reschedule(immediate = false, hasPending = false, keepPollDue = false) {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const config = this.configStore.getPublic();
    if (!config.enabled) {
      this.pollDueAt = null;
      this.runtime.status = "disabled";
      this.runtime.nextPollAt = null;
      this.runtime.nextQuotaSharingAt = null;
      this.publish();
      return;
    }
    const now = Date.now();
    if (!keepPollDue || !this.pollDueAt) {
      const interval = hasPending
        ? Math.min(config.pollIntervalSeconds, config.pendingConfirmIntervalSeconds || 60)
        : config.pollIntervalSeconds;
      this.pollDueAt = now + (immediate ? 1000 : interval * 1000);
    }
    // 定时重算只触发额度均分，不提前 Codex 额度轮询，避免增加上游请求。
    let quotaDueAt = null;
    if (!immediate && config.quotaSharingAutoRecalculateEnabled && config.quotaSharingEnabled) {
      const candidate = now + config.quotaSharingIntervalSeconds * 1000;
      if (candidate < this.pollDueAt) quotaDueAt = candidate;
    }
    const fireAt = quotaDueAt ?? this.pollDueAt;
    this.runtime.status = this.runningPromise ? "running" : this.runtime.lastError ? "error" : "idle";
    this.runtime.nextPollAt = new Date(this.pollDueAt).toISOString();
    this.runtime.nextQuotaSharingAt = quotaDueAt ? new Date(quotaDueAt).toISOString() : null;
    this.publish();
    this.timer = setTimeout(() => {
      this.timer = null;
      const run = quotaDueAt ? this.runQuotaScheduled() : this.runNow("schedule");
      void run.catch(() => {});
    }, Math.max(0, fireAt - now));
  }

  async runNow(trigger = "manual") {
    return this.runOperation(trigger, () => this.engine.pollOnce());
  }

  async runQuotaNow() {
    return this.runOperation("quota-sharing", () => this.engine.recalculateQuota(), { quotaOnly: true });
  }

  async runQuotaScheduled() {
    return this.runOperation("quota-sharing-schedule", () => this.engine.refreshQuotaSharing(), { quotaOnly: true });
  }

  async runOperation(trigger, operation, { quotaOnly = false } = {}) {
    if (this.runningPromise) throw new Error("A quota check is already running");
    this.runtime.status = "running";
    if (!quotaOnly) this.runtime.lastPollAt = new Date().toISOString();
    this.runtime.nextPollAt = null;
    this.publish();
    this.runningPromise = Promise.resolve().then(operation);
    let result;
    try {
      result = await this.runningPromise;
      this.runtime.status = "idle";
      this.runtime.lastSuccessAt = new Date().toISOString();
      this.runtime.lastError = null;
      return { trigger, ...result };
    } catch (error) {
      this.runtime.status = "error";
      this.runtime.lastError = error instanceof Error ? error.message : String(error);
      throw error;
    } finally {
      this.runningPromise = null;
      this.publish();
      // 仅重算额度时保留原定的 Codex 轮询时间。
      this.reschedule(false, Boolean(result?.hasPendingCandidate), quotaOnly);
    }
  }
}

export class SchedulerManager {
  constructor({ database, configStore, emit = () => {}, clientFactory, notifier }) {
    this.database = database;
    this.configStore = configStore;
    this.emit = emit;
    this.clientFactory = clientFactory;
    this.notifier = notifier;
    this.schedulers = new Map();
  }

  createScheduler(monitorId) {
    const scopedEmit = (type, data) => this.emit(type, { monitorId, data });
    const engine = new MonitorEngine({
      database: this.database,
      configStore: this.configStore.forMonitor(monitorId),
      monitorId,
      emit: scopedEmit,
      clientFactory: this.clientFactory,
      notifier: this.notifier,
    });
    return new MonitorScheduler({
      engine,
      configStore: this.configStore.forMonitor(monitorId),
      emit: scopedEmit,
    });
  }

  start() {
    this.reconcile(true);
  }

  reconcile(startNew = false) {
    const ids = new Set(this.configStore.listPublic().map((monitor) => monitor.id));
    for (const [id, scheduler] of this.schedulers) {
      if (!ids.has(id)) {
        scheduler.stop();
        this.schedulers.delete(id);
      }
    }
    for (const id of ids) {
      if (!this.schedulers.has(id)) {
        const scheduler = this.createScheduler(id);
        this.schedulers.set(id, scheduler);
        if (startNew) scheduler.start();
      }
    }
  }

  configChanged(monitorId) {
    let scheduler = this.schedulers.get(monitorId);
    if (!scheduler) {
      scheduler = this.createScheduler(monitorId);
      this.schedulers.set(monitorId, scheduler);
    }
    scheduler.reschedule(true);
  }

  remove(monitorId) {
    const scheduler = this.schedulers.get(monitorId);
    if (scheduler) scheduler.stop();
    this.schedulers.delete(monitorId);
  }

  runNow(monitorId, trigger = "manual") {
    const scheduler = this.schedulers.get(monitorId);
    if (!scheduler) throw new Error("Monitor not found");
    return scheduler.runNow(trigger);
  }

  runQuotaNow(monitorId) {
    const scheduler = this.schedulers.get(monitorId);
    if (!scheduler) throw new Error("Monitor not found");
    return scheduler.runQuotaNow();
  }

  snapshot(monitorId) {
    return this.schedulers.get(monitorId)?.snapshot() || {
      status: "disabled",
      running: false,
      startedAt: null,
      lastPollAt: null,
      lastSuccessAt: null,
      lastError: null,
      nextPollAt: null,
    };
  }

  snapshots() {
    return Object.fromEntries(
      this.configStore.listPublic().map((monitor) => [monitor.id, this.snapshot(monitor.id)]),
    );
  }

  stop() {
    for (const scheduler of this.schedulers.values()) scheduler.stop();
    this.schedulers.clear();
  }
}
