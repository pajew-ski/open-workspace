# AGENTS.md - Open Workspace Protocol

> Single Source of Truth für AI-Agent Interaktion mit dieser Codebase

## System Overview

Open Workspace ist eine umfassende Next.js-Anwendung als einheitliche Schnittstelle für AI-Agent-Kollaboration. Das System implementiert Agent2Agent (A2A), Agent2UI (A2UI) und Model Context Protocol (MCP) für standardisierte Agent-Kommunikation.

## Persönlicher Assistent

Der **Persönliche Assistent** ist der zentrale AI-Agent und einziger Ansprechpartner des Operators (Nutzers):

### Eigenschaften
- **Kontext-bewusst**: Weiß immer, auf welcher Seite der Nutzer ist und was er sieht
- **Vollzugriff**: Hat Zugriff auf den gesamten Workspace, alle Module und Daten
- **Koordinator**: Kann alle anderen Agenten delegieren und orchestrieren
- **Allgegenwärtig**: Als Chat-Widget unten rechts auf allen Seiten verfügbar

### Fähigkeiten
- Wissensbasis durchsuchen und bearbeiten
- Canvas-Karten erstellen und verknüpfen
- Aufgaben verwalten und priorisieren
- A2A-Agenten koordinieren und delegieren
- Tools via MCP aufrufen
- Code generieren und analysieren
- Markdown-Dokumente erstellen

### Kontext-Informationen
Der Assistent erhält automatisch:
- Aktuelle Seite/Modul
- Sichtbare Inhalte im Browser
- Ausgewählte Elemente
- Letzte Aktionen des Nutzers
- Relevante Daten aus der Wissensbasis

## Architektur

```
open-workspace/
├── src/
│   ├── app/
│   │   ├── page.tsx              # Dashboard
│   │   ├── knowledge/            # Wissensbasis
│   │   ├── canvas/               # Visuelle Planung
│   │   ├── tasks/                # Aufgaben
│   │   ├── agents/               # A2A Agenten
│   │   ├── communication/        # Matrix Chat
│   │   ├── settings/             # Einstellungen
│   │   └── api/                  # API-Routen
│   │       ├── chat/             # AI Chat + Health
│   │       ├── notes/            # Notes CRUD
│   │       └── tasks/            # Tasks CRUD
│   ├── components/
│   │   ├── ui/                   # Base UI (Material Design)
│   │   ├── layout/               # App Shell
│   │   └── assistant/            # Persönlicher Assistent
│   └── lib/
│       ├── inference/            # Ollama Client
│       └── storage/              # Notes (MD), Tasks (JSON)
├── data/
│   ├── notes/                    # Markdown-Notizen (GitHub-sync)
│   ├── tasks/                    # Aufgaben (JSON)
│   └── canvas/                   # Canvas-Karten (JSON)
└── public/                       # Static Assets
```

## Core Protokolle

### Agent2Agent (A2A)
- HTTP/SSE-basierte Kommunikation
- JSON-RPC Nachrichtenformat
- Capability Discovery via Agent Cards
- Long-running Task Support

### Agent2UI (A2UI)
- Deklarative UI-Komponenten-Beschreibungen
- Streaming JSON für progressive Darstellung
- Pre-approved Component Catalog
- Secure by Design (keine Code-Ausführung)

### Model Context Protocol (MCP)
- Tool und Resource Exposure für Agenten
- Standardisiertes Context Passing
- JSON-RPC 2.0 Messaging

## AI Inference

**Endpunkt**: `http://192.168.42.2:11434`
**Modell**: `gpt-oss-20`
**API**: Ollama REST API

## Data Layer

### Notizen (Markdown)
Gespeichert als `.md` Dateien mit YAML Frontmatter in `data/notes/` für GitHub-Synchronisation.

### Aufgaben (JSON)
Gespeichert in `data/tasks/tasks.json` mit Kanban-Status (open/in-progress/done).

## Modul-Agenten

| Modul | Agent-Rolle | Kontext-Zugriff |
|-------|------------|-----------------|
| Dashboard | Übersicht-Assistent | System-Metriken, aktuelle Items |
| Wissensbasis | Recherche-Assistent | Notizen, Dokumente, Artefakte |
| Canvas | Planungs-Assistent | Karten, Verbindungen |
| Aufgaben | Projekt-Assistent | Tasks, Deadlines, Fortschritt |
| Agenten | A2A Koordinator | Agent-Configs, MCP Tools |
| Kommunikation | Chat-Assistent | Matrix Rooms, Nachrichten |

## Entwicklung

```bash
bun install    # Abhängigkeiten
bun run dev    # Entwicklung
bun run build  # Produktion
```

## Code-Konventionen

- **Sprache**: TypeScript (strict mode)
- **API**: Englisch
- **UI-Labels**: Deutsch (Standard), Englisch (umschaltbar)
- **Anrede**: Immer informell (du-Form, nie Sie-Form)
- **Umlaute**: Korrekte ä, ö, ü, ß verwenden (nie ae, oe, ue)
- **Design**: Mobile-first, responsive

## Design System

- **Stil**: Digital Zen Garden (minimal, fokussiert)
- **Primärfarbe**: #00674F (Teal)
- **Themes**: Light / Dark / System-auto
- **Komponenten**: Material Design 3 inspiriert

---

*Dieses Dokument wird von AI-Agenten und Menschen kollaborativ gepflegt.*
