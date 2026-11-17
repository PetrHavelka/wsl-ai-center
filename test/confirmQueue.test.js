import { test } from "node:test";
import assert from "node:assert/strict";
import { ConfirmQueue } from "../src/confirmQueue.js";

function setup({ max = 10 } = {}) {
  const calls = [];
  const timers = new Map();
  let nextTimer = 0;
  const queue = new ConfirmQueue({
    max,
    timeoutSec: 30,
    graceMs: 10000,
    onShow: (item, waiting) => calls.push(["show", item.id, item.url, waiting]),
    onWaiting: (id, count) => calls.push(["waiting", id, count]),
    onCancel: id => calls.push(["cancel", id]),
    setTimer: (fn, ms) => { const id = ++nextTimer; timers.set(id, { fn, ms }); return id; },
    clearTimer: id => timers.delete(id)
  });
  return { queue, calls, timers };
}

test("shows the first at once and counts the waiting ones", () => {
  const { queue, calls } = setup();
  queue.enqueue("a");
  queue.enqueue("b");
  queue.enqueue("c");
  assert.deepEqual(calls, [["show", 1, "a", 0], ["waiting", 1, 1], ["waiting", 1, 2]]);
  assert.equal(queue.size, 3);
});

test("resolving the shown one answers it and shows the next", async () => {
  const { queue, calls } = setup();
  const first = queue.enqueue("a");
  queue.enqueue("b");
  queue.enqueue("c");
  assert.equal(queue.resolve(1, "yes"), true);
  assert.equal(await first.promise, "yes");
  assert.deepEqual(calls.at(-1), ["show", 2, "b", 1]);
  assert.equal(queue.size, 2);
});

test("resolve ignores ids that are not shown", () => {
  const { queue } = setup();
  queue.enqueue("a");
  queue.enqueue("b");
  assert.equal(queue.resolve(2, "yes"), false);
  assert.equal(queue.resolve(99, "yes"), false);
});

test("cancelling the shown one closes it and shows the next", async () => {
  const { queue, calls } = setup();
  const first = queue.enqueue("a");
  queue.enqueue("b");
  assert.equal(queue.cancel(1), true);
  assert.equal(await first.promise, "cancelled");
  assert.deepEqual(calls.slice(-2), [["cancel", 1], ["show", 2, "b", 0]]);
});

test("cancelling a waiting one removes it and updates the counter", async () => {
  const { queue, calls } = setup();
  queue.enqueue("a");
  const second = queue.enqueue("b");
  queue.enqueue("c");
  assert.equal(queue.cancel(2), true);
  assert.equal(await second.promise, "cancelled");
  assert.deepEqual(calls.at(-1), ["waiting", 1, 1]);
  assert.equal(calls.some(call => call[0] === "cancel"), false);
  assert.equal(queue.size, 2);
});

test("refuses when full", () => {
  const { queue } = setup({ max: 2 });
  assert.ok(queue.enqueue("a"));
  assert.ok(queue.enqueue("b"));
  assert.equal(queue.enqueue("c"), null);
});

test("safety timer ends the shown one as timeout", async () => {
  const { queue, calls, timers } = setup();
  const first = queue.enqueue("a");
  const [timer] = timers.values();
  assert.equal(timer.ms, 40000);
  timer.fn();
  assert.equal(await first.promise, "timeout");
  assert.deepEqual(calls.at(-1), ["cancel", 1]);
});

test("resolving clears the safety timer", () => {
  const { queue, timers } = setup();
  queue.enqueue("a");
  queue.resolve(1, "no");
  assert.equal(timers.size, 0);
});

test("failAll answers everything and empties the queue", async () => {
  const { queue, timers } = setup();
  const a = queue.enqueue("a");
  const b = queue.enqueue("b");
  queue.failAll("helper-restarted");
  assert.equal(await a.promise, "helper-restarted");
  assert.equal(await b.promise, "helper-restarted");
  assert.equal(queue.size, 0);
  assert.equal(timers.size, 0);
});
