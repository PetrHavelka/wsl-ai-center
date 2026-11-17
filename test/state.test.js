import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadState, saveState } from "../src/state.js";

function tempDir() {
  return mkdtempSync(join(tmpdir(), "aic-state-"));
}

test("missing file means sound is on", () => {
  assert.deepEqual(loadState(join(tempDir(), "state.json")), { soundEnabled: true });
});

test("broken file means sound is on", () => {
  const file = join(tempDir(), "state.json");
  writeFileSync(file, "garbage");
  assert.deepEqual(loadState(file), { soundEnabled: true });
});

test("reads soundEnabled false, with BOM", () => {
  const file = join(tempDir(), "state.json");
  writeFileSync(file, "\uFEFF" + JSON.stringify({ soundEnabled: false }));
  assert.deepEqual(loadState(file), { soundEnabled: false });
});

test("save then load round-trips and leaves no temp file", () => {
  const dir = tempDir();
  const file = join(dir, "state.json");
  saveState(file, { soundEnabled: false });
  assert.deepEqual(loadState(file), { soundEnabled: false });
  saveState(file, { soundEnabled: true });
  assert.deepEqual(loadState(file), { soundEnabled: true });
  assert.deepEqual(readdirSync(dir), ["state.json"]);
});
