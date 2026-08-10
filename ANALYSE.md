# Analyse: Vom Prototyp zum fertigen System

> Vollständige Bestandsaufnahme von Open Workspace (Stand 2026-08-08), durchgeführte
> Modernisierung und priorisierte Roadmap für die verbleibenden Schritte.
>
> **Lesehinweis (2026-08-10)**: Dieses Dokument ist die **historische
> Bestandsaufnahme** des Prototyps und der ersten Modernisierung. Die
> Abschnitte 1–4 und 7 beschreiben den Stand vom 2026-08-08 und werden
> bewusst nicht fortgeschrieben — sie sind der Vorher-Zustand, gegen den
> gemessen wurde. Aktuell und verbindlich sind:
> [AGENTS.md](./AGENTS.md) („Hier weitermachen"),
> [GRAPH_CORE_SPEC.md](./GRAPH_CORE_SPEC.md) (Graph-Ausbau M0–M14) und
> [TODO.md](./TODO.md). Der Status der Roadmap in §5 ist unten
> eingearbeitet.
>
> **Nachtrag (2. Ausbaustufe, 2026-08-08)**: Die AI-Plattform wurde voll
> ausgebaut — Multi-Provider-Inference (Cloud + lokal + WebLLM im Browser),
> Backend-Unabhängigkeit mit automatischem Browser/Server-Routing, natives
> Tool-Calling mit Text-Fallback, MCP-Client, A2A-Protokoll (Discovery +
> message/send), Skills-System und die neuen Oberflächen /ai und /skills.
> Damit sind die Roadmap-Punkte **P1.5 (A2A), P1.6 (MCP), P1.7 (natives
> Tool-Calling)** umgesetzt; P1.9 (IndexedDB-Spiegel) ist für die
> AI-Schicht (Chats, Konfiguration, Skills) erledigt und bleibt für die
> Content-Module offen. Architektur: [docs/ai-platform.md](./docs/ai-platform.md).

## 1. Executive Summary

Open Workspace ist ein ambitionierter Local-First-AI-Workspace mit einem soliden,
echt funktionierenden Kern: Dokumente (Markdown + JSON-LD-Ontologie), Aufgaben/Projekte,
Pinnwand (Canvas), Kalender (ICS), Knowledge Graph, Global Finder mit Fuzzy-Suche,
A2UI-Rendering und Streaming-Chat gegen Ollama/OpenAI-kompatible Endpunkte.

Der Prototyp hatte jedoch drei Problemklassen:

1. **Er baute nicht**: Debug-Reste brachen `next build`; die Testtrennung fehlte;
   viele Dependencies waren Monate hinter dem aktuellen Stand.
2. **Attrappen statt Features**: Matrix-Chat, Notifications, Sprachumschalter,
   AI-Settings, GitHub-Sync, MCP-Button, "A2A aktiviert"-Status — UI ohne Funktion.
   Der beworbene Offline-PWA-Modus existierte nicht (kein Service Worker, keine Icons).
   Die Tool-Ausführung war toter Code: Der System-Prompt bewarb eine
   `[[TOOL:...]]`-Syntax, für die es keinen Parser gab.
3. **Sicherheits- und Integritätslücken**: Path Traversal im Bilder-Endpunkt,
   Stored-XSS über SVG-Uploads, API-Key im Client-Bundle, Ciphertext-Leak bei
   Entschlüsselungsfehlern, keinerlei Input-Validierung, nicht-atomare
   JSON-Writes mit garantierten Race Conditions.

**Diese Modernisierung behebt alle Punkte der Klassen 1 und 3 sowie den Großteil
von Klasse 2** (Details in Abschnitt 4). Verbleibende Großfeatures (Matrix,
GitHub-Sync, echtes A2A/MCP-Protokoll, i18n, IndexedDB-Spiegel) sind in
Abschnitt 5 als priorisierte Roadmap beschrieben — sie sind bewusst nicht
angefangen worden, statt weitere halbe Attrappen zu hinterlassen.

## 2. Methodik

- Vollständige Code-Lektüre aller Module (Seiten, API-Routen, Lib-Schichten)
  mit Fokus auf: Was ist echt implementiert, was ist Stub, was ist tot?
- Build-/Test-/Lint-Läufe zur Validierung des Ist-Zustands
- Dependency-Audit (`npm outdated`) gegen den Stand August 2026
- Umsetzung in vier Arbeitspaketen: Toolchain, Sicherheit/Integrität,
  PWA, Kernfeatures — jeweils mit Verifikation (Typecheck, Unit-Tests, Build)

## 3. Befunde im Detail (Ist-Zustand vor der Modernisierung)

### 3.1 Build & Toolchain

| Befund | Schwere |
|---|---|
| `reproduce_issue.ts` (Debug-Skript, `require('node-fetch')`) brach `next build` | Blocker |
| `e2e/chat_persistence.spec.ts` importierte nicht installiertes `@playwright/test`; Vitest sammelte die Datei ein → Testsuite rot | Blocker |
| Doppelte Lockfiles (`bun.lock` + `package-lock.json`) | Mittel |
| 24 veraltete Pakete, darunter openai 4→7 (3 Majors), CopilotKit 1.51→1.66, ESLint, jsdom, schema-dts 1→2, lucide-react 0.5→1.30 | Mittel |
| `tsconfig target: ES2017` (2017er-Baseline für eine 2026er-App) | Niedrig |
| README versprach "Zustand, React Query" als State-Layer — beides nicht installiert | Mittel |

### 3.2 Sicherheit

| Befund | Schwere |
|---|---|
| Path Traversal: `GET /api/images/[filename]` joinede ungeprüft in den Upload-Ordner | Hoch |
| Stored XSS: SVG-Uploads wurden mit `image/svg+xml` inline ausgeliefert | Hoch |
| `NEXT_PUBLIC_LLM_API_KEY` wird von Next.js ins Client-Bundle inlined | Hoch |
| Entschlüsselungsfehler lieferte den **Ciphertext als Credential** zurück (`catch { return val; }`) | Hoch |
| Keine Input-Validierung (kein Zod), blinde `as X`-Casts in allen 20 Routen | Hoch |
| Kein Größenlimit/Magic-Byte-Check beim Upload (Disk-Fill-DoS) | Mittel |
| Masterkey im Klartext neben den verschlüsselten Daten, ohne KDF/Passphrase | Mittel |
| Tool-Executor: JSON-Injection über Platzhalter, kein Timeout, kein SSRF-Schutz | Mittel |
| Keine Authentifizierung/Session (bewusster Local-First-Scope — dokumentationspflichtig) | Kontext |

### 3.3 Datenintegrität

| Befund | Schwere |
|---|---|
| Alle 8+ Storage-Module: Read-Modify-Write ohne Locking, ohne atomares Rename → Lost Updates, korrupte Dateien bei Crash | Hoch |
| `JSON.parse` ohne Fehlerbehandlung → eine korrupte Datei blockiert das Modul dauerhaft mit 500ern | Hoch |
| Selbstgebauter YAML-Frontmatter-Parser bricht bei Doppelpunkten in Werten | Mittel |
| `scripts/migrate-to-docs.ts`: `unlink` **vor** `write` → stiller Datenverlust bei Slug-Kollision | Mittel |

### 3.4 Attrappen und toter Code

| Befund |
|---|
| Matrix-Chat: komplette Seite ohne einen einzigen Event-Handler, keine matrix-js-sdk-Dependency |
| NotificationBell: eine hartkodierte Demo-Notification, "Als gelesen"-Button ohne Handler |
| Settings: Sprachumschalter, Inference-Endpunkt, Modell, GitHub-Connect — alles ohne Funktion |
| Agenten-Seite: hartkodiert "A2A-Protokoll: Aktiviert", "System-Status: Bereit", Badge "Aktiv" |
| Tool-Executor vollständig implementiert, aber **nirgends aufgerufen**; System-Prompt bewarb Tool-Syntax ohne Parser |
| CopilotKit: Runtime + 5 Actions verdrahtet, aber keine CopilotKit-UI gerendert; 2 Actions riefen nicht existierende Endpunkte (`/api/docs/search` → 404, `PUT /api/tasks?id=` → 405) |
| PWA: `manifest.json` referenzierte nicht existierende Icons; kein Service Worker, kein Offline-Modus, keine IndexedDB |
| i18n: nicht vorhanden trotz README-Versprechen "Deutsch/Englisch" |
| A2A: reines CRUD; kein JSON-RPC, keine Agent Cards, keine Discovery |

### 3.5 Funktionale Bugs

| Befund |
|---|
| Knowledge Graph: Nach erstem Filterwechsel verschwanden alle Kanten (`link.source` wird von d3 zum Objekt mutiert, Filter verglich mit String-IDs) |
| Inference-Client: kein Timeout/AbortController; `temperature`/`num_predict` deklariert, aber nie gesendet |
| Ontologie-Generator: Unreachable Code nach `return` — Beschreibungs-Ellipse wurde nie angehängt |
| Chat-Stream-Fehler wurden erst spät behandelt; Health-Route zeigte Env-Default statt effektiver Konfiguration |
| react-hooks v7 (React-Compiler-Checks) meldete 10 echte Fehler: setState-in-Effect-Kaskaden, TDZ-Zugriffe, `Math.random()` im Render |

## 4. Durchgeführte Modernisierung (dieser Branch)

### 4.1 Toolchain & Dependencies

- Produktions-Build repariert (Debug-Skript und Alt-Lockfile entfernt)
- **Next.js 16.3**, React 19.2.8, CopilotKit 1.66, openai 7, lucide-react 1.x,
  schema-dts 2, mermaid 11.16, date-fns 4.4, node-ical 0.27, Vitest 4.1,
  jsdom 30, Testing-Library-jest-dom 7
- **TanStack React Query** eingeführt (README-Versprechen eingelöst);
  fetch-on-mount-Komponenten migriert
- `tsconfig target: ES2022`; `typecheck`-Script ergänzt
- Unit-/E2E-Trennung: Vitest scoped auf `src/`+`tests/`, Playwright-Setup
  (`playwright.config.ts`, `test:e2e`) mit echtem, lauffähigem E2E-Test
  (stabile `data-testid`-Selektoren; LLM-Test skippt ohne erreichbaren Endpunkt)
- Lint auf 0 Errors; `no-explicit-any` bewusst als Warning während der
  schrittweisen Typisierung (135 Warnings sichtbar gehalten statt versteckt)
- Bewusste Versionsentscheidungen: **ESLint 9.39** statt 10 (eslint-config-next 16.3
  bündelt typescript-eslint v8, das ESLint 10 noch nicht trägt) und
  **TypeScript 5.9** statt 7 (typescript-eslint unterstützt <6.1; TS 6 ist Beta) —
  beides dokumentierte Upgrade-Kandidaten, sobald das Ökosystem nachzieht

### 4.2 Sicherheit & Datenintegrität

- Path-Traversal-Fix, SVG-Auslieferung entschärft, Upload-Allowlist mit
  Magic-Byte-Prüfung und 10-MB-Limit, `X-Content-Type-Options: nosniff`
- **Zod-Validierung** an allen schreibenden API-Routen; konsistente Fehlerantworten
- API-Key nur noch serverseitig (`LLM_API_KEY`); Legacy-Namen als Fallback
- Entschlüsselungsfehler liefern nie mehr Ciphertext; `WORKSPACE_MASTER_KEY`-Env-Option;
  Keyfile mit Mode 0600
- **Atomare Writes** (tmp+rename) plus In-Process-Dateilocks für alle Storage-Module;
  defensives Lesen mit Quarantäne korrupter Dateien
- Tool-Executor: JSON-sichere Platzhalter, Timeout, URL-Schema-Prüfung,
  SSRF-Schutz mit `ALLOW_LOCAL_TOOL_URLS`-Escape-Hatch für lokale Endpunkte
- Migrationsskript mit Datenverlust-Risiko entfernt (Migration war abgeschlossen)

### 4.3 PWA

- **Service Worker** (Vanilla JS, Turbopack-kompatibel): App-Shell-Precache,
  network-first für Navigation und `GET /api/*` mit Offline-Fallback,
  cache-first für Statics, `/api/chat` (Streaming) bewusst ausgenommen,
  Versionierung + Update-Flow (SKIP_WAITING)
- **App-Icons** (192/512, any + maskable) im Digital-Zen-Design generiert,
  wiederverwendbares Generator-Skript (`scripts/generate-icons.ts`)
- Manifest vervollständigt (id, scope, lang, Shortcuts); Offline-Seite in
  hell/dunkel; Registrierung mit sauberem Update-Reload

### 4.4 Kernfeatures

- **Tool-Ausführung existiert jetzt wirklich**: Streaming-Parser für
  `[[TOOL:id:{args}]]` (chunk-grenzen-sicher, unit-getestet), serverseitiger
  Tool-Loop (max. 3 Runden) mit Fortschrittsanzeige im Chat und
  Ergebnis-Rückführung ans Modell
- Inference-Client: Timeouts, Options-Durchreichung, Settings-Auflösung
- **Funktionale AI-Settings**: Endpunkt + Modell werden in `data/settings.json`
  persistiert (`/api/settings`), Modell-Dropdown aus Live-Health-Check
- **Echte Notifications**: gespeist aus dem realen Activity-Log
  (`/api/activity`), Ungelesen-Zählung mit persistiertem Read-State
- Knowledge-Graph-Filter-Bug behoben; CopilotKit-Actions auf existierende
  Endpunkte umgestellt; CopilotKit-Env-Konfiguration mit der übrigen App vereinheitlicht
- Agenten-PUT-Route (Agenten sind jetzt editierbar)
- **Ehrliche UI**: Matrix-Seite kennzeichnet den Planungsstand statt toter
  Buttons; Agenten-Status zeigt reale Zahlen statt "Aktiviert"-Hardcoding;
  tote Settings-Attrappen (Sprache, GitHub) entfernt bis die Features existieren
- Hydration-Muster auf `useSyncExternalStore` umgestellt (Theme, Sidebar,
  Notifications-Read-State); `useId()` statt `Math.random()`

### 4.5 CI/CD & Deployment

- GitHub-Actions-Workflow: Lint → Typecheck → Unit-Tests → Build,
  plus optionaler E2E-Job mit Playwright-Report-Artifact
- Multi-Stage-Dockerfile (bun-Build, Node-22-Alpine-Runtime, non-root,
  `output: 'standalone'`, `data/` als Volume)

## 5. Roadmap zum vollständigen System

Priorisierung: **P0** = nächster sinnvoller Schritt, **P1** = danach, **P2** = Vision.
Aufwände sind Richtwerte für eine Person.

> **Stand 2026-08-10**: Der Graph-Ausbau nach
> [GRAPH_CORE_SPEC.md](./GRAPH_CORE_SPEC.md) (M0–M14) hat große Teile
> dieser Liste eingeholt — teils anders gelöst als hier gedacht. Der
> Status steht bei jedem Punkt; die abhakbare Fassung ist
> [TODO.md](./TODO.md). Bei Widerspruch gilt die Spec.

### P0 — Fundament abrunden (je 0,5–2 Tage)

1. ⏳ **offen** — **i18n wirklich einführen** (`next-intl`): Dictionary-Extraktion aller
   UI-Strings (de als Quelle), en-Übersetzung, Umschalter in den Settings,
   `<html lang>` dynamisch. Das README-Versprechen ist sonst unerfüllbar.
2. ✅ **erledigt** — **`no-explicit-any`-Abbau**: `bun run lint` meldet 0 Warnings.
   Die vorhandenen Typen (`Tool`, `CreateToolRequest`, `Connection`, `Widget`,
   `LegacyGraphView`) tragen jetzt die Stellen, die vorher `any` waren; die
   Force-Graph-Callbacks nutzen die Generics des Pakets. Einzige verbleibende
   Ausnahme ist die A2UI-Protokollgrenze — dort kommen die Bausteine von einem
   entfernten Agenten und sind zur Bauzeit nicht typisierbar; das steht als
   `A2UIValue` benannt und begründet im Code.
3. ⏳ **offen** — **CopilotKit-Entscheidung**: Entweder die CopilotKit-UI (Sidebar/Popup)
   rendern und die 5 Actions erlebbar machen — oder den Stack entfernen und
   die Actions in den eigenen Tool-Loop überführen. Aktuell doppelte
   Infrastruktur (~Bundle-Kosten ohne Nutzererlebnis).
4. ⏳ **offen** — **Frontmatter-Parser ersetzen** durch `yaml`/`gray-matter` (Robustheit).

### P1 — Versprochene Großfeatures (je 3–10 Tage)

5. ✅ **erledigt** (2. Ausbaustufe) — **Echtes A2A-Protokoll**: `/.well-known/agent.json` (Agent Card),
   JSON-RPC-Endpunkt, Task-Lifecycle (submitted → working → completed),
   Remote-Agent-Aufruf im Chat-Tool-Loop (`[[AGENT:id:prompt]]` analog zum
   Tool-Muster), Capability Discovery.
6. ✅ **erledigt** — Client in der 2. Ausbaustufe, **Server** mit M10
   (`/api/mcp`, SPEC §7.6) — **Echtes MCP**: `@modelcontextprotocol/sdk` als Client — konfigurierte
   MCP-Server (stdio/HTTP) verbinden, deren Tools in den Tool-Loop einspeisen;
   den "Geplant"-Button in den Werkzeugen aktivieren.
7. ✅ **erledigt** (2. Ausbaustufe) — **Natives Tool-Calling**: Bei Modellen mit Function-Calling-Support
   (Ollama `tools`-Parameter) die Text-Syntax durch echtes Tool-Calling
   ersetzen; Text-Syntax als Fallback behalten.
8. ✅ **anders gelöst** (M6) — Git-Sync läuft über den EINEN
   Connector-Vertrag (`git-backup`: Backup-Einbahnstraße oder
   bidirektional mit Konfliktregel §6.2, `process-git` und
   `isomorphic-git` als zwei Bindungen), lesende GitHub-Quellen über
   `github-rdf` (commit-gepinnt). Offen bleibt nur der **OAuth Device
   Flow** als bequemerer Zugang statt Token aus der Umgebung.
9. ⏳ **teilweise** — für die AI-Schicht erledigt (Chats in IndexedDB,
   Konfiguration im localStorage); für die Workspace-Inhalte offen. Die
   Bausteine der Runtime `local` stehen seit M12 (Store im Web Worker,
   OPFS, isomorphic-git) — was fehlt, ist die Umstellung der Oberflächen
   auf sie. **IndexedDB-Spiegel + Background Sync**
10. ⏳ **offen** (die Seite kennzeichnet ihren Planungsstand) — **Matrix-Chat**: matrix-js-sdk, Login/SSO, Raum-Liste, E2EE via
    Rust-Crypto-WASM. Bewusst groß — alternativ Element-Web-Embed prüfen.

### P2 — Reife & Vision

11. ⏳ **teilweise** — Identität und Rechte sind gebaut (M12/M13:
    `OW_AUTH_MODE`, Web Access Control in `graph/acl`, Rate-Limits an
    MCP-, Föderations- und anonymen Routen). Offen: Passkey/WebAuthn als
    eigener Anmeldefluss und Rate Limiting an den **Chat**-Routen.
12. ✅ **erledigt** und im blockierenden E2E-Gate abgesichert
    (`e2e/a11y`, `e2e/mobile-*`) — **Accessibility-Durchgang**: Fokus-Management in Dialogen/Overlays,
    ARIA-Rollen im Chat (log/status), Reduced-Motion, Tastatur-Navigation
    auf der Pinnwand.
13. ⏳ **bewusst ausgeschlossen für v1** (SPEC §15: Store bleibt
    single-writer pro Graph) — **Kollaboration**: CRDT-Layer (Yjs) über Docs/Canvas, wenn Multi-Device
    oder Multi-User real wird.
14. ⏳ **offen** (git-basiert ist über `git-backup` möglich, aber ohne UI) —
    **Versionshistorie für Dokumente** (einfach: Snapshot-Ordner; besser: git-basiert
    mit dem GitHub-Sync aus P1).
15. ✅ **Grundlage steht** — MCP in beide Richtungen (Client + Server),
    dazu der Connector-Vertrag als zweiter Erweiterungspunkt.
    **Plugin-System**

## 6. Technologie-Entscheidungen (Warum so?)

| Entscheidung | Begründung |
|---|---|
| Eigener Service Worker statt Serwist/next-pwa | Next 16 baut mit Turbopack; die Plugin-Ökosysteme hängen an Webpack. Ein handgeschriebener SW ist hier robuster und dependency-frei. |
| ESLint 9.39 statt 10 | `eslint-config-next` 16.3 bündelt typescript-eslint v8 (max. ESLint 9). Upgrade, sobald Next nachzieht. |
| TypeScript 5.9 statt 7 (tsgo) | typescript-eslint unterstützt <6.1; TS 6 ist Beta. Der native Compiler ist der richtige Schritt — aber erst mit kompatiblem Lint-Stack. |
| React Query statt Zustand für Server-State | Die App hat fast nur Server-State (JSON-Stores via API). Client-State ist klein (useState reicht). Zustand bleibt Kandidat für den Canvas-Editor. |
| Text-Syntax-Tool-Loop statt sofort natives Function Calling | Funktioniert mit jedem Modell (auch ohne Tool-Support), war als Konvention schon dokumentiert. Natives Calling ist als P1.7 geplant. |
| Tote UI entfernt statt schnell "irgendwas" angebunden | Attrappen kosten Vertrauen und verdecken den echten Zustand. Roadmap-Ehrlichkeit schlägt Feature-Illusion. |

## 7. Verifikation (Stand dieser Analyse, 2026-08-08)

- `bun run build`: ok (Next 16.3, Turbopack, 27 Seiten)
- `bun run typecheck`
- `bun run test:run`: ok (35 Unit-Tests: A2UI-Renderer, Ontologie, Tool-Call-Parser)
- `bun run lint`: 0 Errors (Warnings bewusst sichtbar)
- E2E: Widget-Test läuft headless; Konversations-Test skippt ohne LLM sauber

**Heutiger Stand (2026-08-10)**: dieselben Kommandos plus
`bun run check:ontology`; 495 Unit-Tests und ein blockierendes E2E-Gate
(`e2e/a11y`, `e2e/mobile-navigation`, `e2e/mobile-ux`, `e2e/ingress`).
Die laufend gepflegte Fassung steht in [AGENTS.md](./AGENTS.md).
