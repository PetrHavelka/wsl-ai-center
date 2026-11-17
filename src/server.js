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

const IPV4_HOST = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3}):(\d+)$/;

function isAllowedHost(host, port) {
  if (typeof host !== "string") return false;
  if (host === `localhost:${port}` || host === `[::1]:${port}`) return true;
  const match = IPV4_HOST.exec(host);
  return match !== null && Number(match[5]) === port && match.slice(1, 5).every(octet => Number(octet) <= 255);
}

/**
 * Browsers always send Origin on cross-site requests; a Host that is not an IP literal or localhost
 * means DNS rebinding. IPv4 literals are allowed so the WSL portproxy (Host = Windows IP) works.
 */
function isForbidden(req) {
  if (req.headers.origin !== undefined) return true;
  return !isAllowedHost(req.headers.host, req.socket.localPort);
}

/** origin + path only, with ?*** when a query or fragment (possible token) was dropped; no userinfo. */
function maskUrl(value) {
  const text = typeof value === "string" ? value : describeValue(value);
  try {
    const url = new URL(text);
    return url.origin + url.pathname + (url.search || url.hash ? "?***" : "");
  } catch {
    const cut = text.search(/[?#]/);
    return (cut === -1 ? text : text.slice(0, cut) + "?***").slice(0, 200);
  }
}

/** Escapes control characters so request data cannot forge log lines. */
function escapeLog(text) {
  return String(text).replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, char => {
    if (char === "\n") return "\\n";
    if (char === "\r") return "\\r";
    if (char === "\t") return "\\t";
    return "\\u" + char.charCodeAt(0).toString(16).padStart(4, "0");
  });
}

function describeValue(value) {
  return typeof value === "string" ? value : JSON.stringify(value) ?? "?";
}

function isJsonContentType(req) {
  const type = (req.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase();
  return type === "application/json";
}

async function handleOpen(app, req, body, res, ctx) {
  const url = body ? parseHttpUrl(body.url) : null;
  if (!url) {
    ctx.summary = `url=${body ? describeValue(body.url).slice(0, 200) : "?"} -> invalid`;
    return sendJson(res, 400, { error: "url must be an absolute http(s) URL" });
  }
  ctx.summary = `url=${url.href} -> client-closed`; // stays so if the connection drops while waiting
  if (res.destroyed || req.socket.destroyed) return; // req.destroyed is already true once the body was read
  const ticket = app.requestOpen(url.href);
  if (!ticket) {
    ctx.summary = `url=${url.href} -> queue-full`;
    return sendJson(res, 429, { error: "too many pending confirmations" });
  }
  res.on("close", () => {
    if (!res.writableFinished) app.cancelOpen(ticket.id);
  });
  const result = await ticket.promise;
  if (result === "cancelled") return;
  ctx.summary = `url=${url.href} -> ${result === "yes" ? "opened" : result === "no" ? "rejected" : result}`;
  sendJson(res, 200, result === "yes"
    ? { opened: true }
    : { opened: false, reason: result === "no" ? "rejected" : result });
}

async function handle(app, req, res, ctx) {
  const path = ctx.path;
  const allowed = ROUTES[path];
  if (!allowed) return sendJson(res, 404, { error: "not found" });
  if (!allowed.includes(req.method)) {
    return sendJson(res, 405, { error: "method not allowed" }, { Allow: allowed.join(", ") });
  }
  if (isForbidden(req)) {
    ctx.summary = `forbidden origin=${req.headers.origin ?? "-"} host=${req.headers.host ?? "-"}`;
    return path === "/sound"
      ? sendJson(res, 200, { played: false, reason: "forbidden" })
      : sendJson(res, 403, { error: "forbidden" });
  }
  if (path === "/health") return sendJson(res, 200, app.health());
  if (path === "/console-url" && req.method === "DELETE") {
    ctx.summary = "cleared";
    return sendJson(res, 200, { consoleUrl: app.setConsoleUrl(null) });
  }
  if (!isJsonContentType(req)) {
    ctx.summary = `unsupported content-type=${req.headers["content-type"] ?? "-"}`;
    return path === "/sound"
      ? sendJson(res, 200, { played: false, reason: "bad-request" })
      : sendJson(res, 415, { error: "Content-Type must be application/json" });
  }

  const body = await readJson(req);
  if (path === "/sound") {
    const result = body ? app.playCategory(body.category) : { played: false, reason: "bad-request" };
    ctx.summary = `category=${body ? describeValue(body.category) : "?"} -> ${result.played ? `played ${result.file}` : result.reason}`;
    return sendJson(res, 200, result);
  }
  if (path === "/console-url") {
    if (!body || !isLoopbackHttpUrl(body.url)) {
      ctx.summary = `url=${body ? maskUrl(body.url) : "?"} -> invalid`;
      return sendJson(res, 400, { error: "url must be an http(s) URL on 127.0.0.1, localhost or [::1]" });
    }
    const href = parseHttpUrl(body.url).href;
    ctx.summary = `url=${maskUrl(href)}`;
    return sendJson(res, 200, { consoleUrl: app.setConsoleUrl(href) });
  }
  return handleOpen(app, req, body, res, ctx);
}

export function createServer(app, { logger = console } = {}) {
  return http.createServer((req, res) => {
    const started = process.hrtime.bigint();
    let path = "?";
    try {
      path = new URL(req.url, "http://localhost").pathname;
    } catch {
      // handled below as 404
    }
    const ctx = { path, summary: "" };
    res.on("close", () => {
      const ms = Math.round(Number(process.hrtime.bigint() - started) / 1e6);
      const status = res.headersSent ? res.statusCode : "-";
      logger.log(escapeLog(`${req.method} ${ctx.path} ${status} ${ms}ms${ctx.summary ? " " + ctx.summary : ""}`));
    });
    handle(app, req, res, ctx).catch(error => {
      logger.error(`Request failed: ${error.stack ?? error}`);
      if (!res.headersSent) sendJson(res, 500, { error: error.message });
      else res.destroy();
    });
  });
}
