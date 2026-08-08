# TODO - Open Workspace Development

> Roadmap auf Basis der vollständigen Analyse in [ANALYSE.md](./ANALYSE.md).

## Fundament (fertig)

- [x] Next.js 16 App Router, TypeScript strict, CSS Modules, Design Tokens
- [x] Produktions-Build grün (Debug-Reste entfernt, Toolchain aktualisiert)
- [x] Theme-System (light/dark/system) via useSyncExternalStore
- [x] TanStack React Query als Server-State-Layer
- [x] PWA: Manifest, App-Icons, Service Worker (Offline-Shell, API-Cache), Offline-Seite
- [x] CI: GitHub Actions (Lint, Typecheck, Unit-Tests, Build, optional E2E)
- [x] Deployment: Multi-Stage-Dockerfile (standalone, non-root, data/-Volume)

## Mobile UX & Accessibility (fertig)

- [x] Mobiler Drawer als modaler Dialog: über sticky Inhalten/FABs (Z-Index-Skala
      bereinigt), Fokus-Falle, Escape, Fokus-Rückgabe, Scroll-Lock,
      schließt bei Navigation, `aria-expanded`/`aria-controls`/`aria-current`
- [x] Off-Canvas-Sidebar aus Fokus-/A11y-Baum (visibility), 100dvh statt 100vh
- [x] Safe-Area-Insets (Notch/Home-Indicator) für FABs, Sidebar, Header; viewport-fit=cover
- [x] Touch-Targets ≥44px für Primär-Controls, ≥24px überall (WCAG 2.5.8);
      Hover-only-Controls (Status-Pfeile, Umbenennen) auf Touch/Fokus sichtbar
- [x] iOS-Autozoom verhindert (16px-Minimum für Formularfelder), Pinch-Zoom bleibt erlaubt
- [x] Kontrast-Töne WCAG AA: tertiary/warning-Token, Primärfarbe-als-Text-Token
      (Dark Mode), Event-Chips mit luminanzabhängiger Textfarbe, `--color-*-subtle` definiert
- [x] Skip-Link, Dialog-Semantik für Finder/Chat, scrollbare Regionen fokussierbar
- [x] E2E-Gate (blockierend in CI): Playwright-Projekte Desktop + Pixel-7-Emulation,
      Drawer-Verhalten, Overlay-Abdeckung, Touch-Target-/Overflow-/Fontsize-Scans,
      axe-core (WCAG A/AA, serious/critical = 0) Light + Dark, 200%-Zoom-Reflow

## Module

- [x] Dashboard (Masonry-Layout, Widgets, Activity-Feed)
- [x] Wissensbasis (Markdown-Editor, JSON-LD-Ontologie, Umbenennung)
- [x] Aufgaben (Kanban, Projekte, Prioritäten, Fälligkeiten)
- [x] Pinnwand/Canvas (Karten, Verbindungen)
- [x] Kalender (ICS-Provider, Monats-/Wochenansicht)
- [x] Knowledge Graph (JSON-LD, Force-Graph, Filter — Link-Filter-Bug behoben)
- [x] Global Finder (Fuzzy, Smart Modifiers, Cmd+F)
- [x] Werkzeuge: API-Tools + sichere Verbindungen (AES-256-GCM)
- [x] Agenten: CRUD inkl. Bearbeiten (PUT), ehrliche Status-Anzeige
- [x] Benachrichtigungen aus echtem Activity-Log (Read-State persistiert)
- [x] Einstellungen: Theme, AI-Endpunkt + Modell (persistiert, Live-Health-Check), Kalender
- [ ] Kommunikation (Matrix) — Seite kennzeichnet Planungsstand, siehe P1

## AI-Integration

- [x] Streaming-Chat (Ollama + OpenAI-kompatibel) mit Timeout & Fehlerbehandlung
- [x] Kontext-Injektion pro Modul (viewState)
- [x] A2UI-Protokoll: Parser + React-Renderer + Streaming-Updates (Tests)
- [x] Generative Oberfläche: Surface-Ersetzung/-Leerung, Surface-Persistenz,
      Surface-Zustand im Modell-Kontext, ganzseitige /assistant-Ansicht mit Bühne
- [x] Native Workspace-Widgets (WorkspaceTasks/Calendar/Docs/Stats, selbst-ladend)
- [x] MCP-UI-Standard: UIResource-Renderer (ui://, sandboxed iframe, postMessage)
- [x] Tool-Ausführung: [[TOOL:...]]-Parser + serverseitiger Tool-Loop (max. 3 Runden)
- [x] Chat-Historie (Konversationen, Persistenz inkl. Surfaces)
- [ ] Natives Function Calling (Ollama `tools`-Parameter) mit Text-Syntax-Fallback — P1
- [ ] A2A-Protokoll: Agent Card (/.well-known/agent.json), JSON-RPC, Task-Lifecycle — P1
- [ ] MCP-Client (@modelcontextprotocol/sdk): externe MCP-Server als Tool-Quelle — P1
- [ ] CopilotKit: UI rendern oder Stack entfernen (Entscheidung, siehe ANALYSE §5 P0.3)

## Sicherheit & Datenqualität

- [x] Zod-Validierung aller schreibenden API-Routen
- [x] Atomare JSON-Writes + Dateilocks, defensives Lesen mit Quarantäne
- [x] Path-Traversal-Fix, Upload-Härtung (Allowlist, Magic Bytes, 10 MB), SVG-XSS entschärft
- [x] Credentials: kein Ciphertext-Leak, WORKSPACE_MASTER_KEY-Option, Keyfile 0600
- [x] API-Key nur serverseitig (LLM_API_KEY)
- [x] Tool-Executor: SSRF-Schutz, Timeout, JSON-sichere Platzhalter
- [ ] Rate Limiting am Chat-Endpunkt — P2
- [ ] Optionale Auth (Passkey/WebAuthn) für Nicht-localhost-Deployments — P2

## Offen (priorisiert — Details in ANALYSE.md §5)

### P0
- [ ] i18n mit next-intl (de/en, Umschalter, dynamisches html lang)
- [ ] no-explicit-any-Abbau (135 Warnings → typisierte Module)
- [ ] Frontmatter-Parser durch yaml/gray-matter ersetzen

### P1
- [ ] A2A, MCP, natives Tool-Calling (siehe AI-Integration)
- [ ] GitHub-Sync (OAuth Device Flow, Commit/Pull von data/docs)
- [ ] IndexedDB-Spiegel + Background-Sync-Queue (Offline-Schreiben)
- [ ] Matrix-Chat (matrix-js-sdk, E2EE)

### P2
- [x] Accessibility-Durchgang (Fokus-Management, ARIA, Reduced Motion, Kontraste,
      Touch-Targets — automatisiert abgesichert via e2e/a11y + e2e/mobile-*)
- [ ] A11y-Feinschliff: Chat-Verlauf als Live-Region, Dark-Mode-Scans auf alle Seiten ausweiten
- [ ] Versionshistorie für Dokumente
- [x] Export: Workspace-Backup als JSON-Download (Settings → Daten)
- [ ] Import/Restore aus Backup (mit Validierung und Sicherung des Ist-Stands)
- [ ] Kollaboration (CRDT/Yjs), Plugin-System via MCP, GitLab-Sync

---

*Last updated: 2026-08-08*
