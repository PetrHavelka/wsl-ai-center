import { execFile } from "node:child_process";
import { networkInterfaces } from "node:os";
import { win32 } from "node:path";

export const PROXY_TASK_NAME = "wsl-ai-center proxy";

/** Full path of a System32 executable (spawned without a shell, so no PATH lookup). */
export function system32Exe(name, systemRoot = process.env.SystemRoot) {
  const root = systemRoot && win32.isAbsolute(systemRoot) ? systemRoot : "C:\\Windows";
  return win32.join(root, "System32", name);
}

/** Interface alias with `*` wildcards to an anchored, case-insensitive RegExp. */
export function aliasToRegExp(alias) {
  const body = alias.split("*").map(part => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*");
  return new RegExp(`^${body}$`, "i");
}

/** First non-internal IPv4 address of the first interface matching the alias. */
export function findWslHostIp(alias, interfaces = networkInterfaces()) {
  const re = aliasToRegExp(alias);
  for (const [name, addresses] of Object.entries(interfaces)) {
    if (!re.test(name)) continue;
    const found = (addresses ?? []).find(a => !a.internal && (a.family === "IPv4" || a.family === 4) && !a.address.startsWith("169.254."));
    return found ? found.address : null;
  }
  return null;
}

/** Runs a command; never rejects. */
export function runCommand(command, args) {
  return new Promise(resolve => {
    try {
      execFile(command, args, { windowsHide: true, timeout: 10000 }, (error, stdout) => {
        if (error && typeof error.code !== "number") return resolve({ code: -1, stdout: "" });
        resolve({ code: error ? error.code : 0, stdout: String(stdout ?? "") });
      });
    } catch {
      resolve({ code: -1, stdout: "" });
    }
  });
}

const defaultSleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/** Makes sure `<WSL host IP>:<port>` is proxied to 127.0.0.1:<port>. Never rejects. */
export async function ensureWslProxy({
  config, logger, interfaces = networkInterfaces, run = runCommand, sleep = defaultSleep,
  systemRoot = process.env.SystemRoot, timeoutMs = 15000, pollMs = 500
}) {
  try {
    const { enabled, interfaceAlias } = config.wslProxy;
    if (enabled === false) {
      logger.log("WSL proxy disabled in config.json");
      return "disabled";
    }
    const ip = findWslHostIp(interfaceAlias, interfaces());
    if (!ip) {
      logger.log(`WSL network interface "${interfaceAlias}" not found (WSL not running or mirrored networking) - proxy skipped`);
      return "no-wsl";
    }
    const netsh = system32Exe("netsh.exe", systemRoot);
    const schtasks = system32Exe("schtasks.exe", systemRoot);
    const port = config.port;
    const lineRe = new RegExp(`^\\s*${ip.replace(/\./g, "\\.")}\\s+${port}\\s`);
    const isActive = async () => {
      const { stdout } = await run(netsh, ["interface", "portproxy", "show", "v4tov4"]);
      return stdout.split(/\r?\n/).some(line => lineRe.test(line));
    };
    if (await isActive()) {
      logger.log(`WSL proxy active: ${ip}:${port} -> 127.0.0.1:${port}`);
      return "active";
    }
    const started = await run(schtasks, ["/run", "/tn", PROXY_TASK_NAME]);
    if (started.code !== 0) {
      logger.error(`Cannot run scheduled task "${PROXY_TASK_NAME}" - run setup.cmd once (needs admin)`);
      return "no-task";
    }
    for (let waited = 0; waited < timeoutMs;) {
      await sleep(pollMs);
      waited += pollMs;
      if (await isActive()) {
        logger.log(`WSL proxy ready: from WSL use http://${ip}:${port}`);
        return "created";
      }
    }
    logger.error(`WSL proxy not created within ${timeoutMs / 1000} s - see %ProgramFiles%\\wsl-ai-center\\wsl-proxy.log`);
    return "timeout";
  } catch (error) {
    try { logger.error(`WSL proxy check failed: ${error.message}`); } catch { /* never rejects */ }
    return "timeout";
  }
}
