import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SOUND_CATEGORIES, pickRandomWav } from "../src/sounds.js";

function tempDir() {
  return mkdtempSync(join(tmpdir(), "aic-sounds-"));
}

test("categories are fixed", () => {
  assert.deepEqual([...SOUND_CATEGORIES], ["fail", "done", "ask", "waiting60s"]);
});

test("picks only .wav files, case-insensitive, ignoring folders", () => {
  const dir = tempDir();
  writeFileSync(join(dir, "a.wav"), "");
  writeFileSync(join(dir, "B.WAV"), "");
  writeFileSync(join(dir, "c.mp3"), "");
  mkdirSync(join(dir, "d.wav"));
  // sorted by code unit: ["B.WAV", "a.wav"]
  assert.equal(pickRandomWav(dir, () => 0), join(dir, "B.WAV"));
  assert.equal(pickRandomWav(dir, () => 0.99), join(dir, "a.wav"));
});

test("missing or empty folder gives null", () => {
  assert.equal(pickRandomWav(join(tempDir(), "nope")), null);
  assert.equal(pickRandomWav(tempDir()), null);
});
