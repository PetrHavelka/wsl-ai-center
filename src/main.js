import { readFileSync } from "node:fs";
import { join, win32 } from "node:path";
import { APP_ROOT, CONFIG_FILE, STATE_FILE } from "./paths.js";
import { loadConfig } from "./config.js";
import { createLogger } from "./logger.js";
import { loadState, saveState } from "./state.js";
import { Helper } from "./helper.js";
import { createApp } from "./app.js";
import { createServer } from "./server.js";
import { ensureWslProxy } from "./wslProxy.js";

if (process.platform !== "win32") {
  console.error("AI Center runs on Windows only.");
  process.exit(1);
}

const { version } = JSON.parse(readFileSync(join(APP_ROOT, "package.json"), "utf-8"));

// Spawned without a shell, so the interpreter is named in full; script
// execution is commonly disabled, hence the policy bypass.
const windowsRoot = process.env.SystemRoot && win32.isAbsolute(process.env.SystemRoot)
  ? process.env.SystemRoot
  : "C:\\Windows";
const POWERSHELL = win32.join(windowsRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");

let logger = console;
let helper = null;
let app = null;
let server = null;
let busy = false; // restart or shutdown in progress

async function start() {
  const config = loadConfig(CONFIG_FILE);
  logger = createLogger({ file: config.logFile });
  const currentHelper = new Helper({
    command: POWERSHELL,
    args: [
      "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden",
      "-File", join(APP_ROOT, "helper", "tray.ps1")
    ]
  });
  const currentApp = createApp({
    config,
    helper: currentHelper,
    version,
    loadState: () => loadState(STATE_FILE),
    saveState: state => saveState(STATE_FILE, state),
    onExit: () => shutdown(0),
    onRestart: () => restart(),
    logger
  });
  currentHelper.on("message", message => currentApp.handleHelperMessage(message));
  currentHelper.on("down", code => {
    logger.error(`Tray helper exited (code ${code}), restarting`);
    currentApp.handleHelperDown();
  });
  currentHelper.on("gave-up", () => {
    logger.error("Tray helper keeps failing - giving up.");
    shutdown(1);
  });

  const currentServer = createServer(currentApp, { logger });
  await new Promise((resolve, reject) => {
    currentServer.once("error", error => reject(new Error(error.code === "EADDRINUSE"
      ? `Port ${config.port} is already in use - is AI Center already running?`
      : `Server error: ${error.message}`)));
    currentServer.listen(config.port, "127.0.0.1", resolve);
  });
  currentServer.on("error", error => logger.error(`Server error: ${error.message}`));
  helper = currentHelper;
  app = currentApp;
  server = currentServer;
  logger.log(`AI Center ${version} listening on http://127.0.0.1:${config.port}`);
  helper.start();
  ensureWslProxy({ config, logger }); // result only logs; never rejects
}

async function stop() {
  const currentServer = server;
  const currentHelper = helper;
  app?.shutdown();
  const closed = new Promise(resolve => {
    if (!currentServer) return resolve();
    currentServer.close(() => resolve());
    setTimeout(() => currentServer.closeAllConnections(), 1000).unref();
  });
  await Promise.all([currentHelper ? currentHelper.stop() : Promise.resolve(), closed]);
  helper = app = server = null;
}

function fatal(error) {
  console.error(error.message);
  try { logger.error(error.message); } catch { /* console already has it */ }
  process.exit(1);
}

async function restart() {
  if (busy) return;
  busy = true;
  logger.log("Restarting");
  try {
    const consoleUrl = app?.getConsoleUrl() ?? null; // survives the restart
    await stop();
    await start();
    if (consoleUrl) app.setConsoleUrl(consoleUrl);
  } catch (error) {
    fatal(error);
  }
  busy = false;
}

async function shutdown(code) {
  if (busy) return;
  busy = true;
  process.exitCode = code;
  logger.log("Shutting down");
  setTimeout(() => process.exit(code), 5000).unref();
  try {
    await stop();
  } catch (error) {
    console.error(error.message);
  }
  process.exit(code);
}

try {
  await start();
} catch (error) {
  fatal(error);
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));
process.on("SIGHUP", () => shutdown(0));
