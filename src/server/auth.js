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

export class AuthService {
  constructor({ password, signingSecret, secureCookie, sessionHours = 24 }) {
    if (!password || password.length < 12) {
      throw new Error("SUBMONITOR_ADMIN_PASSWORD must contain at least 12 characters");
    }
    this.password = password;
    this.signingKey = crypto.createHash("sha256").update(signingSecret).digest();
    this.secureCookie = secureCookie;
    this.sessionSeconds = sessionHours * 60 * 60;
    this.cookieName = "submonitor_session";
    this.attempts = new Map();
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

  checkRateLimit(address) {
    const now = Date.now();
    const entry = this.attempts.get(address) || { count: 0, startedAt: now };
    if (now - entry.startedAt > 15 * 60 * 1000) {
      entry.count = 0;
      entry.startedAt = now;
    }
    if (entry.count >= 10) return false;
    entry.count += 1;
    this.attempts.set(address, entry);
    return true;
  }

  clearRateLimit(address) {
    this.attempts.delete(address);
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
