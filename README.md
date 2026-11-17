# AI Center

A Windows tray app with a local REST API for AI agents: it plays notification
sounds, opens web pages after you confirm them in a popup above the clock,
and gives the tray menu a link to the SkilledPlus4U MCP console. It can also
make the API reachable from WSL through a port proxy.

Design: `docs/superpowers/specs/2026-11-17-ai-center-design.md`.

## Requirements

- Windows
- Node.js 20+ with `node.exe` in `PATH` (Windows Node, not the one in WSL)
- The app cloned to a Windows drive, not to `\\wsl.localhost\...` or another network path

No `npm install` is needed.

## Install

```powershell
git clone <repo-url> C:\Tools\wsl-ai-center
```

(`C:\Tools\wsl-ai-center` is just an example, use any Windows folder.)
Then edit `config.json` if you want other values (see [Configuration](#configuration)).

## One-time setup (WSL proxy)

Only needed when you want to call the API from WSL (not needed with mirrored networking, see the hooks section).

```bat
setup.cmd
```

It asks for administrator rights (UAC) once and creates:

- a firewall rule `wsl-ai-center proxy` allowing TCP `port` from `wslProxy.wslSubnet`,
- a scheduled task `wsl-ai-center proxy` (highest privileges, runs `scripts\wsl-proxy.ps1`) that creates a `netsh portproxy` from the Windows IP on the WSL network to `127.0.0.1:<port>`.

To change `port` or `wslProxy.wslSubnet`: run `setup.cmd -Remove` first, then edit `config.json`, then run `setup.cmd` again. Otherwise the proxy of the old port stays in place.
`setup.cmd -Remove` deletes the rule, the task and the port proxy.

## Start

```bat
start.cmd
```

On start (and restart) the app makes sure the proxy exists by running the scheduled task; no admin rights are needed.

## Tray menu

- **Zvuky**: sounds on/off (kept in `state.json`)
- **Otevřít SkilledPlus4U MCP Console**: opens the console link set via `POST /console-url`
- **Restartovat**: restarts the app in the same process: re-reads `config.json` and re-creates the proxy. Use it after `wsl --shutdown` or a Windows restart (the WSL IP changes then).
- **Ukončit**: quits the app (or Ctrl+C in its terminal)

## Configuration

`config.json` next to `package.json`. Missing keys use the defaults. Restart the app (tray menu) after editing it.
`state.json` is local and git-ignored.

| Key | Default | Meaning |
|---|---|---|
| `port` | `7399` | API port (1-65535) |
| `soundsDir` | `%USERPROFILE%\.claude-sound` | Folder with `fail`, `done`, `ask`, `waiting60s` subfolders of `*.wav` files; a random one is played |
| `confirmSoundDir` | `%USERPROFILE%\.claude-sound\confirm` | `*.wav` files played when the open-URL popup appears |
| `confirmTimeoutSec` | `30` | Popup timeout (5-600) |
| `logFile` | `wsl-ai-center.log` | Log file; a relative path is relative to the folder of `config.json` |
| `wslProxy.enabled` | `true` | `false` skips the WSL proxy |
| `wslProxy.interfaceAlias` | `vEthernet (WSL*)` | Name of the Windows network interface of WSL (`*` wildcard) |
| `wslProxy.wslSubnet` | `172.16.0.0/12` | Subnet allowed by the firewall rule |

## API

Listens on `127.0.0.1:<port>`. From WSL it is reached through the proxy, so the `Host` header may be `localhost`, `[::1]` or **any IPv4 address** with the port. POST requests need `Content-Type: application/json` (415 otherwise). Requests with an `Origin` header (i.e. from a browser) or a foreign `Host` are refused with 403; `/sound` still answers 200 with `reason` `forbidden` / `bad-request`.

| Endpoint | Body | Result |
|---|---|---|
| `POST /sound` | `{"category":"fail"\|"done"\|"ask"\|"waiting60s"}` | Always 200: `{"played":true,"file":…}` or `{"played":false,"reason":"muted"\|"unknown-category"\|"no-sounds"\|"bad-request"\|"forbidden"}` |
| `POST /open` | `{"url":"https://…"}` | Waits for the popup: `{"opened":true}` or `{"opened":false,"reason":"rejected"\|"timeout"\|"helper-restarted"\|"shutdown"}`; 400 non-http(s), 429 more than 10 pending |
| `POST /console-url` | `{"url":"http://127.0.0.1:…"}` | Sets the tray menu link (loopback only, 400 otherwise) |
| `DELETE /console-url` | – | Clears it |
| `GET /health` | – | `{"ok":true,"version","port","soundEnabled","consoleUrl","pendingConfirms"}` |

```bash
curl -s -X POST http://127.0.0.1:7399/sound -H "Content-Type: application/json" -d '{"category":"done"}'
curl -s -X POST http://127.0.0.1:7399/open  -H "Content-Type: application/json" -d '{"url":"https://example.com/"}'
```

## Logging

The app logs to stdout/stderr and to `logFile` (append, UTF-8). When the file exceeds 5 MB it is renamed to `<logFile>.1` (replacing the old one) and a new one starts. A write error never stops the app.

Line format: `<ISO time> INFO|ERROR <message>`. Every API call is one line after it completes:
`<METHOD> <path> <status> <ms>ms <summary>`, e.g.

```
POST /sound 200 3ms category=done -> played x.wav
POST /open 200 8123ms url=https://example.com/ -> rejected
POST /console-url 200 1ms url=http://127.0.0.1:36061/?***
```

The query of the console URL is masked (`?***`) because it carries a token. Start, restart, shutdown, proxy result and helper messages are logged too.
The proxy script writes its own `wsl-proxy.log` in the app folder (`OK: <ip>:<port> -> 127.0.0.1:<port>` or `ERROR: ...`).

## Claude Code hooks

Windows:

```json
{
  "type": "command",
  "shell": "powershell",
  "async": true,
  "command": "try { Invoke-RestMethod -Method Post -Uri http://127.0.0.1:7399/sound -ContentType 'application/json' -Body '{\"category\":\"done\"}' -TimeoutSec 2 | Out-Null } catch { }"
}
```

WSL (the Windows host is the default gateway; the proxy forwards it to the app):

```bash
curl -s -m 2 -X POST "http://$(ip route | awk '/default/ {print $3}'):7399/sound" -H "Content-Type: application/json" -d '{"category":"done"}' >/dev/null || true
```

With WSL **mirrored networking** (`networkingMode=mirrored` in `.wslconfig`) `127.0.0.1` reaches Windows directly: use `http://127.0.0.1:7399` instead. The app then finds no WSL interface and skips the proxy automatically.

## Tests

```bash
npm test
```

Unit tests cover everything except the PowerShell scripts, the helper and `src/main.js`; those are checked by hand on Windows.
