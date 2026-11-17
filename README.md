# AI Center

A Windows tray app with a local REST API for AI agents: it plays notification
sounds, opens web pages after you confirm them in a popup above the clock,
and gives the tray menu a link to the SkilledPlus4U MCP console.

Design: `docs/superpowers/specs/2026-11-17-ai-center-design.md`.

## Run

Requires Windows and Node ≥ 20 (`node.exe` on Windows, not in WSL). No `npm install` needed.

```powershell
node C:\path\to\wsl-ai-center\src\main.js
```

From a WSL checkout use the UNC path, e.g.
`node \\wsl.localhost\Ubuntu\home\ai\workspace\wsl-ai-center\src\main.js`
(`cmd`/`npm` do not accept UNC working directories, `node` with a full path does).

Stop it with **Ukončit** in the tray menu or Ctrl+C in its terminal.

## Configuration

`config.json` next to `package.json`, created with defaults on the first start:

```json
{
  "port": 7399,
  "soundsDir": "%USERPROFILE%\\.claude-sound",
  "confirmSoundDir": "%USERPROFILE%\\.claude-sound\\confirm",
  "confirmTimeoutSec": 30
}
```

Restart the app after editing it. `state.json` keeps the sound on/off toggle.
Both files are local and git-ignored.

Sounds: `<soundsDir>\fail`, `\done`, `\ask`, `\waiting60s` and `<confirmSoundDir>`,
each with any number of `*.wav` files; a random one is played.

## API (127.0.0.1 only)

| Endpoint | Body | Result |
|---|---|---|
| `POST /sound` | `{"category":"fail"\|"done"\|"ask"\|"waiting60s"}` | Always 200: `{"played":true,"file":…}` or `{"played":false,"reason":"muted"\|"unknown-category"\|"no-sounds"\|"bad-request"}` |
| `POST /open` | `{"url":"https://…"}` | Waits for the popup: `{"opened":true}` or `{"opened":false,"reason":"rejected"\|"timeout"\|"helper-restarted"\|"shutdown"}`; 400 non-http(s), 429 more than 10 pending |
| `POST /console-url` | `{"url":"http://127.0.0.1:…"}` | Sets the tray menu link (loopback only, 400 otherwise) |
| `DELETE /console-url` | – | Clears it |
| `GET /health` | – | `{"ok":true,"version","port","soundEnabled","consoleUrl","pendingConfirms"}` |

```bash
curl -s -X POST http://127.0.0.1:7399/sound -H "Content-Type: application/json" -d '{"category":"done"}'
curl -s -X POST http://127.0.0.1:7399/open  -H "Content-Type: application/json" -d '{"url":"https://example.com/"}'
```

## Claude Code hook (Windows)

```json
{
  "type": "command",
  "shell": "powershell",
  "async": true,
  "command": "try { Invoke-RestMethod -Method Post -Uri http://127.0.0.1:7399/sound -ContentType 'application/json' -Body '{\"category\":\"done\"}' -TimeoutSec 2 | Out-Null } catch { }"
}
```

From WSL: `curl -s -m 2 -X POST http://127.0.0.1:7399/sound -H "Content-Type: application/json" -d '{"category":"done"}' >/dev/null || true`
(needs WSL mirrored networking so that 127.0.0.1 reaches Windows).

## Tests

```bash
npm test
```

Unit tests cover everything except the PowerShell helper and `src/main.js`; those are checked by hand on Windows.
