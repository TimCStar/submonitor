import assert from "node:assert/strict";
import test from "node:test";
import { MonitorScheduler } from "../src/server/scheduler.js";

function schedulerWith(pollResult, config = {}) {
  const configStore = { getPublic: () => ({ enabled: true, pollIntervalSeconds: 900, pendingConfirmIntervalSeconds: 60, ...config }) };
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

test("a pending reset candidate shortens the next poll to pendingConfirmIntervalSeconds", async () => {
  const scheduler = schedulerWith({ hasPendingCandidate: true });
  await scheduler.runNow("schedule");
  const delay = nextDelaySeconds(scheduler);
  assert.ok(delay >= 55 && delay <= 65, `expected ~60s, got ${delay}s`);
  scheduler.stop();
});

test("pending confirmation respects a custom pendingConfirmIntervalSeconds", async () => {
  const scheduler = schedulerWith({ hasPendingCandidate: true }, { pendingConfirmIntervalSeconds: 45 });
  await scheduler.runNow("schedule");
  const delay = nextDelaySeconds(scheduler);
  assert.ok(delay >= 40 && delay <= 50, `expected ~45s, got ${delay}s`);
  scheduler.stop();
});

test("an idle poll keeps the configured 900 second interval", async () => {
  const scheduler = schedulerWith({ hasPendingCandidate: false });
  await scheduler.runNow("schedule");
  const delay = nextDelaySeconds(scheduler);
  assert.ok(delay >= 895 && delay <= 905, `expected ~900s, got ${delay}s`);
  scheduler.stop();
});

test("sharing timer recalculates quota without polling Codex more often than configured", async () => {
  let automatic = true;
  const calls = { poll: 0, quota: 0 };
  const scheduler = new MonitorScheduler({
    configStore: { getPublic: () => ({ enabled: true, pollIntervalSeconds: 900,
      quotaSharingEnabled: true, quotaSharingAutoRecalculateEnabled: automatic, quotaSharingIntervalSeconds: 120 }) },
    engine: { async pollOnce() { calls.poll++; return {}; },
      async refreshQuotaSharing() { calls.quota++; return { quotaSharing: { status: "applied" } }; },
      async recalculateQuota() { return { quotaSharing: { status: "preview" } }; } },
  });
  try {
    await scheduler.runNow();
    assert.ok(Math.abs(nextDelaySeconds(scheduler) - 900) < 5);
    assert.ok(Math.abs((Date.parse(scheduler.snapshot().nextQuotaSharingAt) - Date.now()) / 1000 - 120) < 5);
    await scheduler.runQuotaScheduled();
    assert.deepEqual(calls, { poll: 1, quota: 1 });
    // 定时重算不会推迟或提前 Codex 轮询。
    assert.ok(Math.abs(nextDelaySeconds(scheduler) - 900) < 5);
    automatic = false;
    assert.equal((await scheduler.runQuotaNow()).quotaSharing.status, "preview");
    assert.ok(Math.abs(nextDelaySeconds(scheduler) - 900) < 5);
    assert.equal(scheduler.snapshot().nextQuotaSharingAt, null);
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
