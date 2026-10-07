import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AppDatabase } from "../src/server/database.js";
import { ConfigStore } from "../src/server/config-store.js";
import { createSecretBox } from "../src/server/secrets.js";
import { calculateSharedWeeklyLimit, estimateWeeklyQuota, publicQuotaSharing, QuotaSharingService } from "../src/server/quota-sharing.js";

function usage(percent = 10, cost = 100, userCost = 200) {
  return { seven_day: { utilization: percent, resets_at: new Date(Date.now() + 6 * 86400000).toISOString(),
    window_stats: { cost, user_cost: userCost } } };
}

function fixture(t, overrides = {}) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "submonitor-sharing-"));
  const db = new AppDatabase(path.join(directory, "test.sqlite"));
  t.after(() => { db.close(); rmSync(directory, { recursive: true, force: true }); });
  const store = new ConfigStore(db, createSecretBox("quota-sharing-test-master-key-at-least-32"));
  const monitor = store.create({ name: "Shared Pro", baseUrl: "https://example.test", authSecret: "secret",
    sourceAccountId: 28, quotaSharingEnabled: true, quotaSharingGroupId: 11,
    quotaSharingReserveEnabled: true, quotaSharingReservePercent: 10,
    quotaSharingAutoRecalculateEnabled: true, quotaSharingDisplayEnabled: true, dryRun: false, ...overrides });
  const config = store.getPrivate(monitor.id);
  const calls = { usage: 0, writes: [], groups: 0 };
  const subs = [1, 2].map((id) => ({ id, user_id: id, group_id: 11, status: "active", weekly_usage_usd: 100, user: { status: "active" } }));
  const group = { id: 11, status: "active", platform: "openai", subscription_type: "subscription", weekly_limit_usd: 600 };
  const client = {
    async getAccountUsage() { calls.usage++; return usage(); },
    async getAccount() { return { id: 28, status: "active", platform: "openai", type: "oauth", group_ids: [11] }; },
    async getGroup() { calls.groups++; return group; },
    async listGroupAccounts() { return { items: [{ id: 28 }], pages: 1 }; },
    async listSubscriptions() { return { items: subs, pages: 1 }; },
    async updateGroupWeeklyLimit(id, limit) { calls.writes.push({ id, limit }); group.weekly_limit_usd = limit; },
  };
  const service = new QuotaSharingService({ database: db, configStore: store.forMonitor(monitor.id) });
  return { db, store, config, calls, client, service, subs, group };
}

test("weekly estimate preserves account and user billing units", () => {
  const value = estimateWeeklyQuota(usage());
  assert.equal(value.estimatedTotalUsd, 1000);
  assert.equal(value.estimatedUserTotalUsd, 2000);
  for (const percent of [0, 1, 4.9, 101, NaN]) assert.equal(estimateWeeklyQuota(usage(percent)), null);
  assert.equal(estimateWeeklyQuota(usage(10, 0)), null);
  const missingBilling = usage(); delete missingBilling.seven_day.window_stats.user_cost;
  assert.equal(estimateWeeklyQuota(missingBilling), null);
  const expired = usage(); expired.seven_day.resets_at = new Date(Date.now() - 1000).toISOString();
  assert.equal(estimateWeeklyQuota(expired), null);
});

test("equal ceilings reserve already spent quota and round down", () => {
  assert.equal(calculateSharedWeeklyLimit(1000, 100, [50, 50, 0, 0]), 250);
  assert.equal(calculateSharedWeeklyLimit(1000, 400, [400, 0, 0, 0]), 200);
  assert.equal(calculateSharedWeeklyLimit(1000, 400, [0, 0, 0]), 200);
  assert.equal(calculateSharedWeeklyLimit(100, 0, [0, 0, 0]), 33.33);
  assert.equal(calculateSharedWeeklyLimit(100, 100, [0, 0]), null);
  assert.equal(calculateSharedWeeklyLimit(100, 0, []), null);
});

test("all sharing switches default off and perform no additional upstream reads", async (t) => {
  const f = fixture(t, { quotaSharingEnabled: false, quotaSharingReserveEnabled: false,
    quotaSharingAutoRecalculateEnabled: false, quotaSharingDisplayEnabled: false });
  assert.equal(await f.service.refresh(f.config, f.client), null);
  assert.equal(f.calls.usage, 0);
  assert.deepEqual(f.calls.writes, []);
  const fresh = f.store.create({ name: "Default" });
  for (const key of ["quotaSharingEnabled", "quotaSharingReserveEnabled", "quotaSharingAutoRecalculateEnabled", "quotaSharingDisplayEnabled"]) assert.equal(fresh[key], false);
});

test("automatic sharing applies reserved user-billed budget once per interval", async (t) => {
  const f = fixture(t);
  const result = await f.service.refresh(f.config, f.client);
  assert.equal(result.status, "applied");
  assert.equal(result.distributableTotalUsd, 1800);
  assert.deepEqual(f.calls.writes, [{ id: 11, limit: 900 }]);
  assert.equal(f.subs[0].weekly_usage_usd, 100);
  await f.service.refresh(f.config, f.client);
  assert.equal(f.calls.usage, 1);
});

test("turning reserve off allocates the full estimated budget", async (t) => {
  const f = fixture(t, { quotaSharingReserveEnabled: false });
  const result = await f.service.refresh(f.config, f.client);
  assert.equal(result.reservePercent, 0);
  assert.equal(result.recommendedWeeklyLimitUsd, 1000);
});

