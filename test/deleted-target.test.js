import assert from "node:assert/strict";
import test from "node:test";
import { MonitorEngine } from "../src/server/monitor-engine.js";
import { Sub2ApiClient } from "../src/server/sub2api-client.js";

function fixture(targets = [23]) {
  const config = { id: "monitor", targetAccountIds: targets, notifyEnabled: true };
  const event = {
    id: "event", status: "pending", dryRun: false, sourceAccountId: 28,
    plan: { targetAccountIds: [23], subscriptionResetWindows: ["weekly"] },
    subscriptionDiscoveryComplete: true,
    actions: { sourceRecovery: { status: "success" },
      targetAccounts: { 23: { status: "failed", error: "old failure" } },
      subscriptions: { 10: { status: "success" } } },
  };
  const counts = { targets: 0, sources: 0, subscriptions: 0, alerts: 0 };
  const client = {
    async resetTargetAccount() { counts.targets++; },
    async recoverSourceAccount() { counts.sources++; },
    async resetSubscription() { counts.subscriptions++; },
  };
  const database = {
    updateEvent() {}, addAudit() {}, getMonitorState() { return {}; }, saveMonitorState() {},
    listPendingEvents() { return event.status === "pending" ? [event] : []; },
  };
  const engine = new MonitorEngine({ database, configStore: {},
    notifier: { async notifyActionFailure() { counts.alerts++; return []; } } });
  return { config, event, counts, client, engine };
}

test("removed target in frozen event is skipped without repeating successful writes or alerts", async () => {
  const f = fixture([]);
  await f.engine.resumePendingEvents(f.config, f.client);
  await f.engine.resumePendingEvents(f.config, f.client);
  assert.equal(f.event.status, "complete");
  assert.equal(f.event.actions.targetAccounts[23].status, "skipped");
  assert.match(f.event.actions.targetAccounts[23].skipReason, /removed/);
  assert.equal(f.event.actions.targetAccounts[23].error, undefined);
  assert.deepEqual(f.counts, { targets: 0, sources: 0, subscriptions: 0, alerts: 0 });
});

test("explicit missing account 404 is terminal for a target reset", async () => {
  const f = fixture();
  f.client.resetTargetAccount = async () => {
    f.counts.targets++;
    throw Object.assign(new Error("account not found"), { status: 404, apiMessage: "account not found" });
  };
  await f.engine.resumePendingEvents(f.config, f.client);
  await f.engine.resumePendingEvents(f.config, f.client);
  assert.equal(f.event.status, "complete");
  assert.equal(f.event.actions.targetAccounts[23].status, "skipped");
  assert.equal(f.counts.targets, 1);
  assert.equal(f.counts.alerts, 0);
});

for (const [status, apiMessage] of [[500, "account not found"], [404, "route not found"], [401, "unauthorized"]]) {
  test(`HTTP ${status} ${apiMessage} remains retryable and alerts`, async () => {
    const f = fixture();
    f.client.resetTargetAccount = async () => {
      f.counts.targets++;
      throw Object.assign(new Error(apiMessage), { status, apiMessage });
    };
    await f.engine.resumePendingEvents(f.config, f.client);
    await f.engine.resumePendingEvents(f.config, f.client);
    assert.equal(f.event.status, "pending");
    assert.equal(f.event.actions.targetAccounts[23].status, "failed");
    assert.equal(f.counts.targets, 2);
    assert.ok(f.counts.alerts > 0);
  });
}

test("a removed target does not prevent other targets and pending subscriptions completing", async () => {
  const f = fixture([24]);
  f.event.actions.targetAccounts[24] = { status: "pending" };
  f.event.actions.subscriptions[11] = { status: "pending" };
  await f.engine.resumePendingEvents(f.config, f.client);
  assert.equal(f.event.status, "complete");
  assert.equal(f.event.actions.targetAccounts[23].status, "skipped");
  assert.equal(f.event.actions.targetAccounts[24].status, "success");
  assert.deepEqual(f.counts, { targets: 1, sources: 0, subscriptions: 1, alerts: 0 });
});

test("HTTP client exposes status and API message for missing-account handling", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async () => new Response(JSON.stringify({ message: "account not found" }), { status: 404 });
  const client = new Sub2ApiClient({ baseUrl: "https://example.test", requestTimeoutSeconds: 5 });
  await assert.rejects(client.resetTargetAccount(23), (error) => {
    assert.equal(error.status, 404);
    assert.equal(error.apiMessage, "account not found");
    assert.match(error.message, /POST .*23\/reset-quota failed with HTTP 404/);
    return true;
  });
});
