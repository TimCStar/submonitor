import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AuthService, generateTotpCode } from "../src/server/auth.js";
import { AppDatabase } from "../src/server/database.js";
import { createSecretBox } from "../src/server/secrets.js";

function createAuth(database, secretBox) {
  return new AuthService({
    password: "administrator-password",
    signingSecret: "auth-test-signing-secret-with-32-characters",
    secureCookie: false,
    database,
    secretBox,
  });
}

test("TOTP setup, verification and password-protected disable flow", (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "submonitor-auth-2fa-"));
  const database = new AppDatabase(path.join(directory, "test.sqlite"));
  const secretBox = createSecretBox("auth-2fa-test-master-key-with-32-characters");
  const auth = createAuth(database, secretBox);
  t.after(() => {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  });

  const setup = auth.setupTwoFactor();
  assert.match(setup.secret, /^[A-Z2-7]{32}$/);
  assert.match(setup.otpauthUri, /^otpauth:\/\/totp\/SubMonitor%3Aadmin\?/);
  assert.deepEqual(auth.twoFactorStatus(), { enabled: false, pending: true });

  const code = generateTotpCode(setup.secret);
  assert.deepEqual(auth.enableTwoFactor(code), { enabled: true, pending: false });
  assert.equal(auth.verifyTwoFactor(code), true);
  assert.equal(auth.verifyTwoFactor("000000"), false);
  assert.throws(() => auth.disableTwoFactor("wrong-password", code), /管理员密码不正确/);
  assert.deepEqual(auth.disableTwoFactor("administrator-password", code), { enabled: false, pending: false });
  assert.equal(auth.verifyTwoFactor("000000"), true);
});

test("login lockout persists across AuthService instances", (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "submonitor-auth-lockout-"));
  const database = new AppDatabase(path.join(directory, "test.sqlite"));
  const secretBox = createSecretBox("auth-lockout-test-master-key-with-32-characters");
  const auth = createAuth(database, secretBox);
  t.after(() => {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  });

  const address = "198.51.100.10";
  for (let attempt = 0; attempt < 4; attempt += 1) {
    assert.equal(auth.loginGuard(address).allowed, true);
    auth.recordLoginFailure(address);
  }
  const blocked = auth.recordLoginFailure(address);
  assert.equal(blocked.allowed, false);
  assert.ok(blocked.retryAfterSeconds >= 1);

  const restartedAuth = createAuth(database, secretBox);
  assert.equal(restartedAuth.loginGuard(address).allowed, false);
  const now = Date.now();
  database.setSetting("auth_login_security", {
    account: { count: 20, firstFailedAt: now - 20 * 60 * 1000, lastFailedAt: now - 20 * 60 * 1000, blockedUntil: now + 60 * 60 * 1000 },
    addresses: {},
  });
  assert.equal(restartedAuth.loginGuard("another-address").allowed, false);
  restartedAuth.clearLoginFailures(address);
  assert.equal(restartedAuth.loginGuard(address).allowed, true);
});