test("display-only mode estimates without reading or modifying the group", async (t) => {
  const f = fixture(t, { quotaSharingEnabled: false });
  const result = await f.service.refresh(f.config, f.client, { manual: true });
  assert.equal(result.status, "ready");
  assert.equal(f.calls.groups, 0);
  assert.deepEqual(f.calls.writes, []);
});

test("timer disabled previews until manual sync, and dry-run never writes", async (t) => {
  const f = fixture(t, { quotaSharingAutoRecalculateEnabled: false });
  assert.equal((await f.service.refresh(f.config, f.client)).status, "preview");
  assert.deepEqual(f.calls.writes, []);
  assert.equal((await f.service.refresh(f.config, f.client, { manual: true })).status, "applied");
  const dry = fixture(t, { dryRun: true });
  assert.equal((await dry.service.refresh(dry.config, dry.client, { manual: true })).status, "preview");
  assert.deepEqual(dry.calls.writes, []);
});

test("reset and insufficient sampling keep limits unchanged and discard old estimates", async (t) => {
  const f = fixture(t);
  await f.service.refresh(f.config, f.client);
  f.client.getAccountUsage = async () => usage(0);
  const result = await f.service.refresh(f.config, f.client, { force: true });
  assert.equal(result.status, "waiting");
  assert.equal(result.estimatedTotalUsd, undefined);
  assert.equal(f.calls.writes.length, 1);
});

test("non-dedicated groups are rejected before quota writes", async (t) => {
  const f = fixture(t);
  f.client.listGroupAccounts = async () => ({ items: [{ id: 28 }, { id: 29 }], pages: 1 });
  assert.equal((await f.service.refresh(f.config, f.client)).status, "error");
  assert.deepEqual(f.calls.writes, []);
  f.client.listGroupAccounts = async () => ({ items: [{ id: 28 }], pages: 1 });
  f.client.getAccount = async () => ({ status: "active", platform: "openai", type: "oauth", group_ids: [11, 12] });
  await assert.rejects(f.service.refresh(f.config, f.client, { manual: true }), /专用/);
  assert.deepEqual(f.calls.writes, []);
});

test("expired and inactive subscribers are excluded and no-user groups are not changed", async (t) => {
  const f = fixture(t);
  f.subs[0].expires_at = new Date(Date.now() - 1000).toISOString();
  f.subs[1].user.status = "disabled";
  const result = await f.service.refresh(f.config, f.client);
  assert.equal(result.subscriberCount, 0);
  assert.equal(result.status, "blocked");
  assert.deepEqual(f.calls.writes, []);
});

test("exhausted reserved budget never writes an unlimited zero limit", async (t) => {
  const f = fixture(t);
  f.client.getAccountUsage = async () => usage(95, 950, 950);
  assert.equal((await f.service.refresh(f.config, f.client)).status, "blocked");
  assert.deepEqual(f.calls.writes, []);
});

test("incomplete subscription pages and malformed dates never change live limits", async (t) => {
  const f = fixture(t);
  for (const result of [
    { items: f.subs, pages: "invalid" },
    { items: f.subs, pages: 1001 },
    { items: f.subs, pages: 1, total: 3 },
    { items: [{ ...f.subs[0], expires_at: "invalid" }], pages: 1 },
  ]) {
    f.client.listSubscriptions = async () => result;
    assert.equal((await f.service.refresh(f.config, f.client, { force: true })).status, "error");
    assert.deepEqual(f.calls.writes, []);
  }
});

test("configuration changed during reads cannot apply or republish stale calculations", async (t) => {
  const f = fixture(t);
  f.client.getAccountUsage = async () => {
    f.store.update(f.config.id, { ...f.store.getPublic(f.config.id), quotaSharingEnabled: false });
    return usage();
  };
  assert.equal(await f.service.refresh(f.config, f.client), null);
  assert.deepEqual(f.calls.writes, []);
  assert.equal(f.db.getSetting(`quota_sharing:${f.config.id}`), null);
});

test("config validation rejects duplicate pools and clears estimates when the group changes", (t) => {
  const f = fixture(t);
  assert.throws(() => f.store.create({ ...f.store.getPublic(f.config.id), name: "Duplicate" }), /重复分配/);
  assert.throws(() => f.store.update(f.config.id, { ...f.store.getPublic(f.config.id), quotaSharingReservePercent: 100 }), /quotaSharingReservePercent/);
  f.db.setSetting(`quota_sharing:${f.config.id}`, { estimatedTotalUsd: 1000 });
  f.store.update(f.config.id, { ...f.store.getPublic(f.config.id), quotaSharingGroupId: 12 });
  assert.equal(f.db.getSetting(`quota_sharing:${f.config.id}`), null);
});

test("public quota display is opt-in and excludes API errors, credentials and internal group IDs", () => {
  const state = { status: "error", estimatedTotalUsd: 1000, lastError: "secret upstream address", groupId: 11, authSecret: "secret" };
  assert.equal(publicQuotaSharing({ quotaSharingDisplayEnabled: false }, state), null);
  const serialized = JSON.stringify(publicQuotaSharing({ quotaSharingDisplayEnabled: true }, state));
  assert.equal(serialized.includes("1000"), true);
  for (const privateField of ["lastError", "groupId", "authSecret", "secret upstream"]) assert.equal(serialized.includes(privateField), false);
});
