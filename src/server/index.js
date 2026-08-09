import http from "node:http";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { AuthService, isSameOrigin } from "./auth.js";
import { ConfigStore } from "./config-store.js";
import { AppDatabase } from "./database.js";
import { readJson, sendData, sendError, serveStatic, setSecurityHeaders } from "./http-utils.js";
import { extractSnapshots } from "./monitor-engine.js";
import { SchedulerManager } from "./scheduler.js";
import { createSecretBox } from "./secrets.js";
import { EventBroker } from "./sse.js";
import { Sub2ApiClient } from "./sub2api-client.js";
import { buildSubscriberPreview, toPublicSubscriberPreview } from "./subscriber-preview.js";

const serverDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(serverDirectory, "../..");
const port = Number.parseInt(process.env.SUBMONITOR_PORT || "8787", 10);
const host = process.env.SUBMONITOR_HOST || "0.0.0.0";
const dataDirectory = path.resolve(process.env.SUBMONITOR_DATA_DIR || path.join(projectRoot, "data"));
const masterKey = process.env.SUBMONITOR_MASTER_KEY || "";
const adminPassword = process.env.SUBMONITOR_ADMIN_PASSWORD || "";
const secureCookie = /^(1|true|yes|on)$/i.test(process.env.SUBMONITOR_COOKIE_SECURE || "false");
const sessionHours = Number.parseInt(process.env.SUBMONITOR_SESSION_HOURS || "24", 10);

if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("SUBMONITOR_PORT is invalid");
if (!Number.isInteger(sessionHours) || sessionHours < 1 || sessionHours > 720) {
  throw new Error("SUBMONITOR_SESSION_HOURS must be between 1 and 720");
}

const database = new AppDatabase(path.join(dataDirectory, "submonitor.sqlite"));
const secretBox = createSecretBox(masterKey);
const configStore = new ConfigStore(database, secretBox);
const publicBroker = new EventBroker();
const adminBroker = new EventBroker();
const auth = new AuthService({
  password: adminPassword,
  signingSecret: masterKey,
  secureCookie,
  sessionHours,
  database,
  secretBox,
});

function emitUpdate(type, payload) {
  adminBroker.emit(type, payload);
  publicBroker.emit("refresh", {
    type,
    monitorId: payload?.monitorId || null,
    time: new Date().toISOString(),
  });
}

const schedulers = new SchedulerManager({ database, configStore, emit: emitUpdate });
const subscriberPreviewCache = new Map();
const subscriberPreviewTtlMs = 5 * 60 * 1000;

async function subscriberPreview(monitorId, force = false) {
  const now = Date.now();
  const cached = subscriberPreviewCache.get(monitorId);
  if (!force && cached?.data && cached.expiresAt > now) return cached.data;
  if (cached?.promise) return cached.promise;
  const promise = (async () => {
    const config = configStore.getPrivate(monitorId);
    if (config.subscriptionGroupMode !== "none" && !configStore.isRunnable(config)) {
      throw new Error("Save a complete connection configuration first");
    }
    const data = await buildSubscriberPreview(new Sub2ApiClient(config), config);
    return { ...data, generatedAt: new Date().toISOString() };
  })();
  subscriberPreviewCache.set(monitorId, { ...cached, promise });
  try {
    const data = await promise;
    subscriberPreviewCache.set(monitorId, { data, expiresAt: Date.now() + subscriberPreviewTtlMs });
    return data;
  } catch (error) {
    subscriberPreviewCache.delete(monitorId);
    throw error;
  }
}

function actionSummary(event) {
  const actions = [
    event.actions?.sourceRecovery,
    ...Object.values(event.actions?.targetAccounts || {}),
    ...Object.values(event.actions?.subscriptions || {}),
  ].filter(Boolean);
  return {
    total: actions.length,
    completed: actions.filter((action) => ["success", "preview", "skipped"].includes(action.status)).length,
    failed: actions.filter((action) => action.status === "failed").length,
    running: actions.filter((action) => ["pending", "in_progress"].includes(action.status)).length,
  };
}

