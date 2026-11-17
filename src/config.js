import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { CONFIG_FILE } from "./paths.js";

export const DEFAULT_CONFIG = Object.freeze({
  port: 7399,
  soundsDir: "%USERPROFILE%\\.claude-sound",
  confirmSoundDir: "%USERPROFILE%\\.claude-sound\\confirm",
  confirmTimeoutSec: 30
});

/** Expands Windows-style %NAME% variables; unknown ones stay as written. */
export function expandEnv(value, env = process.env) {
  return value.replace(/%([^%]+)%/g, (match, name) => env[name] ?? match);
}

function check(ok, key, what) {
  if (!ok) throw new Error(`config.json: "${key}" must be ${what}`);
}

const isPath = value => typeof value === "string" && value.trim().length > 0;

export function loadConfig(file = CONFIG_FILE, env = process.env) {
  let raw = {};
  if (!existsSync(file)) {
    writeFileSync(file, JSON.stringify(DEFAULT_CONFIG, null, 2) + "\n", "utf-8");
  } else {
    const text = readFileSync(file, "utf-8").replace(/^\uFEFF/, "");
    try {
      raw = JSON.parse(text);
    } catch (error) {
      throw new Error(`Invalid JSON in ${file}: ${error.message}`);
    }
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`config.json must contain a JSON object (${file})`);
  }

  const merged = {};
  for (const key of Object.keys(DEFAULT_CONFIG)) {
    merged[key] = Object.hasOwn(raw, key) ? raw[key] : DEFAULT_CONFIG[key];
  }
  check(Number.isInteger(merged.port) && merged.port >= 1 && merged.port <= 65535, "port", "an integer 1-65535");
  check(isPath(merged.soundsDir), "soundsDir", "a non-empty path");
  check(isPath(merged.confirmSoundDir), "confirmSoundDir", "a non-empty path");
  check(Number.isInteger(merged.confirmTimeoutSec) && merged.confirmTimeoutSec >= 5 && merged.confirmTimeoutSec <= 600,
    "confirmTimeoutSec", "an integer 5-600");

  return Object.freeze({
    port: merged.port,
    soundsDir: expandEnv(merged.soundsDir, env),
    confirmSoundDir: expandEnv(merged.confirmSoundDir, env),
    confirmTimeoutSec: merged.confirmTimeoutSec
  });
}
