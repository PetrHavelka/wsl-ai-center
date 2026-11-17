import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG, expandEnv, loadConfig } from "../src/config.js";

const ENV = { USERPROFILE: "C:\\Users\\me" };
function tempFile() {
  return join(mkdtempSync(join(tmpdir(), "aic-config-")), "config.json");
}

test("creates config.json with defaults when missing", () => {
  const file = tempFile();
  const config = loadConfig(file, ENV);
  assert.deepEqual(JSON.parse(readFileSync(file, "utf-8")), DEFAULT_CONFIG);
  assert.deepEqual(config, {
    port: 7399,
    soundsDir: "C:\\Users\\me\\.claude-sound",
    confirmSoundDir: "C:\\Users\\me\\.claude-sound\\confirm",
    confirmTimeoutSec: 30
  });
});

test("merges a partial config over defaults, ignores unknown keys, strips BOM", () => {
  const file = tempFile();
  writeFileSync(file, "\uFEFF" + JSON.stringify({ port: 8000, extra: 1, soundsDir: "D:\\s" }));
  const config = loadConfig(file, ENV);
  assert.equal(config.port, 8000);
  assert.equal(config.soundsDir, "D:\\s");
  assert.equal(config.confirmTimeoutSec, 30);
  assert.equal("extra" in config, false);
});

test("expandEnv leaves unknown variables untouched", () => {
  assert.equal(expandEnv("%USERPROFILE%\\a\\%NOPE%", ENV), "C:\\Users\\me\\a\\%NOPE%");
});

test("rejects invalid JSON", () => {
  const file = tempFile();
  writeFileSync(file, "{ nope");
  assert.throws(() => loadConfig(file, ENV), /Invalid JSON/);
});

test("rejects a non-object", () => {
  const file = tempFile();
  writeFileSync(file, "[1]");
  assert.throws(() => loadConfig(file, ENV), /config\.json/);
});

test("rejects invalid values", () => {
  const bad = [
    { port: 0 }, { port: "80" }, { port: 70000 }, { soundsDir: "" }, { confirmSoundDir: 5 },
    { confirmTimeoutSec: 2 }, { confirmTimeoutSec: 1.5 }, { confirmTimeoutSec: 601 }
  ];
  for (const value of bad) {
    const file = tempFile();
    writeFileSync(file, JSON.stringify(value));
    assert.throws(() => loadConfig(file, ENV), /config\.json: "/, JSON.stringify(value));
  }
});