function publicEvent(event) {
  return {
    id: event.id,
    monitorId: event.monitorId,
    monitorName: event.monitorName,
    sourceAccountId: event.sourceAccountId,
    window: event.window,
    baseline: {
      usedPercent: event.baseline?.usedPercent,
      resetAt: event.baseline?.resetAt,
    },
    resetSnapshot: {
      usedPercent: event.resetSnapshot?.usedPercent,
      resetAt: event.resetSnapshot?.resetAt,
    },
    status: event.status,
    dryRun: event.dryRun,
    confirmedAt: event.confirmedAt,
    completedAt: event.completedAt || null,
    actionSummary: actionSummary(event),
  };
}

function publicRuntime(runtime) {
  return {
    status: runtime.status,
    running: runtime.running,
    startedAt: runtime.startedAt,
    lastPollAt: runtime.lastPollAt,
    lastSuccessAt: runtime.lastSuccessAt,
    nextPollAt: runtime.nextPollAt,
    hasError: Boolean(runtime.lastError),
  };
}

function candidateSummary(monitorId) {
  const state = database.getMonitorState(monitorId);
  return Object.fromEntries(
    Object.entries(state.windows || {}).map(([selector, value]) => [selector, value.pending ? {
      confirmations: value.pending.confirmations,
      firstConfirmedAt: value.pending.firstConfirmedAt,
      lastConfirmedAt: value.pending.lastConfirmedAt || null,
    } : null]),
  );
}

function publicDashboard() {
  const monitors = configStore.listPublic({ enabledOnly: true }).map((monitor) => ({
    id: monitor.id,
    name: monitor.name,
    sourceAccountId: monitor.sourceAccountId,
    monitorWindows: monitor.monitorWindows,
    pollIntervalSeconds: monitor.pollIntervalSeconds,
    confirmationsRequired: monitor.confirmationsRequired,
    dryRun: monitor.dryRun,
    enabled: monitor.enabled,
    targetAccountCount: monitor.targetAccountIds.length,
    subscriptionGroupMode: monitor.subscriptionGroupMode,
    publicSubscriberPreviewEnabled: monitor.publicSubscriberPreviewEnabled !== false,
    runtime: publicRuntime(schedulers.snapshot(monitor.id)),
    candidates: candidateSummary(monitor.id),
    snapshots: database.listSnapshots(monitor.id, 240),
  }));
  const monitorIds = new Set(monitors.map((monitor) => monitor.id));
  return {
    monitors,
    events: database.listEventPayloads(100).filter((event) => monitorIds.has(event.monitorId)).map(publicEvent),
    generatedAt: new Date().toISOString(),
  };
}

function adminDashboard() {
  return {
    monitors: configStore.listPublic().map((monitor) => ({
      ...monitor,
      runtime: schedulers.snapshot(monitor.id),
      snapshots: database.listSnapshots(monitor.id, 40),
    })),
    events: database.listEventPayloads(100),
    audit: database.listAudit(200),
  };
}

function monitorRoute(pathname) {
  const match = pathname.match(/^\/api\/monitors\/([^/]+)(?:\/(test|check|subscribers))?$/);
  return match ? { id: decodeURIComponent(match[1]), action: match[2] || null } : null;
}

