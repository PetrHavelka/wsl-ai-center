import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { CONFIG_FILE } from "./paths.js";

export const DEFAULT_CONFIG = Object.freeze({
  port: 7399,
  soundsDir: "%USERPROFILE%\\.claude-sound",
  confirmSoundDir: "%USERPROFILE%\\.claude-sound\\confirm",
  confirmTimeoutSec: 30,
  logFile: "wsl-ai-center.log",
  wslProxy: Object.freeze({
    enabled: true,
    interfaceAlias: "vEthernet (WSL*)",
    wslSubnet: "172.16.0.0/12"
  })
});

/** Expands Windows-style %NAME% variables; unknown ones stay as written. */
export function expandEnv(value, env = process.env) {
  return value.replace(/%([^%]+)%/g, (match, name) => env[name] ?? match);
}

function check(ok, key, what) {
  if (!ok) throw new Error(`config.json: "${key}" must be ${what}`);
}

function isSubnet(value) {
  const match = typeof value === "string" ? /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/.exec(value) : null;
  return match !== null && match.slice(1, 5).every(octet => Number(octet) <= 255) && Number(match[5]) <= 32;
}

const isPath = value => typeof value === "string" && value.trim().length > 0;

export function loadConfig(file = CONFIG_FILE, env = process.env) {
  if (!existsSync(file)) throw new Error(`config.json not found (${file})`);
  let raw;
  try {
    raw = JSON.parse(readFileSync(file, "utf-8").replace(/^\uFEFF/, ""));
  } catch (error) {
    throw new Error(`Invalid JSON in ${file}: ${error.message}`);
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`config.json must contain a JSON object (${file})`);
  }

  const merged = {};
  for (const key of Object.keys(DEFAULT_CONFIG)) {
    merged[key] = Object.hasOwn(raw, key) ? raw[key] : DEFAULT_CONFIG[key];
  }
  const proxyRaw = merged.wslProxy;
  check(proxyRaw !== null && typeof proxyRaw === "object" && !Array.isArray(proxyRaw), "wslProxy", "an object");
  const proxy = {};
  for (const key of Object.keys(DEFAULT_CONFIG.wslProxy)) {
    proxy[key] = Object.hasOwn(proxyRaw, key) ? proxyRaw[key] : DEFAULT_CONFIG.wslProxy[key];
  }
  check(Number.isInteger(merged.port) && merged.port >= 1 && merged.port <= 65535, "port", "an integer 1-65535");
  check(isPath(merged.soundsDir), "soundsDir", "a non-empty path");
  check(isPath(merged.confirmSoundDir), "confirmSoundDir", "a non-empty path");
  check(Number.isInteger(merged.confirmTimeoutSec) && merged.confirmTimeoutSec >= 5 && merged.confirmTimeoutSec <= 600,
    "confirmTimeoutSec", "an integer 5-600");
  check(isPath(merged.logFile), "logFile", "a non-empty path");
  check(typeof proxy.enabled === "boolean", "wslProxy.enabled", "true or false");
  check(isPath(proxy.interfaceAlias), "wslProxy.interfaceAlias", "a non-empty string");
  check(isSubnet(proxy.wslSubnet),
    "wslProxy.wslSubnet", "an IPv4 subnet like 172.16.0.0/12");

  return Object.freeze({
    port: merged.port,
    soundsDir: expandEnv(merged.soundsDir, env),
    confirmSoundDir: expandEnv(merged.confirmSoundDir, env),
    confirmTimeoutSec: merged.confirmTimeoutSec,
    logFile: resolve(dirname(file), expandEnv(merged.logFile, env)),
    wslProxy: Object.freeze(proxy)
  });
}
