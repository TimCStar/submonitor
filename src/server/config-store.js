import crypto from "node:crypto";
import { DEFAULT_MONITOR_CONFIG } from "./database.js";

const MONITOR_WINDOWS = new Set(["5h", "7d", "primary", "secondary"]);
const RESET_WINDOWS = new Set(["daily", "weekly", "monthly"]);

function positiveInteger(value, name, minimum = 1, maximum = Number.MAX_SAFE_INTEGER) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < minimum || number > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return number;
}

function numberInRange(value, name, minimum, maximum) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < minimum || number > maximum) {
    throw new Error(`${name} must be between ${minimum} and ${maximum}`);
  }
  return number;
}

function ids(value, name) {
  if (!Array.isArray(value)) throw new Error(`${name} must be an array`);
  return [...new Set(value.map((item) => positiveInteger(item, name)))];
}

function choices(value, name, allowed) {
  if (!Array.isArray(value) || value.length === 0) throw new Error(`${name} must not be empty`);
  const result = [...new Set(value.map(String))];
  const invalid = result.filter((item) => !allowed.has(item));
  if (invalid.length) throw new Error(`${name} contains unsupported values: ${invalid.join(", ")}`);
  return result;
}

function normalizeBaseUrl(value) {
  const baseUrl = String(value || "").trim().replace(/\/+$/, "");
  if (!baseUrl) return "";
  const parsed = new URL(baseUrl);
  if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("baseUrl must use HTTP or HTTPS");
  if (parsed.username || parsed.password) throw new Error("baseUrl must not contain embedded credentials");
  return baseUrl;
}

function normalizeName(value) {
  const name = String(value || "").trim();
  if (!name || name.length > 80) throw new Error("name must contain between 1 and 80 characters");
  return name;
}

export class ConfigStore {
  constructor(database, secretBox) {
    this.database = database;
    this.secretBox = secretBox;
  }

  toPublic(config) {
    if (!config) return null;
    const { authSecretCipher, ...safe } = config;
    let authSecretInvalid = false;
    if (authSecretCipher) {
      try {
        this.secretBox.decrypt(authSecretCipher);
      } catch {
        authSecretInvalid = true;
      }
    }
    return {
      ...safe,
      authSecretConfigured: Boolean(authSecretCipher),
      authSecretInvalid,
    };
  }

  listPublic() {
    return this.database.listMonitors().map((config) => this.toPublic(config));
  }

  getPublic(id) {
    const config = this.database.getMonitor(id);
    if (!config) throw new Error("Monitor not found");
    return this.toPublic(config);
  }

  getPrivate(id) {
    const config = this.database.getMonitor(id);
    if (!config) throw new Error("Monitor not found");
    return {
      ...config,
      authSecret: config.authSecretCipher ? this.secretBox.decrypt(config.authSecretCipher) : "",
    };
  }

  normalize(input, current) {
    const sourceAccountId = input.sourceAccountId
      ? positiveInteger(input.sourceAccountId, "sourceAccountId")
      : null;
    const targetAccountIds = ids(input.targetAccountIds || [], "targetAccountIds");
    if (sourceAccountId && targetAccountIds.includes(sourceAccountId)) {
      throw new Error("targetAccountIds must not contain sourceAccountId");
    }
    const groupMode = ["none", "auto", "explicit"].includes(input.subscriptionGroupMode)
      ? input.subscriptionGroupMode
      : "none";
    const next = {
      ...current,
      name: normalizeName(input.name ?? current.name),
      baseUrl: normalizeBaseUrl(input.baseUrl),
      authType: input.authType === "jwt" ? "jwt" : "apiKey",
      sourceAccountId,
      targetAccountIds,
      monitorWindows: choices(input.monitorWindows || ["7d"], "monitorWindows", MONITOR_WINDOWS),
      pollIntervalSeconds: positiveInteger(input.pollIntervalSeconds, "pollIntervalSeconds", 15, 86400),
      requestTimeoutSeconds: positiveInteger(input.requestTimeoutSeconds, "requestTimeoutSeconds", 5, 300),
      confirmationsRequired: positiveInteger(input.confirmationsRequired, "confirmationsRequired", 1, 10),
      resetGraceSeconds: positiveInteger(input.resetGraceSeconds, "resetGraceSeconds", 1, 3600),
      resetMaxUsedPercent: numberInRange(input.resetMaxUsedPercent, "resetMaxUsedPercent", 0, 100),
      subscriptionGroupMode: groupMode,
      subscriptionGroupIds: groupMode === "explicit" ? ids(input.subscriptionGroupIds || [], "subscriptionGroupIds") : [],
      subscriptionResetWindows: choices(
        input.subscriptionResetWindows || ["weekly"],
        "subscriptionResetWindows",
        RESET_WINDOWS,
      ),
      publicSubscriberPreviewEnabled: Boolean(input.publicSubscriberPreviewEnabled ?? current.publicSubscriberPreviewEnabled ?? true),
      dryRun: Boolean(input.dryRun),
      enabled: Boolean(input.enabled),
    };
    if (Object.hasOwn(input, "authSecret") && input.authSecret) {
      next.authSecretCipher = this.secretBox.encrypt(String(input.authSecret));
    }
    if (input.clearAuthSecret === true) next.authSecretCipher = "";
    if (next.authSecretCipher) this.secretBox.decrypt(next.authSecretCipher);
    if (next.enabled && (!next.baseUrl || !next.sourceAccountId || !next.authSecretCipher)) {
      throw new Error("baseUrl, sourceAccountId and an administrator credential are required before enabling monitoring");
    }
    return next;
  }

  create(input = {}) {
    const id = crypto.randomUUID();
    const defaults = {
      id,
      name: input.name || `Codex monitor ${this.database.listMonitors().length + 1}`,
      ...structuredClone(DEFAULT_MONITOR_CONFIG),
    };
    const next = this.normalize({ ...defaults, ...input }, defaults);
    this.database.createMonitor(next);
    this.database.clearMonitorState(id, next.sourceAccountId);
    return this.getPublic(id);
  }

  update(id, input) {
    const current = this.database.getMonitor(id);
    if (!current) throw new Error("Monitor not found");
    const next = this.normalize(input, current);
    const baselineChanged =
      current.baseUrl !== next.baseUrl ||
      current.sourceAccountId !== next.sourceAccountId ||
      JSON.stringify(current.monitorWindows) !== JSON.stringify(next.monitorWindows);
    this.database.saveMonitor(id, next);
    let cancelledEvents = 0;
    if (baselineChanged) {
      this.database.clearMonitorState(id, next.sourceAccountId);
      cancelledEvents = this.database.cancelPendingEvents(id, "Monitor identity changed");
    }
    return { monitor: this.getPublic(id), baselineChanged, cancelledEvents };
  }

  delete(id) {
    if (!this.database.getMonitor(id)) throw new Error("Monitor not found");
    return this.database.deleteMonitor(id);
  }

  isRunnable(config) {
    return Boolean(config?.baseUrl && config?.sourceAccountId && config?.authSecret);
  }

  forMonitor(id) {
    return {
      getPublic: () => this.getPublic(id),
      getPrivate: () => this.getPrivate(id),
      isRunnable: (config) => this.isRunnable(config),
    };
  }
}
