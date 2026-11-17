import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { createInterface } from "node:readline";

/** One protocol line, ASCII only so the console code page never matters. */
export function encodeMessage(message) {
  return JSON.stringify(message).replace(/[\u007f-\uffff]/g,
    ch => "\\u" + ch.charCodeAt(0).toString(16).padStart(4, "0")) + "\n";
}

/**
 * The PowerShell tray helper as a child process speaking JSON lines.
 * Restarts it with exponential backoff when it dies unexpectedly.
 */
export class Helper extends EventEmitter {
  #child = null;
  #stopping = false;
  #attempts = 0;
  #restartTimer = null;

  constructor({ command, args, spawnFn = spawn, baseDelayMs = 5000, maxDelayMs = 60000, maxRestarts = 5 }) {
    super();
    Object.assign(this, { command, args, spawnFn, baseDelayMs, maxDelayMs, maxRestarts });
  }

  start() {
    const child = this.spawnFn(this.command, this.args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    this.#child = child;
    createInterface({ input: child.stdout }).on("line", line => this.#onLine(line));
    createInterface({ input: child.stderr }).on("line", line => {
      if (line.trim()) this.emit("message", { event: "log", message: `stderr: ${line}` });
    });
    child.stdin.on("error", () => { /* EPIPE while the helper is dying */ });
    child.on("error", error => {
      this.emit("message", { event: "log", message: `helper failed: ${error.message}` });
      this.#onExit(child, null);
    });
    child.on("exit", code => this.#onExit(child, code));
  }

  send(message) {
    const child = this.#child;
    if (!child || !child.stdin.writable) return false;
    child.stdin.write(encodeMessage(message));
    return true;
  }

  stop() {
    this.#stopping = true;
    clearTimeout(this.#restartTimer);
    const child = this.#child;
    if (!child) return;
    child.stdin.end();
    const killTimer = setTimeout(() => child.kill(), 3000);
    killTimer.unref?.();
    child.once("exit", () => clearTimeout(killTimer));
  }

  #onLine(raw) {
    const line = raw.replace(/^\uFEFF/, "").trim();
    if (!line) return;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      this.emit("message", { event: "log", message: `unparsable helper output: ${line}` });
      return;
    }
    if (message === null || typeof message !== "object") return;
    if (message.event === "ready") this.#attempts = 0;
    this.emit("message", message);
  }

  #onExit(child, code) {
    if (this.#child !== child) return;
    this.#child = null;
    if (this.#stopping) return;
    this.emit("down", code);
    if (this.#attempts >= this.maxRestarts) {
      this.emit("gave-up");
      return;
    }
    const delay = Math.min(this.maxDelayMs, this.baseDelayMs * 2 ** this.#attempts);
    this.#attempts += 1;
    this.#restartTimer = setTimeout(() => {
      this.#restartTimer = null;
      if (!this.#stopping) this.start();
    }, delay);
  }
}
