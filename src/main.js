import { readFileSync } from "node:fs";
import { join, win32 } from "node:path";
import { APP_ROOT, CONFIG_FILE, STATE_FILE } from "./paths.js";
import { loadConfig } from "./config.js";
import { loadState, saveState } from "./state.js";
import { Helper } from "./helper.js";
import { createApp } from "./app.js";
import { createServer } from "./server.js";

const stamp = () => new Date().toISOString();
const logger = {
  log: message => console.log(`${stamp()} ${message}`),
  error: message => console.error(`${stamp()} ${message}`)
};

if (process.platform !== "win32") {
  console.error("AI Center runs on Windows only.");
  process.exit(1);
}

let config;
try {
  config = loadConfig(CONFIG_FILE);
} catch (error) {
  console.error(error.message);
  process.exit(1);
}

const { version } = JSON.parse(readFileSync(join(APP_ROOT, "package.json"), "utf-8"));

// Spawned without a shell, so the interpreter is named in full; script
// execution is commonly disabled, hence the policy bypass.
const windowsRoot = process.env.SystemRoot && win32.isAbsolute(process.env.SystemRoot)
  ? process.env.SystemRoot
  : "C:\\Windows";
const helper = new Helper({
  command: win32.join(windowsRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
  args: [
    "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden",
    "-File", join(APP_ROOT, "helper", "tray.ps1")
  ]
});

let shuttingDown = false;
function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  process.exitCode = code;
  logger.log("Shutting down");
  app.shutdown();
  helper.stop();
  server.close();
  setTimeout(() => server.closeAllConnections(), 1000).unref();
  setTimeout(() => process.exit(code), 4000).unref();
}

const app = createApp({
  config,
  helper,
  version,
  loadState: () => loadState(STATE_FILE),
  saveState: state => saveState(STATE_FILE, state),
  onExit: () => shutdown(0),
  logger
});

helper.on("message", message => app.handleHelperMessage(message));
helper.on("down", code => {
  logger.error(`Tray helper exited (code ${code}), restarting`);
  app.handleHelperDown();
});
helper.on("gave-up", () => {
  logger.error("Tray helper keeps failing - giving up.");
  shutdown(1);
});

const server = createServer(app, { logger });
server.on("error", error => {
  logger.error(error.code === "EADDRINUSE"
    ? `Port ${config.port} is already in use - is AI Center already running?`
    : `Server error: ${error.message}`);
  process.exit(1);
});
server.listen(config.port, "127.0.0.1", () => {
  logger.log(`AI Center ${version} listening on http://127.0.0.1:${config.port}`);
  helper.start();
});

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));
process.on("SIGHUP", () => shutdown(0));
