# Mimir-Tunnel

Lokale HTTP-bridge waarmee Mímir (PHP op sleutels.kvt.nl) Business Central aanroept via [`business-central-mcp@2.2.0`](https://github.com/SShadowS/business-central-mcp) (SShadowS). Dat pakket spreekt het webclient-websocketprotocol `/csh` op poort 443. Deze bridge zet daar een kleine JSON-API voor, met een bearer-token, een sessiepool en een schrijfschakelaar.

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
sudo rsync -a --exclude node_modules --exclude .env ./ /opt/mimir-bc-bridge/
sudo chown -R bcbridge:bcbridge /opt/mimir-bc-bridge
sudo -u bcbridge bash -lc 'cd /opt/mimir-bc-bridge && npm install --omit=dev'
```

`npm install` in **deze** repo is het goede pad: `business-central-mcp` komt als dependency binnen en npm slaat de devDependencies van dat pakket over.

`npm pack business-central-mcp@2.2.0`, uitpakken en dáár `npm i --omit=dev` draaien faalt op npm 10 met `Cannot read properties of null (reading 'edgesOut')` (arborist, in de devDependency-boom van vitest). Oplossing als een installatie toch op die fout stukloopt:

```bash
node scripts/install-bc-mcp.mjs
```

Het script probeert eerst `npm install --omit=dev`. Bij `edgesOut` pakt het de tarball, haalt lockfile, `devDependencies` en `scripts` uit `package.json`, en draait `npm install --omit=dev` in die uitgepakte map (`vendor/`, niet committen).

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

Antwoorden zijn JSON. Fouten: `{ "ok": false, "error": "...", "code": "..." }` met 400 (invoer of BC-validatie), 401 (token), 403 (tool geweigerd), 404, 405, 413, 502 (BC), 503 (wachtrij of dode sessie), 504 (timeout).

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
- `filter` — herhaalbaar, vorm `Kolom=waarde` (BC-filtersyntax in de waarde: `10000..20000`, `*twist*`, `>1000`). Meerdere filters zijn AND.
- `columns` — kommagescheiden captions.
- `top` / `skip` — worden `range.limit` / `range.offset`. Alleen `skip` gebruikt `top=100`.
- `section` — standaard de header van de pagina (`lines`, `factbox:...`).

Het antwoord bevat `rows[]` met `bookmark` en `cells`. `cells` is een object waarvan de sleutels de kolomcaptions zijn.

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

`TUNNEL_ALLOW_WRITE=false` weigert die tools met 403, ook als ze op de allowlist staan. Een onbekende `bc_`-tool telt dan ook als muterend. `bc_close_page` is opruimen en blijft toegestaan; de bridge roept hem zelf aan na een transactie, ook als de aanroeper hem niet op de allowlist heeft gezet. Een expliciete `bc_close_page` in `POST /call` volgt de allowlist wel.

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
