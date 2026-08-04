import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ConfigStore } from "../src/server/config-store.js";
import { AppDatabase } from "../src/server/database.js";
import { createSecretBox } from "../src/server/secrets.js";

function validConfig(overrides = {}) {
  return {
    baseUrl: "https://sub2api.example.test",
    authType: "apiKey",
    authSecret: "administrator-secret",
    sourceAccountId: 12,
    targetAccountIds: [34],
    monitorWindows: ["7d"],
    pollIntervalSeconds: 300,
    requestTimeoutSeconds: 45,
    confirmationsRequired: 2,
    resetGraceSeconds: 60,
    resetMaxUsedPercent: 20,
    subscriptionGroupMode: "none",
    subscriptionGroupIds: [],
    subscriptionResetWindows: ["weekly"],
    dryRun: true,
    enabled: false,
    ...overrides,
  };
}

test("credentials stay encrypted and identity changes cancel pending events", (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "submonitor-config-"));
  const database = new AppDatabase(path.join(directory, "test.sqlite"));
  t.after(() => {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const secretBox = createSecretBox("configuration-test-master-key-32-characters");
  const store = new ConfigStore(database, secretBox);
  store.update(validConfig());

  const publicConfig = store.getPublic();
  assert.equal(publicConfig.authSecretConfigured, true);
  assert.equal(Object.hasOwn(publicConfig, "authSecret"), false);
  assert.equal(Object.hasOwn(publicConfig, "authSecretCipher"), false);
  assert.notEqual(database.getConfig().authSecretCipher, "administrator-secret");
  assert.equal(store.getPrivate().authSecret, "administrator-secret");

  database.createEvent({
    id: "12:7d:100",
    status: "pending",
    sourceAccountId: 12,
    window: "7d",
    baseline: { resetAt: 100, usedPercent: 5 },
    resetSnapshot: { resetAt: 200, usedPercent: 0 },
    confirmedAt: new Date().toISOString(),
    actions: {
      sourceRecovery: { status: "pending" },
      targetAccounts: { 34: { status: "failed" } },
      subscriptions: {},
    },
  });

  const result = store.update(validConfig({ sourceAccountId: 13, authSecret: "" }));
  assert.equal(result.baselineChanged, true);
  assert.equal(result.cancelledEvents, 1);
  const cancelled = database.getEvent("12:7d:100");
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.actions.sourceRecovery.status, "skipped");
  assert.equal(cancelled.actions.targetAccounts[34].status, "skipped");
});
