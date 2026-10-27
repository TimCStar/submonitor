import assert from "node:assert/strict";
import test from "node:test";
import { mapWithConcurrency, MonitorEngine } from "../src/server/monitor-engine.js";

test("mapWithConcurrency caps in-flight work and preserves order", async () => {
  let inflight = 0;
  let peak = 0;
  const started = [];
  const results = await mapWithConcurrency([1, 2, 3, 4, 5], 2, async (value) => {
    started.push(value);
    inflight += 1;
    peak = Math.max(peak, inflight);
    await new Promise((resolve) => setTimeout(resolve, 20));
    inflight -= 1;
    return value * 10;
  });
  assert.deepEqual(results, [10, 20, 30, 40, 50]);
  assert.equal(peak, 2);
  assert.deepEqual(started.slice(0, 2).sort(), [1, 2]);
});

test("confirmed reset runs target and subscription writes concurrently", async () => {
  const event = {
    id: "event",
    status: "pending",
    dryRun: false,
    sourceAccountId: 28,
    plan: { targetAccountIds: [21, 22, 23], subscriptionResetWindows: ["weekly"] },
    subscriptionDiscoveryComplete: true,
    actions: {
      sourceRecovery: { status: "success" },
      targetAccounts: {
        21: { status: "pending" },
        22: { status: "pending" },
        23: { status: "pending" },
      },
      subscriptions: {
        10: { status: "pending" },
        11: { status: "pending" },
        12: { status: "pending" },
        13: { status: "pending" },
      },
    },
  };
  let targetInflight = 0;
  let targetPeak = 0;
  let subscriptionInflight = 0;
  let subscriptionPeak = 0;
  const client = {
    async resetTargetAccount() {
      targetInflight += 1;
      targetPeak = Math.max(targetPeak, targetInflight);
      await new Promise((resolve) => setTimeout(resolve, 30));
      targetInflight -= 1;
    },
    async resetSubscription() {
      subscriptionInflight += 1;
      subscriptionPeak = Math.max(subscriptionPeak, subscriptionInflight);
      await new Promise((resolve) => setTimeout(resolve, 30));
      subscriptionInflight -= 1;
    },
  };
  const engine = new MonitorEngine({
    database: { updateEvent() {}, addAudit() {}, getMonitorState() { return {}; }, saveMonitorState() {} },
    configStore: {},
    notifier: { async notifyActionFailure() { return []; } },
  });
  const started = Date.now();
  await engine.executeEvent({ id: "monitor", targetAccountIds: [21, 22, 23], notifyEnabled: false }, client, event);
  const elapsed = Date.now() - started;
  assert.equal(event.status, "complete");
  assert.ok(targetPeak >= 3, `expected parallel targets, peak=${targetPeak}`);
  assert.ok(subscriptionPeak >= 4, `expected parallel subscriptions, peak=${subscriptionPeak}`);
  assert.ok(elapsed < 200, `expected concurrent resets under 200ms, got ${elapsed}ms`);
});
