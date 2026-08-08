# TODO - Open Workspace Development

> Roadmap auf Basis der vollständigen Analyse in [ANALYSE.md](./ANALYSE.md).
> Für den Graph-Ausbau gilt die SPEC „Graph Core — Vollausbau" (hat Vorrang
> vor ANALYSE §5, wo sie widersprechen).

## Graph Core (SPEC „Vollausbau", M0–M13)

- [x] **M0 Fundament**: Vokabular `ontology/ow.ttl` (33 Terme, de/en,
      CI-Check `check:ontology`), IRI-Strategie (drei Basen, nutzerskalierte
      Named Graphs, `owl:sameAs`-Migration), `GraphStore`-Interface,
      Oxigraph-WASM-Anbindung (Entscheidung mit Messwerten:
      docs/decisions/0001-graph-store.md), deterministische Serialisierung
      inkl. RDFC-1.0 (Round-Trip RDF-isomorph, Dumps byte-identisch)
- [x] **M1 Migration/Kompatibilität**: idempotenter Migrator
      (`bun run migrate:graph`, Zähl-Assertions), `/api/graph` per SPARQL aus
      dem Store, `color`/`val` entfernt (UI berechnet Präsentation), alte
      Generatoren → `src/lib/graph/projection/` (seo.ts, schema-org.ts),
      kein `any` im Graph-Pfad (ESLint-Error)
  - [ ] **M1-Rest: Schreibpfade umstellen** — `src/lib/storage/*` schreibt
        über den Store als Wahrheitsquelle; danach die
        `// MIGRATION:`-Marker auflösen:
        `src/lib/graph/server/instance.ts#syncWorkspaceFromFiles`
- [x] **M2 SPARQL (Protokoll)**: `GET|POST /api/graph/sparql` nach
      SPARQL 1.1 Protocol; SELECT/CONSTRUCT/ASK/DESCRIBE + UPDATE;
      Content Negotiation (SPARQL-JSON, CSV, TSV, Turtle, JSON-LD, N-Quads,
      TriG); Dataset-Injektion überschreibt `FROM`; `graph/acl` unerreichbar;
      Updates transaktional mit Schutz systemverwalteter Graphen
  - [ ] M2-Rest: SPARQL-Editor-UI (Syntax-Highlighting, Prefix-Vervollständigung,
        Ergebnis-als-Graph), gespeicherte Queries als Graph-Entitäten
- [ ] **M3 Connector-Framework** + `rdf-file` + `github-rdf`
      (prima-materia als Referenzfall, fehlertolerant mit Quarantäne-Bericht)
- [ ] **M4 Obsidian-Connector** (Round-Trip-Test, Verlustpositionen dokumentiert)
- [ ] **M5 Canvas/Präsentationsschicht** (`graph/<u>/presentation`,
      JSON-Canvas 1.0, generierte Query-Views; Layout-Blacklist-Test existiert)
- [ ] **M6 Git-Sync** in allen drei Runtimes (`backup`/`bidirectional`,
      `git-backup` als regulärer Connector)
- [ ] **M7 Reasoning** (SHACL, OWL RL Tier 1, `graph/<u>/inferred/<scope>`,
      DL-Sidecar optional)
- [ ] **M8 Suche + Multi-Hop-Retrieval** (§7.5-Pipeline, `workspace_finder`
      auf den Graphen)
- [ ] **M9 Agents/Skills/Tools als Graph-Bürger**
- [ ] **M10 MCP-Server** (`/api/mcp`, graph_search/retrieve/neighbors/
      describe/sparql)
- [ ] **M11 Föderation** (Endpoint-Registry, SERVICE, Authz-Rewriting,
      SSRF-Schutz)
- [ ] **M12 Runtime-Vollausbau** (HA-Add-on inkl. Ingress-Base-Path,
      `server`-Compose, ein Image)
- [ ] **M13 Multi-User/ACL** (WAC/ACP in `graph/acl`, Dataset-Resolver,
      Test-Matrix §17.6)

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
- [x] Einstellungen: Theme, Kalender, AI-Summary (Provider-Verwaltung im AI-Hub /ai)
- [x] AI-Hub (/ai): Provider-Karten, Presets, Routing-Badges, WebLLM-Manager
- [x] Skills (/skills): Verwaltung + Lade-Flows
- [x] Werkzeuge: MCP-Server-Verwaltung (Status, Tools, Prompts→Skills)
- [ ] Kommunikation (Matrix) — Seite kennzeichnet Planungsstand, siehe P1

## AI-Integration

- [x] Streaming-Chat (Ollama + OpenAI-kompatibel) mit Timeout & Fehlerbehandlung
- [x] Kontext-Injektion pro Modul (viewState)
- [x] A2UI-Protokoll: Parser + React-Renderer + Streaming-Updates (Tests)
- [x] Generative Oberfläche: Surface-Ersetzung/-Leerung, Surface-Persistenz,
      Surface-Zustand im Modell-Kontext, ganzseitige /assistant-Ansicht mit Bühne
- [x] Native Workspace-Widgets (WorkspaceTasks/Calendar/Docs/Stats, selbst-ladend)
- [x] MCP-UI-Standard: UIResource-Renderer (ui://, sandboxed iframe, postMessage)
- [x] Tool-Ausführung: [[TOOL:...]]-Parser + Tool-Loop (max. 4 Runden)
- [x] Chat-Historie (Konversationen, Persistenz inkl. Surfaces)
- [x] **Multi-Provider-Inference**: Provider-Katalog (lokal/cloud/browser),
      Protokoll-Adapter (openai/anthropic/ollama/webllm), AI-Hub (/ai),
      ModelPicker im Chat, Defaults, Live-Diagnose (CORS/Mixed-Content/Auth)
- [x] **Backend-Unabhängigkeit**: Routing browser-direkt vs. Server-Route pro
      Provider (auto-Probe), Browser-Keys, serverlose Persistenz (localStorage +
      IndexedDB-Chats), isomorphe Engine auf beiden Pfaden
- [x] **WebLLM**: Inference im Browser via WebGPU, Modell-Manager mit
      Download-Fortschritt und Cache-Status (offline-fähig)
- [x] Natives Function Calling (OpenAI/Anthropic/Ollama `tools`) mit
      automatischem Text-Syntax-Fallback
- [x] A2A-Protokoll: Agent-Card-Discovery, JSON-RPC message/send,
      Task-Polling, Delegation via [[AGENT:...]], lokale Persona-Agenten
- [x] MCP-Client (@modelcontextprotocol/sdk): Streamable HTTP/SSE,
      Tools im Loop, Prompts→Skills, ui://-Ressourcen auf der Bühne
- [x] **Skills**: SKILL.md-Konvention, Ladewege manuell/URL/GitHub-Repo/
      MCP-Prompt, Progressive Disclosure (use_skill), /skills-Seite
- [ ] A2A-Streaming (message/stream) + Push-Notifications — Vertiefung
- [ ] MCP-Ressourcen-Browser (resources/list als UI) — Vertiefung
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
- [x] A2A, MCP, natives Tool-Calling (siehe AI-Integration)
- [ ] GitHub-Sync (OAuth Device Flow, Commit/Pull von data/docs)
- [ ] IndexedDB-Spiegel + Background-Sync-Queue für Workspace-INHALTE
      (Docs/Tasks/Canvas — die AI-Schicht inkl. Chats ist bereits serverlos-fähig)
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
