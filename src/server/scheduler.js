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
    this.runtime.status = this.runningPromise ? "running" : "idle";
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
