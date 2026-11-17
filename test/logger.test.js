import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLogger } from "../src/logger.js";

const NOW = () => new Date("2026-01-02T03:04:05.000Z");
const TS = "2026-01-02T03:04:05.000Z";

function setup(extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), "aic-log-"));
  const out = [];
  const err = [];
  const file = join(dir, "t.log");
  const logger = createLogger({
    file, now: NOW, stdout: { write: s => out.push(s) }, stderr: { write: s => err.push(s) }, ...extra
  });
  return { dir, file, out, err, logger };
}

test("log and error write the formatted line to the stream and the file", () => {
  const { file, out, err, logger } = setup();
  logger.log("hello");
  logger.error("boom");
  assert.deepEqual(out, [`${TS} INFO hello\n`]);
  assert.deepEqual(err, [`${TS} ERROR boom\n`]);
  assert.equal(readFileSync(file, "utf-8"), `${TS} INFO hello\n${TS} ERROR boom\n`);
  assert.equal(logger.file, file);
});

test("rotates to <file>.1 when the size limit would be exceeded", () => {
  const { file, logger } = setup({ maxBytes: 100 });
  const lines = [];
  for (let i = 0; i < 4; i++) {
    logger.log(`line-${i}`);
    lines.push(`${TS} INFO line-${i}\n`);
  }
  // each line is 37 bytes: two fit in 100, the third rotates, the fourth fits next to it
  assert.equal(readFileSync(file + ".1", "utf-8"), lines[0] + lines[1]);
  assert.equal(readFileSync(file, "utf-8"), lines[2] + lines[3]);
  logger.log("line-4");
  logger.log("line-5");
  assert.equal(readFileSync(file + ".1", "utf-8"), lines[2] + lines[3]);
  assert.equal(readFileSync(file, "utf-8"), `${TS} INFO line-4\n${TS} INFO line-5\n`);
});

test("an unwritable file is reported once and never throws", () => {
  const { dir, err, out, logger } = setup({ file: join(tmpdir(), "aic-no-such-dir-x", "sub", "t.log") });
  assert.doesNotThrow(() => { logger.log("a"); logger.error("b"); logger.log("c"); });
  const reports = err.filter(line => line.includes("cannot write log file"));
  assert.equal(reports.length, 1);
  assert.match(reports[0], new RegExp(`^${TS} ERROR cannot write log file .*t\\.log: `));
  assert.equal(out.length, 2);
  assert.equal(err.length, 2); // the one report plus the error line itself
  assert.equal(existsSync(join(dir, "t.log")), false);
});

test("file null touches no file", () => {
  const { dir, out, logger } = setup({ file: null });
  logger.log("x");
  assert.deepEqual(out, [`${TS} INFO x\n`]);
  assert.equal(existsSync(join(dir, "t.log")), false);
});