async function apiRoute(request, response, url) {
  if (request.method === "GET" && url.pathname === "/api/health") {
    return sendData(response, { status: "ok", time: new Date().toISOString() });
  }
  if (request.method === "GET" && url.pathname === "/api/public/dashboard") {
    return sendData(response, publicDashboard());
  }
  if (request.method === "GET" && url.pathname === "/api/public/events") {
    const limit = Math.min(200, Math.max(1, Number.parseInt(url.searchParams.get("limit") || "100", 10)));
    const enabledMonitorIds = new Set(configStore.listPublic({ enabledOnly: true }).map((monitor) => monitor.id));
    return sendData(response, database.listEventPayloads(limit).filter((event) => enabledMonitorIds.has(event.monitorId)).map(publicEvent));
  }
  if (request.method === "GET" && url.pathname === "/api/public/stream") {
    publicBroker.connect(request, response);
    return;
  }
  const publicSubscriberMatch = url.pathname.match(/^\/api\/public\/monitors\/([^/]+)\/subscribers$/);
  if (request.method === "GET" && publicSubscriberMatch) {
    const monitorId = decodeURIComponent(publicSubscriberMatch[1]);
    const monitor = configStore.listPublic({ enabledOnly: true }).find((item) => item.id === monitorId);
    if (!monitor) return sendError(response, 404, "Monitor not found", "NOT_FOUND");
    if (monitor.publicSubscriberPreviewEnabled === false) {
      return sendData(response, {
        enabled: false,
        resetWindows: [],
        groupCount: 0,
        total: 0,
        truncated: false,
        generatedAt: new Date().toISOString(),
        subscribers: [],
      });
    }
    return sendData(response, toPublicSubscriberPreview(await subscriberPreview(monitorId)));
  }
  if (request.method === "GET" && url.pathname === "/api/auth/session") {
    return sendData(response, { authenticated: auth.isAuthenticated(request) });
  }
  if (request.method === "POST" && url.pathname === "/api/auth/login") {
    if (!isSameOrigin(request)) return sendError(response, 403, "Cross-origin request rejected", "ORIGIN_REJECTED");
    const address = request.socket.remoteAddress || "unknown";
    const guard = auth.loginGuard(address);
    if (!guard.allowed) {
      response.setHeader("Retry-After", String(guard.retryAfterSeconds));
      return sendError(response, 429, `登录暂时被风控拦截，请在约 ${guard.retryAfterSeconds} 秒后重试`, "RATE_LIMITED");
    }
    const body = await readJson(request);
    if (!auth.verifyPassword(body.password || "")) {
      auth.recordLoginFailure(address);
      database.addAudit("warn", "auth.failed", "Administrator login failed", { address });
      return sendError(response, 401, "Password is incorrect", "AUTH_FAILED");
    }
    if (auth.isTwoFactorEnabled() && !auth.verifyTwoFactor(body.totp)) {
      auth.recordLoginFailure(address);
      database.addAudit("warn", "auth.2fa.failed", "Administrator two-factor verification failed", { address });
      return sendError(
        response,
        401,
        body.totp ? "身份验证器验证码无效" : "请输入身份验证器验证码",
        body.totp ? "TWO_FACTOR_INVALID" : "TWO_FACTOR_REQUIRED",
      );
    }
    auth.clearLoginFailures(address);
    response.setHeader("Set-Cookie", auth.sessionCookie(auth.createToken()));
    database.addAudit("info", "auth.login", "Administrator signed in", { address });
    return sendData(response, { authenticated: true });
  }

  if (!auth.isAuthenticated(request)) return sendError(response, 401, "Authentication required", "UNAUTHORIZED");
  if (["POST", "PUT", "PATCH", "DELETE"].includes(request.method) && !isSameOrigin(request)) {
    return sendError(response, 403, "Cross-origin request rejected", "ORIGIN_REJECTED");
  }
  if (request.method === "GET" && url.pathname === "/api/auth/2fa") {
    return sendData(response, auth.twoFactorStatus());
  }
  if (request.method === "POST" && url.pathname === "/api/auth/2fa/setup") {
    try {
      const result = auth.setupTwoFactor();
      database.addAudit("info", "auth.2fa.setup", "Two-factor setup secret generated");
      return sendData(response, result);
    } catch (error) {
      return sendError(response, error.status || 400, error.message, error.code);
    }
  }
  if (request.method === "POST" && url.pathname === "/api/auth/2fa/enable") {
    try {
      const body = await readJson(request);
      const result = auth.enableTwoFactor(body.code);
      database.addAudit("info", "auth.2fa.enabled", "Two-factor authentication enabled");
      return sendData(response, result);
    } catch (error) {
      return sendError(response, error.status || 400, error.message, error.code);
    }
  }
  if (request.method === "POST" && url.pathname === "/api/auth/2fa/disable") {
    try {
      const body = await readJson(request);
      const result = auth.disableTwoFactor(body.password, body.code);
      database.addAudit("warn", "auth.2fa.disabled", "Two-factor authentication disabled");
      return sendData(response, result);
    } catch (error) {
      return sendError(response, error.status || 400, error.message, error.code);
    }
  }
  if (request.method === "POST" && url.pathname === "/api/auth/logout") {
    response.setHeader("Set-Cookie", auth.clearCookie());
    return sendData(response, { authenticated: false });
  }
  if (request.method === "GET" && url.pathname === "/api/dashboard") {
    return sendData(response, adminDashboard());
  }
  if (request.method === "GET" && url.pathname === "/api/monitors") {
    return sendData(response, configStore.listPublic());
  }
  if (request.method === "POST" && url.pathname === "/api/monitors") {
    const monitor = configStore.create(await readJson(request));
    schedulers.configChanged(monitor.id);
    database.addAudit("info", "monitor.created", "Monitor created", { monitorId: monitor.id, name: monitor.name });
    emitUpdate("config", { monitorId: monitor.id, data: monitor });
    return sendData(response, monitor, 201);
  }

  const route = monitorRoute(url.pathname);
  if (route && request.method === "PUT" && !route.action) {
    const result = configStore.update(route.id, await readJson(request));
    subscriberPreviewCache.delete(route.id);
    schedulers.configChanged(route.id);
    database.addAudit("info", "monitor.updated", "Monitor configuration updated", {
      monitorId: route.id,
      baselineChanged: result.baselineChanged,
      cancelledEvents: result.cancelledEvents,
      enabled: result.monitor.enabled,
      dryRun: result.monitor.dryRun,
    });
    emitUpdate("config", { monitorId: route.id, data: result.monitor });
    return sendData(response, result);
  }
  if (route && request.method === "DELETE" && !route.action) {
    const monitor = configStore.getPublic(route.id);
    schedulers.remove(route.id);
    configStore.delete(route.id);
    subscriberPreviewCache.delete(route.id);
    database.addAudit("warn", "monitor.deleted", "Monitor deleted", { monitorId: route.id, name: monitor.name });
    emitUpdate("config", { monitorId: route.id, data: null });
    return sendData(response, { deleted: true });
  }
  if (route && request.method === "POST" && route.action === "test") {
    const config = configStore.getPrivate(route.id);
    if (!configStore.isRunnable(config)) throw new Error("Save a complete connection configuration first");
    const quota = await new Sub2ApiClient(config).queryCodexQuota(config.sourceAccountId);
    const snapshots = extractSnapshots(quota);
    database.addAudit("info", "monitor.connection_test", "Sub2API connection test succeeded", {
      monitorId: route.id,
      sourceAccountId: config.sourceAccountId,
    });
    return sendData(response, { snapshots });
  }
  if (route && request.method === "POST" && route.action === "check") {
    return sendData(response, await schedulers.runNow(route.id, "manual"));
  }
  if (route && request.method === "GET" && route.action === "subscribers") {
    return sendData(response, await subscriberPreview(route.id, url.searchParams.get("refresh") === "1"));
  }
  if (request.method === "GET" && url.pathname === "/api/events") {
    const limit = Math.min(200, Math.max(1, Number.parseInt(url.searchParams.get("limit") || "100", 10)));
    return sendData(response, database.listEventPayloads(limit));
  }
  if (request.method === "GET" && url.pathname.startsWith("/api/events/")) {
    const event = database.getEvent(decodeURIComponent(url.pathname.slice("/api/events/".length)));
    return event ? sendData(response, event) : sendError(response, 404, "Event not found", "NOT_FOUND");
  }
  if (request.method === "GET" && url.pathname === "/api/audit") {
    const limit = Math.min(500, Math.max(1, Number.parseInt(url.searchParams.get("limit") || "200", 10)));
    return sendData(response, database.listAudit(limit));
  }
  if (request.method === "GET" && url.pathname === "/api/stream") {
    adminBroker.connect(request, response);
    return;
  }
  return sendError(response, 404, "API endpoint not found", "NOT_FOUND");
}

const server = http.createServer(async (request, response) => {
  setSecurityHeaders(response);
  const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
  try {
    if (url.pathname.startsWith("/api/")) return await apiRoute(request, response, url);
    if (!["GET", "HEAD"].includes(request.method)) return sendError(response, 405, "Method not allowed", "METHOD_NOT_ALLOWED");
    const distDirectory = path.join(projectRoot, "dist");
    if (await serveStatic(response, distDirectory, url.pathname)) return;
    if (await serveStatic(response, distDirectory, "/index.html")) return;
    return sendError(response, 503, "Frontend has not been built", "FRONTEND_NOT_BUILT");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    database.addAudit("error", "http.error", message, { method: request.method, path: url.pathname });
    if (!response.headersSent) sendError(response, 400, message);
    else response.end();
  }
});

server.listen(port, host, () => {
  console.log(JSON.stringify({
    time: new Date().toISOString(),
    level: "info",
    message: "SubMonitor started",
    address: `http://${host}:${port}`,
  }));
  schedulers.start();
});

function shutdown() {
  schedulers.stop();
  publicBroker.close();
  adminBroker.close();
  server.close(() => {
    database.close();
    process.exit(0);
  });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
