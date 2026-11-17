import http from "node:http";
import { test } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { createServer } from "../src/server.js";

function fakeApp() {
  const calls = [];
  return {
    calls,
    openResult: "yes",
    health: () => ({ ok: true }),
    playCategory(category) { calls.push(["play", category]); return { played: true, file: "x.wav" }; },
    requestOpen(url) { calls.push(["open", url]); return { id: 1, promise: Promise.resolve(this.openResult) }; },
    cancelOpen(id) { calls.push(["cancel", id]); },
    setConsoleUrl(url) { calls.push(["console", url]); return url; }
  };
}

async function withServer(app, fn, lines = []) {
  const server = createServer(app, { logger: { error() {}, log: line => lines.push(line) } });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn(base);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
}

const post = (base, path, body, init = {}) => fetch(base + path, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: typeof body === "string" ? body : JSON.stringify(body),
  ...init
});

async function waitFor(predicate) {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return;
    await sleep(10);
  }
  throw new Error("condition not met");
}

test("health", async () => {
  await withServer(fakeApp(), async base => {
    const res = await fetch(base + "/health");
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
  });
});

test("404 and 405", async () => {
  await withServer(fakeApp(), async base => {
    assert.equal((await fetch(base + "/nope")).status, 404);
    const res = await fetch(base + "/sound");
    assert.equal(res.status, 405);
    assert.equal(res.headers.get("allow"), "POST");
  });
});

test("/sound passes the category and is always 200", async () => {
  const app = fakeApp();
  await withServer(app, async base => {
    let res = await post(base, "/sound", { category: "done" });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { played: true, file: "x.wav" });
    res = await post(base, "/sound", "{ broken");
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { played: false, reason: "bad-request" });
    res = await post(base, "/sound", JSON.stringify({ category: "x".repeat(20000) }));
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { played: false, reason: "bad-request" });
  });
  assert.deepEqual(app.calls, [["play", "done"]]);
});

test("/open validates, normalizes and maps results", async () => {
  const app = fakeApp();
  await withServer(app, async base => {
    assert.equal((await post(base, "/open", { url: "file:///C:/Windows" })).status, 400);
    assert.equal((await post(base, "/open", "nope")).status, 400);

    let res = await post(base, "/open", { url: "https://Example.com" });
    assert.deepEqual(await res.json(), { opened: true });
    assert.deepEqual(app.calls.at(-1), ["open", "https://example.com/"]);

    app.openResult = "no";
    res = await post(base, "/open", { url: "https://e.com/" });
    assert.deepEqual(await res.json(), { opened: false, reason: "rejected" });

    app.openResult = "timeout";
    res = await post(base, "/open", { url: "https://e.com/" });
    assert.deepEqual(await res.json(), { opened: false, reason: "timeout" });
  });
});

test("/open answers 429 when the queue is full", async () => {
  const app = fakeApp();
  app.requestOpen = () => null;
  await withServer(app, async base => {
    assert.equal((await post(base, "/open", { url: "https://e.com/" })).status, 429);
  });
});

test("/open cancels when the client disconnects", async () => {
  const app = fakeApp();
  let finish;
  app.requestOpen = url => {
    app.calls.push(["open", url]);
    return { id: 7, promise: new Promise(resolve => { finish = resolve; }) };
  };
  app.cancelOpen = id => {
    app.calls.push(["cancel", id]);
    finish("cancelled");
  };
  await withServer(app, async base => {
    const controller = new AbortController();
    const pending = post(base, "/open", { url: "https://e.com/" }, { signal: controller.signal }).catch(e => e);
    await waitFor(() => app.calls.some(c => c[0] === "open"));
    controller.abort();
    await pending;
    await waitFor(() => app.calls.some(c => c[0] === "cancel"));
    assert.deepEqual(app.calls.at(-1), ["cancel", 7]);
  });
});

test("/console-url accepts loopback only and can be cleared", async () => {
  const app = fakeApp();
  await withServer(app, async base => {
    let res = await post(base, "/console-url", { url: "http://127.0.0.1:36061/?t=abc" });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { consoleUrl: "http://127.0.0.1:36061/?t=abc" });
    assert.equal((await post(base, "/console-url", { url: "https://example.com/" })).status, 400);
    res = await fetch(base + "/console-url", { method: "DELETE" });
    assert.deepEqual(await res.json(), { consoleUrl: null });
  });
  assert.deepEqual(app.calls, [["console", "http://127.0.0.1:36061/?t=abc"], ["console", null]]);
});

/** Raw request, so that Origin, Host and Content-Type can be set freely. */
function rawRequest(base, path, { method = "POST", headers = {}, body } = {}) {
  const { port } = new URL(base);
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path, method, headers }, res => {
      const chunks = [];
      res.on("data", chunk => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode, json: JSON.parse(Buffer.concat(chunks).toString("utf-8")) }));
    });
    req.on("error", reject);
    req.end(body);
  });
}

