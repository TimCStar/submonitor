import crypto from "node:crypto";

function parseCookies(header = "") {
  return Object.fromEntries(
    header.split(";").map((item) => item.trim()).filter(Boolean).map((item) => {
      const index = item.indexOf("=");
      return index < 0
        ? [decodeURIComponent(item), ""]
        : [decodeURIComponent(item.slice(0, index)), decodeURIComponent(item.slice(index + 1))];
    }),
  );
}

function secureEqual(left, right) {
  const leftHash = crypto.createHash("sha256").update(String(left)).digest();
  const rightHash = crypto.createHash("sha256").update(String(right)).digest();
  return crypto.timingSafeEqual(leftHash, rightHash);
}

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOCKOUT_LEVELS = [
  { failures: 20, durationMs: 24 * 60 * 60 * 1000 },
  { failures: 12, durationMs: 30 * 60 * 1000 },
  { failures: 8, durationMs: 5 * 60 * 1000 },
  { failures: 5, durationMs: 60 * 1000 },
];

function authError(message, code, status = 400) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
}

function encodeBase32(value) {
  let bits = 0;
  let bitCount = 0;
  let output = "";
  for (const byte of value) {
    bits = (bits << 8) | byte;
    bitCount += 8;
    while (bitCount >= 5) {
      output += BASE32_ALPHABET[(bits >>> (bitCount - 5)) & 31];
      bitCount -= 5;
    }
  }
  if (bitCount > 0) output += BASE32_ALPHABET[(bits << (5 - bitCount)) & 31];
  return output;
}

function decodeBase32(value) {
  const normalized = String(value || "").toUpperCase().replace(/[\s=]/g, "");
  let bits = 0;
  let bitCount = 0;
  const output = [];
  for (const character of normalized) {
    const index = BASE32_ALPHABET.indexOf(character);
    if (index < 0) throw authError("2FA 密钥格式无效", "TWO_FACTOR_SECRET_INVALID", 500);
    bits = (bits << 5) | index;
    bitCount += 5;
    if (bitCount >= 8) {
      output.push((bits >>> (bitCount - 8)) & 255);
      bitCount -= 8;
    }
  }
  return Buffer.from(output);
}

export function generateTotpCode(secret, timestamp = Date.now()) {
  const key = decodeBase32(secret);
  const counter = Math.floor(Number(timestamp) / 1000 / 30);
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(Math.max(0, counter)));
  const digest = crypto.createHmac("sha1", key).update(message).digest();
  const offset = digest[digest.length - 1] & 15;
  const binary = (digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000;
  return String(binary).padStart(6, "0");
}

function verifyTotpCode(secret, code, timestamp = Date.now()) {
  const normalized = String(code || "").replace(/\s/g, "");
  if (!/^\d{6}$/.test(normalized)) return false;
  const baseTime = Number(timestamp);
  return [-1, 0, 1].some((offset) => secureEqual(
    generateTotpCode(secret, baseTime + offset * 30 * 1000),
    normalized,
  ));
}

function emptyFailureEntry() {
  return { count: 0, firstFailedAt: 0, lastFailedAt: 0, blockedUntil: 0 };
}

function normalizeFailureEntry(value) {
  return {
    count: Number.isSafeInteger(value?.count) && value.count > 0 ? value.count : 0,
    firstFailedAt: Number.isFinite(value?.firstFailedAt) ? value.firstFailedAt : 0,
    lastFailedAt: Number.isFinite(value?.lastFailedAt) ? value.lastFailedAt : 0,
    blockedUntil: Number.isFinite(value?.blockedUntil) ? value.blockedUntil : 0,
  };
}

export class AuthService {
  constructor({ password, signingSecret, secureCookie, sessionHours = 24, database, secretBox }) {
    if (!password || password.length < 12) {
      throw new Error("SUBMONITOR_ADMIN_PASSWORD must contain at least 12 characters");
    }
    this.password = password;
    this.signingKey = crypto.createHash("sha256").update(signingSecret).digest();
    this.secureCookie = secureCookie;
    this.sessionSeconds = sessionHours * 60 * 60;
    this.cookieName = "submonitor_session";
    this.database = database;
    this.secretBox = secretBox;
  }

  verifyPassword(password) {
    return secureEqual(password, this.password);
  }

  createToken() {
    const now = Math.floor(Date.now() / 1000);
    const payload = Buffer.from(JSON.stringify({
      iat: now,
      exp: now + this.sessionSeconds,
      nonce: crypto.randomBytes(12).toString("base64url"),
    })).toString("base64url");
    const signature = crypto.createHmac("sha256", this.signingKey).update(payload).digest("base64url");
    return `${payload}.${signature}`;
  }

  verifyToken(token) {
    if (!token || !token.includes(".")) return false;
    const [payload, signature] = token.split(".");
    const expected = crypto.createHmac("sha256", this.signingKey).update(payload).digest("base64url");
    if (!secureEqual(signature, expected)) return false;
    try {
      const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
      return Number(parsed.exp) > Math.floor(Date.now() / 1000);
    } catch {
      return false;
    }
  }

  isAuthenticated(request) {
    const cookies = parseCookies(request.headers.cookie);
    return this.verifyToken(cookies[this.cookieName]);
  }

  sessionCookie(token) {
    const secure = this.secureCookie ? "; Secure" : "";
    return `${this.cookieName}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${this.sessionSeconds}${secure}`;
  }

  clearCookie() {
    const secure = this.secureCookie ? "; Secure" : "";
    return `${this.cookieName}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure}`;
  }

