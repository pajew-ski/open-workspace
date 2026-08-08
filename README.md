# Open Workspace
[![License: GPL v3](https://img.shields.io/badge/License-GPLv3-blue.svg)](./LICENSE)
[![Stack: Next.js 16](https://img.shields.io/badge/Stack-Next.js_16-black)](https://nextjs.org/)
[![Protocol: A2UI](https://img.shields.io/badge/Protocol-A2UI-00674F)](https://github.com/google/A2UI)
[![Protocol: A2A (geplant)](https://img.shields.io/badge/Protocol-A2A_geplant-8a8a8a)](https://github.com/a2aproject/A2A)
[![Protocol: MCP (geplant)](https://img.shields.io/badge/Protocol-MCP_geplant-8a8a8a)](https://modelcontextprotocol.io/)

Open Workspace ist eine **Local-First Kognitions-Architektur**: eine installierbare
PWA, die als kollaborativer Partner agiert. Ein kontext-bewusster AI-Assistent
begleitet alle Module, rendert dynamische UI (A2UI) direkt im Chat und führt
konfigurierte Tools selbstständig aus.

## Features

- **Übersicht (Dashboard)**: Echtzeit-Übersicht mit adaptivem Masonry-Layout
- **Wissensbasis**: Markdown-Dokumente mit Editor, JSON-LD-Ontologie (Schema.org) und Wiki-Links
- **Knowledge Graph**: Interaktiver Force-Graph über alle Inhalte (JSON-LD `@graph`)
- **Aufgaben**: Projekte und Aufgaben im Kanban-Stil mit Prioritäten und Fälligkeiten
- **Pinnwand (Canvas)**: Visuelle Planung mit Karten und Verbindungen
- **Kalender**: ICS/iCal-Provider mit Monats-/Wochenansicht
- **Global Finder**: Smarte Suche (`Cmd+F`) mit Modifiers (`@task`, `@doc`, …) und Fuzzy-Matching
- **Persönlicher Assistent**: Streaming-Chat mit Seiten-Kontext, Chat-Historie,
  **Agent2UI-Rendering** und **automatischer Tool-Ausführung** (`[[TOOL:…]]`-Loop)
- **Generative Oberfläche**: UI entsteht pro Interaktion aus dem Gespräch statt
  aus festen Views. Native, selbst-ladende Workspace-Widgets (Aufgaben, Kalender,
  Dokumente, Kennzahlen) und eingebettete UI nach **MCP-UI-Standard**; ganzseitig
  unter `/assistant` mit Dialog links und generativer Bühne rechts
- **Werkzeuge**: Externe APIs als Tools, sichere Verbindungen (AES-256-GCM at rest)
- **Agenten**: Verwaltung lokaler und Remote-Agenten (A2A-Protokoll in Entwicklung)
- **Benachrichtigungen**: Echtes Activity-Log mit Ungelesen-Status
- **Backup**: Kompletter Workspace-Export als JSON (Settings → Daten)
- **Offline PWA**: Service Worker mit App-Shell-Precache, API-Cache und Offline-Seite
- **Mobile First**: Voll responsive UI mit Overlay-Sidebar und FABs

## Tech Stack

- **Framework**: Next.js 16 (App Router, Turbopack)
- **Sprache**: TypeScript (strict, ES2022)
- **Styling**: CSS Modules, Material Design 3 inspiriert
- **State**: TanStack React Query (Server-State), useSyncExternalStore (persistenter UI-State)
- **Validierung**: Zod an allen schreibenden API-Routen
- **Offline**: Eigener Service Worker (Turbopack-kompatibel, ohne Build-Plugin)
- **AI**: Ollama oder jeder OpenAI-kompatible Endpunkt, Streaming + Tool-Loop
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

## AI-Konfiguration

Endpunkt und Modell lassen sich **direkt in den Einstellungen** der App setzen
(persistiert in `data/settings.json`) — oder per Umgebungsvariablen:

```env
LLM_API_BASE_URL=http://localhost:11434   # Ollama-Default; für OpenAI-kompatible Provider /v1 anhängen
LLM_MODEL=gpt-oss:20b
# LLM_API_KEY=sk-...                      # nur serverseitig, niemals NEXT_PUBLIC_
```

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
- **Scope**: Die App ist für den lokalen Einzelnutzer-Betrieb konzipiert und hat
  bewusst keine Login-Schicht — vor ein öffentliches Deployment gehört ein
  Auth-Proxy (siehe [ANALYSE.md](./ANALYSE.md), Roadmap P2)

## Projekt-Struktur

```
src/
├── app/            # Seiten und API-Routen
├── components/     # UI-Komponenten (a2ui, assistant, dashboard, pwa, …)
├── lib/            # Core: inference, storage (atomar), tools, settings, security
└── types/          # TypeScript-Definitionen
data/               # Local-First-Datenhaltung (JSON/Markdown), data/secure ausgenommen
public/             # PWA: manifest, sw.js, icons, offline.html
e2e/                # Playwright-Tests
```

## API-Routen (Auszug)

| Route | Beschreibung |
|-------|--------------|
| `POST /api/chat` | AI-Chat mit Streaming und Tool-Loop |
| `GET /api/chat/health` | Verbindungsstatus + verfügbare Modelle |
| `GET/PUT /api/settings` | Workspace-Einstellungen (Inference) |
| `GET /api/activity` | Activity-Log (Benachrichtigungen) |
| `GET /api/export` | Workspace-Backup als JSON-Download |
| `GET/POST /api/docs`, `/api/docs/[id]` | Wissensbasis |
| `GET/POST /api/tasks`, `/api/tasks/[id]` | Aufgaben |
| `GET/POST /api/projects`, `/api/projects/[id]` | Projekte |
| `GET/POST /api/canvas` | Pinnwand |
| `GET/POST /api/calendar` | Kalender-Provider & Sync |
| `GET /api/finder` | Globale Suche (Fuzzy + Modifiers) |
| `GET /api/graph` | JSON-LD Knowledge Graph |
| `GET/POST/PUT/DELETE /api/agents` | Agenten-Verwaltung |
| `GET/POST/DELETE /api/tools` | Tool-Konfiguration |
| `GET/POST/PUT/DELETE /api/connections` | Sichere Verbindungen |

## Dokumentation

- [ANALYSE.md](./ANALYSE.md) — Vollständige Analyse, Modernisierung und Roadmap
- [AGENTS.md](./AGENTS.md) — AI-Agent-Protokoll und Architektur
- [CHAT_WIDGET_SPEC.md](./CHAT_WIDGET_SPEC.md) — Verhaltens-Spezifikation des Chat-Widgets
- [TODO.md](./TODO.md) — Entwicklungs-Roadmap

## Lizenz

GPL-3.0 — Diese Software ist und bleibt Open Source.