const JSON_HEADERS = { "Content-Type": "application/json" };

test("requests with an Origin header are refused with 403", async () => {
  const app = fakeApp();
  await withServer(app, async base => {
    const headers = { ...JSON_HEADERS, Origin: "https://evil.example" };
    let res = await rawRequest(base, "/open", { headers, body: JSON.stringify({ url: "https://e.com/" }) });
    assert.equal(res.status, 403);
    assert.deepEqual(res.json, { error: "forbidden" });
    res = await rawRequest(base, "/console-url", { headers, body: JSON.stringify({ url: "http://127.0.0.1:1/" }) });
    assert.equal(res.status, 403);
    res = await rawRequest(base, "/console-url", { method: "DELETE", headers: { Origin: "https://evil.example" } });
    assert.equal(res.status, 403);
    res = await rawRequest(base, "/health", { method: "GET", headers: { Origin: "https://evil.example" } });
    assert.equal(res.status, 403);
  });
  assert.deepEqual(app.calls, []);
});

test("a Host header other than loopback:port is refused with 403", async () => {
  const app = fakeApp();
  await withServer(app, async base => {
    const { port } = new URL(base);
    const body = JSON.stringify({ url: "https://e.com/" });
    let res = await rawRequest(base, "/open", { headers: { ...JSON_HEADERS, Host: "evil.example" }, body });
    assert.equal(res.status, 403);
    res = await rawRequest(base, "/open", { headers: { ...JSON_HEADERS, Host: `evil.example:${port}` }, body });
    assert.equal(res.status, 403);
    res = await rawRequest(base, "/open", { headers: { ...JSON_HEADERS, Host: `localhost:${port}` }, body });
    assert.equal(res.status, 200);
  });
});

test("a POST that is not application/json is refused with 415", async () => {
  const app = fakeApp();
  await withServer(app, async base => {
    const body = JSON.stringify({ url: "https://e.com/" });
    let res = await rawRequest(base, "/open", { headers: { "Content-Type": "text/plain" }, body });
    assert.equal(res.status, 415);
    assert.deepEqual(res.json, { error: "Content-Type must be application/json" });
    res = await rawRequest(base, "/open", { body });
    assert.equal(res.status, 415);
    res = await rawRequest(base, "/open", { headers: { "Content-Type": "Application/JSON; charset=utf-8" }, body });
    assert.equal(res.status, 200);
  });
  assert.deepEqual(app.calls, [["open", "https://e.com/"]]);
});

test("/sound keeps answering 200 for forbidden and non-JSON requests", async () => {
  const app = fakeApp();
  await withServer(app, async base => {
    const body = JSON.stringify({ category: "done" });
    let res = await rawRequest(base, "/sound", { headers: { ...JSON_HEADERS, Origin: "https://evil.example" }, body });
    assert.equal(res.status, 200);
    assert.deepEqual(res.json, { played: false, reason: "forbidden" });
    res = await rawRequest(base, "/sound", { headers: { "Content-Type": "text/plain" }, body });
    assert.equal(res.status, 200);
    assert.deepEqual(res.json, { played: false, reason: "bad-request" });
  });
  assert.deepEqual(app.calls, []);
});

const lastLine = lines => lines.at(-1);

test("/sound logs one request line", async () => {
  const lines = [];
  await withServer(fakeApp(), async base => {
    await post(base, "/sound", { category: "done" });
    await waitFor(() => lines.length === 1);
  }, lines);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^POST \/sound 200 \d+ms category=done -> played x\.wav$/);
});

test("/sound logs the reason and unusable categories", async () => {
  const lines = [];
  const app = fakeApp();
  app.playCategory = category => (category === "nope" ? { played: false, reason: "unknown-category" } : { played: true, file: "x.wav" });
  await withServer(app, async base => {
    await post(base, "/sound", { category: "nope" });
    await post(base, "/sound", { category: 5 });
    await post(base, "/sound", "{ broken");
    await waitFor(() => lines.length === 3);
  }, lines);
  assert.match(lines[0], /category=nope -> unknown-category$/);
  assert.match(lines[1], /category=5 -> played x\.wav$/);
  assert.match(lines[2], /category=\? -> bad-request$/);
});

test("/open logs the outcome, invalid input and client abort", async () => {
  const lines = [];
  const app = fakeApp();
  await withServer(app, async base => {
    app.openResult = "no";
    await post(base, "/open", { url: "https://e.com/" });
    await waitFor(() => lines.length === 1);
    assert.match(lastLine(lines), /^POST \/open 200 \d+ms url=https:\/\/e\.com\/ -> rejected$/);
    app.openResult = "yes";
    await post(base, "/open", { url: "https://e.com/" });
    await waitFor(() => lines.length === 2);
    assert.match(lastLine(lines), /-> opened$/);
    await post(base, "/open", { url: "x".repeat(300) });
    await waitFor(() => lines.length === 3);
    assert.match(lastLine(lines), new RegExp(` 400 \\d+ms url=x{200} -> invalid$`));

    let finish;
    app.requestOpen = () => ({ id: 9, promise: new Promise(resolve => { finish = resolve; }) });
    app.cancelOpen = () => finish("cancelled");
    const controller = new AbortController();
    const pending = post(base, "/open", { url: "https://e.com/" }, { signal: controller.signal }).catch(e => e);
    await sleep(50);
    controller.abort();
    await pending;
    await waitFor(() => lines.length === 4);
    assert.match(lastLine(lines), /^POST \/open - \d+ms .*client-closed$/);
  }, lines);
  assert.equal(lines.length, 4);
});

