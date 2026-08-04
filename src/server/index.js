import http from "node:http";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { AuthService, isSameOrigin } from "./auth.js";
import { ConfigStore } from "./config-store.js";
import { AppDatabase } from "./database.js";
import { readJson, sendData, sendError, serveStatic, setSecurityHeaders } from "./http-utils.js";
import { MonitorEngine, extractSnapshots } from "./monitor-engine.js";
import { MonitorScheduler } from "./scheduler.js";
import { createSecretBox } from "./secrets.js";
import { EventBroker } from "./sse.js";
import { Sub2ApiClient } from "./sub2api-client.js";

const serverDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(serverDirectory, "../..");
const port = Number.parseInt(process.env.SUBMONITOR_PORT || "8787", 10);
const host = process.env.SUBMONITOR_HOST || "0.0.0.0";
const dataDirectory = path.resolve(process.env.SUBMONITOR_DATA_DIR || path.join(projectRoot, "data"));
const masterKey = process.env.SUBMONITOR_MASTER_KEY || "";
const adminPassword = process.env.SUBMONITOR_ADMIN_PASSWORD || "";
const secureCookie = /^(1|true|yes|on)$/i.test(process.env.SUBMONITOR_COOKIE_SECURE || "false");

if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("SUBMONITOR_PORT is invalid");

const database = new AppDatabase(path.join(dataDirectory, "submonitor.sqlite"));
const secretBox = createSecretBox(masterKey);
const configStore = new ConfigStore(database, secretBox);
const broker = new EventBroker();
const auth = new AuthService({
  password: adminPassword,
  signingSecret: masterKey,
  secureCookie,
  sessionHours: Number.parseInt(process.env.SUBMONITOR_SESSION_HOURS || "24", 10),
});
const engine = new MonitorEngine({
  database,
  configStore,
  emit: (type, data) => broker.emit(type, data),
});
const scheduler = new MonitorScheduler({
  engine,
  configStore,
  emit: (type, data) => broker.emit(type, data),
});

function dashboard() {
  return {
    config: configStore.getPublic(),
    runtime: scheduler.snapshot(),
    snapshots: database.listSnapshots(240),
    events: database.listEventPayloads(40),
    audit: database.listAudit(80),
  };
}

async function apiRoute(request, response, url) {
  if (request.method === "GET" && url.pathname === "/api/health") {
    return sendData(response, { status: "ok", time: new Date().toISOString() });
  }
  if (request.method === "GET" && url.pathname === "/api/auth/session") {
    return sendData(response, { authenticated: auth.isAuthenticated(request) });
  }
  if (request.method === "POST" && url.pathname === "/api/auth/login") {
    if (!isSameOrigin(request)) return sendError(response, 403, "Cross-origin request rejected", "ORIGIN_REJECTED");
    const address = request.socket.remoteAddress || "unknown";
    if (!auth.checkRateLimit(address)) return sendError(response, 429, "Too many login attempts", "RATE_LIMITED");
    const body = await readJson(request);
    if (!auth.verifyPassword(body.password || "")) {
      database.addAudit("warn", "auth.failed", "Administrator login failed", { address });
      return sendError(response, 401, "Password is incorrect", "AUTH_FAILED");
    }
    auth.clearRateLimit(address);
    response.setHeader("Set-Cookie", auth.sessionCookie(auth.createToken()));
    database.addAudit("info", "auth.login", "Administrator signed in", { address });
    return sendData(response, { authenticated: true });
  }

  if (!auth.isAuthenticated(request)) return sendError(response, 401, "Authentication required", "UNAUTHORIZED");
  if (["POST", "PUT", "PATCH", "DELETE"].includes(request.method) && !isSameOrigin(request)) {
    return sendError(response, 403, "Cross-origin request rejected", "ORIGIN_REJECTED");
  }
  if (request.method === "POST" && url.pathname === "/api/auth/logout") {
    response.setHeader("Set-Cookie", auth.clearCookie());
    return sendData(response, { authenticated: false });
  }
  if (request.method === "GET" && url.pathname === "/api/dashboard") {
    return sendData(response, dashboard());
  }
  if (request.method === "GET" && url.pathname === "/api/config") {
    return sendData(response, configStore.getPublic());
  }
  if (request.method === "PUT" && url.pathname === "/api/config") {
    const body = await readJson(request);
    const result = configStore.update(body);
    database.addAudit("info", "config.updated", "Monitor configuration updated", {
      baselineChanged: result.baselineChanged,
      cancelledEvents: result.cancelledEvents,
      enabled: result.config.enabled,
      dryRun: result.config.dryRun,
    });
    scheduler.reschedule(true);
    broker.emit("config", result.config);
    return sendData(response, result);
  }
  if (request.method === "POST" && url.pathname === "/api/config/test") {
    const config = configStore.getPrivate();
    if (!configStore.isRunnable(config)) throw new Error("Save a complete connection configuration first");
    const quota = await new Sub2ApiClient(config).queryCodexQuota(config.sourceAccountId);
    const snapshots = extractSnapshots(quota);
    database.addAudit("info", "config.connection_test", "Sub2API connection test succeeded", {
      sourceAccountId: config.sourceAccountId,
    });
    return sendData(response, { snapshots });
  }
  if (request.method === "POST" && url.pathname === "/api/monitor/check") {
    const result = await scheduler.runNow("manual");
    return sendData(response, result);
  }
  if (request.method === "GET" && url.pathname === "/api/events") {
    const limit = Math.min(200, Math.max(1, Number.parseInt(url.searchParams.get("limit") || "100", 10)));
    return sendData(response, database.listEventPayloads(limit));
  }
  if (request.method === "GET" && url.pathname.startsWith("/api/events/")) {
    const id = decodeURIComponent(url.pathname.slice("/api/events/".length));
    const event = database.getEvent(id);
    return event ? sendData(response, event) : sendError(response, 404, "Event not found", "NOT_FOUND");
  }
  if (request.method === "GET" && url.pathname === "/api/audit") {
    const limit = Math.min(500, Math.max(1, Number.parseInt(url.searchParams.get("limit") || "200", 10)));
    return sendData(response, database.listAudit(limit));
  }
  if (request.method === "GET" && url.pathname === "/api/stream") {
    broker.connect(request, response);
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
  scheduler.start();
});

function shutdown() {
  scheduler.stop();
  broker.close();
  server.close(() => {
    database.close();
    process.exit(0);
  });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
