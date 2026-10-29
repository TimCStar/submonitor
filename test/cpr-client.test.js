import assert from "node:assert/strict";
import test from "node:test";
import {
  CprClient,
  clientKeyResetPeriod,
  normalizeCprQuota,
  parseResetAtDisplay,
} from "../src/server/cpr-client.js";
import { createBackendClient } from "../src/server/backend-client.js";
import { extractSnapshots } from "../src/server/monitor-engine.js";
import { Sub2ApiClient } from "../src/server/sub2api-client.js";

test("parseResetAtDisplay treats em dash and blank as missing", () => {
  assert.equal(parseResetAtDisplay("—"), 0);
  assert.equal(parseResetAtDisplay(""), 0);
  assert.equal(parseResetAtDisplay(null), 0);
});

test("parseResetAtDisplay parses CPR local display as UTC seconds", () => {
  assert.equal(parseResetAtDisplay("2026-10-29 14:30:00"), Date.UTC(2026, 9, 29, 14, 30, 0) / 1000);
});

test("normalizeCprQuota maps windows into rate_limit for extractSnapshots", () => {
  const quota = normalizeCprQuota({
    account: {
      quota: {
        refreshedAt: "2026-10-29T06:00:00.000Z",
        limitReached: false,
        windows: [
          {
            key: "5h",
            group: "codex",
            role: "primary",
            windowSeconds: 18000,
            usedPercent: 42.5,
            limitReached: false,
            resetAtDisplay: "2026-10-29 14:30:00",
          },
          {
            key: "7d",
            group: "codex",
            role: "secondary",
            windowSeconds: 604800,
            usedPercent: 10,
            limitReached: false,
            resetAtDisplay: "2026-11-01 00:00:00",
          },
        ],
      },
    },
  });
  const snapshots = extractSnapshots(quota);
  assert.equal(snapshots.length, 2);
  assert.equal(snapshots[0].role, "primary");
  assert.equal(snapshots[0].usedPercent, 42.5);
  assert.equal(snapshots[0].resetAt, Date.UTC(2026, 9, 29, 14, 30, 0) / 1000);
  assert.equal(snapshots[0].canonicalName, "5h");
  assert.equal(snapshots[1].canonicalName, "7d");
});

test("clientKeyResetPeriod maps selected windows", () => {
  assert.equal(clientKeyResetPeriod(["daily"]), "daily");
  assert.equal(clientKeyResetPeriod(["weekly"]), "weekly");
  assert.equal(clientKeyResetPeriod(["monthly"]), "all");
  assert.equal(clientKeyResetPeriod(["daily", "weekly"]), "all");
});

test("createBackendClient selects CPR vs Sub2API", () => {
  assert.ok(createBackendClient({ provider: "cpr", baseUrl: "https://cpr.test", authSecret: "k", requestTimeoutSeconds: 5 }) instanceof CprClient);
  assert.ok(createBackendClient({ provider: "sub2api", baseUrl: "https://s.test", authSecret: "k", requestTimeoutSeconds: 5 }) instanceof Sub2ApiClient);
});

test("CprClient treats envelope code 200 as success and recovers via POST body", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), method: options.method, body: options.body, headers: options.headers });
    return {
      ok: true,
      status: 200,
      async text() {
        return JSON.stringify({ code: 200, message: "ok", data: { ok: true } });
      },
    };
  };
  const client = new CprClient({
    baseUrl: "https://cpr.example.test",
    authType: "apiKey",
    authSecret: "secret",
    requestTimeoutSeconds: 5,
  });
  await client.recoverSourceAccount("acc_1");
  await client.resetClientKeyBudget("ck_9", "weekly");
  assert.equal(calls[0].url, "https://cpr.example.test/api/admin/accounts/recover");
  assert.equal(calls[0].headers["x-api-key"], "secret");
  assert.deepEqual(JSON.parse(calls[0].body), { accountId: "acc_1" });
  assert.equal(calls[1].url, "https://cpr.example.test/api/admin/client-keys/reset-budget");
  assert.deepEqual(JSON.parse(calls[1].body), { id: "ck_9", period: "weekly" });
});

test("CprClient rejects Sub2API-style code 0 success", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    async text() {
      return JSON.stringify({ code: 0, message: "ok", data: {} });
    },
  });
  const client = new CprClient({
    baseUrl: "https://cpr.example.test",
    authType: "apiKey",
    authSecret: "secret",
    requestTimeoutSeconds: 5,
  });
  await assert.rejects(() => client.recoverSourceAccount("acc_1"), /failed: ok|failed: 0/);
});