test("/open logs queue-full", async () => {
  const lines = [];
  const app = fakeApp();
  app.requestOpen = () => null;
  await withServer(app, async base => {
    await post(base, "/open", { url: "https://e.com/" });
    await waitFor(() => lines.length === 1);
  }, lines);
  assert.match(lines[0], / 429 \d+ms url=https:\/\/e\.com\/ -> queue-full$/);
});

test("/console-url masks the query in the log", async () => {
  const lines = [];
  await withServer(fakeApp(), async base => {
    await post(base, "/console-url", { url: "http://127.0.0.1:36061/?t=secret" });
    await post(base, "/console-url", { url: "https://example.com/" });
    await fetch(base + "/console-url", { method: "DELETE" });
    await waitFor(() => lines.length === 3);
  }, lines);
  assert.match(lines[0], /url=http:\/\/127\.0\.0\.1:36061\/\?\*\*\*$/);
  assert.ok(!lines[0].includes("secret"));
  assert.match(lines[1], / 400 \d+ms url=https:\/\/example\.com\/ -> invalid$/);
  assert.match(lines[2], /^DELETE \/console-url 200 \d+ms cleared$/);
});

test("refusals are logged", async () => {
  const lines = [];
  await withServer(fakeApp(), async base => {
    await rawRequest(base, "/open", { headers: { ...JSON_HEADERS, Origin: "https://evil.example" }, body: "{}" });
    await rawRequest(base, "/open", { headers: { "Content-Type": "text/plain" }, body: "{}" });
    await rawRequest(base, "/open", { body: "{}" });
    await waitFor(() => lines.length === 3);
  }, lines);
  assert.match(lines[0], / 403 \d+ms forbidden origin=https:\/\/evil\.example host=127\.0\.0\.1:\d+$/);
  assert.match(lines[1], / 415 \d+ms unsupported content-type=text\/plain$/);
  assert.match(lines[2], / 415 \d+ms unsupported content-type=-$/);
});

test("any IPv4 literal with the right port is an allowed Host", async () => {
  await withServer(fakeApp(), async base => {
    const { port } = new URL(base);
    const get = host => rawRequest(base, "/health", { method: "GET", headers: { Host: host } });
    assert.equal((await get(`172.31.176.1:${port}`)).status, 200);
    assert.equal((await get(`[::1]:${port}`)).status, 200);
    assert.equal((await get(`evil.example:${port}`)).status, 403);
    assert.equal((await get(`999.1.1.1:${port}`)).status, 403);
    assert.equal((await get("172.31.176.1:1")).status, 403);
    assert.equal((await get(`172.31.176.1`)).status, 403);
  });
});

test("tokens in console URLs never reach the log, valid or invalid", async () => {
  const lines = [];
  await withServer(fakeApp(), async base => {
    await post(base, "/console-url", { url: "http://evil.example/?t=SECRET" });
    await post(base, "/console-url", { url: "http://127.0.0.1:1/p#token=SECRET" });
    await post(base, "/console-url", { url: "http://user:SECRET@127.0.0.1:1/p" });
    await post(base, "/console-url", { url: "not a url?t=SECRET" });
    await waitFor(() => lines.length === 4);
  }, lines);
  for (const line of lines) assert.ok(!line.includes("SECRET"), line);
  assert.match(lines[0], /url=http:\/\/evil\.example\/\?\*\*\* -> invalid$/);
  assert.match(lines[1], /url=http:\/\/127\.0\.0\.1:1\/p\?\*\*\*$/);
  assert.match(lines[2], /url=http:\/\/127\.0\.0\.1:1\/p$/);
  assert.match(lines[3], /url=not a url\?\*\*\* -> invalid$/);
});

test("control characters in logged values cannot forge log lines", async () => {
  const lines = [];
  await withServer(fakeApp(), async base => {
    await post(base, "/sound", { category: "a\nFAKE line\r" });
    await rawRequest(base, "/open", { headers: { ...JSON_HEADERS, Origin: "x\ty" }, body: "{}" });
    await waitFor(() => lines.length === 2);
  }, lines);
  assert.ok(lines.every(line => !/[\r\n\t]/.test(line)));
  assert.match(lines[0], /category=a\\nFAKE line\\r -> played/);
});
