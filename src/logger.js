import * as nodeFs from "node:fs";

const RETRY_AFTER_MS = 60 * 1000;

/** Console + size-rotated file logger. Never throws. */
export function createLogger({
  file,
  maxBytes = 5 * 1024 * 1024,
  stdout = process.stdout,
  stderr = process.stderr,
  now = () => new Date(),
  fs = nodeFs
}) {
  let disabledUntil = 0; // file logging is off until this time (ms) after an append failure

  function toFile(line) {
    if (!file) return;
    const time = now().getTime();
    if (time < disabledUntil) return;
    try {
      if (fs.existsSync(file) && fs.statSync(file).size + Buffer.byteLength(line) > maxBytes) {
        try {
          fs.renameSync(file, file + ".1");
        } catch {
          // keep appending to the current file; rotation is tried again on a later write
        }
      }
      fs.appendFileSync(file, line, "utf-8");
    } catch (error) {
      disabledUntil = time + RETRY_AFTER_MS;
      try {
        stderr.write(`${now().toISOString()} ERROR cannot write log file ${file}: ${error.message} (retry in 60 s)\n`);
      } catch {
        // the logger never throws
      }
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
