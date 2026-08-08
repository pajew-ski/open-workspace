# AGENTS.md - Open Workspace Protocol

> Single Source of Truth für AI-Agent Interaktion mit dieser Codebase

## Hier weitermachen (Einstieg für neue Sessions)

**Stand 2026-08-08**: Das Projekt ist vom Prototyp auf einen belastbaren Stand
gehoben. Build, Typecheck, Lint (0 Errors) und Unit-Tests laufen grün; CI und
Docker-Deployment stehen; PWA, Tool-Loop, API-Härtung und die generative
Oberfläche (A2UI + native Workspace-Widgets + MCP-UI) sind implementiert.

**Bevor du etwas Neues baust, lies in dieser Reihenfolge:**
1. [ANALYSE.md](./ANALYSE.md) — vollständige Bestandsaufnahme, was umgesetzt
   wurde und **§5 die priorisierte Roadmap** (P0/P1/P2) mit Begründungen
2. [TODO.md](./TODO.md) — dieselbe Roadmap als abhakbare Liste
3. Diesen Abschnitt hier für die Architektur-Prinzipien

**Nächster geplanter Schritt (P1, direkt anschlussfähig)**: MCP-Client mit
`@modelcontextprotocol/sdk` — konfigurierte MCP-Server anbinden, deren Tools in
den bestehenden Tool-Loop (`/api/chat`) einspeisen und deren `UIResource`-Antworten
in die bereits vorhandene generative Bühne rendern. Der `UIResource`-Renderer
(MCP-UI-Standard) und der Tool-Loop existieren bereits — es fehlt nur die
Server-Anbindung. Danach kann der deaktivierte MCP-Button in den Werkzeugen scharf
geschaltet werden.

**Ebenfalls offen und klein genug für einen Einstieg (P0)**: i18n mit `next-intl`,
Abbau der `no-explicit-any`-Warnings, CopilotKit-Entscheidung (UI rendern oder
Stack entfernen), Frontmatter-Parser auf `yaml`/`gray-matter` umstellen.

**Arbeitsprinzip dieses Repos**: Keine Attrappen. Lieber ein Feature ehrlich als
„geplant" kennzeichnen, als tote Buttons stehen lassen.

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

### Agent2UI (A2UI) — Generative Oberfläche
- Deklarative UI-Komponenten-Beschreibungen
- Streaming JSON (JSONL) für progressive Darstellung innerhalb des Chats
- **Grundprinzip**: Die Oberfläche ist eine Funktion des Gesprächsverlaufs,
  kein festes View-Inventar. Der Dialog ist der primäre Kanal; UI
  materialisiert sich pro Interaktion. Ein a2ui-Block **ersetzt** die
  aktive Bühne; ein leerer Block leert sie ("blende X aus"). Der
  Surface-Zustand fließt als Kontext zurück ans Modell (`AKTIVE BÜHNE`),
  und Surfaces werden mit der Chat-Historie persistiert — die Oberfläche
  ist aus dem Gespräch rekonstruierbar.
- **Verfügbare Komponenten**:
  - **Basis**: `Text`, `Card`, `Button`, `Divider`
  - **Layout**: `Column`, `Row`
  - **Display**: `Markdown`, `CodeBlock`, `Image`, `Link`, `Alert`
  - **Struktur**: `List`, `ListItem`, `Table`
  - **Status**: `Progress`, `Chip`, `Badge`
  - **Input**: `Input`, `Select`, `Checkbox`
  - **Native Workspace-Widgets** (selbst-ladend, Live-Daten):
    `WorkspaceTasks`, `WorkspaceCalendar`, `WorkspaceDocs`, `WorkspaceStats`.
    Das Modell deklariert nur die Absicht (z.B. `{"status":"todo"}`),
    Datenbindung und Refresh besitzt die native Schicht.
  - **`UIResource`** (MCP-UI-Standard, https://mcpui.dev): rendert von
    Tools/MCP-Servern gelieferte UI (`ui://`-URIs, `text/html` oder
    `text/uri-list`) sandboxed im iframe; Interaktionen kommen per
    postMessage als `mcpui:<type>`-Aktionen zurück.
- Interaktionen werden als `UserAction` zurück an den Agenten gesendet
- Secure by Design (A2UI: keine Code-Ausführung; UIResource: sandboxed iframe)
- **Ganzseitige Ansicht**: `/assistant` — Dialog links, generative Bühne rechts
- **Tests**: A2UI-Renderer + MCP-UI-Resource Unit-Tests mit Vitest (`bun run test:run`)

### Model Context Protocol (MCP)
- Tool und Resource Exposure für Agenten
- Standardisiertes Context Passing
- JSON-RPC 2.0 Messaging

### Agent Tools
- Verfügbare Tools sind in [TOOLS.md](./TOOLS.md) dokumentiert.
- **Dynamic Tool Discovery**: Der Agent erhält verfügbare Tools via System-Prompt.
- **Tool Protocol** (implementiert in `/api/chat` + `src/lib/tools/callParser.ts`):
  Um ein Tool auszuführen, verwendet der Agent die Syntax
  `[[TOOL:tool_id:{"arg":"value"}]]`.
  Der Server erkennt Aufrufe im Stream (auch über Chunk-Grenzen), blendet sie
  aus der sichtbaren Antwort aus, führt das Tool aus (`src/lib/tools/executor.ts`)
  und gibt das Ergebnis als `[TOOL_RESULT tool_id]`-Nachricht an das Modell
  zurück — maximal 3 Runden pro Anfrage, Fortschritt wird im Chat angezeigt.

  Beispiel:
  - User: "Wie ist das Wetter in Berlin?"
  - Agent (Output): `Ich prüfe das Wetter. [[TOOL:weather:{"latitude":52.52,"longitude":13.41}]]`
  - System führt das Tool aus → Agent fasst das Ergebnis zusammen.
  
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
bun install        # Abhängigkeiten
bun run dev        # Entwicklung
bun run lint       # ESLint (0 Errors erwartet)
bun run typecheck  # TypeScript
bun run test:run   # Unit Tests (Vitest)
bun run test:e2e   # E2E (Playwright, braucht bun run build)
bun run build      # Produktion
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

### Chat Widget Protocol (A2A Interface)
- **Single Source of Truth**: The behavior of the Assistant Chat is strictly defined in `CHAT_WIDGET_SPEC.md` in the root directory.
- **Compliance**: All agents modifying the Chat Widget MUST consult and adhere to this specification.
- **No Guesswork**: Do not "guess" scroll behavior or persistence logic. Use the spec.
- **Persistence**: The widget MUST persist state (open/close, size, scroll) across client-side navigation.

---

*Dieses Dokument wird von AI-Agenten und Menschen kollaborativ gepflegt.*
