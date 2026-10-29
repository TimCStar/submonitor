/** CPR admin API client. Envelope success is code === 200 (not Sub2API's 0). */

function buildApiUrl(baseUrl, apiPath) {
  const suffix = apiPath.startsWith("/") ? apiPath : `/${apiPath}`;
  return `${baseUrl.replace(/\/+$/, "")}${suffix}`;
}

export function parseResetAtDisplay(display) {
  if (display == null) return 0;
  const text = String(display).trim();
  if (!text || text === "—" || text === "-" || text === "–") return 0;
  const match = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/.exec(text);
  if (!match) return 0;
  const ms = Date.UTC(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
    Number(match[4]),
    Number(match[5]),
    Number(match[6]),
  );
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : 0;
}

export function parseRefreshedAt(value) {
  if (!value) return Math.floor(Date.now() / 1000);
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : Math.floor(Date.now() / 1000);
}

function toRateLimitWindow(window) {
  if (!window || typeof window !== "object") return undefined;
  const usedPercent = Number(window.usedPercent);
  if (!Number.isFinite(usedPercent)) return undefined;
  return {
    used_percent: usedPercent,
    reset_at: parseResetAtDisplay(window.resetAtDisplay),
    limit_window_seconds: Number(window.windowSeconds) || 0,
  };
}

function pickWindows(windows) {
  const list = Array.isArray(windows) ? [...windows] : [];
  list.sort((a, b) => (Number(a?.windowSeconds) || 0) - (Number(b?.windowSeconds) || 0));
  let primary;
  let secondary;
  for (const window of list) {
    const role = String(window?.role || "").toLowerCase();
    if (role === "primary" && !primary) primary = window;
    else if (role === "secondary" && !secondary) secondary = window;
  }
  if (!primary) primary = list[0];
  if (!secondary) secondary = list.find((item) => item !== primary) || list[1];
  return { primary, secondary };
}

/** Normalize CPR AccountView / AccountQuotaView into the rate_limit shape extractSnapshots expects. */
export function normalizeCprQuota(payload) {
  const account = payload?.account && typeof payload.account === "object" ? payload.account : payload;
  const quota = account?.quota && typeof account.quota === "object" ? account.quota : account;
  if (!quota || typeof quota !== "object") {
    throw new Error("CPR quota response does not contain quota data");
  }
  const { primary, secondary } = pickWindows(quota.windows);
  const limitReached = quota.limitReached === true;
  const rateLimited = Boolean(quota.rateLimitedUntil);
  return {
    rate_limit: {
      allowed: !limitReached && !rateLimited,
      limit_reached: limitReached,
      primary_window: toRateLimitWindow(primary),
      secondary_window: toRateLimitWindow(secondary),
    },
    fetched_at: parseRefreshedAt(quota.refreshedAt || account?.refreshedAt),
  };
}

/** Map subscriptionResetWindows selection to CPR reset-budget period. */
export function clientKeyResetPeriod(windows) {
  const selected = [...new Set((windows || []).map(String))];
  if (selected.length === 1 && selected[0] === "daily") return "daily";
  if (selected.length === 1 && selected[0] === "weekly") return "weekly";
  return "all";
}

export class CprClient {
  constructor(config) {
    this.config = config;
    this.provider = "cpr";
  }

  async request(method, apiPath, body) {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      this.config.requestTimeoutSeconds * 1000,
    );
    const headers = { Accept: "application/json" };
    if (this.config.authType === "jwt") headers.Authorization = `Bearer ${this.config.authSecret}`;
    else headers["x-api-key"] = this.config.authSecret;
    const options = { method, headers, signal: controller.signal };
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      options.body = JSON.stringify(body);
    }

    try {
      const response = await fetch(buildApiUrl(this.config.baseUrl, apiPath), options);
      const responseText = await response.text();
      let envelope;
      try {
        envelope = responseText ? JSON.parse(responseText) : {};
      } catch {
        throw new Error(`${method} ${apiPath} returned non-JSON HTTP ${response.status}`);
      }
      if (!response.ok) {
        const error = new Error(
          `${method} ${apiPath} failed with HTTP ${response.status}: ${envelope.message || responseText}`,
        );
        error.status = response.status;
        error.apiMessage = envelope.message || "";
        throw error;
      }
      if (Object.hasOwn(envelope, "code") && Number(envelope.code) !== 200) {
        throw new Error(`${method} ${apiPath} failed: ${envelope.message || envelope.code}`);
      }
      return Object.hasOwn(envelope, "data") ? envelope.data : envelope;
    } catch (error) {
      if (error?.name === "AbortError") throw new Error(`${method} ${apiPath} timed out`);
      if (error instanceof TypeError && /fetch failed/i.test(error.message)) {
        const cause = error.cause;
        const reason = [cause?.code, cause?.message].filter(Boolean).join(": ") || error.message;
        throw new Error(`Cannot reach CPR at ${this.config.baseUrl}: ${reason}`);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  async queryCodexQuota(accountId) {
    const id = String(accountId);
    try {
      const data = await this.request("POST", "/api/admin/accounts/quota/refresh", { accountId: id });
      return normalizeCprQuota(data);
    } catch (error) {
      // Fall back to the last stored snapshot when refresh is unavailable (credential / capability).
      if (error?.status === 400 || error?.status === 403 || error?.status === 404 || error?.status === 409) {
        const data = await this.request("GET", `/api/admin/accounts/quota?accountId=${encodeURIComponent(id)}`);
        return normalizeCprQuota(data);
      }
      throw error;
    }
  }

  getAccount(accountId) {
    return this.request("GET", `/api/admin/accounts/detail?accountId=${encodeURIComponent(String(accountId))}`);
  }

  async getConcurrency(accountId) {
    const account = await this.getAccount(accountId);
    const view = account?.account || account;
    const current = Number(view?.capacity?.usedSlots);
    const max = Number(view?.capacity?.totalSlots);
    if (!Number.isFinite(current) || !Number.isFinite(max)) return null;
    return { current, max, updatedAt: new Date().toISOString() };
  }

  recoverSourceAccount(accountId) {
    return this.request("POST", "/api/admin/accounts/recover", { accountId: String(accountId) });
  }

  /** CPR has no separate target quota reset; recover clears local exhaustion facts. */
  resetTargetAccount(accountId) {
    return this.recoverSourceAccount(accountId);
  }

  resetClientKeyBudget(clientKeyId, period) {
    return this.request("POST", "/api/admin/client-keys/reset-budget", {
      id: String(clientKeyId),
      period,
    });
  }

  resetSubscription() {
    throw new Error("CPR does not support Sub2API subscription reset; configure clientKeyIds instead");
  }
}
