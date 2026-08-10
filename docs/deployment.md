# Betrieb: ein Image, drei Runtimes

Der Workspace läuft in drei Umgebungen (SPEC §5.2). Zwei davon sind
**dasselbe Container-Image** — ein zweites Dockerfile wäre laut Spec ein
Review-Blocker und ist per Test ausgeschlossen
(`tests/platform/packaging.test.ts`):

| Runtime | Packaging | Auth | Ingress/Pfad |
|---|---|---|---|
| `server` | `deploy/server/docker-compose.yml` (Caddy + optional oauth2-proxy) | OIDC über den Proxy, alternativ Einzelnutzer | Wurzel oder fester Unterpfad |
| `ha-addon` | `deploy/ha-addon/config.yaml` (Supervisor zieht dasselbe Image) | Home Assistant | dynamischer Ingress-Pfad |
| `local` | keins — die App läuft im Browser | keine (ein Gerät, ein Nutzer) | — |

## Der Start-Schritt

Einstieg des Images ist immer `scripts/start.mjs`. Er macht drei Dinge und
danach nichts mehr:

1. **Base-Path ermitteln.** Im Add-on über die Supervisor-API
   (`/addons/self/info` → `ingress_entry`), sonst aus `OW_BASE_PATH`
   (leer = App liegt an der Wurzel).
2. **Base-Path in den Build einsetzen** (`scripts/base-path.mjs`). Next
   backt `basePath` und `assetPrefix` in den Build; der Ingress-Pfad steht
   aber erst zur Installationszeit fest. Deshalb baut das Image **einmal**
   mit einem Platzhalter, der beim Start durch den echten Pfad ersetzt wird
   — idempotent, mit Markierungsdatei, und einem gewechselten Token folgend.
3. **Starten.** Ohne Ingress hört Next direkt auf `PORT`. Mit Ingress hört
   es nur auf localhost, und davor läuft `scripts/ingress-proxy.mjs`.

Läuft der Start als root (so startet der Supervisor Add-ons), übereignet er
das Datenverzeichnis und wechselt auf uid/gid 1001 — der Anwendungsprozess
ist in beiden Kontexten unprivilegiert.

## Warum der Ingress einen Proxy braucht

Home Assistant liefert Add-ons unter `/api/hassio_ingress/<token>/…` aus und
**entfernt dieses Präfix, bevor es die Anfrage weiterreicht**; mitgeteilt
wird es im Header `X-Ingress-Path`. Next dagegen erwartet Anfragen **mit**
seinem `basePath` und antwortet sonst 404. Der Proxy schließt genau diese
Lücke, indem er das Präfix wieder vor den Pfad setzt. Er ist Packaging,
nicht Anwendung: in der Runtime `server` existiert er nicht.

Wechselt der Ingress-Token, stimmen alle eingebackenen URLs nicht mehr. Der
Proxy erkennt das am Header, antwortet einmal mit einem Hinweis (503) und
beendet den Prozess — der Supervisor startet das Add-on neu, der Build
bekommt den neuen Pfad.

Innerhalb der App kennt **keine** Feature-Datei den Ingress:
`src/lib/platform/base-path.ts` präfixt `fetch`-Aufrufe an genau einer
Stelle; `<Link>`, `next/image` und `_next/*` erledigt Next selbst. Manifest
(`/manifest.webmanifest`), Service-Worker-Registrierung und
Service-Worker-Scope hängen ebenfalls am Präfix — der Worker liest seinen
Base-Path aus `self.registration.scope`.

Abnahme: `e2e/ingress.spec.ts` gegen den Prüfstand
`scripts/e2e-ingress-server.mjs`, der die volle Kette nachstellt
(Supervisor-Simulation → Ingress-Proxy → Standalone-Build mit eingesetztem
Pfad).

## Runtime `server`

```bash
cp deploy/server/.env.example deploy/server/.env   # Host, OIDC, Secrets
# mit OIDC-Anmeldung:
docker compose -f deploy/server/docker-compose.yml --profile oidc up -d
# ohne (Einzelnutzer): OW_UPSTREAM=app:3000, OW_AUTH_MODE=single-user
docker compose -f deploy/server/docker-compose.yml up -d
```

Kette: **Caddy** (TLS, ACME) → **oauth2-proxy** (OIDC-Anmeldefluss) →
**App**. Die App führt bewusst keinen eigenen Anmeldefluss: Sitzungen,
Cookies und Refresh macht der Proxy, die App liest die Identität aus seinen
Headern (`OW_AUTH_MODE=proxy-header`).

Ein Unterpfad (z. B. `https://host/workspace`) wird über `OW_BASE_PATH`
gesetzt — derselbe Mechanismus wie beim Ingress, nur mit festem Wert.

