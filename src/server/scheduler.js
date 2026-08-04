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
    };
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
    this.runtime.status = "stopped";
    this.runtime.nextPollAt = null;
    this.publish();
  }

  reschedule(immediate = false) {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const config = this.configStore.getPublic();
    if (!config.enabled) {
      this.runtime.status = "disabled";
      this.runtime.nextPollAt = null;
      this.publish();
      return;
    }
    const delay = immediate ? 1000 : config.pollIntervalSeconds * 1000;
    this.runtime.status = this.runningPromise ? "running" : this.runtime.lastError ? "error" : "idle";
    this.runtime.nextPollAt = new Date(Date.now() + delay).toISOString();
    this.publish();
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.runNow("schedule").catch(() => {});
    }, delay);
  }

  async runNow(trigger = "manual") {
    if (this.runningPromise) throw new Error("A quota check is already running");
    this.runtime.status = "running";
    this.runtime.lastPollAt = new Date().toISOString();
    this.runtime.nextPollAt = null;
    this.publish();
    this.runningPromise = this.engine.pollOnce();
    try {
      const result = await this.runningPromise;
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
      this.reschedule(false);
    }
  }
}

export class SchedulerManager {
  constructor({ database, configStore, emit = () => {}, clientFactory }) {
    this.database = database;
    this.configStore = configStore;
    this.emit = emit;
    this.clientFactory = clientFactory;
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
