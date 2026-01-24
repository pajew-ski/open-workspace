# AI Workspace

A comprehensive, offline-capable workspace for AI agent collaboration. Built with Next.js, implementing Agent2Agent (A2A) and Agent2UI (A2UI) protocols.

## Features

- **Dashboard**: Real-time overview of system activity and recent items
- **Knowledge Base**: Markdown notes, documents, code fragments, artifacts
- **Canvas**: Visual planning with cards and connections
- **AI Chat**: Context-aware agents per module
- **Offline PWA**: Full functionality without internet
- **Internationalization**: German (default) / English

## Tech Stack

- **Framework**: Next.js 14 (App Router)
- **Language**: TypeScript
- **Styling**: CSS Modules, Material Design 3
- **State**: Zustand, React Query
- **Offline**: Service Worker, IndexedDB
- **AI Protocols**: A2A, A2UI
- **Inference**: Ollama API (local)

## Quick Start

```bash
# Clone and install
bun install

# Configure environment
cp .env.example .env.local

# Start development
bun run dev
```

Open [http://localhost:3000](http://localhost:3000)

## AI Configuration

Default inference endpoint: `http://192.168.42.2:11434`

Configure in `.env.local`:
```env
INFERENCE_ENDPOINT=http://192.168.42.2:11434
INFERENCE_MODEL=gpt-oss-20
```

## Design Philosophy

**Digital Zen Garden**: Calm, focused interface with minimal distractions. Neutral tones with #00674F teal accent. Light and dark modes with system preference detection.

## Project Structure

```
src/
├── app/          # Pages and API routes
├── components/   # Reusable UI components
├── lib/          # Core utilities and clients
├── stores/       # State management
└── types/        # TypeScript definitions
```

## Documentation

- [AGENTS.md](./AGENTS.md) - AI agent protocol and architecture
- [TODO.md](./TODO.md) - Development roadmap

## License

GPL-3.0 - This software is and will remain open source.

---

*Built for focused AI collaboration*
