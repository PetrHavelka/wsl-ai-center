function defaultSetTimer(fn, ms) {
  const timer = setTimeout(fn, ms);
  timer.unref?.();
  return timer;
}

/**
 * FIFO of URLs waiting for the user's Yes/No. Exactly one is shown at a time;
 * the rest wait. Talks to the UI only through the three callbacks.
 */
export class ConfirmQueue {
  #pending = [];
  #current = null;
  #nextId = 1;

  constructor({ max, timeoutSec, graceMs = 10000, onShow, onWaiting, onCancel,
    setTimer = defaultSetTimer, clearTimer = clearTimeout }) {
    this.max = max;
    this.timeoutSec = timeoutSec;
    this.graceMs = graceMs;
    this.onShow = onShow;
    this.onWaiting = onWaiting;
    this.onCancel = onCancel;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
  }

  get size() {
    return this.#pending.length + (this.#current ? 1 : 0);
  }

  enqueue(url) {
    if (this.size >= this.max) return null;
    let resolve;
    const promise = new Promise(r => { resolve = r; });
    const item = { id: this.#nextId++, url, resolve, timer: null };
    this.#pending.push(item);
    if (this.#current) this.onWaiting(this.#current.id, this.#pending.length);
    else this.#showNext();
    return { id: item.id, promise };
  }

  resolve(id, result) {
    if (this.#current?.id !== id) return false;
    this.#finish(result);
    return true;
  }

  cancel(id) {
    if (this.#current?.id === id) {
      this.onCancel(id);
      this.#finish("cancelled");
      return true;
    }
    const index = this.#pending.findIndex(item => item.id === id);
    if (index < 0) return false;
    const [item] = this.#pending.splice(index, 1);
    item.resolve("cancelled");
    if (this.#current) this.onWaiting(this.#current.id, this.#pending.length);
    return true;
  }

  failAll(reason) {
    const items = this.#current ? [this.#current, ...this.#pending] : [...this.#pending];
    if (this.#current) this.clearTimer(this.#current.timer);
    this.#current = null;
    this.#pending = [];
    for (const item of items) item.resolve(reason);
  }

  #finish(result) {
    const item = this.#current;
    this.clearTimer(item.timer);
    this.#current = null;
    item.resolve(result);
    this.#showNext();
  }

  #showNext() {
    const item = this.#pending.shift();
    if (!item) return;
    this.#current = item;
    item.timer = this.setTimer(() => {
      this.onCancel(item.id);
      this.#finish("timeout");
    }, this.timeoutSec * 1000 + this.graceMs);
    this.onShow({ id: item.id, url: item.url }, this.#pending.length);
  }
}
