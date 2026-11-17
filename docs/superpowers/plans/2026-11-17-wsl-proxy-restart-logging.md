# WSL proxy, restart, logging — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `config.json` in the repo, log every API call to stdout + file, accept WSL requests coming through a `netsh portproxy`, create that proxy on app start via a one-time admin setup, and add "Restartovat" to the tray menu.

**Architecture:** Node stays the brain: a new `logger.js` (stdout + rotating file), `wslProxy.js` (find WSL interface, run the scheduled task, verify the proxy) and an in-process restart in `main.js`. Windows-admin work lives in two PowerShell scripts (`scripts/setup.ps1`, `scripts/wsl-proxy.ps1`) behind `setup.cmd`; `start.cmd` launches the app.

**Tech Stack:** Node ≥ 20 ESM, `node:test`, no npm deps; Windows PowerShell 5.1; `netsh`, `schtasks`, NetSecurity / ScheduledTasks cmdlets.

**Spec:** `docs/superpowers/specs/2026-11-17-ai-center-design.md` — section "Rozšíření 2" is binding for this plan; the earlier sections still hold where not changed.

## Global Constraints

- Windows only; nothing user- or machine-specific hardcoded: paths derive from the app folder (`$PSScriptRoot`, `APP_ROOT`) and `config.json`.
- No npm dependencies. `src/*.js` pure ASCII except existing `·` literals; escapes stay escapes (`\uFEFF`).
- `config.json` is committed with all defaults; the app only reads it; missing file → startup error naming the file.
- Defaults: `port` 7399, `soundsDir` `%USERPROFILE%\.claude-sound`, `confirmSoundDir` `%USERPROFILE%\.claude-sound\confirm`, `confirmTimeoutSec` 30, `logFile` `wsl-ai-center.log`, `wslProxy.enabled` true, `wslProxy.interfaceAlias` `vEthernet (WSL*)`, `wslProxy.wslSubnet` `172.16.0.0/12`.
- Scheduled task name and firewall rule display name: exactly `wsl-ai-center proxy`.
- Proxy maps `<WSL host IP>:<port>` → `127.0.0.1:<port>`; proxy log file `wsl-proxy.log` in the app folder.
- No periodic polling of the WSL interface; proxy is ensured at start and on menu restart only; proxy problems never stop the app.
- Log line: `<ISO time> INFO|ERROR <message>`; one line per API call after it finishes: `<METHOD> <path> <status|-> <ms>ms <summary>`; console URL query masked as `?***`; log file rotates at 5 MB to `<logFile>.1`.
- Allowed Host: `localhost:<port>`, `[::1]:<port>`, any IPv4 literal `:<port>`; Origin → 403, non-JSON POST → 415, `/sound` keeps 200 with reasons.
- `.ps1` files UTF-8 **with BOM**; `.cmd` files CRLF (enforced via `.gitattributes`).
- Every commit message ends with a blank line and `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## File Structure

```
config.json            NEW, committed defaults
.gitignore             drop config.json; add *.log, *.log.1
.gitattributes         NEW: *.cmd text eol=crlf
setup.cmd              NEW
start.cmd              NEW
scripts/setup.ps1      NEW
scripts/wsl-proxy.ps1  NEW
src/config.js          read-only config, logFile, wslProxy
src/logger.js          NEW
src/server.js          request logging, Host rule
src/wslProxy.js        NEW
src/helper.js          stop() returns a Promise
src/app.js             "restart" helper event → onRestart
src/main.js            start/stop/restart lifecycle, logger, proxy
helper/tray.ps1        "Restartovat" menu item
README.md              install/setup/start/WSL/logging/restart
test/config.test.js test/logger.test.js test/server.test.js test/wslProxy.test.js test/helper.test.js test/app.test.js
example/               DELETE (user's sample, not part of the app)
```

---

### Task 1: config.json in the repo + new keys

**Files:** Modify `src/config.js`, `.gitignore`, `test/config.test.js`; Create `config.json`.

**Interfaces — produces:** `DEFAULT_CONFIG` gains `logFile: "wsl-ai-center.log"` and `wslProxy: { enabled: true, interfaceAlias: "vEthernet (WSL*)", wslSubnet: "172.16.0.0/12" }` (frozen, nested frozen). `loadConfig(file = CONFIG_FILE, env = process.env)` returns frozen `{ port, soundsDir, confirmSoundDir, confirmTimeoutSec, logFile, wslProxy: { enabled, interfaceAlias, wslSubnet } }` where `logFile` is env-expanded and resolved to an absolute path against `dirname(file)` when relative.

Behavior:
- Missing file → `throw new Error(\`config.json not found (${file})\`)` — the function never writes files any more.
- `wslProxy` merges per sub-key over defaults (a config with `"wslProxy": {"enabled": false}` keeps default alias and subnet). A non-object `wslProxy` → error.
- Validation (message format unchanged `config.json: "<key>" must be …`, nested keys named `wslProxy.enabled` etc.): `logFile` non-empty string; `wslProxy.enabled` boolean; `wslProxy.interfaceAlias` non-empty string; `wslProxy.wslSubnet` matches `/^\d{1,3}(\.\d{1,3}){3}\/\d{1,2}$/`.
- `config.json` content = `JSON.stringify(DEFAULT_CONFIG, null, 2) + "\n"` (pretty, LF, no BOM).
- `.gitignore`: remove `config.json`; add `*.log` and `*.log.1`.

Tests (adapt existing ones; the "creates config.json with defaults when missing" test becomes "missing config.json is an error"):
- missing file → throws `/config\.json not found/`, and no file is created;
- full default file → returns expanded defaults, `logFile` === `join(dir, "wsl-ai-center.log")`, `wslProxy` equals defaults;
- partial `wslProxy` merges; absolute `logFile` (e.g. `/tmp/x.log` on Linux) kept as is; `%VAR%` in `logFile` expanded;
- invalid: `logFile: ""`, `wslProxy: 5`, `wslProxy.enabled: "yes"`, `wslProxy.interfaceAlias: ""`, `wslProxy.wslSubnet: "abc"` → throw `/config\.json: "/`;
- the committed `config.json` in the repo root parses and deep-equals `DEFAULT_CONFIG` (guards drift).

- [ ] Write/adjust tests, run `node --test test/config.test.js` → FAIL
- [ ] Implement, run → PASS; `npm test` green
- [ ] Commit `feat: ship config.json and add logFile and wslProxy settings`

---

### Task 2: Logger (stdout + rotating file)

**Files:** Create `src/logger.js`, `test/logger.test.js`.

**Interfaces — produces:** `createLogger({ file, maxBytes = 5 * 1024 * 1024, stdout = process.stdout, stderr = process.stderr, now = () => new Date() }) → { log(message: string): void, error(message: string): void, file }`.

Behavior:
- Line = `${now().toISOString()} INFO ${message}` (or `ERROR`), newline-terminated. `log` → `stdout.write(line)`, `error` → `stderr.write(line)`; both append the same line to `file` (`appendFileSync`, utf-8).
- Before appending: if the file exists and `size + Buffer.byteLength(line) > maxBytes`, `renameSync(file, file + ".1")` (overwriting an old `.1`).
- `file` may be null/undefined → console only.
- Any file error (missing directory, permission) is reported once on `stderr` as `<time> ERROR cannot write log file <file>: <msg>` and further file writes are skipped; the logger never throws.

Tests (temp dirs, fake `stdout`/`stderr` collecting strings, fixed `now`):
- log/error write the formatted line to the right stream and to the file;
- rotation: with `maxBytes: 100`, writing lines until over the limit produces `<file>.1` holding the earlier lines and `<file>` holding the newest line only;
- unwritable file (path inside a non-existent dir) → one ERROR on stderr, later calls do not throw and do not repeat the error;
- `file: null` → no file touched.

- [ ] Tests → FAIL; implement → PASS
- [ ] Commit `feat: logger writing to stdout and a rotating log file`

---

### Task 3: Request logging + Host rule in the server

**Files:** Modify `src/server.js`, `test/server.test.js`.

**Interfaces — consumes:** a logger with `log`/`error` (Task 2 shape). `createServer(app, { logger })` unchanged signature.

Behavior:
- Every request produces exactly one `logger.log` line when the response finishes or the connection closes: `${method} ${path} ${status} ${ms}ms${summary ? " " + summary : ""}`, where `status` is `res.statusCode` if headers were sent, else `-`; `path` is the pathname (no query).
- Summaries (set by the handlers through a per-request context object):
  - `/sound`: `category=<value> -> played <file>` or `-> <reason>` (category printed as given, `JSON.stringify`-ed if not a string, `?` if body unusable);
  - `/open`: `url=<href> -> opened|rejected|timeout|helper-restarted|shutdown|queue-full|client-closed`; invalid URL → `url=<raw value truncated to 200 chars> -> invalid`;
  - `/console-url` POST: `url=<href with query replaced by ?***>` (or `-> invalid`), DELETE: `cleared`;
  - refused: `forbidden origin=<origin or -> host=<host or ->`, `unsupported content-type=<value or ->`.
- 500 path: keep `logger.error("Request failed: …")`, the request line is still logged.
- Host rule: allowed when Host is `localhost:<port>`, `[::1]:<port>`, or `<a>.<b>.<c>.<d>:<port>` with each octet 0–255 (port = `req.socket.localPort`). Everything else (missing Host, names, wrong port) → forbidden as today.

Tests (logger fake collecting lines; existing tests keep passing):
- `/sound` done → one line matching `/^POST \/sound 200 \d+ms category=done -> played x\.wav$/`;
- `/open` rejected → line ends `-> rejected`; client abort → line contains `- ` status or `client-closed`;
- `/console-url` with `?t=secret` → line contains `?***` and not `secret`;
- Host `172.31.176.1:<port>` accepted on `/health`; `evil.example:<port>`, `999.1.1.1:<port>`, `172.31.176.1:1` refused; Origin refusal line contains `forbidden origin=`.

- [ ] Tests → FAIL; implement → PASS; `npm test` green
- [ ] Commit `feat: log every API call and accept IPv4 hosts for the WSL proxy`

---

### Task 4: WSL proxy at startup (Node side)

**Files:** Create `src/wslProxy.js`, `test/wslProxy.test.js`.

**Interfaces — produces:**
- `PROXY_TASK_NAME = "wsl-ai-center proxy"`
- `aliasToRegExp(alias: string): RegExp` — escapes regex characters, `*` → `.*`, anchored `^…$`, case-insensitive.
- `findWslHostIp(alias, interfaces = os.networkInterfaces()): string | null` — first non-internal IPv4 address (`family === "IPv4"` or `4`) of the first interface whose name matches.
- `runCommand(command, args): Promise<{ code: number, stdout: string }>` — `execFile` with `windowsHide: true`; never rejects (spawn error → `{ code: -1, stdout: "" }`).
- `ensureWslProxy({ config, logger, interfaces = os.networkInterfaces, run = runCommand, sleep = ms => new Promise(r => setTimeout(r, ms)), timeoutMs = 15000, pollMs = 500 }): Promise<"disabled"|"no-wsl"|"active"|"created"|"no-task"|"timeout">` — never rejects.

Behavior:
1. `config.wslProxy.enabled === false` → log `WSL proxy disabled in config.json` → `"disabled"`.
2. No matching interface → log `WSL network interface "<alias>" not found (WSL not running or mirrored networking) - proxy skipped` → `"no-wsl"`.
3. Proxy active check: `run("netsh", ["interface", "portproxy", "show", "v4tov4"])`, active when a stdout line matches `^\s*<ip escaped>\s+<port>\s`. Active → log `WSL proxy active: <ip>:<port> -> 127.0.0.1:<port>` → `"active"`.
4. `run("schtasks", ["/run", "/tn", PROXY_TASK_NAME])`; non-zero code → `logger.error('Cannot run scheduled task "wsl-ai-center proxy" - run setup.cmd once (needs admin)')` → `"no-task"`.
5. Poll the active check every `pollMs` until `timeoutMs`; success → log `WSL proxy ready: from WSL use http://<ip>:<port>` → `"created"`; else `logger.error("WSL proxy not created within <s> s - see wsl-proxy.log")` → `"timeout"`.

Tests with fake `interfaces` (object like `os.networkInterfaces()` output), fake `run` recording calls and returning scripted results, `sleep` resolving immediately, small `timeoutMs`:
- aliasToRegExp matches `vEthernet (WSL (Hyper-V firewall))` and `vEthernet (WSL)` for `vEthernet (WSL*)`, not `Ethernet`; parentheses are literal;
- findWslHostIp skips internal and IPv6, returns null without a match;
- each of the 6 outcomes, asserting the commands run (e.g. `"active"` never calls schtasks) and the logged message.

- [ ] Tests → FAIL; implement → PASS
- [ ] Commit `feat: ensure the WSL port proxy at startup`

---

### Task 5: Restart (helper stop promise, app event, main lifecycle, menu item)

**Files:** Modify `src/helper.js`, `test/helper.test.js`, `src/app.js`, `test/app.test.js`, `src/main.js`, `helper/tray.ps1`.

**Interfaces:**
- `Helper.stop(): Promise<void>` — resolves when the current child has exited (or immediately if none); kill fallback after 3 s stays. Existing behavior otherwise unchanged.
- `createApp({ …, onRestart })` — helper message `{ event: "restart" }` calls `onRestart()`.
- `main.js` (Windows only, no unit test): logger from `createLogger({ file: config.logFile })`; functions:
  - `start()`: `loadConfig()`, create logger, helper, app (`onExit: () => shutdown(0)`, `onRestart: () => restart()`), wire helper events as today, create server with the logger, listen on `127.0.0.1:config.port` (await), then `helper.start()` and `ensureWslProxy({ config, logger })` (not awaited by start; its result only logs). Log `AI Center <version> listening on http://127.0.0.1:<port>`.
  - `stop()`: `app.shutdown()`, `server.close()` + `closeAllConnections()` after 1 s (unref'd), await both `helper.stop()` and the server's close callback.
  - `restart()`: guarded against re-entry; log `Restarting`; `await stop()`; `await start()`; any error (invalid config, EADDRINUSE…) → `console.error` + log, `process.exit(1)`.
  - `shutdown(code)`: guarded; log `Shutting down`; `await stop()`; `process.exit(code)`; hard exit after 5 s (unref'd timer).
  - Startup errors (config, EADDRINUSE) → message to stderr and exit 1, as today. Platform guard unchanged.
  - Signals SIGINT/SIGTERM/SIGHUP → `shutdown(0)`.
- `helper/tray.ps1`: new `ToolStripMenuItem 'Restartovat'` inserted right before `Ukončit` (after the existing separator); click → `Send-Event @{ event = 'restart' }`. Keep the UTF-8 BOM; no other changes.

Tests:
- helper: `stop()` returns a promise that resolves after the fake child emits `exit`; `stop()` with no child resolves immediately;
- app: `{ event: "restart" }` calls `onRestart` once.
- main.js: `node --check src/main.js`; on Linux `node src/main.js` still prints the Windows-only message with exit 1.

- [ ] Tests → FAIL; implement → PASS; `npm test` green; BOM check `head -c 3 helper/tray.ps1 | xxd` → `efbb bf`
- [ ] Commit `feat: restart from the tray menu and in-process lifecycle`

---

### Task 6: Setup and start scripts

**Files:** Create `setup.cmd`, `start.cmd`, `scripts/setup.ps1`, `scripts/wsl-proxy.ps1`, `.gitattributes`.

- `.gitattributes`: `*.cmd text eol=crlf`. Write the `.cmd` files with CRLF line endings in the working tree too (verify with `file setup.cmd` → "CRLF").
- `setup.cmd`: `@echo off` + `powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\setup.ps1" %*`
- `start.cmd`: `@echo off`; if `where node` fails → print `Node.js 20+ not found in PATH - install it from https://nodejs.org` and `pause`, `exit /b 1`; else `node "%~dp0src\main.js" %*`.
- Both `.ps1`: UTF-8 with BOM, `$ErrorActionPreference = 'Stop'`, read config with `Get-Content -Raw -Encoding UTF8 (Join-Path $PSScriptRoot '..\config.json') | ConvertFrom-Json`, falling back to the Global-Constraints defaults for missing keys (`port`, `wslProxy.interfaceAlias`, `wslProxy.wslSubnet`). App root = `Split-Path -Parent $PSScriptRoot` (resolved full path). Names `$TASK_NAME = $RULE_NAME = 'wsl-ai-center proxy'`.
- `scripts/setup.ps1` `param([switch]$Remove)` — modeled on the user's former example:
  - refuse to run when the app root starts with `\\` (UNC / `\\wsl.localhost`): print that the app must be cloned to a Windows drive, wait for Enter, exit 1;
  - not admin → relaunch itself elevated (`Start-Process powershell.exe -Verb RunAs` with `-NoProfile -ExecutionPolicy Bypass -File "<PSCommandPath>"` and `-Remove` when given) and exit;
  - install: remove + recreate firewall rule (`New-NetFirewallRule -DisplayName $RULE_NAME -Direction Inbound -Protocol TCP -LocalPort <port> -RemoteAddress <wslSubnet> -Action Allow`), register task (`New-ScheduledTaskAction -Execute 'powershell.exe' -Argument '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "<root>\scripts\wsl-proxy.ps1"'`, principal `"$env:USERDOMAIN\$env:USERNAME"` Interactive, RunLevel Highest, `-Force`); print what was created and the next step (`start.cmd`);
  - `-Remove`: remove the rule, unregister the task, delete every `netsh interface portproxy` v4tov4 entry listening on `<port>`;
  - errors printed in red; always end with `Read-Host 'Press Enter to close'`.
- `scripts/wsl-proxy.ps1` (no params, runs elevated from the task): log function appending `"<yyyy-MM-ddTHH:mm:ss> <msg>"` to `<root>\wsl-proxy.log` (UTF-8); `Start-Service iphlpsvc`; IPv4 of `Get-NetIPAddress -AddressFamily IPv4 -InterfaceAlias <alias>` (first) else log `ERROR: interface '<alias>' not found. Is WSL running?` and exit 1; delete stale `portproxy` entries on `<port>` (parse `netsh interface portproxy show v4tov4` lines `^\s*(\S+)\s+<port>\s`); `netsh interface portproxy add v4tov4 listenaddress=<ip> listenport=<port> connectaddress=127.0.0.1 connectport=<port>`; log `OK: <ip>:<port> -> 127.0.0.1:<port>`; any exception → log `ERROR: …`, exit 1.
- No automated tests (Windows-only). Verify: BOM on both `.ps1`, CRLF on both `.cmd`, `grep` that no user-specific path (`D:\`, `C:\Users`, a user name) appears.

- [ ] Write files; run the checks
- [ ] Commit `feat: one-time setup and start scripts for the WSL proxy`

---

### Task 7: README, remove example

**Files:** Modify `README.md`; Delete `example/` (untracked user sample: `rm -rf example`).

README must cover, in this order: what it is; requirements (Windows, Node 20+ in PATH, app cloned to a Windows drive, not `\\wsl.localhost`); install (`git clone … C:\Tools\wsl-ai-center` as an example path, edit `config.json`); one-time `setup.cmd` (UAC, what it creates, rerun after changing `port`/`wslSubnet`, `setup.cmd -Remove`); start with `start.cmd`; tray menu (Zvuky, console, Restartovat, Ukončit) and that Restartovat re-reads config and re-creates the proxy (use it after `wsl --shutdown` / Windows restart); configuration table for every key incl. `logFile` and `wslProxy.*`; API (existing table, add that Host may be any IPv4 for WSL); logging (stdout + file, rotation, line format, masked token, `wsl-proxy.log`); hooks: Windows example (existing) and WSL example using `http://$(ip route | awk '/default/ {print $3}'):7399` with `-m 2 … || true`; mirrored networking note (then `127.0.0.1` works and the proxy is skipped automatically); tests (`npm test`). Keep README in English like now.

- [ ] Write README; `rm -rf example`; `git status` shows no `example/`
- [ ] Commit `docs: README for setup, start, WSL proxy, logging and restart`
