# AI Center – návrh

Datum: 2026-11-17 · Stav: ke schválení

## Účel

Malá aplikace pro Windows, která běží na pozadí a je vidět jako ikona u hodin.
Vystavuje lokální REST API, přes které AI agenti (Claude na Windows i ve WSL)
přehrávají zvuky a žádají o otevření webové stránky. Otevření stránky musí
uživatel vždy potvrdit v okénku vpravo dole.

Bez GUI kromě ikony u hodin, jejího kontextového menu a potvrzovacího okénka.

## Rozhodnutí

| Téma | Rozhodnutí |
|---|---|
| Platforma | Windows, `node.exe` (Node ≥ 20), bez npm závislostí |
| UI | PowerShell helper s WinForms (vzor: tray v skilled-plus4u-mcp) |
| Komunikace Node ↔ helper | JSON řádky přes stdin/stdout |
| Popup | Vlastní okno bez rámečku, vždy navrchu, nebere fokus, vpravo dole nad hodinami (ověřeno demem) |
| Síť | Poslouchá jen na `127.0.0.1`, port z konfigurace |
| Autostart | Ne, spouští se ručně |
| Umístění | Samostatná složka `wsl-ai-center`, nezávislá na projektu Mimosa |

## Architektura

```
 Claude hook / agent ──HTTP──▶ Node (server, logika, validace)
                                   │ stdin  (JSON řádky: příkazy)
                                   ▼
                              PowerShell helper (WinForms)
                                   │ stdout (JSON řádky: odpovědi, události)
                                   ▼
                              ikona u hodin · menu · popup · zvuk · prohlížeč
```

- **Node** drží veškerý stav a rozhodování: konfiguraci, frontu potvrzení,
  URL konzole, zapnutí zvuku, výběr zvuku. Je testovatelný bez Windows UI.
- **Helper** je „hloupý“: zobrazuje, co mu Node řekne, a hlásí kliknutí.
  Běží po celou dobu života aplikace (smyčka WinForms `Application.Run`).

### Životní cyklus

- Start: Node načte konfiguraci, otevře port, spustí helper; po `ready` mu pošle
  `init` a `consoleUrl` (totéž po každém restartu helperu).
- Port obsazený → vypíše chybu a skončí dřív, než se objeví druhá ikona
  (= ochrana proti dvojímu spuštění).
- Helper spadne → Node ho znovu spustí s narůstající prodlevou (5 s … 60 s,
  max. 5 pokusů); čekající potvrzení skončí s důvodem `helper-restarted`.
  Dokud helper znovu nepošle `ready`, odpovídá `/open` okamžitě
  `{ "opened": false, "reason": "helper-restarted" }`.
- Node skončí → helperu se zavře stdin → helper odstraní ikonu a skončí.
- Položka menu **Ukončit** → helper pošle `exit` → Node zavře server a skončí.

## REST API

Vše JSON, tělo max. 16 KB. Neplatný JSON / chybějící pole → `400` (kromě `/sound`).

### Ochrana proti požadavkům z prohlížeče

- Požadavek s hlavičkou `Origin` nebo s hlavičkou `Host` jinou než
  `127.0.0.1:<port>` / `localhost:<port>` dostane `403 { "error": "forbidden" }`.
- `POST` s jiným `Content-Type` než `application/json` (parametry jako
  `; charset=utf-8` jsou povoleny) dostane `415`.
- Výjimka `/sound`: zůstává u `200` a nic nepřehraje,
  `{ "played": false, "reason": "forbidden" }` (Origin/Host) nebo
  `"bad-request"` (Content-Type).
- Kontroly běží po routování (404/405), před čtením těla; `GET /health`
  a `DELETE /console-url` podléhají jen kontrole Origin/Host.

### `POST /sound`

```json
{ "category": "done" }
```

- Kategorie: `fail`, `done`, `ask`, `waiting60s`.
- Z `<soundsDir>\<category>\*.wav` vybere náhodný soubor a předá ho helperu.
  Přehrává se na pozadí (`SoundPlayer.Play`), odpověď přijde hned.
- **Vždy `200`**, i při vypnutém zvuku, neznámé kategorii, chybějící/prázdné
  složce nebo neplatném těle. Tělo odpovědi jen informuje:
  `{ "played": true, "file": "x.wav" }` nebo
  `{ "played": false, "reason": "muted" | "unknown-category" | "no-sounds" | "bad-request" | "forbidden" }`.
- Nový zvuk přeruší právě hrající (chování Windows `PlaySound`).

### `POST /open`

```json
{ "url": "https://example.com/page" }
```

- Povoleno jen `http` a `https`; jinak `400`.
- Zobrazí popup **Otevřít / Zamítnout** s odpočtem `confirmTimeoutSec`
  a přehraje zvuk popupu (viz níže).
