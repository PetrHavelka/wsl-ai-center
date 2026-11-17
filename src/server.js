import http from "node:http";
import { isLoopbackHttpUrl, parseHttpUrl } from "./urls.js";

export const MAX_BODY_BYTES = 16 * 1024;

const ROUTES = {
  "/health": ["GET"],
  "/sound": ["POST"],
  "/open": ["POST"],
  "/console-url": ["POST", "DELETE"]
};

function sendJson(res, status, body, headers = {}) {
  if (res.destroyed) return;
  const data = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(data),
    ...headers
  });
  res.end(data);
}

/** The parsed JSON object, or undefined for anything unusable (too big, broken, not an object). */
async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size <= MAX_BODY_BYTES) chunks.push(chunk);
  }
  if (size > MAX_BODY_BYTES) return undefined;
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
    return value !== null && typeof value === "object" && !Array.isArray(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

/** Browsers always send Origin on cross-site requests; a foreign Host means DNS rebinding. */
function isForbidden(req) {
  if (req.headers.origin !== undefined) return true;
  const port = req.socket.localPort;
  return req.headers.host !== `127.0.0.1:${port}` && req.headers.host !== `localhost:${port}`;
}

function isJsonContentType(req) {
  const type = (req.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase();
  return type === "application/json";
}

async function handleOpen(app, req, body, res) {
  const url = body ? parseHttpUrl(body.url) : null;
  if (!url) return sendJson(res, 400, { error: "url must be an absolute http(s) URL" });
  if (res.destroyed || req.socket.destroyed) return; // req.destroyed is already true once the body was read
  const ticket = app.requestOpen(url.href);
  if (!ticket) return sendJson(res, 429, { error: "too many pending confirmations" });
  res.on("close", () => {
    if (!res.writableFinished) app.cancelOpen(ticket.id);
  });
  const result = await ticket.promise;
  if (result === "cancelled") return;
  sendJson(res, 200, result === "yes"
    ? { opened: true }
    : { opened: false, reason: result === "no" ? "rejected" : result });
}

async function handle(app, req, res) {
  const path = new URL(req.url, "http://localhost").pathname;
  const allowed = ROUTES[path];
  if (!allowed) return sendJson(res, 404, { error: "not found" });
  if (!allowed.includes(req.method)) {
    return sendJson(res, 405, { error: "method not allowed" }, { Allow: allowed.join(", ") });
  }
  if (isForbidden(req)) {
    return path === "/sound"
      ? sendJson(res, 200, { played: false, reason: "forbidden" })
      : sendJson(res, 403, { error: "forbidden" });
  }
  if (path === "/health") return sendJson(res, 200, app.health());
  if (path === "/console-url" && req.method === "DELETE") {
    return sendJson(res, 200, { consoleUrl: app.setConsoleUrl(null) });
  }
  if (!isJsonContentType(req)) {
    return path === "/sound"
      ? sendJson(res, 200, { played: false, reason: "bad-request" })
      : sendJson(res, 415, { error: "Content-Type must be application/json" });
  }

  const body = await readJson(req);
  if (path === "/sound") {
    return sendJson(res, 200, body ? app.playCategory(body.category) : { played: false, reason: "bad-request" });
  }
  if (path === "/console-url") {
    if (!body || !isLoopbackHttpUrl(body.url)) {
      return sendJson(res, 400, { error: "url must be an http(s) URL on 127.0.0.1, localhost or [::1]" });
    }
    return sendJson(res, 200, { consoleUrl: app.setConsoleUrl(parseHttpUrl(body.url).href) });
  }
  return handleOpen(app, req, body, res);
}

export function createServer(app, { logger = console } = {}) {
  return http.createServer((req, res) => {
    handle(app, req, res).catch(error => {
      logger.error(`Request failed: ${error.stack ?? error}`);
      if (!res.headersSent) sendJson(res, 500, { error: error.message });
      else res.destroy();
    });
  });
}
