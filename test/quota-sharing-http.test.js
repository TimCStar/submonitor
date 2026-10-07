import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

test("manual sharing API authenticates, changes only weekly limits, and honors public display opt-in", async (t) => {
  const writes = [];
  const fake = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    let data;
    if (url.pathname.endsWith("/accounts/28/usage")) data = { seven_day: {
      utilization: 10, resets_at: new Date(Date.now() + 6 * 86400000).toISOString(),
      window_stats: { cost: 100, user_cost: 100 },
    } };
    else if (url.pathname.endsWith("/accounts/28")) data = { id: 28, status: "active", platform: "openai", type: "oauth", group_ids: [11] };
    else if (url.pathname.endsWith("/accounts")) data = { pages: 1, items: [{ id: 28 }] };
    else if (url.pathname.endsWith("/groups/11")) {
      if (req.method === "PUT") {
        let body = ""; for await (const chunk of req) body += chunk;
        writes.push(JSON.parse(body));
      }
      data = { status: "active", platform: "openai", subscription_type: "subscription", weekly_limit_usd: 600 };
    } else if (url.pathname.endsWith("/subscriptions")) data = { pages: 1,
      items: [1, 2].map((id) => ({ id, user_id: id, group_id: 11, status: "active", weekly_usage_usd: 50 })) };
    else {
      res.writeHead(404, { "Content-Type": "application/json" }); res.end(JSON.stringify({ message: "route not found" })); return;
    }
    res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ code: 0, data }));
  });
  await new Promise((resolve) => fake.listen(0, "127.0.0.1", resolve));
  t.after(async () => { fake.closeAllConnections(); await new Promise((resolve) => fake.close(resolve)); });
  const upstream = `http://127.0.0.1:${fake.address().port}`;
  const directory = mkdtempSync(path.join(os.tmpdir(), "submonitor-sharing-http-"));
  const baseUrl = `http://127.0.0.1:${await freePort()}`;
  const app = spawn(process.execPath, ["src/server/index.js"], { cwd: process.cwd(), stdio: "ignore", env: {
    ...process.env, SUBMONITOR_HOST: "127.0.0.1", SUBMONITOR_PORT: new URL(baseUrl).port,
    SUBMONITOR_DATA_DIR: directory, SUBMONITOR_MASTER_KEY: "sharing-http-test-master-key-at-least-32", SUBMONITOR_ADMIN_PASSWORD: "test-password",
  } });
  t.after(async () => {
    if (app.exitCode === null) { app.kill(); await new Promise((resolve) => app.once("exit", resolve)); }
    rmSync(directory, { recursive: true, force: true });
  });
  for (let i = 0; i < 80; i++) {
    try { if ((await fetch(`${baseUrl}/api/health`)).ok) break; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal((await fetch(`${baseUrl}/api/monitors/missing/quota-sharing`, { method: "POST" })).status, 401);
  const login = await fetch(`${baseUrl}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json", Origin: baseUrl }, body: JSON.stringify({ password: "test-password" }) });
  const headers = { "Content-Type": "application/json", Origin: baseUrl, Cookie: login.headers.get("set-cookie").split(";", 1)[0] };
  const created = await fetch(`${baseUrl}/api/monitors`, { method: "POST", headers, body: JSON.stringify({
    name: "Shared", baseUrl: upstream, sourceAccountId: 28, authSecret: "secret", dryRun: false,
    quotaSharingEnabled: true, quotaSharingGroupId: 11, quotaSharingReserveEnabled: true,
    quotaSharingDisplayEnabled: true, enabled: false,
  }) }).then((res) => res.json());
  assert.equal(created.ok, true);
  const monitor = created.data;
  const result = await fetch(`${baseUrl}/api/monitors/${monitor.id}/quota-sharing`, { method: "POST", headers }).then((res) => res.json());
  assert.equal(result.data.quotaSharing.status, "applied");
  assert.deepEqual(writes, [{ weekly_limit_usd: 450 }]);
  await fetch(`${baseUrl}/api/monitors/${monitor.id}`, { method: "PUT", headers, body: JSON.stringify({ ...monitor, enabled: true }) });
  let dashboard = await fetch(`${baseUrl}/api/public/dashboard`).then((res) => res.json());
  // enabled changes do not discard the last successful quota calculation.
  assert.equal(dashboard.data.monitors[0].quotaSharing.estimatedTotalUsd, 1000);
  await fetch(`${baseUrl}/api/monitors/${monitor.id}`, { method: "PUT", headers,
    body: JSON.stringify({ ...monitor, enabled: true, quotaSharingDisplayEnabled: false }) });
  dashboard = await fetch(`${baseUrl}/api/public/dashboard`).then((res) => res.json());
  assert.equal(dashboard.data.monitors[0].quotaSharing, null);
  assert.equal((await fetch(`${baseUrl}/api/monitors/${monitor.id}/quota-sharing`, { method: "POST", headers: { ...headers, Origin: "https://other.test" } })).status, 403);
});