- Odpověď počká na rozhodnutí:
  `{ "opened": true }` nebo `{ "opened": false, "reason": "rejected" | "timeout" | "helper-restarted" | "shutdown" }`
  (`shutdown` = čekající požadavky při ukončení aplikace).

#### Souběžné požadavky

- FIFO fronta v Node, vždy jen jeden popup. Každý požadavek drží své HTTP
  spojení otevřené, dokud není vyřízen.
- Odpočet běží od **zobrazení** popupu, ne od příchodu požadavku.
- Popup ukazuje počítadlo čekajících („+2 čekají“); aktualizuje se, když
  požadavky přibývají nebo ubývají.
- **Zrušení při odpojení:** zavře-li volající spojení dřív, než je vyřízeno,
  požadavek se vyřadí z fronty; je-li jeho popup právě vidět, popup zmizí
  a ukáže se další. Odpověď se už neposílá.
- Stejné URL se **neslučují** – každý požadavek má vlastní popup.
- Ve frontě max. 10 čekajících (včetně zobrazeného), další dostanou `429`.

#### Zvuk popupu

- Při každém zobrazení popupu (i z fronty) se přehraje náhodný WAV
  z `confirmSoundDir`.
- Při vypnutém zvuku nebo chybějící/prázdné složce se nepřehraje nic, bez chyby.
- Po „Otevřít“ helper otevře URL ve výchozím prohlížeči (shell execute,
  žádné skládání příkazové řádky).

### `POST /console-url` · `DELETE /console-url`

```json
{ "url": "http://127.0.0.1:36061/?t=…" }
```

- Nastaví URL pro položku menu *Otevřít SkilledPlus4U MCP Console*.
- Povoleno jen `http(s)` na `127.0.0.1`, `localhost` nebo `[::1]`; jinak `400`.
  Důvod: z menu se otevírá bez potvrzení.
- Drží se jen v paměti (obsahuje token, mění se s každým startem konzole).
- `DELETE` ji zruší, položka menu zešedne. Obojí vrací `{ "consoleUrl": <url|null> }`.

### `GET /health`

`{ "ok": true, "version": "…", "port": 7399, "soundEnabled": true|false, "consoleUrl": true|false, "pendingConfirms": 0 }`

Jiná cesta / metoda → `404` / `405`.

## Kontextové menu

```
AI Center · port 7399              (neaktivní, jen informace)
──────────────────────────────
✓ Zvuky                            (zaškrtávací, přepíná zapnuto/vypnuto)
Otevřít SkilledPlus4U MCP Console  (šedé, dokud URL není nastavená)
──────────────────────────────
Ukončit
```

Tooltip ikony: `AI Center · port 7399`, při vypnutém zvuku
`AI Center · zvuk vypnutý`. Ikona se kreslí v kódu (žádný binární soubor),
barva podle světlého/tmavého motivu Windows. Při vypnutém zvuku má v pravém
dolním rohu červený kroužek s bílým přeškrtnutím (reproduktor by byl při
16 px nečitelný).

Zapnutí zvuku se ukládá do `state.json` v kořeni aplikace
(`{ "soundEnabled": true }`) a platí i po restartu. Chybí-li soubor, zvuk je
zapnutý. Aplikace nikdy nepřepisuje `config.json`.

## Popup

Podle schváleného dema (`popup-demo.ps1`):

- 380 × 150 px (škálováno podle DPI), tmavý, rámeček 1 px.
- Pravý dolní roh pracovní plochy primární obrazovky, odsazení 12 px.
- `WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW | WS_EX_TOPMOST` – nebere fokus,
  není v taskbaru, je navrchu.
- Obsah: „AI Center · požadavek na otevření odkazu“, doména tučně, celá URL
  (zkrácená trojtečkou), odpočet „Zamítne se samo za N s“, počítadlo
  „+N čekají“ (jen když N > 0), tlačítka **Zamítnout** a **Otevřít**.

## Konfigurace

`config.json` v kořeni aplikace (vedle `package.json`; cesta se odvozuje od
umístění kódu, ne od pracovního adresáře). Když neexistuje, vytvoří se
s výchozími hodnotami. Neznámé klíče se ignorují, neplatné hodnoty → chyba při startu
s jasnou zprávou.

```json
{
  "port": 7399,
  "soundsDir": "%USERPROFILE%\\.claude-sound",
  "confirmSoundDir": "%USERPROFILE%\\.claude-sound\\confirm",
  "confirmTimeoutSec": 30
}
```

`%PROMĚNNÉ%` v cestách se rozbalí.

`config.json` i `state.json` jsou v `.gitignore` – jsou to lokální data
konkrétního počítače. Výchozí hodnoty žijí v kódu (`config.js`). Změna konfigurace = restart aplikace.

