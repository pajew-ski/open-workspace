# TODO - Open Workspace Development

> Roadmap auf Basis der vollständigen Analyse in [ANALYSE.md](./ANALYSE.md).
> Für den Graph-Ausbau gilt [GRAPH_CORE_SPEC.md](./GRAPH_CORE_SPEC.md)
> (hat Vorrang vor ANALYSE §5, wo sie widersprechen). Arbeitsmodus:
> ein Meilenstein = eine Session = ein Branch = ein PR.

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
  - [x] **M1-Rest: Schreibpfade umstellen** — Store-first-CRUD
        (`src/lib/graph/workspace/`): Mutation → Store (EINE Transaktion:
        Workspace, Layout, Projekt-Farben, Waisen) → Datei-Projektion →
        Snapshot; `src/lib/storage/*` sind Fassaden, Lesepfade kommen aus
        dem Store (SPEC §16). Quelltreue-Terme (ow:workflowStatus,
        ow:priority, ow:taskKind, ow:deferredUntil,
        ow:estimated-/actualEffort, ow:dependencyKind als
        RDF-1.2-Kanten-Annotation, ow:cardKind in presentation,
        completedAt als prov:endedAtTime); Bootstrap re-migriert
        v1-Snapshots einmalig aus dem Dateibestand (Manifest v2); alle
        `// MIGRATION:`-Marker aufgelöst — Abnahme (Round-Trip exakt +
        Fixpunkt, Store-first-CRUD, Marker-Scan):
        `tests/graph/workspace-roundtrip.test.ts`
- [x] **M2 SPARQL (Protokoll)**: `GET|POST /api/graph/sparql` nach
      SPARQL 1.1 Protocol; SELECT/CONSTRUCT/ASK/DESCRIBE + UPDATE;
      Content Negotiation (SPARQL-JSON, CSV, TSV, Turtle, JSON-LD, N-Quads,
      TriG); Dataset-Injektion überschreibt `FROM`; `graph/acl` unerreichbar;
      Updates transaktional mit Schutz systemverwalteter Graphen
  - [x] M2-Rest: SPARQL-Editor-UI (`/graph/sparql`): Prism-Highlighting
        (scroll-synchrones Overlay), Prefix-Autovervollständigung aus
        graph/vocab (ow:-Terme + de-Labels per SPARQL), Ergebnistabelle,
        ASK-Wahrheitswert, Ergebnis-als-Graph
        (`POST /api/graph/views/preview`), geschützter Update-Pfad;
        gespeicherte Queries als ow:QueryView in graph/meta (SELECT/ASK
        speicherbar, Updates nicht; Nicht-Graph-Queries öffnen auf /graph
        den Editor) — Abnahme: `tests/graph/sparql-editor.test.ts`
- [x] **M3 Connector-Framework** + `rdf-file` + `github-rdf`
      (`src/lib/graph/connectors/`): ein Vertrag für alles Externe (§6.1
      inkl. Locator↔Config-Abbildung), Registry als `ow:Connector`-Knoten in
      `graph/meta`, Sync-Runner mit Replace-Semantik, PROV pro Lauf,
      Revision-No-Op (Inhalts-Hash bzw. Commit-SHA, commit-gepinnte Abrufe),
      fehlertolerant mit Quarantäne-Bericht (zeilen- bzw. dateigenau,
      als `schema:error` am Lauf-Knoten), SSRF-geschützter Fetch mit
      Redirect-Validierung, Verwaltung unter `/graph/connectors`,
      Persistenz nach `data/graph/` — Abnahme als Tests:
      `tests/graph/connectors.test.ts`
