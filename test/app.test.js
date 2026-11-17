import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { createApp } from "../src/app.js";

const CONFIG = { port: 7399, soundsDir: "/s", confirmSoundDir: "/c", confirmTimeoutSec: 30 };

function setup({ soundEnabled = true, pickWav = dir => join(dir, "x.wav"), failOpen = false } = {}) {
  const sent = [];
  const saved = [];
  const logs = [];
  let exited = 0;
  const app = createApp({
    config: CONFIG,
    helper: { send: msg => { sent.push(msg); return !(failOpen && msg.cmd === "open"); } },
    version: "0.1.0",
    loadState: () => ({ soundEnabled }),
    saveState: state => saved.push(state),
    onExit: () => { exited += 1; },
    logger: { log: m => logs.push(m), error: m => logs.push(m) },
    pickWav
  });
  app.handleHelperMessage({ event: "ready" });
  sent.length = 0;
  return { app, sent, saved, logs, exits: () => exited };
}

test("playCategory plays a random file from the category folder", () => {
  const { app, sent } = setup();
  assert.deepEqual(app.playCategory("done"), { played: true, file: "x.wav" });
  assert.deepEqual(sent, [{ cmd: "play", path: join("/s", "done", "x.wav") }]);
});

test("playCategory reports unknown category, muted and no sounds", () => {
  assert.deepEqual(setup().app.playCategory("nope"), { played: false, reason: "unknown-category" });
  const muted = setup({ soundEnabled: false });
  assert.deepEqual(muted.app.playCategory("done"), { played: false, reason: "muted" });
  assert.deepEqual(muted.sent, []);
  assert.deepEqual(setup({ pickWav: () => null }).app.playCategory("ask"), { played: false, reason: "no-sounds" });
});

test("requestOpen shows the popup with its sound and opens on yes", async () => {
  const { app, sent } = setup();
  const ticket = app.requestOpen("https://e.com/");
  assert.deepEqual(sent, [
    { cmd: "play", path: join("/c", "x.wav") },
    { cmd: "confirm", id: 1, url: "https://e.com/", timeoutSec: 30, waiting: 0 }
  ]);
  app.handleHelperMessage({ event: "confirm", id: ticket.id, result: "yes" });
  assert.equal(await ticket.promise, "yes");
  assert.deepEqual(sent.at(-1), { cmd: "open", url: "https://e.com/" });
});

test("rejected popup does not open; muted popup is silent", async () => {
  const { app, sent } = setup({ soundEnabled: false });
  const ticket = app.requestOpen("https://e.com/");
  app.handleHelperMessage({ event: "confirm", id: ticket.id, result: "no" });
  assert.equal(await ticket.promise, "no");
  assert.deepEqual(sent.map(m => m.cmd), ["confirm"]);
});

test("queue sends counter updates and cancel", async () => {
  const { app, sent } = setup({ soundEnabled: false });
  const first = app.requestOpen("https://a/");
  app.requestOpen("https://b/");
  assert.deepEqual(sent.at(-1), { cmd: "waiting", id: 1, count: 1 });
  app.cancelOpen(first.id);
  assert.equal(await first.promise, "cancelled");
  assert.deepEqual(sent.slice(-2), [
    { cmd: "cancel", id: 1 },
    { cmd: "confirm", id: 2, url: "https://b/", timeoutSec: 30, waiting: 0 }
  ]);
});

test("ignores confirm results with an unknown value", () => {
  const { app } = setup();
  app.requestOpen("https://e.com/");
  app.handleHelperMessage({ event: "confirm", id: 1, result: "maybe" });
  assert.equal(app.health().pendingConfirms, 1);
  app.shutdown();
});

test("toggleSound flips, saves and notifies the helper", () => {
  const { app, sent, saved } = setup();
  app.handleHelperMessage({ event: "toggleSound" });
  assert.deepEqual(saved, [{ soundEnabled: false }]);
  assert.deepEqual(sent.at(-1), { cmd: "soundEnabled", value: false });
  assert.equal(app.health().soundEnabled, false);
});

test("ready sends init and the console URL", () => {
  const { app, sent } = setup();
  assert.equal(app.setConsoleUrl("http://127.0.0.1:1/?t=x"), "http://127.0.0.1:1/?t=x");
  sent.length = 0;
  app.handleHelperMessage({ event: "ready" });
  assert.deepEqual(sent, [
    { cmd: "init", header: "AI Center · port 7399", soundEnabled: true },
    { cmd: "consoleUrl", url: "http://127.0.0.1:1/?t=x" }
  ]);
});

test("helper down fails pending confirmations", async () => {
  const { app } = setup();
  const ticket = app.requestOpen("https://e.com/");
  app.handleHelperDown();
  assert.equal(await ticket.promise, "helper-restarted");
  assert.equal(app.health().pendingConfirms, 0);
});

test("requestOpen answers helper-restarted before ready and while the helper is down", async () => {
  const { app, sent } = setup({ soundEnabled: false });
  app.handleHelperDown();
  let ticket = app.requestOpen("https://e.com/");
  assert.equal(await ticket.promise, "helper-restarted");
  assert.equal(app.health().pendingConfirms, 0);
  assert.deepEqual(sent, []);
  app.handleHelperMessage({ event: "ready" });
  sent.length = 0;
  ticket = app.requestOpen("https://e.com/");
  assert.deepEqual(sent.map(m => m.cmd), ["confirm"]);
  app.shutdown();
});

test("requestOpen answers helper-restarted before the first ready", async () => {
  const app = createApp({
    config: CONFIG, helper: { send: () => true }, version: "0.1.0",
    loadState: () => ({ soundEnabled: true }), saveState() {}, onExit() {}
  });
  assert.equal(await app.requestOpen("https://e.com/").promise, "helper-restarted");
});

test("yes is reported as helper-restarted when the open command cannot be sent", async () => {
  const { app } = setup({ failOpen: true });
  const ticket = app.requestOpen("https://e.com/");
  app.handleHelperMessage({ event: "confirm", id: ticket.id, result: "yes" });
  assert.equal(await ticket.promise, "helper-restarted");
});

test("exit and log events", () => {
  const { app, logs, exits } = setup();
  app.handleHelperMessage({ event: "exit" });
  app.handleHelperMessage({ event: "log", message: "hi" });
  assert.equal(exits(), 1);
  assert.deepEqual(logs, ["[helper] hi"]);
});

test("health", () => {
  const { app } = setup();
  assert.deepEqual(app.health(), {
    ok: true, version: "0.1.0", port: 7399, soundEnabled: true, consoleUrl: false, pendingConfirms: 0
  });
});

test("helper restart event calls onRestart once", () => {
  let restarts = 0;
  const app = createApp({
    config: CONFIG,
    helper: { send: () => true },
    version: "0.1.0",
    loadState: () => ({ soundEnabled: true }),
    saveState: () => {},
    onExit: () => {},
    onRestart: () => { restarts += 1; },
    logger: { log: () => {}, error: () => {} }
  });
  app.handleHelperMessage({ event: "restart" });
  assert.equal(restarts, 1);
});
