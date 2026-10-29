import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ConfigStore } from "../src/server/config-store.js";
import { AppDatabase } from "../src/server/database.js";
import { createSecretBox } from "../src/server/secrets.js";

function store() {
  const directory = mkdtempSync(path.join(os.tmpdir(), "submonitor-tpl-"));
  const database = new AppDatabase(path.join(directory, "test.sqlite"));
  const secretBox = createSecretBox("configuration-test-master-key-32-characters");
  return {
    directory,
    database,
    store: new ConfigStore(database, secretBox),
    cleanup() {
      database.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

test("connection templates encrypt secrets and apply without exposing them", (t) => {
  const ctx = store();
  t.after(() => ctx.cleanup());
  const created = ctx.store.createTemplate({
    name: "Prod CPR",
    provider: "cpr",
    baseUrl: "https://cpr.example.test",
    authType: "apiKey",
    authSecret: "super-secret",
  });
  assert.equal(created.authSecretConfigured, true);
  assert.equal(Object.hasOwn(created, "authSecret"), false);
  assert.equal(Object.hasOwn(created, "authSecretCipher"), false);

  const applied = ctx.store.applyTemplate(created.id);
  assert.equal(applied.provider, "cpr");
  assert.equal(applied.baseUrl, "https://cpr.example.test");
  assert.equal(applied.useSavedSecret, true);
  assert.ok(applied.authSecretCipher);

  const monitor = ctx.store.create({
    name: "From template",
    provider: "cpr",
    baseUrl: "https://cpr.example.test",
    authType: "apiKey",
    sourceAccountId: "acc_abc",
    useSavedSecret: true,
    templateId: created.id,
  });
  assert.equal(monitor.provider, "cpr");
  assert.equal(monitor.sourceAccountId, "acc_abc");
  assert.equal(monitor.authSecretConfigured, true);
  assert.equal(ctx.store.getPrivate(monitor.id).authSecret, "super-secret");
});

test("CPR rejects subscription cascade and quota sharing", (t) => {
  const ctx = store();
  t.after(() => ctx.cleanup());
  assert.throws(
    () => ctx.store.create({
      name: "CPR bad",
      provider: "cpr",
      baseUrl: "https://cpr.example.test",
      authSecret: "secret",
      sourceAccountId: "acc_1",
      subscriptionGroupMode: "auto",
    }),
    /Client Key|订阅/,
  );
  assert.throws(
    () => ctx.store.create({
      name: "CPR bad share",
      provider: "cpr",
      baseUrl: "https://cpr.example.test",
      authSecret: "secret",
      sourceAccountId: "acc_1",
      quotaSharingEnabled: true,
      quotaSharingGroupId: 1,
    }),
    /额度均分/,
  );
});

test("CPR accepts string account ids and client key ids", (t) => {
  const ctx = store();
  t.after(() => ctx.cleanup());
  const monitor = ctx.store.create({
    name: "CPR ok",
    provider: "cpr",
    baseUrl: "https://cpr.example.test",
    authSecret: "secret",
    sourceAccountId: "acc_source",
    targetAccountIds: ["acc_t1", "acc_t2"],
    clientKeyIds: ["ck_1", "ck_2"],
    subscriptionResetWindows: ["daily", "weekly"],
  });
  assert.equal(monitor.provider, "cpr");
  assert.deepEqual(monitor.targetAccountIds, ["acc_t1", "acc_t2"]);
  assert.deepEqual(monitor.clientKeyIds, ["ck_1", "ck_2"]);
  assert.equal(monitor.subscriptionGroupMode, "none");
  assert.equal(monitor.quotaSharingEnabled, false);
});

test("source_account_id column stores string CPR ids", (t) => {
  const ctx = store();
  t.after(() => ctx.cleanup());
  const created = ctx.database.createEvent({
    id: "evt-1",
    monitorId: "m1",
    monitorName: "m",
    status: "pending",
    sourceAccountId: "acc_string",
    window: "7d",
    baseline: { resetAt: 1, usedPercent: 90 },
    resetSnapshot: { resetAt: 100, usedPercent: 1 },
    confirmedAt: new Date().toISOString(),
    actions: { sourceRecovery: { status: "pending" }, targetAccounts: {}, subscriptions: {}, clientKeys: {} },
  });
  assert.equal(created, true);
  const row = ctx.database.db.prepare("SELECT source_account_id AS id FROM reset_events WHERE id = ?").get("evt-1");
  assert.equal(row.id, "acc_string");
});
