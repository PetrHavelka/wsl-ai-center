import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { CONFIG_FILE } from "../src/paths.js";
import { DEFAULT_CONFIG, expandEnv, loadConfig } from "../src/config.js";

const ENV = { USERPROFILE: "C:\\Users\\me" };
function tempFile() {
  return join(mkdtempSync(join(tmpdir(), "aic-config-")), "config.json");
}

const DEFAULT_WSL_PROXY = { enabled: true, interfaceAlias: "vEthernet (WSL*)", wslSubnet: "172.16.0.0/12" };

test("missing config.json is an error and nothing is created", () => {
  const file = tempFile();
  assert.throws(() => loadConfig(file, ENV), /config\.json not found/);
  assert.equal(existsSync(file), false);
});

test("a full default file returns expanded defaults", () => {
  const file = tempFile();
  writeFileSync(file, JSON.stringify(DEFAULT_CONFIG, null, 2));
  const config = loadConfig(file, ENV);
  assert.deepEqual(config, {
    port: 7399,
    soundsDir: "C:\\Users\\me\\.claude-sound",
    confirmSoundDir: "C:\\Users\\me\\.claude-sound\\confirm",
    confirmTimeoutSec: 30,
    logFile: join(dirname(file), "wsl-ai-center.log"),
    wslProxy: DEFAULT_WSL_PROXY
  });
  assert.equal(Object.isFrozen(config), true);
  assert.equal(Object.isFrozen(config.wslProxy), true);
});

test("wslProxy merges per sub-key over defaults", () => {
  const file = tempFile();
  writeFileSync(file, JSON.stringify({ wslProxy: { enabled: false } }));
  assert.deepEqual(loadConfig(file, ENV).wslProxy, { ...DEFAULT_WSL_PROXY, enabled: false });
});

test("logFile: absolute kept, %VAR% expanded", () => {
  let file = tempFile();
  writeFileSync(file, JSON.stringify({ logFile: "/tmp/x.log" }));
  assert.equal(loadConfig(file, ENV).logFile, resolve("/tmp/x.log"));
  file = tempFile();
  writeFileSync(file, JSON.stringify({ logFile: "%LOGDIR%/y.log" }));
  assert.equal(loadConfig(file, { LOGDIR: "/var/l" }).logFile, resolve("/var/l/y.log"));
});

test("the committed config.json equals DEFAULT_CONFIG", () => {
  const text = readFileSync(CONFIG_FILE, "utf-8");
  assert.deepEqual(JSON.parse(text), DEFAULT_CONFIG);
  assert.equal(text, JSON.stringify(DEFAULT_CONFIG, null, 2) + "\n");
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
    { confirmTimeoutSec: 2 }, { confirmTimeoutSec: 1.5 }, { confirmTimeoutSec: 601 },
    { logFile: "" }, { wslProxy: 5 }, { wslProxy: { enabled: "yes" } }, { wslProxy: { interfaceAlias: "" } },
    { wslProxy: { wslSubnet: "abc" } }, { wslProxy: { wslSubnet: "999.9.9.9/16" } },
    { wslProxy: { wslSubnet: "10.0.0.0/33" } }
  ];
  for (const value of bad) {
    const file = tempFile();
    writeFileSync(file, JSON.stringify(value));
    assert.throws(() => loadConfig(file, ENV), /config\.json: "/, JSON.stringify(value));
  }
});