## Runtime `ha-addon`

`deploy/ha-addon/config.yaml` als Add-on-Repository hinzufügen; Details in
[deploy/ha-addon/DOCS.md](../deploy/ha-addon/DOCS.md). Das Add-on baut
nichts selbst, es zieht das veröffentlichte Image. Daten liegen in `/data`
(beim ersten Start mit dem Saat-Bestand befüllt, danach unangetastet),
Vaults und Git-Ziele unter `/share`.

## Identität (`OW_AUTH_MODE`)

| Modus | Quelle | Wofür |
|---|---|---|
| `single-user` (Default) | — | Einzelnutzer-Betrieb, kein Anmeldeverfahren |
| `ha-ingress` | `X-Remote-User-*` | Home Assistant hat bereits angemeldet |
| `proxy-header` | `X-Forwarded-User`/`-Groups` | vorgelagerter OIDC-Proxy |
| `oidc-bearer` | `Authorization: Bearer …` | Clients mit eigenem Token; Signatur, Issuer, Audience und Ablauf werden gegen die JWKS des Issuers geprüft (`src/lib/platform/auth/oidc.ts`) |

Die Identität wird **gelesen und angezeigt** (`GET /api/runtime`, Karte
„System" in den Einstellungen). WER hereinkommt, entscheidet weiterhin die
Schicht davor — beim `server` der oauth2-proxy, beim Add-on Home Assistant.
WAS eine Identität dann sehen und ändern darf, steht seit M13 als
Web-Access-Control-RDF in `graph/acl` (SPEC §17,
[multi-user.md](./multi-user.md)); `capabilities.multiUser` steht deshalb
für `server` und `ha-addon` auf `true`.

**Sicherheitskritisch**: Läuft ein Anmeldeverfahren und kommt eine Anfrage
ohne geprüfte Identität an, ist sie **anonym** — nicht der Einzelnutzer.
Ein fehlender Header ist damit kein Generalschlüssel.

## Runtime `local` (Browser)

Die Bindungen stehen und sind getestet: Store im Web Worker
(`src/lib/platform/runtime/worker/`, Oxigraph-WASM außerhalb des
Haupt-Threads — die UI blockiert nie auf einer Query), Dateien im OPFS
(`opfs.ts`, dieselbe `FileSystemLike` wie node:fs, inklusive der
Frische-Signale, auf denen isomorphic-git besteht), Git über genau dieses
Dateisystem, Secrets im `localStorage`.

Der Speicher-Zustand steht in den Einstellungen: dauerhaft oder
löschbar, Belegung, Warnung ab 80 % (SPEC §8.3) — samt Knopf, um
dauerhaften Speicher anzufordern.

Ehrliche Grenze: Die **Anwendung** läuft weiterhin gegen das Backend, wenn
eines erreichbar ist; die serverlose Betriebsart deckt heute die AI-Schicht
ab (siehe [ai-platform.md](./ai-platform.md)), nicht den Graph-Kern. Die
Runtime-Bausteine dafür existieren seit M12, die Umstellung der
Graph-Oberflächen auf einen Browser-Store ist nicht Teil dieses
Meilensteins — und wird deshalb auch nirgends als verfügbar angezeigt.

## Umgebungsvariablen (Betrieb)

| Variable | Wirkung |
|---|---|
| `OW_BASE_PATH` | Unterpfad der Installation; im Add-on überschreibt ihn der Supervisor-Wert |
| `OW_INGRESS` | `1`/`0` erzwingt bzw. verhindert den Ingress-Modus (sonst: Supervisor-Token entscheidet) |
| `OW_RUNTIME` | `server` oder `ha-addon` — meldet die Runtime-Kennung |
| `OW_INTERNAL_PORT` | Port des Next-Prozesses hinter dem Ingress-Proxy (Default 3001) |
| `OW_DATA_DIR` | Persistentes Datenverzeichnis (Add-on: `/data`) |
| `OW_UID`/`OW_GID` | Nutzer, auf den der Start-Schritt wechselt (Default 1001) |
| `OW_AUTH_MODE` | siehe Tabelle oben |
| `OW_AUTH_USER_HEADER`, `OW_AUTH_NAME_HEADER`, `OW_AUTH_GROUPS_HEADER` | Header-Namen des Anmelde-Proxys |
| `OW_OIDC_ISSUER`, `OW_OIDC_AUDIENCE`, `OW_OIDC_JWKS_URL` | Token-Prüfung für `oidc-bearer` |

Die übrigen Variablen (Instanz-Basis, Vault-/Git-Wurzeln, MCP-Tokens,
Embeddings) stehen in [.env.example](../.env.example).