- [x] **M4 Obsidian-Connector** (`src/lib/graph/connectors/obsidian/` +
      `src/lib/graph/projection/obsidian.ts`): `obsidian-vault` über den
      EINEN Connector-Vertrag — Import (Body byte-genau in `schema:text`,
      Frontmatter als fm:-Quelltreue-Properties + Wissens-Mapping
      bekannter Keys, Wikilinks als `ow:linksTo` mit Alias/Einbettung als
      RDF-1.2-Reifier-Annotation, Tags als `skos:Concept` mit
      `skos:broader`, `ow:inFolder`), Export als verlustbehaftete
      Projektion (typisierte Kanten → generische Wikilinks),
      Push-Konfliktregel §6.2 (`pushConnector`, Zustand `conflict`),
      Vault-Pfad-Politik (`data/vaults/` + `OW_VAULT_ROOTS`),
      Verlustpositionen: docs/obsidian-kompatibilitaet.md — Abnahme
      (Round-Trip markdown-identisch bis auf normalisierte
      Frontmatter-Reihenfolge, zweiter Round-Trip byte-identisch) als
      Tests: `tests/graph/obsidian-vault.test.ts`
- [x] **M5 Canvas/Präsentationsschicht**: `graph/<u>/presentation` mit
      gruppenweisem Replace + Orphan-Bereinigung
      (`src/lib/graph/presentation/layout.ts`; Layout-Terme
      `ow:CanvasNode`/`ow:CanvasEdge`/… in Ontologie + vocab.ts, Werte via
      `schema:width`/`height`/`color`), nativer Layout-Spiegel in
      `syncWorkspaceFromFiles` (Snapshot `presentation.nq`);
      JSON Canvas 1.0 (`connectors/json-canvas/`): pures
      Parse-/Serialisier-Modul (fehlertolerant, deterministisch),
      `json-canvas`-Connector über den EINEN Vertrag (Layout via neuem
      `ctx.presentation()`-Collector, Push-Konfliktregel §6.2, zweiter
      Push byte-identisch), UI-Import unter `/canvas` + Export mit
      Verlust-Hinweis (Kartentypen `file`/`group` ergänzt; Gruppen ohne
      semantisches Gegenstück); generierte Query-Views (`ow:QueryView` in
      `graph/meta`, `/api/graph/views`, Auflösung über `resolveDataset` —
      presentation bleibt unsichtbar, Layout-Verfahren force-directed/
      hierarchisch/radial im Explorer) — Abnahme als Tests:
      `tests/graph/json-canvas.test.ts`; Verlustpositionen:
      docs/obsidian-kompatibilitaet.md
- [x] **M6 Git-Sync** in allen drei Runtimes: `GitProvider`-Interface mit
      zwei Bindungen (`process-git` für server/ha-addon — ein Image,
      `isomorphic-git` über FileSystemLike für local; OPFS-Packaging folgt
      M12 über dieselben Interfaces), Binär-Ebene + Frische-Signale in
      FileSystemLike, `server`-RuntimeAdapter
      (`src/lib/platform/runtime/server.ts`, von den Connector-Routen
      injiziert); `git-backup` als regulärer Connector (Inhalts-Hash-
      Revision, deterministischer Snapshot ohne eigene volatile
      Buchführung, Modus `backup` = Einbahnstraße, `bidirectional` =
      Konfliktregel §6.2 + Rücklesen: Snapshot-Dateien als Restore der
      kanonischen Graphen in EINER Runner-Transaktion
      [`restoresCanonicalGraphs`, acl/vocab/shapes/inferred nie —
      Negativtest], fremde RDF-Dateien in den Import-Graphen,
      Datei-Reprojektion nach Restore); Pfad-Politik `data/` +
      `OW_GIT_ROOTS`; UI: git-backup-Formular (Pfad/Modus/Remote/Branch),
      „Backup erstellen", Sync-Button nur bei bidirectional — Abnahme
      (minimale lesbare Diffs in beiden Bindungen, externe
      .ttl-/Snapshot-Edits kommen per Pull an):
      `tests/graph/git-provider.test.ts`, `tests/graph/git-backup.test.ts`
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

*Last updated: 2026-08-09 (M1-Rest §12.4 + M2-Rest Editor + M6 Git-Sync)*
