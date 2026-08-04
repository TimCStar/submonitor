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
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error("baseUrl must use HTTP or HTTPS");
  if (parsed.username || parsed.password) throw new Error("baseUrl must not contain embedded credentials");
  return baseUrl;
}

export class ConfigStore {
  constructor(database, secretBox) {
    this.database = database;
    this.secretBox = secretBox;
  }

  getPublic() {
    const config = this.database.getConfig();
    const { authSecretCipher, ...safe } = config;
    return { ...safe, authSecretConfigured: Boolean(authSecretCipher) };
  }

  getPrivate() {
    const config = this.database.getConfig();
    return {
      ...config,
      authSecret: config.authSecretCipher ? this.secretBox.decrypt(config.authSecretCipher) : "",
    };
  }

  update(input) {
    const current = this.database.getConfig();
    const authType = input.authType === "jwt" ? "jwt" : "apiKey";
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
      baseUrl: normalizeBaseUrl(input.baseUrl),
      authType,
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
      dryRun: Boolean(input.dryRun),
      enabled: Boolean(input.enabled),
    };
    if (Object.prototype.hasOwnProperty.call(input, "authSecret") && input.authSecret) {
      next.authSecretCipher = this.secretBox.encrypt(String(input.authSecret));
    }
    if (input.clearAuthSecret === true) next.authSecretCipher = "";
    if (next.enabled && (!next.baseUrl || !next.sourceAccountId || !next.authSecretCipher)) {
      throw new Error("baseUrl, sourceAccountId and an administrator credential are required before enabling monitoring");
    }

    const baselineChanged =
      current.baseUrl !== next.baseUrl ||
      current.sourceAccountId !== next.sourceAccountId ||
      JSON.stringify(current.monitorWindows) !== JSON.stringify(next.monitorWindows);
    this.database.saveConfig(next);
    let cancelledEvents = 0;
    if (baselineChanged) {
      this.database.clearMonitorState(next.sourceAccountId);
      cancelledEvents = this.database.cancelPendingEvents("Monitor identity changed");
    }
    return { config: this.getPublic(), baselineChanged, cancelledEvents };
  }

  isRunnable(config = this.getPrivate()) {
    return Boolean(config.baseUrl && config.sourceAccountId && config.authSecret);
  }
}
