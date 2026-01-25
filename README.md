# Open Workspace
[![License: GPL v3](https://img.shields.io/badge/License-GPLv3-blue.svg)](./LICENSE)
[![Stack: Next.js 16](https://img.shields.io/badge/Stack-Next.js_16-black)](https://nextjs.org/)
[![Protocol: A2A](https://img.shields.io/badge/Protocol-A2A-00674F)](https://github.com/a2aproject/A2A)
[![Protocol: A2UI](https://img.shields.io/badge/Protocol-A2UI-00674F)](https://github.com/google/A2UI)
[![Protocol: MCP](https://img.shields.io/badge/Protocol-MCP-00674F)](https://modelcontextprotocol.io/)

Open Workspace ist eine **Local-First Kognitions-Architektur**. Es handelt sich um eine Offline-PWA, die als kollaborativer Partner agiert. Durch die strikte Implementierung der offenen Standards **Agent2Agent (A2A)** und **Agent2UI (A2UI)** verschmilzt die Grenze zwischen statischem Interface und generativer AI-Interaktion.

## Features

- **Übersicht (Dashboard)**: Echtzeit-Übersicht mit adaptivem **Masonry-Layout** für optimale Platznutzung
- **Wissensbasis**: Markdown-Notizen mit Professional-Editor (Toolbar) und Umbenennung
- **Pinnwand**: Visuelle Planung mit Karten und Verbindungen
- **Aufgaben**: Projekte und Aufgabenverwaltung im Kanban-Stil
- **Kalender**: ICS/iCal Integration mit Monats-/Wochenansicht
- **Global Finder**: Smarte Suche (`Cmd+F`) mit Modifiers (`@task`, `@note`) und Fuzzy-Matching
- **Agenten**: A2A Agent-Verwaltung und Koordination
- **Kommunikation**: Matrix-Protokoll Chat für Team-Kommunikation
- **Persönlicher Assistent**: Kontext-bewusster AI-Assistent mit **Dynamic UI Generation** (A2UI) und Chat-Historie
- **Mobile First**: Voll responsive UI mit Overlay-Sidebar und Burger-Menü
- **Offline PWA**: Volle Funktionalität ohne Internet
- **Internationalisierung**: Deutsch (Standard) / Englisch

## Tech Stack

- **Framework**: Next.js 16 (App Router)
- **Sprache**: TypeScript
- **Styling**: CSS Modules, Material Design 3
- **State**: Zustand, React Query
- **Offline**: Service Worker, IndexedDB
- **AI Protokolle**: A2A, A2UI, MCP
- **Inference**: Ollama API (lokal)

## Quick Start

```bash
# Klonen und installieren
bun install

# Konfiguration (optional, aber empfohlen für AI)
cp .env.example .env.local
# -> Passe .env.local nach Bedarf an (lokale Ollama IP etc.)

# Entwicklungsserver starten
bun run dev
```

Öffne [http://localhost:3000](http://localhost:3000)

## AI Konfiguration

Standard Inference-Endpunkt: `http://localhost:11434` (Ollama Default)

Konfiguriere in `.env.local`:
```env
NEXT_PUBLIC_LLM_API_BASE_URL=http://localhost:11434
NEXT_PUBLIC_LLM_API_KEY= # Optional
INFERENCE_MODEL=gpt-oss:20b
```

## Design Philosophie

**Digital Zen Garden**: Ruhige, fokussierte Oberfläche mit minimalen Ablenkungen. Neutrale Töne mit #00674F Teal-Akzent. Hell- und Dunkelmodus mit System-Präferenz-Erkennung.

## Projekt-Struktur

```
src/
├── app/          # Seiten und API-Routen
├── components/   # Wiederverwendbare UI-Komponenten
├── lib/          # Core-Utilities und Clients
│   ├── inference/  # Ollama Client
│   └── storage/    # Datenspeicher (Notes, Tasks)
└── types/        # TypeScript Definitionen
data/
├── notes/        # Markdown-Notizen (GitHub-sync ready)
├── tasks/        # Aufgaben (JSON)
└── canvas/       # Canvas-Karten (JSON)
```

## API Routes

| Route | Beschreibung |
|-------|--------------|
| `POST /api/chat` | AI Chat mit Streaming |
| `GET /api/chat/health` | Ollama Verbindungsstatus |
| `GET/POST /api/chat/conversations` | Chat-Historie verwalten |
| `GET /api/chat/conversations?action=events` | Kalender-Termine abrufen |
| `GET/POST /api/notes` | Notizen auflisten/erstellen |
| `GET/PUT/DELETE /api/notes/[id]` | Notiz bearbeiten |
| `GET/POST /api/tasks` | Aufgaben auflisten/erstellen |
| `GET/PUT/DELETE /api/tasks/[id]` | Aufgabe bearbeiten |
| `GET /api/finder` | Globaler Such-Endpunkt (Fuzzy + Smart Modifiers) |
| `GET/POST /api/calendar` | Kalender-Provider & Sync |

## Dokumentation

- [AGENTS.md](./AGENTS.md) - AI-Agent Protokoll und Architektur
- [TODO.md](./TODO.md) - Entwicklungs-Roadmap

## Lizenz

GPL-3.0 - Diese Software ist und bleibt Open Source.
