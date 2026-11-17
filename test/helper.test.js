import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { setTimeout as sleep } from "node:timers/promises";
import { Helper, encodeMessage } from "../src/helper.js";

class FakeChild extends EventEmitter {
  constructor() {
    super();
    this.stdin = new PassThrough();
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.written = "";
    this.stdin.on("data", chunk => { this.written += chunk; });
  }
  kill() { this.emit("exit", null); }
}

function fakeSpawn() {
  const children = [];
  const fn = (command, args, options) => {
    const child = new FakeChild();
    Object.assign(child, { command, args, options });
    children.push(child);
    return child;
  };
  return { fn, children };
}

function collect(helper) {
  const events = [];
  helper.on("message", m => events.push(["message", m]));
  helper.on("down", c => events.push(["down", c]));
  helper.on("gave-up", () => events.push(["gave-up"]));
  return events;
}

test("encodeMessage escapes non-ASCII and round-trips", () => {
  const line = encodeMessage({ path: "C:\\Users\\Petr Novák\\a.wav", header: "AI Center · port 1" });
  assert.equal(line, '{"path":"C:\\\\Users\\\\Petr Nov\\u00e1k\\\\a.wav","header":"AI Center \\u00b7 port 1"}\n');
  assert.match(line, /^[\x00-\x7f]*$/);
  assert.deepEqual(JSON.parse(line), { path: "C:\\Users\\Petr Novák\\a.wav", header: "AI Center · port 1" });
});

test("spawns with piped stdio and parses stdout lines", async () => {
  const { fn, children } = fakeSpawn();
  const helper = new Helper({ command: "ps", args: ["-File", "x"], spawnFn: fn });
  const events = collect(helper);
  helper.start();
  const child = children[0];
  assert.equal(child.command, "ps");
  assert.deepEqual(child.options.stdio, ["pipe", "pipe", "pipe"]);
  child.stdout.write('\uFEFF{"event":"ready"}\n\n{"event":"confirm","id":1,"result":"yes"}\nnot json\n');
  child.stderr.write("boom\n");
  await sleep(10);
  assert.deepEqual(events, [
    ["message", { event: "ready" }],
    ["message", { event: "confirm", id: 1, result: "yes" }],
    ["message", { event: "log", message: "unparsable helper output: not json" }],
    ["message", { event: "log", message: "stderr: boom" }]
  ]);
});

test("send writes one encoded line", async () => {
  const { fn, children } = fakeSpawn();
  const helper = new Helper({ command: "ps", args: [], spawnFn: fn });
  assert.equal(helper.send({ cmd: "play" }), false);
  helper.start();
  assert.equal(helper.send({ cmd: "play", path: "é" }), true);
  await sleep(5);
  assert.equal(children[0].written, '{"cmd":"play","path":"\\u00e9"}\n');
});

test("restarts with backoff and gives up", async () => {
  const { fn, children } = fakeSpawn();
  const helper = new Helper({ command: "ps", args: [], spawnFn: fn, baseDelayMs: 1, maxDelayMs: 4, maxRestarts: 2 });
  const events = collect(helper);
  helper.start();
  children[0].emit("exit", 1);
  await sleep(20);
  assert.equal(children.length, 2);
  children[1].emit("exit", 1);
  await sleep(20);
  assert.equal(children.length, 3);
  children[2].emit("exit", 1);
  await sleep(20);
  assert.equal(children.length, 3);
  assert.deepEqual(events.map(e => e[0]), ["down", "down", "down", "gave-up"]);
});

test("ready resets the restart counter", async () => {
  const { fn, children } = fakeSpawn();
  const helper = new Helper({ command: "ps", args: [], spawnFn: fn, baseDelayMs: 1, maxRestarts: 1 });
  const events = collect(helper);
  helper.start();
  children[0].emit("exit", 1);
  await sleep(20);
  children[1].stdout.write('{"event":"ready"}\n');
  await sleep(10);
  children[1].emit("exit", 1);
  await sleep(20);
  assert.equal(children.length, 3);
  assert.equal(events.some(e => e[0] === "gave-up"), false);
});

test("a spawn error counts as an exit, once", async () => {
  const { fn, children } = fakeSpawn();
  const helper = new Helper({ command: "ps", args: [], spawnFn: fn, baseDelayMs: 1, maxRestarts: 0 });
  const events = collect(helper);
  helper.start();
  children[0].emit("error", new Error("ENOENT"));
  children[0].emit("exit", null);
  await sleep(10);
  assert.deepEqual(events.map(e => e[0]), ["message", "down", "gave-up"]);
});

test("stop ends stdin and does not restart", async () => {
  const { fn, children } = fakeSpawn();
  const helper = new Helper({ command: "ps", args: [], spawnFn: fn, baseDelayMs: 1 });
  const events = collect(helper);
  helper.start();
  let ended = false;
  children[0].stdin.on("finish", () => { ended = true; });
  helper.stop();
  await sleep(5);
  assert.equal(ended, true);
  children[0].emit("exit", 0);
  await sleep(10);
  assert.equal(children.length, 1);
  assert.deepEqual(events, []);
});

test("stop returns a promise that resolves after the child exits", async () => {
  const { fn, children } = fakeSpawn();
  const helper = new Helper({ command: "ps", args: [], spawnFn: fn });
  helper.start();
  let done = false;
  const p = helper.stop();
  assert.ok(p instanceof Promise);
  p.then(() => { done = true; });
  await sleep(5);
  assert.equal(done, false);
  children[0].emit("exit", 0);
  await p;
  assert.equal(done, true);
});

test("stop without a child resolves immediately", async () => {
  const helper = new Helper({ command: "ps", args: [], spawnFn: fakeSpawn().fn });
  await helper.stop();
});
