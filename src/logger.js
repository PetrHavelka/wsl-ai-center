import { appendFileSync, existsSync, renameSync, statSync } from "node:fs";

/** Console + size-rotated file logger. Never throws. */
export function createLogger({
  file,
  maxBytes = 5 * 1024 * 1024,
  stdout = process.stdout,
  stderr = process.stderr,
  now = () => new Date()
}) {
  let fileOk = Boolean(file);

  function toFile(line) {
    if (!fileOk) return;
    try {
      if (existsSync(file) && statSync(file).size + Buffer.byteLength(line) > maxBytes) {
        renameSync(file, file + ".1");
      }
      appendFileSync(file, line, "utf-8");
    } catch (error) {
      fileOk = false;
      stderr.write(`${now().toISOString()} ERROR cannot write log file ${file}: ${error.message}\n`);
    }
  }

  function write(level, stream, message) {
    const line = `${now().toISOString()} ${level} ${message}\n`;
    try {
      stream.write(line);
    } catch {
      // console problems must not break the app
    }
    toFile(line);
  }

  return {
    file,
    log: message => write("INFO", stdout, message),
    error: message => write("ERROR", stderr, message)
  };
}
