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

async function withServer(app, fn) {
  const server = createServer(app, { logger: { error() {} } });
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