## Protokol Node ↔ helper

Jeden JSON objekt na řádek, UTF-8.

Node → helper:

| Zpráva | Význam |
|---|---|
| `{"cmd":"init","header":"…","soundEnabled":true}` | První řádek menu, stav zvuku (ikona, tooltip, zaškrtnutí) |
| `{"cmd":"soundEnabled","value":false}` | Změna stavu zvuku |
| `{"cmd":"consoleUrl","url":"…"\|null}` | URL pro položku menu (null = šedá) |
| `{"cmd":"play","path":"C:\\…\\x.wav"}` | Přehraj zvuk |
| `{"cmd":"confirm","id":7,"url":"…","timeoutSec":30,"waiting":2}` | Ukaž popup |
| `{"cmd":"waiting","id":7,"count":3}` | Aktualizuj počítadlo zobrazeného popupu |
| `{"cmd":"cancel","id":7}` | Zavři popup bez výsledku (volající se odpojil) |
| `{"cmd":"open","url":"…"}` | Otevři URL v prohlížeči |

Helper → Node:

| Zpráva | Význam |
|---|---|
| `{"event":"ready"}` | Ikona je zobrazená |
| `{"event":"confirm","id":7,"result":"yes"\|"no"\|"timeout"}` | Výsledek popupu |
| `{"event":"toggleSound"}` | Uživatel klikl na Zvuky (Node přepne, uloží, pošle `soundEnabled`) |
| `{"event":"exit"}` | Uživatel zvolil Ukončit |
| `{"event":"log","message":"…"}` | Diagnostika |

Konzoli z menu otevírá helper sám (URL zná z `consoleUrl`). O přehrání zvuku
rozhoduje vždy Node (stav zvuku, výběr souboru); helper jen přehraje `play`.

Helper čte stdin ve vlákně na pozadí (malá C# třída přes `Add-Type`) do fronty,
kterou UI vlákno vybírá časovačem každých 50 ms.

## Struktura

```
wsl-ai-center/
  package.json            bez závislostí, "start": "node src/main.js"
  .gitignore              config.json, state.json, node_modules
  config.json             (lokální, vznikne při prvním startu)
  state.json              (lokální, vznikne při prvním přepnutí zvuku)
  README.md               spuštění, API, příklady curl, hook
  src/
    main.js               start, propojení částí, ukončení
    config.js             načtení/vytvoření/validace konfigurace
    state.js              state.json (zapnutí zvuku)
    server.js             HTTP routy (node:http)
    sounds.js             výběr náhodného WAV podle kategorie
    urls.js               validace URL (http/https, loopback)
    confirmQueue.js       fronta potvrzení, max. 10, jedno aktivní, počítadlo, zrušení
    helper.js             spuštění helperu, JSON řádky, restart
  helper/
    tray.ps1              ikona, menu, popup, zvuk, otevírání URL
  test/
    *.test.js             node:test
```

## Ošetření chyb

- Chyby v `/sound` nikdy nevrací chybový status (viz výše).
- Výjimka v obsluze požadavku → `500` s `{ "error": "…" }`, server běží dál.
- Helper zaznamenává své chyby jako `log` události; Node je vypisuje na stdout.
- Neodpoví-li helper na `confirm` do `timeoutSec + 10 s`, Node to ukončí jako `timeout`.

## Testování

- **Automaticky (`node --test`)**: config, state, sounds (dočasné složky), urls,
  confirmQueue (pořadí, počítadlo, zrušení zobrazeného i čekajícího, limit),
  server proti falešnému helperu (in-memory protokol, odpojení klienta, mute).
  Běží i ve WSL/Linuxu.
- **Ručně na Windows**: ikona a tooltip (i ve stavu vypnutého zvuku), menu
  (Zvuky, šedá/aktivní konzole, Ukončit), popup (Otevřít / Zamítnout / timeout /
  fronta tří požadavků s počítadlem / zrušení přes Ctrl+C v curl / zvuk popupu /
  nebere fokus), vypnutí zvuku přežije restart,
  zvuky všech kategorií, prázdná složka, restart helperu po zabití procesu.

## Použití v hooku Claude

```json
{ "type": "command", "async": true,
  "command": "curl -s -X POST http://127.0.0.1:7399/sound -H \"Content-Type: application/json\" -d \"{\\\"category\\\":\\\"done\\\"}\"" }
```

Z WSL totéž (vyžaduje, aby `127.0.0.1` z WSL dosáhlo na Windows).

## Mimo rozsah

Autostart, instalátor, autentizace API, více monitorů / jiná pozice taskbaru,
úprava `skilled-plus4u-mcp-start` (nastavení URL konzole) – řeší se zvlášť.
