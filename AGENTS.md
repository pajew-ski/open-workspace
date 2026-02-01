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
- Wissensbasis durchsuchen und bearbeiten (Professional Editor)
- Canvas-Karten erstellen und verknüpfen
- Aufgaben verwalten und priorisieren
- Global Finder nutzen (`workspace_finder`) für kontext-sensitive Suchen
- A2A-Agenten koordinieren und delegieren
- Tools via MCP aufrufen
- Code generieren und analysieren
- Markdown-Dokumente erstellen

### Kontext-Informationen
Der Assistent erhält automatisch:
- Aktuelle Seite/Modul
- Sichtbare Inhalte im Browser (Dynamic `viewState`)
- Ausgewählte Elemente
- Ausgewählte Elemente
- Letzte Aktionen des Nutzers
- Relevante Daten aus der Wissensbasis

### Architektur

```
open-workspace/
├── src/
│   ├── app/
│   │   ├── page.tsx              # Dashboard
│   │   ├── knowledge/            # Wissensbasis
│   │   ├── canvas/               # Visuelle Planung
│   │   ├── tasks/                # Aufgaben
│   │   ├── calendar/             # Kalender (ICS)
│   │   ├── agents/               # A2A Agenten
│   │   ├── communication/        # Matrix Chat
│   │   ├── settings/             # Einstellungen
│   │   └── api/                  # API-Routen
│   │       ├── chat/             # AI Chat + Health + Conversations
│   │       ├── calendar/         # Calendar Providers + Events
│   │       ├── notes/            # Notes CRUD
│   │       └── tasks/            # Tasks CRUD
│   ├── components/
│   │   ├── ui/                   # Base UI (Material Design)
│   │   ├── layout/               # App Shell
│   │   └── assistant/            # Persönlicher Assistent
│   └── lib/
│       ├── inference/            # Ollama Client
│       ├── calendar/             # ICS Parser
│       └── storage/              # Notes, Tasks, Chat, Calendar
├── data/
│   ├── notes/                    # Markdown-Notizen (GitHub-sync)
│   ├── tasks/                    # Aufgaben (JSON)
│   ├── canvas/                   # Canvas-Karten (JSON)
│   ├── chat/                     # Konversationen (JSON)
│   └── calendar/                 # Kalender-Provider & Events (JSON)
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
- Streaming JSON (JSONL) für progressive Darstellung innerhalb des Chats
- **Verfügbare Komponenten**:
  - **Basis**: `Text`, `Card`, `Button`, `Divider`
  - **Layout**: `Column`, `Row`
  - **Display**: `Markdown`, `CodeBlock`, `Image`, `Link`, `Alert`
  - **Struktur**: `List`, `ListItem`, `Table`
  - **Status**: `Progress`, `Chip`, `Badge`
  - **Input**: `Input`, `Select`, `Checkbox`
- Interaktionen werden als `UserAction` zuruck an den Agenten gesendet
- Secure by Design (keine Code-Ausfuhrung)
- **Tests**: 25 Unit Tests mit Vitest (`bun test`)

### Model Context Protocol (MCP)
- Tool und Resource Exposure für Agenten
- Standardisiertes Context Passing
- JSON-RPC 2.0 Messaging

### Agent Tools
- Verfügbare Tools sind in [TOOLS.md](./TOOLS.md) dokumentiert.
- **Dynamic Tool Discovery**: Der Agent erhält verfügbare Tools via System-Prompt.
- **Tool Protocol**:
  Um ein Tool auszuführen, muss der Agent eine spezifische Syntax verwenden:
  `[[TOOL:tool_id:{"arg":"value"}]]`
  
  Beispiel:
  - User: "Wie ist das Wetter in Berlin?"
  - Agent (Output): `Ich prüfe das Wetter. [[TOOL:weather:{"latitude":52.52,"longitude":13.41}]]`
  
- **Standard-Tool**: `workspace_finder` (Global Finder)
  - Unterstützt Fuzzy-Suche (Levenshtein) für Inhalte und Befehle
  - Smart Modifiers: `@task`, `@note`, `@termin`, `@chat`, `@projekt`
  - Findet auch Aufgaben ohne Projektzuordnung via `@projekt`

## AI Inference

**Endpunkt**: `Konfigurierbar via .env`
**Modell**: `gpt-oss:20b` (konfigurierbar)
**API**: Ollama REST API

## Data Layer

### Documents (Markdown + JSON-LD)
Refactored from "Notes". Stored as `.md` files in `data/docs/`.
- **Structure**: Markdown with YAML Frontmatter
- **Ontology**: Schema.org compliant JSON-LD injected automatically.
  - `TechArticle`, `BlogPosting`, `HowTo`, `DefinedTerm`.
  - Polymorphic typing based on tags and content.
  - Internal links `[[Link]]` are resolved to Graph edges (`mentions`).
  - **Single Source of Truth**: All Knowledge is here.
- **Multilingual**: URLs are English slugs, Content is German, `inLanguage: de`.

### Tasks (JSON + JSON-LD)
Stored in `data/tasks/tasks.json`.
- **Ontology**: Mapped to `schema.org/Project` (Projects) and `schema.org/Action` (Tasks).
- **Status**: Mapped to `ActiveActionStatus`, `CompletedActionStatus`.

### Canvas (JSON + JSON-LD)
Stored in `data/canvas/`.
- **Ontology**: Mapped to `schema.org/CreativeWork` (VisualArtwork).
- **Graph**: Diagram nodes represent `hasPart`.

### Kalender (ICS/JSON)
Provider-Konfiguration in `data/calendar/providers.json`. Gecachte Events in `data/calendar/events.json`.

### Chat (JSON)
Historie und Konversationen in `data/chat/conversations.json`.

## Modul-Agenten

Die Anwendung unterstützt nun **Dynamisches Agenten-Management**:
- **Lokal**: Agenten, die im System-Context laufen (definiert durch System Prompt).
- **Remote (A2A)**: Agenten, die extern laufen und via HTTP/A2A kommunizieren.
- **Connections**: Remote Agenten können mit sicheren Credentials (z.B. Bearer Token) verknüpft werden.

Siehe [architecture_agents.md](docs/architecture_agents.md) für die detaillierte Architektur-Vision.

| Modul | Agent-Rolle | Kontext-Zugriff |
|-------|------------|-----------------|
| Übersicht | Übersicht-Assistent | System-Metriken, aktuelle Items |
| Wissensbasis | Recherche-Assistent | Notizen, Dokumente, Artefakte |
| Pinnwand | Planungs-Assistent | Karten, Verbindungen, Layout |
| Aufgaben | Projekt-Assistent | Tasks, Deadlines, Fortschritt |
| Kalender | Zeit-Assistent | Termine, Verfügbarkeit |
| Agenten | A2A Koordinator | Agent-Configs, MCP Tools |
| Kommunikation | Chat-Assistent | Matrix Rooms, Nachrichten |

## Entwicklung

```bash
bun install    # Abhangigkeiten
bun run dev    # Entwicklung
bun test       # Unit Tests (Vitest)
bun run build  # Produktion
```

## Code-Konventionen

- **Sprache**: TypeScript (strict mode)
- **API**: Englisch
- **UI-Labels**: Deutsch (Standard), Englisch (umschaltbar)
- **Anrede**: Immer informell (du-Form, nie Sie-Form)
- **Umlaute**: Korrekte ä, ö, ü, ß verwenden (nie ae, oe, ue)
- **Design**: **Mobile First!**
  - UI muss auf kleinen Screens perfekt funktionieren.
  - **Aktionen**: Primäre "Hinzufügen"-Aktionen (Notiz, Aufgabe etc.) MÜSSEN als **Floating Action Button (FAB)** unten rechts platziert werden.
  - Reihenfolge unten rechts: [Chat] -> [Finder] -> [Aktion].
- **Navigation**: Logische Sortierung beachten (Übersicht -> Aufgaben -> Kalender...)

## Safety & UX Regeln

### Löschen
- **Immer Bestätigung**: Löschvorgänge erfordern IMMER eine Sicherheitsabfrage
- Dialog mit Titel, Beschreibung und "Abbrechen" / "Löschen" Buttons
- Kein silentes Löschen ohne explizite Nutzer-Bestätigung

### Auto-Save
- Automatisches Speichern muss IMMER eine Undo-Möglichkeit bieten
- Toast-Benachrichtigung: "Gespeichert" mit "Rückgängig" Button
- Undo-Zeitfenster: mindestens 5 Sekunden

### Bestätigungen
- Destruktive Aktionen (Löschen, Überschreiben) = Bestätigungsdialog
- Konstruktive Aktionen (Erstellen, Speichern) = Keine Bestätigung nötig

## Design System

- **Stil**: Digital Zen Garden (minimal, fokussiert)
- **Primärfarbe**: #00674F (Teal)
- **Themes**: Light / Dark / System-auto
- **Komponenten**: Material Design 3 inspiriert

---

*Dieses Dokument wird von AI-Agenten und Menschen kollaborativ gepflegt.*
