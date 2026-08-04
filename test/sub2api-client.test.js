import assert from "node:assert/strict";
import test from "node:test";
import { Sub2ApiClient } from "../src/server/sub2api-client.js";

test("connection failures include the configured Sub2API address and root cause", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async () => {
    const cause = new Error("connect ECONNREFUSED 127.0.0.1:9999");
    cause.code = "ECONNREFUSED";
    throw new TypeError("fetch failed", { cause });
  };
  const client = new Sub2ApiClient({
    baseUrl: "http://127.0.0.1:9999",
    authType: "apiKey",
    authSecret: "secret",
    requestTimeoutSeconds: 5,
  });

  await assert.rejects(
    client.queryCodexQuota(12),
    /Cannot reach Sub2API at http:\/\/127\.0\.0\.1:9999: ECONNREFUSED: connect ECONNREFUSED/,
  );
});
