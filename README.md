# Open Workspace
[![License: GPL v3](https://img.shields.io/badge/License-GPLv3-blue.svg)](./LICENSE)
[![Stack: Next.js 16](https://img.shields.io/badge/Stack-Next.js_16-black)](https://nextjs.org/)
[![Protocol: A2UI](https://img.shields.io/badge/Protocol-A2UI-00674F)](https://github.com/google/A2UI)
[![Protocol: A2A](https://img.shields.io/badge/Protocol-A2A-00674F)](https://github.com/a2aproject/A2A)
[![Protocol: MCP](https://img.shields.io/badge/Protocol-MCP-00674F)](https://modelcontextprotocol.io/)

Open Workspace ist eine **Local-First Kognitions-Architektur**: eine installierbare
PWA, die als kollaborativer Partner agiert. Ein kontext-bewusster AI-Assistent
begleitet alle Module, rendert dynamische UI (A2UI) direkt im Chat und führt
konfigurierte Tools selbstständig aus.

## Features

- **AI-Hub (Multi-Provider-Inference)**: Beliebig viele Provider parallel —
  Cloud (OpenAI, Anthropic, Gemini, Mistral, Groq, OpenRouter, Together,
  DeepSeek, xAI, eigene Endpunkte), lokal (Ollama, LM Studio, llama.cpp,
  vLLM, Jan) und **WebLLM direkt im Browser (WebGPU)**. Live-Status,
  Modell-Discovery, Standard-Wahl, Provider·Modell-Switcher im Chat
- **Backend-unabhängig**: Jede Anfrage nimmt automatisch den Weg, der
  funktioniert — **Browser-direkt** (erreicht lokale Endpunkte auch bei
  cloud-gehosteter App; Keys optional nur im Browser) oder **Server-Route**
  (verschlüsselte Keys, CORS-Fälle). Ohne Backend laufen Konfiguration,
  Chats (IndexedDB), Skills und Inference vollständig im Browser weiter
- **Übersicht (Dashboard)**: Echtzeit-Übersicht mit adaptivem Masonry-Layout
- **Wissensbasis**: Markdown-Dokumente mit Editor, JSON-LD-Ontologie (Schema.org) und Wiki-Links
- **Knowledge Graph**: Interaktiver Force-Graph über alle Inhalte (JSON-LD `@graph`)
- **Aufgaben**: Projekte und Aufgaben im Kanban-Stil mit Prioritäten und Fälligkeiten
- **Pinnwand (Canvas)**: Visuelle Planung mit Karten und Verbindungen
- **Kalender**: ICS/iCal-Provider mit Monats-/Wochenansicht
- **Global Finder**: Smarte Suche (`Cmd+F`) mit Modifiers (`@task`, `@doc`, …) und Fuzzy-Matching
- **Persönlicher Assistent**: Streaming-Chat mit Seiten-Kontext, Chat-Historie,
  **Agent2UI-Rendering** und Tool-Loop — **natives Function Calling** wo
  verfügbar, universelle `[[TOOL:…]]`-Text-Syntax als Fallback
- **MCP-Client**: Model-Context-Protocol-Server verbinden (Streamable HTTP/SSE,
  browser-direkt oder Server-Relay) — deren Tools landen im Tool-Loop, deren
  Prompts sind als Skills importierbar, gelieferte `ui://`-UI rendert auf der Bühne
- **MCP-Server** (`/api/mcp`): Der Workspace ist auch MCP-*Server* — externe
  Agenten retrieven auf dem Wissensgraphen (`graph_search`, `graph_retrieve`,
  `graph_neighbors`, `graph_describe`, `graph_sparql`, optional `graph_write`),
  Knoten als Resources `graph://<iri>`, Retrieval-Profile als Prompts. Zugang
  nur per Token; ein Token nennt den Nutzer, dessen Rechte aus `graph/acl`
  gelten (`OW_MCP_TOKENS`)
- **Föderation** (`/graph/federation`): `SERVICE`-Abfragen gegen registrierte
  SPARQL-Endpoints (Vertrauensstufe entscheidet, ob lokale Join-Schlüssel
  mitgeschickt werden), SSRF-Schutz, Zeit- und Ergebnis-Limits — und der eigene
  Endpoint als föderierbare Quelle (`/api/graph/federation/sparql`, read-only;
  ohne Token ist das Dataset leer)
- **Zugriff & Freigaben** (`/graph/access`): Mehrbenutzerbetrieb mit eigenen
  Nutzergraphen, geteilten Räumen und Web-Access-Control-Regeln in
  `graph/acl` — Rechte pro Named Graph (Lesen, Beitragen, Bearbeiten,
  Verwalten), per Default gehört jeder Graph nur seinem Eigentümer. Der
  öffentliche Teilgraph ist anonym lesbar und föderierbar
  (`/.well-known/void`, dereferenzierbare Entitäts-IRIs)
- **Agenten (A2A)**: Remote-Agenten per Agent-Card-Discovery verbinden
  (JSON-RPC `message/send`, Task-Polling) und lokale Personas definieren —
  der Assistent delegiert im Chat via `[[AGENT:id:…]]`
- **Skills**: Anleitungspakete nach SKILL.md-Konvention aus allen Quellen
  (manuell, URL, GitHub-Repo, MCP-Prompts) mit Progressive Disclosure
  (`use_skill`-Tool) oder Immer-aktiv-Injection
- **Generative Oberfläche**: UI entsteht pro Interaktion aus dem Gespräch statt
  aus festen Views. Native, selbst-ladende Workspace-Widgets (Aufgaben, Kalender,
  Dokumente, Kennzahlen) und eingebettete UI nach **MCP-UI-Standard**; ganzseitig
  unter `/assistant` mit Dialog links und generativer Bühne rechts
- **Werkzeuge**: Externe APIs als Tools, sichere Verbindungen (AES-256-GCM at rest)
- **Benachrichtigungen**: Echtes Activity-Log mit Ungelesen-Status
- **Backup**: Kompletter Workspace-Export als JSON (Settings → Daten)
- **Offline PWA**: Service Worker mit App-Shell-Precache, API-Cache und Offline-Seite;
  mit WebLLM-Modell im Cache chattet der Assistent auch offline
- **Mobile First**: Voll responsive UI mit Overlay-Sidebar und FABs

## Tech Stack

- **Framework**: Next.js 16 (App Router, Turbopack)
- **Sprache**: TypeScript (strict, ES2022)
- **Styling**: CSS Modules, Material Design 3 inspiriert
- **State**: TanStack React Query (Server-State), useSyncExternalStore (persistenter UI-State)
- **Validierung**: Zod an allen schreibenden API-Routen
- **Offline**: Eigener Service Worker (Turbopack-kompatibel, ohne Build-Plugin)
- **AI**: Multi-Provider (OpenAI-kompatibel, Anthropic, Ollama nativ, WebLLM/WebGPU),
  isomorphe Engine (Browser + Server), natives Tool-Calling mit Text-Fallback,
  MCP-Client (`@modelcontextprotocol/sdk`), A2A-Client
- **Tests**: Vitest + Testing Library (Unit), Playwright (E2E)

## Quick Start

```bash
# Installieren (bun ist der Paketmanager dieses Repos)
bun install

# Konfiguration (optional, aber empfohlen für AI)
cp .env.example .env.local
# -> .env.local anpassen (Ollama-URL, Modell, optional API-Key)

# Entwicklungsserver starten
bun run dev
```

Öffne [http://localhost:3000](http://localhost:3000)

### Docker

```bash
docker build -t open-workspace .
docker run -p 3000:3000 -v ow-data:/app/data open-workspace
```

### Server-Deployment und Home-Assistant-Add-on

Dasselbe Image trägt beide Betriebsarten — Unterschied ist nur das
Packaging (Details: [docs/deployment.md](./docs/deployment.md)):

```bash
# Server: TLS über Caddy, Anmeldung über oauth2-proxy (OIDC)
cp deploy/server/.env.example deploy/server/.env
docker compose -f deploy/server/docker-compose.yml --profile oidc up -d
```

Als **Home-Assistant-Add-on** wird `deploy/ha-addon/config.yaml` als
Add-on-Repository eingebunden; die Oberfläche läuft dann über Ingress —
ohne eigenen Port, mit der Anmeldung von Home Assistant
([deploy/ha-addon/DOCS.md](./deploy/ha-addon/DOCS.md)).

## AI-Konfiguration

Provider werden im **AI-Hub** (`/ai`) verwaltet: Preset wählen (Ollama,
LM Studio, OpenAI, Anthropic, WebLLM, …), Endpunkt/Key eintragen, fertig.
Schlüssel liegen wahlweise **verschlüsselt auf dem Server** (Anfragen laufen
dann über das Backend) oder **nur im Browser** (Direktverbindung — funktioniert
auch ohne Backend). Die Konfiguration liegt in `data/ai/config.json` (gitignored).

Für den Browser-Direktzugriff auf lokales Ollama aus einer gehosteten App:

```bash
OLLAMA_ORIGINS=https://deine-app.example ollama serve   # oder OLLAMA_ORIGINS='*'
```

Umgebungsvariablen (`LLM_API_BASE_URL`, `LLM_MODEL`, `LLM_API_KEY`) werden
beim ersten Start automatisch in einen Provider migriert. Details:
[docs/ai-platform.md](./docs/ai-platform.md).

## Entwicklung & Qualität

```bash
bun run dev        # Entwicklung
bun run lint       # ESLint (0 Errors erwartet)
bun run typecheck  # TypeScript
bun run test       # Unit-Tests (Watch)
bun run test:run   # Unit-Tests (CI)
bun run test:e2e   # Playwright E2E (braucht Build; LLM-Test skippt ohne Endpunkt)
bun run build      # Produktion
```

CI läuft via GitHub Actions (`.github/workflows/ci.yml`): Lint → Typecheck → Tests → Build.

## Design-Philosophie

**Digital Zen Garden**: Ruhige, fokussierte Oberfläche mit minimalen Ablenkungen.
Neutrale Töne mit `#00674F`-Teal-Akzent. Hell-/Dunkelmodus mit System-Erkennung.

## Sicherheit & Credentials

- **Verschlüsselung**: Lokale Secrets mit AES-256-GCM (`data/secure/`), Keyfile 0600
  oder `WORKSPACE_MASTER_KEY`-Env; Entschlüsselungsfehler leaken nie Ciphertext
- **Verbindungen**: Zentrale Auth-Verwaltung (Bearer, API-Key, Basic), getrennt von Tools,
  `ENV:MY_VAR`-Referenzen statt lokaler Speicherung möglich
- **API-Härtung**: Zod-Validierung, Upload-Allowlist mit Magic-Byte-Prüfung,
  Path-Traversal-Schutz, SSRF-Schutz im Tool-Executor
- **Anmeldung**: Die App führt bewusst keinen eigenen Anmeldefluss. Sie liest
  die Identität aus ihrer Umgebung (`OW_AUTH_MODE`: Home-Assistant-Ingress,
  vorgelagerter OIDC-Proxy, oder ein selbst geprüftes Bearer-Token) und zeigt
  sie an; die Durchsetzung übernimmt der Proxy vor der App. Das
  Server-Compose bringt ihn mit ([docs/deployment.md](./docs/deployment.md)).
- **Scope**: Rechte pro Nutzer und Graph sind noch nicht implementiert
  (Graph Core M13, [GRAPH_CORE_SPEC.md](./GRAPH_CORE_SPEC.md) §17) —
  `capabilities.multiUser` steht deshalb auf `false`. Ohne Auth-Proxy davor
  ist die Installation Einzelnutzer-Betrieb.

## Projekt-Struktur

```
src/
├── app/            # Seiten und API-Routen
├── components/     # UI-Komponenten (a2ui, assistant, dashboard, pwa, …)
├── lib/            # Core: inference, storage (atomar), tools, settings, security
└── types/          # TypeScript-Definitionen
data/               # Local-First-Datenhaltung (JSON/Markdown), data/secure ausgenommen
public/             # PWA: sw.js, icons, offline.html (Manifest ist eine Route)
deploy/             # Packaging: HA-Add-on (config.yaml) und server-Compose
scripts/            # Start-Einstieg des Images, Base-Path-Rewrite, Ingress-Proxy
e2e/                # Playwright-Tests
```

## API-Routen (Auszug)

| Route | Beschreibung |
|-------|--------------|
| `POST /api/chat` | AI-Chat mit Streaming und Tool-Loop (Server-Pfad der Engine) |
| `GET /api/chat/health` | Status des Standard-Providers + Inventar |
| `GET /api/ai/config` | AI-Plattform-Konfiguration (client-sicher) |
| `POST/PUT/DELETE /api/ai/providers` | Inference-Provider (Keys verschlüsselt) |
| `POST /api/ai/mcp/[id]`, `/api/ai/a2a` | MCP-/A2A-Relays für CORS-Fälle |
| `GET/POST /api/skills` | Skills (SKILL.md-Konvention) |
| `GET/PUT /api/settings` | Legacy-Inference-Einstellungen (migriert zu /api/ai) |
| `GET /api/activity` | Activity-Log (Benachrichtigungen) |
| `GET /api/export` | Workspace-Backup als JSON-Download |
| `GET/POST /api/docs`, `/api/docs/[id]` | Wissensbasis |
| `GET/POST /api/tasks`, `/api/tasks/[id]` | Aufgaben |
| `GET/POST /api/projects`, `/api/projects/[id]` | Projekte |
| `GET/POST /api/canvas` | Pinnwand |
| `GET/POST /api/calendar` | Kalender-Provider & Sync |
| `GET /api/finder` | Globale Suche (Fuzzy + Modifiers) |
| `GET /api/graph` | JSON-LD Knowledge Graph |
| `GET/POST /api/graph/sparql` | SPARQL 1.1 Protocol (Content Negotiation, geschützter Update-Pfad) |
| `POST /api/graph/retrieve`, `GET /api/graph/search` | Multi-Hop-Retrieval und Graph-Suche |
| `POST/GET/DELETE /api/mcp` | MCP-Server (Streamable HTTP) — Token-gebunden |
| `GET /api/mcp/status` | Status des MCP-Servers (Zugänge, Rechte, Sitzungen — ohne Geheimnisse) |
| `GET/POST /api/graph/federation/endpoints` | Registrierte SPARQL-Endpoints (`ow:FederatedEndpoint`) |
| `GET/POST /api/graph/federation/sparql` | Eingehende Föderation (read-only, Dataset aus dem Token) |
| `GET /api/graph/access` | Identität, sichtbare Graphen, Freigaben, Räume |
| `POST/DELETE /api/graph/access/authorizations`, `/spaces`, `/groups` | Freigaben, geteilte Räume, Gruppen verwalten |
| `POST /api/graph/access/publish` | Knoten freigeben (kopieren/verschieben, als `prov:Activity` protokolliert) |
| `GET /.well-known/void` | VoID-Beschreibung des sichtbaren Datasets |
| `GET /u/<userId>/<type>/<id>` | Dereferenzierung einer Entität (Turtle/JSON-LD/HTML) |
| `GET/POST/PUT/DELETE /api/agents` | Agenten-Verwaltung |
| `GET/POST/DELETE /api/tools` | Tool-Konfiguration |
| `GET/POST/PUT/DELETE /api/connections` | Sichere Verbindungen |

## Dokumentation

- [docs/ai-platform.md](./docs/ai-platform.md) — AI-Plattform: Multi-Provider, Routing, MCP, A2A, Skills, Serverless
- [docs/multi-user.md](./docs/multi-user.md) — Identität, ACL-Modell, Durchsetzung, öffentlicher Teilgraph
- [GRAPH_CORE_SPEC.md](./GRAPH_CORE_SPEC.md) — verbindliche Spec des Graph-Kerns (M0–M13)
- [ANALYSE.md](./ANALYSE.md) — Vollständige Analyse, Modernisierung und Roadmap
- [AGENTS.md](./AGENTS.md) — AI-Agent-Protokoll und Architektur
- [CHAT_WIDGET_SPEC.md](./CHAT_WIDGET_SPEC.md) — Verhaltens-Spezifikation des Chat-Widgets
- [TODO.md](./TODO.md) — Entwicklungs-Roadmap

## Lizenz

GPL-3.0 — Diese Software ist und bleibt Open Source.
