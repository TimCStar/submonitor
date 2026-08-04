import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function freePort() {
  const listener = net.createServer();
  await new Promise((resolve, reject) => listener.listen(0, "127.0.0.1", resolve).once("error", reject));
  const port = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  return port;
}

async function waitForServer(url, child) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`Server exited with code ${child.exitCode}`);
    try {
      const response = await fetch(`${url}/api/health`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Timed out waiting for test server");
}

test("public monitoring stays anonymous and sanitized while management requires login", async (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "submonitor-http-"));
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [path.join(projectRoot, "src/server/index.js")], {
    cwd: projectRoot,
    env: {
      ...process.env,
      SUBMONITOR_HOST: "127.0.0.1",
      SUBMONITOR_PORT: String(port),
      SUBMONITOR_DATA_DIR: directory,
      SUBMONITOR_MASTER_KEY: "http-test-master-key-with-32-characters",
      SUBMONITOR_ADMIN_PASSWORD: "http-test-password",
    },
    stdio: "ignore",
  });
  t.after(async () => {
    if (child.exitCode === null) {
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    }
    rmSync(directory, { recursive: true, force: true });
  });
  await waitForServer(baseUrl, child);

  const anonymous = await fetch(`${baseUrl}/api/public/dashboard`);
  assert.equal(anonymous.status, 200);
  assert.deepEqual((await anonymous.json()).data.monitors, []);
  assert.equal((await fetch(`${baseUrl}/api/dashboard`)).status, 401);
  assert.equal((await fetch(`${baseUrl}/api/monitors/missing/subscribers`)).status, 401);

  const login = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: baseUrl },
    body: JSON.stringify({ password: "http-test-password" }),
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get("set-cookie").split(";", 1)[0];
  for (const name of ["Primary Codex", "Backup Codex"]) {
    const created = await fetch(`${baseUrl}/api/monitors`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie, Origin: baseUrl },
      body: JSON.stringify({ name }),
    });
    assert.equal(created.status, 201);
  }

  const publicPayload = await fetch(`${baseUrl}/api/public/dashboard`).then((response) => response.json());
  assert.equal(publicPayload.data.monitors.length, 2);
  const serialized = JSON.stringify(publicPayload);
  for (const sensitiveField of ["baseUrl", "authSecret", "authSecretCipher", "targetAccountIds", "subscriptionGroupIds"]) {
    assert.equal(serialized.includes(sensitiveField), false, `${sensitiveField} leaked into public dashboard`);
  }

  const admin = await fetch(`${baseUrl}/api/dashboard`, { headers: { Cookie: cookie } });
  assert.equal(admin.status, 200);
  assert.equal((await admin.json()).data.monitors.length, 2);
});
