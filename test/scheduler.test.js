import assert from "node:assert/strict";
import test from "node:test";
import { MonitorScheduler } from "../src/server/scheduler.js";

function schedulerWith(pollResult) {
  const configStore = { getPublic: () => ({ enabled: true, pollIntervalSeconds: 900 }) };
  const engine = {
    async pollOnce() {
      return {
        snapshots: [],
        newEvents: [],
        ...(typeof pollResult === "function" ? pollResult() : pollResult),
      };
    },
  };
  return new MonitorScheduler({ engine, configStore, emit: () => {} });
}

function nextDelaySeconds(scheduler) {
  return (Date.parse(scheduler.snapshot().nextPollAt) - Date.now()) / 1000;
}

test("a pending reset candidate shortens the next poll to 300 seconds", async () => {
  const scheduler = schedulerWith({ hasPendingCandidate: true });
  await scheduler.runNow("schedule");
  const delay = nextDelaySeconds(scheduler);
  assert.ok(delay >= 295 && delay <= 305, `expected ~300s, got ${delay}s`);
  scheduler.stop();
});

test("an idle poll keeps the configured 900 second interval", async () => {
  const scheduler = schedulerWith({ hasPendingCandidate: false });
  await scheduler.runNow("schedule");
  const delay = nextDelaySeconds(scheduler);
  assert.ok(delay >= 895 && delay <= 905, `expected ~900s, got ${delay}s`);
  scheduler.stop();
});

test("a failed poll falls back to the configured interval", async () => {
  const configStore = { getPublic: () => ({ enabled: true, pollIntervalSeconds: 900 }) };
  const engine = {
    async pollOnce() {
      throw new Error("boom");
    },
  };
  const scheduler = new MonitorScheduler({ engine, configStore, emit: () => {} });
  await assert.rejects(() => scheduler.runNow("schedule"), /boom/);
  const delay = nextDelaySeconds(scheduler);
  assert.ok(delay >= 895 && delay <= 905, `expected ~900s, got ${delay}s`);
  scheduler.stop();
});
