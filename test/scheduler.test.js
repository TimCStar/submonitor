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

test("optional sharing timer shortens polling but manual mode keeps the normal interval", async () => {
  let automatic = true;
  const scheduler = new MonitorScheduler({
    configStore: { getPublic: () => ({ enabled: true, pollIntervalSeconds: 900,
      quotaSharingEnabled: true, quotaSharingAutoRecalculateEnabled: automatic, quotaSharingIntervalSeconds: 120 }) },
    engine: { async pollOnce() { return {}; }, async recalculateQuota() { return { quotaSharing: { status: "preview" } }; } },
  });
  try {
    await scheduler.runNow();
    assert.ok(Math.abs(nextDelaySeconds(scheduler) - 120) < 5);
    automatic = false;
    assert.equal((await scheduler.runQuotaNow()).quotaSharing.status, "preview");
    assert.ok(Math.abs(nextDelaySeconds(scheduler) - 900) < 5);
  } finally { scheduler.stop(); }
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

test("manual recalculation and quota polling share the same running lock", async () => {
  let finish;
  const scheduler = new MonitorScheduler({
    configStore: { getPublic: () => ({ enabled: false, pollIntervalSeconds: 300 }) },
    engine: { recalculateQuota: () => new Promise((resolve) => { finish = resolve; }), pollOnce: () => assert.fail("must not poll concurrently") },
  });
  const running = scheduler.runQuotaNow();
  await Promise.resolve();
  await assert.rejects(scheduler.runNow(), /already running/);
  finish({ quotaSharing: { status: "preview" } });
  await running;
  scheduler.stop();
});
