import { readFile } from "node:fs/promises";
import path from "node:path";

const MIME_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
};

export function setSecurityHeaders(response) {
  response.setHeader("Content-Security-Policy", "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
  response.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
}

export function sendJson(response, status, data) {
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Cache-Control", "no-store");
  response.end(JSON.stringify(data));
}

export function sendData(response, data, status = 200) {
  sendJson(response, status, { ok: true, data });
}

export function sendError(response, status, message, code = "REQUEST_FAILED") {
  sendJson(response, status, { ok: false, error: { code, message } });
}

export async function readJson(request, maximumBytes = 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maximumBytes) throw new Error("Request body is too large");
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("Request body must be valid JSON");
  }
}

export async function serveStatic(response, distDirectory, pathname) {
  const requested = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const safePath = path.resolve(distDirectory, requested);
  const root = path.resolve(distDirectory);
  if (!safePath.startsWith(`${root}${path.sep}`) && safePath !== root) return false;
  try {
    const content = await readFile(safePath);
    response.statusCode = 200;
    response.setHeader("Content-Type", MIME_TYPES[path.extname(safePath)] || "application/octet-stream");
    response.setHeader(
      "Cache-Control",
      path.basename(safePath) === "index.html" ? "no-cache" : "public, max-age=31536000, immutable",
    );
    response.end(content);
    return true;
  } catch (error) {
    if (error?.code !== "ENOENT" && error?.code !== "EISDIR") throw error;
    return false;
  }
}
