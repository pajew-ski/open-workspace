# AGENTS.md - AI Workspace Protocol

> Single Source of Truth for AI agent interaction with this codebase

## System Overview

AI Workspace is a comprehensive Next.js application designed as a unified interface for AI agent collaboration. The system implements Agent2Agent (A2A) and Agent2UI (A2UI) protocols for standardized agent communication and UI generation.

## Architecture

```
ai-workspace/
├── src/
│   ├── app/                    # Next.js App Router pages
│   │   ├── (dashboard)/        # Dashboard module
│   │   ├── (knowledge)/        # Knowledge base module
│   │   ├── (canvas)/           # Visual planning module
│   │   ├── (tasks)/            # Task/project management module
│   │   ├── api/                # API routes
│   │   │   ├── agents/         # A2A protocol endpoints
│   │   │   ├── chat/           # Chat inference endpoints
│   │   │   ├── artifacts/      # Artifact CRUD operations
│   │   │   └── github/         # GitHub sync endpoints
│   │   └── settings/           # Settings page
│   ├── components/
│   │   ├── ui/                 # Base UI components (Material Design)
│   │   ├── chat/               # Chat widget components
│   │   ├── markdown/           # Markdown renderer with Mermaid
│   │   ├── canvas/             # Canvas planning components
│   │   ├── tasks/              # Task/project management components
│   │   └── a2ui/               # A2UI renderer components
│   ├── lib/
│   │   ├── agents/             # A2A client implementation
│   │   ├── inference/          # LLM inference client (Ollama)
│   │   ├── github/             # GitHub API integration
│   │   ├── i18n/               # Internationalization
│   │   ├── storage/            # IndexedDB for offline
│   │   └── hooks/              # React hooks
│   ├── stores/                 # Zustand state management
│   └── types/                  # TypeScript definitions
├── data/                       # JSON data storage
├── public/
│   ├── manifest.json           # PWA manifest
│   └── sw.js                   # Service worker
└── locales/
    ├── de.json                 # German translations (default)
    └── en.json                 # English translations
```

## Core Protocols

### Agent2Agent (A2A) Protocol
- HTTP/SSE-based communication
- JSON-RPC message format
- Capability discovery via agent cards
- Long-running task support
- Multi-modal content (text, structured data)

### Agent2UI (A2UI) Protocol
- Declarative UI component descriptions
- Streaming JSON for progressive rendering
- Pre-approved component catalog
- Framework-agnostic specification
- Secure by design (no code execution)

### Model Context Protocol (MCP)
- Tool and resource exposure for agents
- Standardized context passing
- Server/client architecture
- JSON-RPC 2.0 messaging

## AI Inference Configuration

**Primary Endpoint**: `http://192.168.42.2:11434`
**Model**: `gpt-oss-20`
**API Compatibility**: Ollama REST API

### Available Endpoints
- `POST /api/chat` - Chat completions with message history
- `POST /api/generate` - Single prompt completions
- `GET /api/tags` - List available models

## Data Storage

**Location**: `data/` (project root)
**Format**: JSON files (database-ready structure)

```
data/
├── notes/           # Knowledge base notes
│   └── {id}.json
├── artifacts/       # Generated artifacts
│   └── {id}.json
├── canvas/          # Canvas cards and connections
│   └── {id}.json
├── chat/            # Chat history per session
│   └── {sessionId}.json
└── settings.json    # User preferences
```

**Schema Design**: All JSON files use database-compatible schemas with `id`, `createdAt`, `updatedAt` fields for future migration to SQLite/PostgreSQL.

## Module Agents

Each module has a dedicated agent accessible via chat widget:

| Module | Agent Role | Context Access |
|--------|-----------|----------------|
| Dashboard | Overview assistant | System metrics, recent items |
| Knowledge | Research assistant | Notes, documents, code, artifacts |
| Canvas | Planning assistant | Cards, visual elements, connections |
| Tasks | Project assistant | Tasks, projects, deadlines, progress |

## Development Commands

```bash
# Install dependencies
bun install

# Development server
bun run dev

# Build production
bun run build

# Lint check
bun run lint
```

## Code Conventions

- Language: TypeScript (strict mode)
- API endpoints: English
- UI labels: German (default), English (switchable)
- No emojis in UI or code
- Semantic HTML structure
- CSS: CSS Modules with Material Design tokens

## Design System

- **Style**: Digital Zen Garden (minimal, focused)
- **Primary Color**: #00674F (teal accent)
- **Theme**: Light/Dark/System-auto
- **Typography**: System fonts, clean hierarchy
- **Components**: Material Design 3 inspired

## File Naming

- Components: PascalCase (e.g., `ChatWidget.tsx`)
- Utilities: camelCase (e.g., `parseMarkdown.ts`)
- Types: PascalCase with `.types.ts` suffix
- API routes: kebab-case

## State Management

- **Server State**: React Query / SWR
- **Client State**: Zustand stores
- **Persistence**: IndexedDB via idb-keyval

## Testing

- Unit: Vitest
- Component: React Testing Library
- E2E: Playwright (if needed)

---

*This document is maintained by AI agents and humans collaboratively.*
