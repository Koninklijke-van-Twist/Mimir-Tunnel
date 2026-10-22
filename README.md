# Mimir-Tunnel

Lokale HTTP-bridge waarmee Mímir (PHP op sleutels.kvt.nl) Business Central aanroept via [`business-central-mcp@2.2.1`](https://github.com/SShadowS/business-central-mcp) (SShadowS). Dat pakket spreekt het webclient-websocketprotocol `/csh` op poort 443. Deze bridge zet daar een kleine JSON-API voor, met een bearer-token, een sessiepool en een schrijfschakelaar.

De bridge luistert **alleen op `127.0.0.1`**. Mímir roept hem met curl aan op dezelfde machine, of via een tunnel die op die loopback landt.

## Architectuur

```
Mímir (PHP, curl)
    │  Authorization: Bearer $TUNNEL_TOKEN
    ▼
HTTP 127.0.0.1:$TUNNEL_PORT          src/index.js
    │  wachtrij + pool (standaard 1 sessie)
    ▼
één stdio-proces per sessie          business-central-mcp dist/stdio-server.js
    │  MCP-client (@modelcontextprotocol/sdk)
    ▼
BC-webclient  wss://kvtmd365.kvt.nl/KVTMDLive_NUP/.../csh
```

Elke poolsessie is een eigen Node-proces en een eigen ingelogde webclient-sessie. Een call duurt inclusief login ongeveer 4–5 seconden. De sessie is stateful (open pagina's, gekozen bedrijf), dus een sessie doet één HTTP-request tegelijk. Andere requests wachten in de wachtrij. Een dode sessie wordt afgesloten en bij de volgende leespoging vervangen door een nieuwe login. Mutaties worden niet automatisch herhaald: de wijziging kan al in BC staan.

`BC_RECONNECT_MAX_RETRIES` staat standaard op `0`. Het pakket probeert dan zelf niet opnieuw in te loggen (dat kan een account locken). Opnieuw inloggen doet de bridge, door een nieuw proces te starten.

Pagina's gaan altijd dicht:

- `GET /page/{id}` doet `bc_open_page` → `bc_read_data` → `bc_close_page`, ook als het lezen mislukt.
- `POST /call` is één transactie op één sessie. Pagina's die in die transactie opengingen (`pageContextId` / `targetPageContextId`) en niet zelf met `bc_close_page` zijn gesloten, sluit de bridge daarna. Een losse `bc_open_page` levert dus wel het pagina-antwoord, maar de pagina is daarna dicht. Meerdere stappen horen in één `calls`-array.

`bc_query` (OData/API v2 op poort 7048) werkt op deze omgeving niet. De bridge blokkeert hem niet apart; haal hem van de allowlist af als Mímir hem niet mag aanroepen.

### Het HTTP-endpoint van het pakket zelf

`dist/server.js` van business-central-mcp is een aparte HTTP-server. Deze bridge gebruikt die niet (één proces, één sessie, ander API-vlak). Ter referentie, uit `loadConfig()` en `server.listen`:

- Host: omgevingsvariabele `BIND_ADDRESS`, standaard `127.0.0.1`.
- Poort: omgevingsvariabele `PORT`, standaard `3000`.
- `server.listen(config.port, config.server.bindAddress)`.

Antwoorden zijn **JSON, geen SSE**:

- `POST /mcp` antwoordt met `Content-Type: application/json` (JSON-RPC). Een notification zonder `id` krijgt `202` en een lege body.
- `GET /mcp` (de SSE-probe van een streamable-HTTP-client) krijgt `405` met JSON: `Method not allowed; the MCP endpoint accepts POST only`. De bron zegt expliciet dat die probe niet als SSE mag worden afgehandeld.
- `/health` en de REST-routes onder `/api/v1/` zijn ook JSON.

## Installatie op Ubuntu

Node.js **20 of nieuwer**. De Node uit de Ubuntu-repo is soms ouder; controleer met `node -v`.

```bash
sudo apt update
sudo apt install -y ca-certificates curl
# Node 20+ als `node -v` te laag is, bijvoorbeeld via NodeSource:
#   curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
#   sudo apt install -y nodejs
node -v
```

```bash
sudo useradd --system --home-dir /opt/mimir-bc-bridge --create-home --shell /usr/sbin/nologin bcbridge
sudo mkdir -p /opt/mimir-bc-bridge
sudo tar -C "$(pwd)" \
  --exclude .git --exclude node_modules --exclude .env --exclude vendor --exclude logs --exclude .state \
  -cf - . | sudo tar -C /opt/mimir-bc-bridge -xf -
sudo chown -R bcbridge:bcbridge /opt/mimir-bc-bridge
sudo -u bcbridge bash -c 'cd /opt/mimir-bc-bridge && npm install --omit=dev'
```

`business-central-mcp` komt van npm, vastgepind op `2.2.1` (upstream [`SShadowS/business-central-mcp`](https://github.com/SShadowS/business-central-mcp), tag `v2.2.1`). Die versie bevat de `ColumnBinderPath`-fix voor lijstfilters (PR #44), dus een fork of eigen build is niet meer nodig. Andere versie: het versienummer in `package.json` aanpassen, `npm install`, lockbestand meecommitten. `scripts/update.sh` draait `npm install --omit=dev` vanzelf als `package.json` of het lockbestand verandert.

Na een wijziging aan `scripts/update.sh` moet de root-kopie opnieuw worden geïnstalleerd: `sudo install -o root -g root -m 755 /home/administrator/mimir-tunnel/scripts/update.sh /usr/local/sbin/mimir-tunnel-update`.

```bash
sudo cp /opt/mimir-bc-bridge/.env.example /opt/mimir-bc-bridge/.env
sudo editor /opt/mimir-bc-bridge/.env
sudo cp /opt/mimir-bc-bridge/deploy/mimir-bc-bridge.service /etc/systemd/system/mimir-bc-bridge.service
# Pas ExecStart aan als node niet op /usr/bin/node staat (`command -v node`).
sudo systemctl daemon-reload
sudo systemctl enable --now mimir-bc-bridge
sudo systemctl status mimir-bc-bridge
journalctl -u mimir-bc-bridge -f
```

Het unit-bestand draait als gebruiker `bcbridge`, leest `/opt/mimir-bc-bridge/.env` en herstart bij een crash. `BC_PASSWORD` en `TUNNEL_TOKEN` staan alleen in dat bestand en in de omgeving van het proces, nooit op de command line.

### Bijwerken

Op de server staat de git-checkout in `/home/administrator/mimir-tunnel` (eigenaar `administrator`) en de draaiende code in `/opt/mimir-bc-bridge` (eigenaar `bcbridge`). `scripts/update.sh` werkt die installatie bij. Draai het met sudo, vanuit de checkout:

```bash
sudo /home/administrator/mimir-tunnel/scripts/update.sh main
```

Zonder argument is de branch `master`. Het eerste argument wint van `MIMIR_BRANCH`. Deze repository heet op GitHub `main`; geef die naam mee. `sudo MIMIR_BRANCH=main /home/administrator/mimir-tunnel/scripts/update.sh` doet hetzelfde.

Het script is idempotent en print elke stap:

1. `git fetch` en `checkout`/`pull --ff-only` van de gekozen branch, als de eigenaar van de checkout. Een vieze werkboom of een remote die niet fast-forward is, stopt vóór `/opt` wijzigt.
2. Bewaart de huidige `/opt/mimir-bc-bridge` in `/opt/mimir-bc-bridge.backups/<tijd>`. Die map is alleen voor root (`700`). Er blijven drie backups staan. In een backup zit ook `.env`.
3. Kopieert de nieuwe code met `tar` (rsync staat op deze server niet). `.env` in `/opt` blijft het bestaande bestand; een `.env` uit git wordt niet meegenomen.
4. Draait `npm install --omit=dev` alleen als `package.json` of `package-lock.json` veranderd is, of als `node_modules` ontbreekt. Anders gaat de bestaande `node_modules` mee.
5. Zet eigenaar `bcbridge:bcbridge` en `.env` op modus `600`.
6. `systemctl restart mimir-bc-bridge`.
7. Vraagt `GET /health` op `127.0.0.1` met `TUNNEL_TOKEN` en `TUNNEL_PORT` uit `/opt/mimir-bc-bridge/.env`. Het token komt niet in de output.

Lukt de healthcheck niet, dan zet het script de backup terug, herstart de service opnieuw en eindigt met een fout. De vorige versie blijft dan de draaiende. Een mislukte `npm install` gebeurt vóór de wissel, de draaiende service blijft dan onaangeroerd.

## Omgevingsvariabelen

| Variabele | Verplicht | Standaard | Betekenis |
| --- | --- | --- | --- |
| `TUNNEL_TOKEN` | ja | — | Bearer-token, minimaal 16 tekens. Niet loggen. |
| `TUNNEL_PORT` | nee | `8787` | Poort op `127.0.0.1`. |
| `TUNNEL_POOL_SIZE` | nee | `1` | Aantal sessies, 1–4. Aanbevolen 1 of 2. |
| `TUNNEL_ALLOW_WRITE` | nee | `true` | `false` weigert muterende tools. |
| `TUNNEL_TOOL_ALLOWLIST` | nee | uit | Kommagescheiden toolnamen. Alleen actief als de variabele niet leeg is. |
| `TUNNEL_CALL_TIMEOUT_MS` | nee | `120000` | Timeout per tool-call. Bij timeout gaat de sessie weg. |
| `TUNNEL_QUEUE_TIMEOUT_MS` | nee | `180000` | Hoe lang een request op een vrije sessie wacht. |
| `TUNNEL_BODY_LIMIT_BYTES` | nee | `12582912` | Maximale JSON-body. |
| `LOG_LEVEL` | nee | `info` | `debug`, `info`, `warn`, `error`. |
| `BC_BASE_URL` | ja | — | `https://kvtmd365.kvt.nl/KVTMDLive_NUP` |
| `BC_AUTH` | nee | `NavUserPassword` | |
| `BC_TENANT_ID` | nee | `default` | |
| `BC_USERNAME` | ja | — | Windows/NUP-gebruiker. Niet de OData-websleutel. |
| `BC_PASSWORD` | ja | — | Zelf zetten. Nooit committen of loggen. |
| `BC_SERVER_MAJOR` | nee | `26` | |
| `BC_CLIENT_VERSION` | nee | `26.3.0.0` | |
| `BC_ODATA_COMPANY` | nee | — | Optioneel. Het webclient-bedrijf wisselt via `?company=` of `bc_switch_company`. |
| `BC_RECONNECT_MAX_RETRIES` | nee | `0` | Herhaalpogingen van het pakket zelf. |

In een systemd-`EnvironmentFile` zijn aanhalingstekens geen syntax: schrijf `BC_PASSWORD=waarde` zonder quotes en zonder spaties rond `=`. Lokaal `node src/index.js` leest ook `.env` en stript dan wel een paar matching quotes. Bestaande omgevingsvariabelen winnen van het bestand.

## API

Elk request, ook `/health`, heeft `Authorization: Bearer $TUNNEL_TOKEN`. Optioneel: `X-Mimir-Key-Id` (letters, cijfers, `._:@-`, max 80) voor de logregel. Een ongeldige waarde wordt als `invalid` gelogd, niet letterlijk.

Antwoorden zijn JSON. Fouten: `{ "ok": false, "error": "...", "code": "..." }` met 400 (invoer of BC-validatie), 401 (token), 403 (bekende tool geweigerd door beleid), 404, 405, 413, 502 (BC), 503 (wachtrij of dode sessie), 504 (timeout).

Een `bc_`-tool die de bridge niet ondersteunt (de naam zit niet in de lees- of schrijfset, of het pakket kent hem niet) antwoordt **501** met een eigen body:

```json
{"error":"UNSUPPORTED_TOOL","tool":"bc_does_not_exist","message":"Deze tool wordt niet ondersteund door de bridge"}
```

Een bekende tool die het beleid blokkeert blijft **403** `{ "ok": false, "error": "...", "code": "TOOL_FORBIDDEN" }`. Dat is `TUNNEL_ALLOW_WRITE=false` voor een muterende tool, of een gezet `TUNNEL_TOOL_ALLOWLIST` waar de tool niet op staat. Een naam die niet de vorm `bc_` plus kleine letters, cijfers en `_` heeft is 400.

```bash
TOKEN=$(grep '^TUNNEL_TOKEN=' /opt/mimir-bc-bridge/.env | cut -d= -f2-)
BASE=http://127.0.0.1:8787

curl -sS -H "Authorization: Bearer $TOKEN" "$BASE/health"

curl -sS \
  -H "Authorization: Bearer $TOKEN" \
  -H "X-Mimir-Key-Id: mimir-lezen" \
  "$BASE/companies"

curl -sS -g \
  -H "Authorization: Bearer $TOKEN" \
  "$BASE/page/22?company=Koninklijke%20van%20Twist&filter=City=London&filter=No.=10000&columns=No.,Name&top=20&skip=0"
```

`GET /page/{id}` query:

- `company` — exacte bedrijfsnaam; de sessie onthoudt het bedrijf en wisselt alleen als het verschilt.
- `filter` — herhaalbaar, vorm `Kolom=waarde`. Meerdere filters zijn AND. De bridge probeert het filter eerst server-side (`bc_read_data` met `filters`). Op deze webclient ontbreekt vaak `columnBinderPath`, en een kaart heeft geen repeater. Het pakket antwoordt dan met `PROTOCOL_ERROR` (`Column … has no columnBinderPath for filtering`, `Page has no repeater -- cannot filter`, `Page has no FilterLogicalControl (filc) -- cannot filter`). Bij díe fouten leest de bridge de pagina ongefilterd en filtert zelf op de caption van de cel. `filterMode` is dan `client`. Lukt het server-side filter, dan is `filterMode` `server`. Een onbekende kolom (`Filter column not found`) antwoordt 502.
- `columns` — kommagescheiden captions. Bij client-side filter past de bridge ze pas ná het matchen toe, zodat de filterkolom in de ruwe rijen mag ontbreken uit deze lijst.
- `top` / `skip` — het gevraagde venster. Alleen `skip`, of een filter zonder `top`, gebruikt `top=100`. Zonder `top`, `skip` en `filter` is het één leesactie zonder `range` (het venster dat BC zelf geeft). Past `skip + top` in 50 rijen, dan is het één `bc_read_data` met die `range`.
- `section` — standaard de header van de pagina (`lines`, `factbox:...`).

`bc_read_data` houdt het geladen venster op deze webclient op ongeveer 50 rijen: een `limit` van 500 komt terug als 50, omdat een `DataLoaded` het venster vervangt in plaats van verlengt. Een `offset` voorbij dat venster is dan een lege slice, terwijl de nieuwe rijen vooraan staan. De bridge leest daarom intern in stukken van 50 en plakt unieke bookmarks aan elkaar. Komt een vervolgstuk leeg terug of met dezelfde bookmarks, dan herleest ze het begin één keer. Blijft het daarna stilstaan, of zijn er 40 leesacties geweest, dan stopt ze. `truncated: true` staat in het antwoord als het gevraagde `top` niet gevuld is en het laatste stuk nog vol was (`totalRowCount` ontbreekt of is groter dan wat er binnen is). Een korter laatste stuk geldt als het einde van de lijst. Bij `filterMode: client` gelden `top` en `skip` voor de treffers. Hoogstens 40 aanroepen: volle stukken van 50 zijn 2000 rijen; als elk vervolg een herlezing nodig heeft, minder.

Client-side syntax is hoofdletterongevoelig en werkt op de celtekst (leading `@` mag, BC gebruikt dat voor hoofdletterongevoelig en de bridge vergelijkt altijd zo):

- exact: `London`
- joker: `*` en `?`, bijvoorbeeld `*twist*`
- bereik: `10000..20000`, open met `..100` of `100..`
- vergelijking: `>`, `<`, `>=`, `<=`, `<>`
- OF in één waarde: `A|B`
- getal als beide kanten op een getal lijken (`1234`, `1234.5`, `1234,5`); anders tekst

Een kaart heeft geen rijen maar `fields`. Die velden tellen als één record, met de veldnaam als sleutel. Past het filter en is `skip` 0, dan blijven `fields` staan (geprojecteerd op `columns`). Anders is `fields` een lege lijst.

Het antwoord bevat `rows[]` met `bookmark` en `cells`. `cells` is een object waarvan de sleutels de kolomcaptions zijn. `totalRowCount` blijft het aantal dat BC voor de repeater gaf; bij client-side filter is dat het ongefilterde aantal.

```bash
curl -sS \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"tool":"bc_search_pages","args":{"query":"customer"}}' \
  "$BASE/call"

curl -sS \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"calls":[
    {"tool":"bc_open_page","args":{"pageId":22}},
    {"tool":"bc_read_data","args":{"pageContextId":"$0.pageContextId","filters":[{"column":"City","value":"London"}]}}
  ]}' \
  "$BASE/call"
```

`$0.pageContextId` wijst naar het resultaat van call 0 in dezelfde body (een heel string-argument, geen stukje tekst). Na afloop staan gesloten pagina's in `closedPages`.

### Schrijven

Muterend: `bc_write_data`, `bc_execute_action`, `bc_respond_dialog`, `bc_run_report`, `bc_wizard_navigate`, `bc_upload_file`, `bc_run_tests`.

`TUNNEL_ALLOW_WRITE=false` weigert die tools met 403, ook als ze op de allowlist staan. `bc_close_page` is opruimen en blijft toegestaan; de bridge roept hem zelf aan na een transactie, ook als de aanroeper hem niet op de allowlist heeft gezet. Een expliciete `bc_close_page` in `POST /call` volgt de allowlist wel. Een `bc_`-naam buiten de lees- en schrijfset antwoordt 501 `UNSUPPORTED_TOOL`. Dat geldt ook als schrijven uit staat of de naam op de allowlist staat.

De allowlist geldt alleen als `TUNNEL_TOOL_ALLOWLIST` een niet-lege waarde heeft. Anders zijn alle bekende tools toegestaan, minus mutaties als schrijven uit staat. Mímir beslist per API-key of een client mag schrijven; de bridge vertrouwt dat en kijkt alleen naar deze twee variabelen.

Lezen: `bc_list_companies`, `bc_switch_company`, `bc_open_page`, `bc_read_data`, `bc_navigate`, `bc_lookup`, `bc_search_pages`, `bc_close_page`, `bc_get_operation`, `bc_query`.

`GET /companies` en `GET /page/{id}` gebruiken die leestools en vallen onder dezelfde allowlist. Zonder `bc_open_page` en `bc_read_data` op de lijst antwoordt `/page` met 403.

## Logging

Elke regel is één JSON-object op stderr (journald). Per tool-call en per HTTP-request staan duur (`ms`), tool of pad, status en optioneel `keyId`. Wachtwoorden, het tunnel-token en `Authorization: Bearer …` worden uit de tekst gehaald. Argumenten (velden, base64) worden niet gelogd.

## Hosts

Als `getent hosts kvtmd365.kvt.nl` een adres in `198.18.0.0/15` teruggeeft, wijst DNS naar een fake-ip (VPN/filter) en komt de webclient niet bij BC. Zet op de machine waar de bridge draait in `/etc/hosts`:

```
93.117.207.44 kvtmd365.kvt.nl
```

## Tests

Er is hier geen live BC. De tests praten tegen een nagebouwde MCP-client.

```bash
npm test
```

## Development

```bash
cp .env.example .env
npm install
npm start
```