  readLoginSecurity() {
    const saved = this.database.getSetting("auth_login_security");
    const addresses = {};
    for (const [address, entry] of Object.entries(saved?.addresses || {})) {
      addresses[address] = normalizeFailureEntry(entry);
    }
    return {
      account: normalizeFailureEntry(saved?.account),
      addresses,
    };
  }

  writeLoginSecurity(value) {
    const entries = Object.entries(value.addresses)
      .sort(([, left], [, right]) => right.lastFailedAt - left.lastFailedAt)
      .slice(0, 1000);
    this.database.setSetting("auth_login_security", {
      account: value.account,
      addresses: Object.fromEntries(entries),
    });
  }

  loginGuard(address) {
    const now = Date.now();
    const security = this.readLoginSecurity();
    const addressEntry = security.addresses[address] || emptyFailureEntry();
    const entries = [security.account, addressEntry].map((entry) => (
      entry.blockedUntil <= now && entry.lastFailedAt && now - entry.lastFailedAt > LOGIN_WINDOW_MS
        ? emptyFailureEntry()
        : entry
    ));
    const blockedUntil = Math.max(...entries.map((entry) => entry.blockedUntil));
    if (blockedUntil <= now) return { allowed: true, retryAfterSeconds: 0 };
    return {
      allowed: false,
      retryAfterSeconds: Math.max(1, Math.ceil((blockedUntil - now) / 1000)),
    };
  }

  recordLoginFailure(address) {
    const now = Date.now();
    const security = this.readLoginSecurity();
    const addressEntry = security.addresses[address] || emptyFailureEntry();
    for (const entry of [security.account, addressEntry]) {
      if (entry.lastFailedAt && now - entry.lastFailedAt > LOGIN_WINDOW_MS) {
        Object.assign(entry, emptyFailureEntry());
      }
      if (!entry.firstFailedAt) entry.firstFailedAt = now;
      entry.count += 1;
      entry.lastFailedAt = now;
      const level = LOCKOUT_LEVELS.find((item) => entry.count >= item.failures);
      entry.blockedUntil = level ? Math.max(entry.blockedUntil, now + level.durationMs) : 0;
    }
    security.addresses[address] = addressEntry;
    this.writeLoginSecurity(security);
    return this.loginGuard(address);
  }

  clearLoginFailures(address) {
    const security = this.readLoginSecurity();
    delete security.addresses[address];
    security.account = emptyFailureEntry();
    this.writeLoginSecurity(security);
  }

  checkRateLimit(address) {
    return this.loginGuard(address).allowed;
  }

  clearRateLimit(address) {
    this.clearLoginFailures(address);
  }

  twoFactorRecord() {
    const record = this.database.getSetting("auth_2fa");
    return record && typeof record === "object" ? record : {};
  }

  decryptTwoFactorSecret(ciphertext) {
    if (!ciphertext) throw authError("2FA 尚未完成配置", "TWO_FACTOR_NOT_CONFIGURED", 400);
    try {
      return this.secretBox.decrypt(ciphertext);
    } catch {
      throw authError("2FA 密钥无法解密，请恢复原来的主密钥", "TWO_FACTOR_SECRET_INVALID", 500);
    }
  }

  twoFactorStatus() {
    const record = this.twoFactorRecord();
    return {
      enabled: record.enabled === true,
      pending: Boolean(record.pendingSecretCipher),
    };
  }

  isTwoFactorEnabled() {
    return this.twoFactorStatus().enabled;
  }

  setupTwoFactor() {
    if (this.isTwoFactorEnabled()) throw authError("2FA 已经启用", "TWO_FACTOR_ALREADY_ENABLED", 409);
    const secret = encodeBase32(crypto.randomBytes(20));
    this.database.setSetting("auth_2fa", {
      enabled: false,
      pendingSecretCipher: this.secretBox.encrypt(secret),
      secretCipher: "",
    });
    const label = encodeURIComponent("SubMonitor:admin");
    const issuer = encodeURIComponent("SubMonitor");
    return {
      ...this.twoFactorStatus(),
      secret,
      otpauthUri: `otpauth://totp/${label}?secret=${secret}&issuer=${issuer}&algorithm=SHA1&digits=6&period=30`,
    };
  }

  enableTwoFactor(code) {
    const record = this.twoFactorRecord();
    const secret = this.decryptTwoFactorSecret(record.pendingSecretCipher);
    if (!verifyTotpCode(secret, code)) throw authError("身份验证器验证码无效", "TWO_FACTOR_INVALID", 400);
    this.database.setSetting("auth_2fa", {
      enabled: true,
      pendingSecretCipher: "",
      secretCipher: record.pendingSecretCipher,
      enabledAt: new Date().toISOString(),
    });
    return this.twoFactorStatus();
  }

  verifyTwoFactor(code) {
    if (!this.isTwoFactorEnabled()) return true;
    const secret = this.decryptTwoFactorSecret(this.twoFactorRecord().secretCipher);
    return verifyTotpCode(secret, code);
  }

  disableTwoFactor(password, code) {
    if (!this.verifyPassword(password)) throw authError("管理员密码不正确", "PASSWORD_INVALID", 401);
    if (!this.verifyTwoFactor(code)) throw authError("身份验证器验证码无效", "TWO_FACTOR_INVALID", 401);
    this.database.setSetting("auth_2fa", {
      enabled: false,
      pendingSecretCipher: "",
      secretCipher: "",
    });
    return this.twoFactorStatus();
  }
}

export function isSameOrigin(request) {
  const origin = request.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === request.headers.host;
  } catch {
    return false;
  }
}
