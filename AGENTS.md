# AGENTS.md - Open Workspace Protocol

> Single Source of Truth für AI-Agent Interaktion mit dieser Codebase

## Hier weitermachen (Einstieg für neue Sessions)

**Stand 2026-08-09 (8. Ausbaustufe, Graph Core M0–M10 inkl. §12.4)**: Der
**RDF-Graph ist das kanonische Datenmodell — und seit der 6. Stufe die
einzige Wahrheit auch für die Schreibpfade**. Die verbindliche Spezifikation
inklusive aller Meilensteine M0–M13 liegt in
[GRAPH_CORE_SPEC.md](./GRAPH_CORE_SPEC.md) — **Arbeitsmodus: ein Meilenstein
= eine Session = ein Branch = ein PR**; jede Session liest zuerst diesen
Abschnitt und den jeweiligen Meilenstein-Abschnitt der Spec.
(Store-Entscheidung mit Messwerten in
[docs/decisions/0001-graph-store.md](./docs/decisions/0001-graph-store.md).)

- **Store** (`src/lib/graph/store/`): `GraphStore`-Interface + Oxigraph-WASM
  (SPARQL 1.1 Query/Update, RDF 1.2/RDF-star, Quads) + ehrliches
  In-Memory-Test-Double. Kein Default-Graph-Schreibpfad — jedes Tripel hat
  einen Named Graph, per Store erzwungen.
- **Vokabular** (`ontology/ow.ttl` + `src/lib/graph/vocab.ts`): 66 eigene
  Terme unter der produktweit konstanten Base
  `https://pajew-ski.github.io/open-workspace/ns/v1#`, jeder mit
  de/en-Labels und Begründung. CI-Check `bun run check:ontology` erzwingt
  ow.ttl ↔ vocab.ts synchron. Zusätzlich der Frontmatter-Namespace
  `…/ns/frontmatter#` (Quelltreue-Träger dynamischer YAML-Keys, bewusst
  außerhalb von v1# und des CI-Checks).
- **IRIs** (`src/lib/graph/iri.ts`): Instanz-Base pro Installation
  (`urn:ow:<uuid>:` oder `OW_INSTANCE_BASE`), nutzerskalierte Graphen
  (`graph/u/<userId>/workspace|public|presentation|import/<id>|inferred/<scope>`),
  Migration per `owl:sameAs`-Brücke. `https://exocortex.local` ist Geschichte.
- **Deterministische Serialisierung** (`src/lib/graph/serialize/`):
  RDFC-1.0-kanonische N-Quads (rdf-canonize), byte-identische Dumps,
  Snapshot-Layout `data/graph/` mit Manifest. `bun run migrate:graph`
  erzeugt den Snapshot aus dem Dateibestand (idempotent, Zähl-Assertions).
- **`GET /api/graph`** wird per SPARQL aus dem Store generiert
  (`src/lib/graph/projection/schema-org.ts`); `color`/`val` sind aus der
  Antwort entfernt — die Graph-UI berechnet Präsentation clientseitig.
- **SPARQL-Endpoint** `GET|POST /api/graph/sparql` (SPARQL 1.1 Protocol,
  Content Negotiation JSON/CSV/TSV/Turtle/JSON-LD/N-Quads/TriG): Dataset
  wird IMMER injiziert (überschreibt `FROM`), `graph/acl` ist unerreichbar,
  `presentation`/`inferred` nur auf explizite Anforderung, Updates laufen
  transaktional mit Schutz vor Änderungen an systemverwalteten Graphen.
- **Connector-Framework (M3)** (`src/lib/graph/connectors/`): EIN Vertrag
  für alles Externe (SPEC §6.1, plus Locator↔Config-Abbildung — Instanzen
  persistieren als `ow:Connector`-Knoten in `graph/meta`, nie als
  JSON-Datei). Implementiert: `rdf-file` (RDF-Datei per URL,
  Inhalts-Hash-Revision) und `github-rdf` (Repo/Ordner mit `.ttl`/`.jsonld`,
  commit-gepinnt; Referenzfall prima-materia). Der Sync-Runner (`sync.ts`)
  besitzt No-Op bei unveränderter Revision, vollständigen Replace des
  Import-Graphen, PROV-Tripel pro Lauf und den Quarantäne-Bericht:
  Quell-Qualität bricht einen Import NIE ab — was parst, wird importiert
  (zeilengenau bei N-Quads/N-Triples), der Rest landet als `schema:error`
  am Lauf-Knoten und in der UI (`/graph/connectors`). Fetch läuft
  SSRF-geschützt mit Redirect-Validierung (`http.ts`,
  `ALLOW_LOCAL_TOOL_URLS=1` erlaubt lokale Quellen). Nach Mutationen wird
  `data/graph/` persistiert (meta + import/*). Abnahme:
  `tests/graph/connectors.test.ts`.
- **Obsidian-Connector (M4)** (`src/lib/graph/connectors/obsidian/` +
  `src/lib/graph/projection/obsidian.ts`): `obsidian-vault` als dritte
  Connector-Art — Import eines lokalen Vaults (Body byte-genau in
  `schema:text`, Frontmatter doppelt: Quelltreue als fm:-Properties
  [`…/ns/frontmatter#`, Strings wörtlich, Strukturiertes als `rdf:JSON`] +
  Wissens-Mapping bekannter Keys; Wikilinks als `ow:linksTo` mit
  Alias/Einbettung als RDF-1.2-Annotation am benannten Reifier
  [`rdf:reifies` + Triple Term]; Tags als `skos:Concept` mit
  `skos:broader`; `ow:inFolder`) und verlustbehafteter Export zurück
  (typisierte Kanten flachen zu generischen Wikilinks ab). Round-Trip
  Vault → Store → Vault ist markdown-identisch bis auf normalisierte
  Frontmatter-Reihenfolge, der zweite Round-Trip byte-identisch — als
  Tests verankert (`tests/graph/obsidian-vault.test.ts`). Push folgt der
  Konfliktregel §6.2 (`pushConnector`, Zustand `conflict` bei externer
  Änderung, dateigenauer Bericht; Route
  `POST /api/graph/connectors/[id]/push`, UI-Button „Exportieren" mit
  Bestätigung). Vault-Pfade nur unter `data/vaults/` bzw. Wurzeln aus
  `OW_VAULT_ROOTS` (Pfad-Politik analog SSRF). Dateizugriff kommt als
  `FileSystemLike` in den ConnectorContext (`files`, injiziert von Route
  bzw. Test — node-fs/memfs). Alle Verlustpositionen:
  [docs/obsidian-kompatibilitaet.md](./docs/obsidian-kompatibilitaet.md).
- **Canvas/Präsentationsschicht (M5)** (`src/lib/graph/presentation/layout.ts`
  + `src/lib/graph/connectors/json-canvas/` +
  `src/lib/graph/projection/json-canvas.ts`): Layout — Position, Größe,
  Farbe, Gruppen, Viewport — lebt AUSSCHLIESSLICH in
  `graph/<u>/presentation` als `ow:CanvasNode`/`ow:CanvasEdge`-Gruppen
  (`schema:isPartOf` = Eigentum, `ow:rendersNode` = Brücke zum
  semantischen Knoten; Werte via `schema:width`/`height`/`color`,
  Position/Anker/Viewport als eigene ow:-Terme). Ersetzt wird immer
  gruppenweise (native Pinnwände und Connector-Importe koexistieren),
  Verwaiste räumt `pruneOrphanCanvasLayouts` auf. JSON Canvas 1.0:
  pures Format-Modul (tolerant parsen, deterministisch serialisieren),
  `json-canvas`-Connector über den EINEN Vertrag — `pull` liefert
  Wissen in den Import-Graphen und meldet Layout über den neuen
  Collector `ctx.presentation()` (Runner ersetzt beides in einer
  Transaktion); Push mit Konfliktregel §6.2, zweiter Push
  byte-identisch. Gruppen-Knoten bekommen KEIN semantisches Gegenstück
  (SPEC §9). UI: `.canvas`-Import auf `/canvas`, Export auf der
  Pinnwand mit Verlust-Hinweis vor dem Schreiben (Kartentypen
  `file`/`group` ergänzt). Generierte Query-Views: `ow:QueryView` in
  `graph/meta` (`/api/graph/views` + Sektion im Graph-Explorer),
  Auflösung über `resolveDataset` — Layout-Quads sind dort nachweislich
  unsichtbar; Layout-Verfahren force-directed/hierarchisch/radial.
  Abnahme: `tests/graph/json-canvas.test.ts`; Verlustpositionen:
  [docs/obsidian-kompatibilitaet.md](./docs/obsidian-kompatibilitaet.md).
- **Store-first-Schreibpfade (§12.4 abgeschlossen)**
  (`src/lib/graph/workspace/`): Jede Mutation läuft Store lesen →
  Domänenmodell ändern → EINE Transaktion (Workspace-Graph, Layout-Gruppen,
  Projekt-Farben, Waisen-Bereinigung) → Datei-Projektion
  (`workspace/files.ts`: data/docs|tasks|canvas bleiben für Git und
  Obsidian lesbar) → Snapshot. `src/lib/storage/{docs,tasks,projects,canvas}`
  sind Fassaden; Lesepfade kommen aus dem Store (`workspace/read.ts` —
  Normalisierungen dokumentiert: Tags/Abhängigkeiten sortiert, leere
  optionale Strings entfallen, dateTime-Lexik rückgeführt). Der exakte
  native Zustand liegt als Quelltreue-Terme im Graphen (ow:workflowStatus,
  ow:priority, ow:taskKind, ow:deferredUntil, ow:estimated-/actualEffort,
  ow:dependencyKind als RDF-1.2-Kanten-Annotation; completedAt =
  prov:endedAtTime; Projekt-Farbe + ow:cardKind NUR in
  graph/<u>/presentation). Bootstrap: Snapshot-Manifest v2; ein
  v1-Snapshot oder fehlender Snapshot re-migriert den Dateibestand
  EINMALIG (`server/instance.ts`), danach fließen externe Datei-Edits nur
  noch über Connectors zurück (SPEC §16). Alle `// MIGRATION:`-Marker sind
  aufgelöst (per Test erzwungen). `bun run migrate:graph` bleibt der
  explizite Weg, den Dateibestand erneut zur Wahrheit zu erklären.
  Abnahme: `tests/graph/workspace-roundtrip.test.ts`.
- **SPARQL-Editor (M2-Rest)** (`/graph/sparql`): Prism-Highlighting
  (language-sparql, scroll-synchrones Overlay, Theme-Token),
  Prefix-Autovervollständigung aus `graph/vocab` (ow:-Terme mit de-Labels
  per SPARQL vom eigenen Endpoint) plus Standard-Prefixe/Schlüsselwörter;
  SELECT als Tabelle, ASK als Wahrheitswert, CONSTRUCT/DESCRIBE als
  Graph-Ansicht (`POST /api/graph/views/preview` — Auflösung identisch zu
  Views: erlaubtes Dataset, harte Kappung), Updates über den geschützten
  Update-Pfad. Gespeicherte Queries sind `ow:QueryView`-Entitäten in
  `graph/meta` (dieselbe Entität wie die M5-Views): SELECT/ASK speicherbar
  (Probe-Ausführung), Updates nicht; auf `/graph` öffnen
  Nicht-Graph-Queries den Editor statt eines toten Anwenden-Buttons.
  Klassifikation IRI-/String-sicher in `sparql/classify.ts`. Abnahme:
  `tests/graph/sparql-editor.test.ts`.
- **Git-Sync (M6)** (`src/lib/platform/runtime/` +
  `src/lib/graph/connectors/git-backup/`): `GitProvider` ist ein echtes
  Interface (init/head/status/commitAll/changedFiles/diff, optional
  push/pull ff-only) mit ZWEI Bindungen — `process-git`
  (server/ha-addon, dasselbe Image) und `isomorphic-git` über
  `FileSystemLike` (local; OPFS-Backing folgt M12 über dieselben
  Interfaces). `FileSystemLike` trägt dafür eine Binär-Ebene
  (readBytes/writeBytes) und Frische-Signale (size/mtimeMs — ohne sie
  vertraut isomorphic-git seinem Index-Cache und übersieht Änderungen).
  Der `server`-RuntimeAdapter existiert (`runtime/server.ts`, ehrliche
  Capabilities) und wird von den Connector-Routen injiziert
  (`ctx.runtime`). `git-backup` läuft über den EINEN Vertrag: Revision =
  Inhalts-Hash (No-Op, erkennt auch unkommittierte Edits); `push`
  schreibt den deterministischen Snapshot OHNE die eigene volatile
  Sync-Buchführung (sonst wäre jedes Backup „geändert") und committet;
  Modus `backup` = Einbahnstraße §8.2 (Pull lehnt ab, kein
  Konflikt-Check — Working Tree ist Spiegel), `bidirectional` =
  Konfliktregel §6.2 beim Push + Rücklesen beim Sync: Snapshot-Dateien
  laut Manifest als Restore ihrer kanonischen Graphen (Runner-Capability
  `restoresCanonicalGraphs`, EINE Transaktion; acl/vocab/shapes/inferred
  nie — Negativtest), fremde RDF-Dateien in den Import-Graphen; nach
  einem Restore projiziert die Sync-Route die Workspace-Dateien neu.
  Pfad-Politik `data/` + `OW_GIT_ROOTS`; Empfehlung: `data/graph` für
  `backup`, eigenes Verzeichnis (z. B. `data/backup`) für
  `bidirectional`. UI: git-backup im Katalog (Pfad/Modus/Remote/Branch,
  „Backup erstellen"; Sync-Button nur bei bidirectional). Abnahme in
  BEIDEN Bindungen: `tests/graph/git-provider.test.ts`,
  `tests/graph/git-backup.test.ts`.
- **Reasoning + SHACL (M7)** (`src/lib/graph/reasoning/`): OWL RL Tier 1
  als EIGENE Regelmenge über exakt das §7.3-Fragment (`owl-rl.ts`:
  subClassOf/subPropertyOf inkl. Hierarchie-Transitivität, domain/range,
  inverseOf, Transitive-/SymmetricProperty, equivalentClass/-Property,
  sameAs mit Ersetzung — Entscheidung gegen eye-js in
  [docs/decisions/0002-shacl-library.md](./docs/decisions/0002-shacl-library.md)).
  Materialisierung ist **scope-partitioniert** (Inferenz-Leak, §7.3):
  ein Lauf pro Sichtbarkeits-Scope über genau dessen Dataset —
  `workspace` (workspace+public+import/*+meta) und `public` (nur public) —
  vollständiger Replace nach `graph/<u>/inferred/<scope>` mit PROV;
  Schema-Axiome über fremde Vokabulare in `ontology/rules/reasoning.ttl`
  (skos:broader transitiv — die Hülle liegt NUR im Inferenz-Graphen,
  behauptete Graphen bleiben reines SKOS). Läuft beim Start (inferred
  wird nie persistiert, SPEC §8.1), nach jedem Import/Connector-Löschen
  und auf Anforderung (`GET|POST /api/graph/reasoning`). SHACL
  (rdf-validate-shacl, gekapselt in `reasoning/shacl.ts`; Kern-Shapes
  `ontology/shapes/core.ttl` → `graph/shapes` beim Start, inkl.
  Layout-Blacklist als Shape) validiert an den DREI Stellen aus §7.2:
  vor jedem UI/API-Schreibvorgang (`workspace/crud.ts` — blockierend NUR
  bei sh:Violation, das die Mutation NEU einführt; Altbestand bleibt
  bearbeitbar; API → 422), nach jedem Connector-Pull (berichtend, NIE
  blockierend; Bericht als sh:ValidationReport in `graph/meta`,
  Kurzfassung im Connector-Lesemodell + `/graph/connectors`) und on
  demand (`POST /api/graph/validate` + Explorer-Panel „Reasoning &
  Validierung"; inferierte Kanten gestrichelt, per Default aus).
  DL-Sidecar (Tier 2) bewusst nicht gebaut — optional laut SPEC, kein
  Bedarf, keine Attrappe. Abnahme: `tests/graph/reasoning.test.ts`
  (inkl. Scope-Leak-Negativtest) und `tests/graph/shacl.test.ts`.
- **Suche + Multi-Hop-Retrieval (M8)** (`src/lib/graph/search/`):
  Volltext-Index über ALLE Literale als eigene, leichte JS-Lösung
  (invertierter Index, Levenshtein-Fuzzy + Präfix über sortiertes
  Vokabular; Einträge tragen Subjekt-IRI/Prädikat/Graph → nach Graphen
  filterbar, §17.4). Optionaler Vektorindex separat vom Store (jeder
  Vektor trägt die Subjekt-IRI; Embedding-Provider aus der AI-Schicht per
  `OW_EMBEDDING_PROVIDER`/`OW_EMBEDDING_MODEL`, openai-kompatibel oder
  Ollama — ohne Konfiguration ehrlich „nicht verfügbar"). Beide Indizes
  werden NIE persistiert (reproduzierbar wie graph/inferred): WeakMap-
  Cache pro Store, invalidiert im Mutations-Pfad (`runExclusive`) und in
  der SPARQL-Update-Route. Retrieval-Pipeline nach SPEC §7.5
  (`search/retrieval.ts`) mit vier einzeln exportierten Phasen: Seeding
  (IRI exakt + Volltext + Vektor, still gefiltert gegen das erlaubte
  Dataset), Expansion (BFS bis maxHops über die Wissens-Graphen
  workspace+public+import/*+meta — presentation/acl/vocab/shapes nie,
  inferred/workspace nur bei `includeInferred: true`; Richtung,
  edgeTypes/nodeTypes, Grad-Kappung maxDegree als Hub-Schutz,
  Zyklenschutz, harte Knoten-/Kanten-/Laufzeit-Obergrenzen; rdf:type ist
  per Default keine Traversal-Kante), Scoring (deterministisch:
  seed × decay^hop × Kantengewichts-Pfad [`ow:weight` am RDF-1.2-Reifier]
  × Zentralität × Aktualität — normiert gegen Zeitstempel IM Ergebnis,
  kein Wall-Clock-Bezug) und Assembly (Kanten-Hülle über den
  aufgenommenen Knoten + zitierfähiger [n]-Kontext, Token-Budget entlang
  der Score-Reihenfolge). `explain` + `provenance` sind Pflicht: jeder
  Knoten weist hop/via/scoreParts aus, jede Quelle Graph + Connector.
  Retrieval-Profile sind `ow:RetrievalProfile`-Entitäten in `graph/meta`
  (`ow:retrievalConfig` als JSON-Literal). APIs: `GET /api/graph/search`
  (eigene Such-API mit ehrlicher Embedding-Diagnose),
  `POST /api/graph/retrieve` (zod-validiert; `profile` als Basis,
  Body-Felder überschreiben), `GET|POST /api/graph/retrieval-profiles`
  (+ `DELETE /[id]`). Der Global Finder (`/api/finder`,
  `workspace_finder`) ist auf den Graphen UMGESTELLT, nicht ersetzt:
  Dokumente/Aufgaben/Projekte kommen aus dem Index (Fuzzy-Verhalten und
  matchScore-Ranking erhalten), Chats/Termine ehrlich weiter aus ihren
  Storages, bis sie Graph-Bürger sind (M9+). Bekannte Grenze: oxigraph-js
  kann keine Custom-SPARQL-Functions — die §7.7-Custom-Function ist eine
  erstklassige Funktion der Suchschicht; `FulltextIndex.search` ist der
  Einhängepunkt, sobald die Bindung es exponiert. Abnahme:
  `tests/graph/retrieval.test.ts` (Reproduzierbarkeit auch über einen
  zweiten, anders befüllten Store; Hub-Kappung an einem Tag mit 120
  Dokumenten samt Gegenprobe; Token-Budget; includeInferred) und
  `tests/graph/search.test.ts`.
- **Agents, Skills, Tools als Graph-Bürger (M9)**
  (`src/lib/graph/connectors/a2a-agent-card.ts`, `…/mcp-server.ts`,
  `src/lib/graph/meta/ai.ts`): Die Abnahmefrage „welche Skills benötigen
  welche Tools, und welcher Agent bietet sie an" ist per SPARQL
  beantwortbar — über drei Quellen. (1) Connector `a2a-agent-card`:
  Card-Discovery in der Reihenfolge des A2A-Clients
  (`agentCardCandidates`, Netz über den SSRF-Guard), Revision =
  Inhalts-Hash; Agent als foaf:Agent + ow:Agent +
  schema:SoftwareApplication (`ow:agentCardUrl`/`ow:endpoint`/
  `ow:securityScheme` als quelltreues JSON-Literal), Card-Skills als
  `ow:Skill` mit `ow:providesSkill`; unbrauchbare Cards/Einzel-Skills
  werden quarantäniert, nie fatal. (2) Connector `mcp-server`: läuft durch
  den ECHTEN SDK-Client (`describeMcpServer` — Server-Info, Tools, Prompts
  über EINE Verbindung; Transporte akzeptieren injiziertes fetch →
  SSRF-Guard gilt), Revision = Hash des sortierten Inventars; Server →
  `ow:ToolProvider` (`ow:endpoint`, `ow:transport` = verbundener
  Transport), Tools → `ow:Tool` mit `ow:inputSchema` (JSON-Schema als
  Literal) + `ow:providedBy`, Prompts → `ow:Skill`. (3) AI-Spiegel
  (§18-Muster) nach `graph/meta`: Skills aus `data/ai/skills.json`
  (`ow:trigger` = SKILL.md-Description, `ow:skillSource` = Ladeweg,
  `schema:text` = Anleitung → volltext-suchbar, `[[TOOL:…]]`-Bedarf als
  `ow:requiresTool` ⊑ schema:tool [neuer Term, §4.3]), Agenten aus
  `data/agents/config.json` (Remote-A2A inkl. Card-Capabilities als
  Skills), Builtins + API-Tools als `ow:Tool` unter dem Anbieter
  „Open Workspace" (Beschreibungen aus `tools.shared.ts` — keine zweite
  Kopie), konfigurierte MCP-Server als `ow:ToolProvider` OHNE erfundenes
  Tool-Inventar (das liefert der Connector). Wahrheits-Semantik: die
  JSON-Bestände bleiben operative Konfiguration (AI-Schicht läuft auch
  serverlos), der Spiegel wird GENERIERT — beim Start und nach jeder
  Mutation (`refreshAiMirror`, aufgerufen von den Skills-/Agents-/Tools-/
  MCP-Server-Routen), deterministisch (dateTime-Vergleich als Zeitpunkt,
  diff-stabile Snapshots), abschnittsweiser Replace neben der
  Connector-Registry. Abnahme: `tests/graph/agents-skills-tools.test.ts`
  (inkl. MCP end-to-end gegen einen Streamable-HTTP-Stub).
- **MCP-Server (M10)** (`src/lib/graph/mcp/` + `/api/mcp`): Der Workspace
  ist jetzt auch MCP-**Server** — externe Agenten (Claude Desktop, ein
  zweiter Workspace) retrieven auf dem Graphen, ohne SPARQL zu sprechen.
  Streamable HTTP über die Web-Standard-Bindung DERSELBEN SDK, die schon
  den Client trägt (`WebStandardStreamableHTTPServerTransport`: `Request`
  rein, `Response` raus — direkt am App-Router-Handler, kein Node-Adapter,
  kein nachgebautes Protokoll). Werkzeuge nach §7.6: `graph_search`,
  `graph_retrieve` (Default `format: 'context'`, `profile` als Basis),
  `graph_neighbors`, `graph_describe` — dazu `graph_sparql` nur mit
  SPARQL-Recht (read-only) und `graph_write` nur mit Schreibfreigabe
  (**Default aus**); ein Werkzeug ohne Recht wird gar nicht erst
  registriert (kein toter Eintrag im Inventar). Resources: `graph://<iri>`
  mit **prozentkodierter** IRI (nur so ist die URI für `urn:ow:…` wie für
  `https://…`-Basen eine gültige URL), ausgeliefert als Turtle + JSON-LD;
  Prompts sind die `ow:RetrievalProfile`-Entitäten aus M8.
  **Sicherheit ist kein zweiter Pfad**: `AccessGrant`
  (`src/lib/graph/authz/grant.ts`) ist ausschließlich eine Verengung —
  `resolveDataset` (SPARQL) und `retrievalDataset` (Retrieval) nehmen
  `allowedGraphs` und können dadurch nur weniger zeigen; `graph_sparql`
  ist derselbe `executeSparqlProtocol` mit `readOnly: true`. Die Klammer
  greift VOR der Expansion, und die Expansion nimmt nur noch Knoten auf,
  über die im erlaubten Dataset etwas ausgesagt ist — eine Kante ins
  Gesperrte endet im Nichts statt eine nackte IRI auszuliefern. Zugänge
  stehen bis M13 in `OW_MCP_TOKENS` (zod-validiert, Vergleich über
  SHA-256-Digest ohne frühen Abbruch, Scope-Muster wie `workspace`,
  `import/*`, `shared/<id>`, `*` — `graph/acl` trifft keins davon); ohne
  Konfiguration ist der Endpunkt ehrlich **aus** (503 mit Hinweis), nie
  anonym offen. Sitzungen sind an die Token-Identität gebunden (fremde
  Session-ID = 404), Rate-Limit pro Token als gleitendes Minutenfenster
  (429 + `Retry-After`), Zeitbudget pro Werkzeug. `graph_write` schreibt
  ausschließlich in `workspace`/`public`/`shared/<id>` und hängt an jedes
  Subjekt `prov:wasAttributedTo` plus eine `prov:Activity`.
  `capabilities.mcpServer` steht damit für `server`/`ha-addon` auf true.
  UI: read-only Status-Karte auf `/tools` (Zugänge, Rechte, sichtbare
  Graphen, Sitzungen) über `GET /api/mcp/status` — Geheimnisse verlassen
  die Route nie. Abnahme: `tests/graph/mcp-server.test.ts` (echter
  SDK-Client; Negativtest über retrieve/neighbors/describe/search/sparql/
  Resource).
- **Invarianten** (Review-Blocker, SPEC §2): RDF ist die eine Wahrheit;
  Wissen ≠ Präsentation; asserted ≠ inferred; ein Connector-Vertrag für
  alles Externe; kein `any` unter `src/lib/graph/` (ESLint-Error);
  Vokabular-Base niemals deployment-spezifisch.

**Stand 2026-08-08 (2. Ausbaustufe)**: Die **AI-Plattform ist voll ausgebaut
und backend-unabhängig** — Details in [docs/ai-platform.md](./docs/ai-platform.md):

- **Multi-Provider-Inference** (`src/lib/ai/`): Provider-Katalog (Ollama,
  LM Studio, llama.cpp, vLLM, Jan, OpenAI, Anthropic, Gemini, Mistral, Groq,
  OpenRouter, Together, DeepSeek, xAI, custom, **WebLLM im Browser/WebGPU**),
  Protokoll-Adapter (openai/anthropic/ollama/webllm) mit Streaming und
  **nativem Tool-Calling + Text-Syntax-Fallback**.
- **Routing pro Provider**: Browser-direkt (erreicht lokale Endpunkte auch
  bei cloud-gehosteter App; Keys optional nur im Browser) oder Server-Route
  (AES-verschlüsselte Keys); `auto` probt Browser→Server. Diagnose erkennt
  CORS/Mixed-Content/Auth mit deutschen Lösungs-Hinweisen.
- **Serverloser Modus**: ohne erreichbares Backend laufen Konfiguration
  (localStorage), Chats (IndexedDB), Skills und Inference im Browser weiter;
  die **isomorphe Engine** (`engine.ts`) ist auf beiden Pfaden identisch.
- **MCP-Client** (Streamable HTTP/SSE, browser-direkt + Server-Relay):
  Tools im Loop, Prompts→Skills-Import, `ui://`-Ressourcen auf der Bühne.
- **A2A**: Agent-Card-Discovery, `message/send` + Task-Polling, Delegation
  im Chat via `[[AGENT:id:…]]`; lokale Persona-Agenten mit Provider-Override.
- **Skills** (`src/lib/skills/`): SKILL.md-Konvention, Ladewege manuell/URL/
  GitHub-Repo/MCP-Prompt, Progressive Disclosure über das `use_skill`-Tool.
- **UI**: AI-Hub (`/ai`), Skills (`/skills`), MCP-Verwaltung in `/tools`,
  A2A-Discovery in `/agents`, ModelPicker in beiden Chat-Oberflächen.

Build, Typecheck, Lint (0 Errors), 356 Unit-Tests und das **blockierende
E2E-Gate** (`e2e/mobile-navigation`, `e2e/mobile-ux`, `e2e/a11y` inkl. der
Seiten `/ai`, `/skills`, `/tools`, `/graph/connectors` und `/graph/sparql`)
laufen grün. In Sandboxes ohne Playwright-Download zeigt
`CHROMIUM_PATH=/opt/pw-browsers/chromium bun run test:e2e` auf einen
vorinstallierten Browser (die Konfiguration wertet die Variable aus).

**Bevor du etwas Neues baust, lies in dieser Reihenfolge:**
1. [GRAPH_CORE_SPEC.md](./GRAPH_CORE_SPEC.md) — verbindliche Spec des
   Graph-Ausbaus (M0–M13, Invarianten, Abnahmen) — Pflicht für Graph-Arbeit
2. [docs/ai-platform.md](./docs/ai-platform.md) — Architektur der AI-Schicht
3. [ANALYSE.md](./ANALYSE.md) — Bestandsaufnahme + **§5 Roadmap** (P0/P1/P2)
4. [TODO.md](./TODO.md) — Roadmap als abhakbare Liste (inkl. Graph Core)
5. Diesen Abschnitt hier für die Architektur-Prinzipien

**Nächste sinnvolle Schritte**: Graph Core M11 (**Föderation** nach SPEC
§7.4: Endpoint-Registry als `ow:FederatedEndpoint` mit `ow:trustLevel` in
`graph/meta`, `SERVICE`-Queries gegen registrierte Endpoints mit
Erreichbarkeits-Probe pro Endpoint [im Browser CORS-abhängig, in der UI
ehrlich markieren], ausgehende Aufrufe über den bestehenden SSRF-Guard
[`src/lib/net/private.ts` bzw. `connectors/http.ts`], Query-Timeouts und
Ergebnis-Limits als Pflicht — und **eingehende** Föderation für
`ha-addon`/`server` mit Authz-Rewriting: das erlaubte Dataset wird aus
der authentifizierten Identität abgeleitet und in die Query injiziert,
nie nachgefiltert. Der Grant aus M10 (`src/lib/graph/authz/grant.ts`) ist
dafür der Einhängepunkt — `resolveDataset` nimmt `allowedGraphs` bereits
entgegen; Default für unauthentifizierte Zugriffe ist das LEERE Dataset.
Abnahme: Live-Query gegen Wikidata liefert Ergebnisse; ein
unauthentifizierter Zugriff sieht ausschließlich explizit freigegebene
Named Graphs — Negativtest mit manipuliertem `FROM`). Danach M12
(Runtime-Vollausbau) und M13 (Multi-User/ACL — dort wird die
Token→Scope-Konfiguration aus `OW_MCP_TOKENS` durch `graph/acl` ersetzt,
ohne dass sich die Grant-Schnittstelle ändert).
Parallel weiter sinnvoll: i18n mit `next-intl` (P0); Abbau der
`no-explicit-any`-Warnings außerhalb des Graph-Codes;
CopilotKit-Entscheidung.

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

### Agent2Agent (A2A) — implementiert (`src/lib/ai/a2a/client.ts`)
- Capability Discovery via Agent Cards (`/.well-known/agent-card.json`,
  Fallback `agent.json`)
- JSON-RPC `message/send` (Fallback `tasks/send` für ältere Agenten)
- Task-Lifecycle via `tasks/get`-Polling bis Terminal-Status
- Delegation im Chat: `[[AGENT:agent_id:Auftrag]]` → `[AGENT_RESULT]`
- Browser-direkt (CORS erlaubt) oder Server-Relay `POST /api/ai/a2a`

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

### Model Context Protocol (MCP) — implementiert (`src/lib/ai/mcp/client.ts`)
- Client auf `@modelcontextprotocol/sdk`: Streamable HTTP mit SSE-Fallback
- Verwaltung in `/tools`; Verbindung browser-direkt (auch serverlos) oder
  über das Server-Relay `POST /api/ai/mcp/[id]` (nur konfigurierte Server)
- Entdeckte Tools laufen namespaced (`mcp_<server>_<tool>`) im Tool-Loop
- Prompts sind als Skills importierbar; `ui://`-Ressourcen in
  Tool-Ergebnissen rendern als `UIResource` auf der generativen Bühne
- **Server-Seite** (`/api/mcp`, `src/lib/graph/mcp/`, GRAPH_CORE_SPEC §7.6):
  externe Agenten retrieven auf dem Wissensgraphen — Werkzeuge
  `graph_search`/`graph_retrieve`/`graph_neighbors`/`graph_describe`
  (+ `graph_sparql`, `graph_write` je nach Recht), Knoten als Resources
  `graph://<iri>`, Retrieval-Profile als Prompts. Zugang ausschließlich
  per Token aus `OW_MCP_TOKENS` mit ausdrücklich freigegebenen Graphen;
  Status read-only unter `/tools`

### Agent Tools
- Verfügbare Tools sind in [TOOLS.md](./TOOLS.md) dokumentiert.
- **Dynamic Tool Discovery**: Der Agent erhält verfügbare Tools via
  System-Prompt (Builtins + API-Tools + MCP-Tools) — bei Providern mit
  Function-Calling-Support zusätzlich als native Tool-Definitionen.
- **Tool Protocol** (isomorphe Engine `src/lib/ai/engine.ts`, Parser
  `src/lib/tools/callParser.ts`): Nativ ruft das Modell Function Calls auf;
  als universeller Fallback gilt die Text-Syntax
  `[[TOOL:tool_name:{"arg":"value"}]]`. Die Engine erkennt Aufrufe im
  Stream (auch über Chunk-Grenzen), blendet sie aus der sichtbaren Antwort
  aus, führt das Tool aus und speist das Ergebnis als `[TOOL_RESULT]`
  (Text-Modus) bzw. `role:"tool"`-Nachricht (nativ) zurück — maximal
  4 Runden pro Anfrage, Fortschritt wird im Chat angezeigt. Der gleiche
  Loop läuft serverseitig (`/api/chat`) und im Browser (Serverless/
  Direktverbindungen, `src/lib/ai/transport.ts`).

  Beispiel:
  - User: "Wie ist das Wetter in Berlin?"
  - Agent (Output): `Ich prüfe das Wetter. [[TOOL:weather:{"latitude":52.52,"longitude":13.41}]]`
  - System führt das Tool aus → Agent fasst das Ergebnis zusammen.
  
- **Standard-Tool**: `workspace_finder` (Global Finder)
  - Unterstützt Fuzzy-Suche (Levenshtein) für Inhalte und Befehle
  - Smart Modifiers: `@task`, `@note`, `@termin`, `@chat`, `@projekt`
  - Findet auch Aufgaben ohne Projektzuordnung via `@projekt`

## AI Inference

**Multi-Provider** (AI-Hub `/ai`, persistiert in `data/ai/config.json`,
Keys AES-256-GCM-verschlüsselt oder browser-lokal):

- Protokolle: OpenAI-kompatibel, Anthropic Messages, Ollama nativ,
  WebLLM (In-Browser/WebGPU)
- Routing pro Provider: Browser-direkt oder Server-Route, `auto` probt
  Browser→Server (`src/lib/ai/store.client.ts#resolveRoute`)
- Tool-Calling: nativ (Function Calling) mit automatischem Fallback auf
  die `[[TOOL:…]]`-Text-Syntax
- Legacy-Env (`LLM_API_BASE_URL`/`LLM_MODEL`/`LLM_API_KEY`) wird beim
  ersten Start in einen Provider migriert

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
  - **FAB-Positionierung**: immer über die Tokens `--fab-bottom`/`--fab-right`
    (enthalten Safe-Area-Insets), nie hartkodierte Pixel.
  - **Touch-Targets**: Primär-Controls ≥ `--touch-target` (44px), alles ≥ 24px.
    Hover-only-Controls sind verboten — auf Touch immer sichtbar/erreichbar
    (`@media (pointer: coarse)`), bei Tastatur via `:focus-within`.
  - **Z-Index**: nur die Token-Skala (`--z-*`) verwenden. Modale Layer (Drawer,
    Dialoge) liegen auf `--z-modal`-Niveau, FABs auf `--z-dropdown` darunter.
  - **Farben als Text**: `--color-primary-text` statt `--color-primary`
    (Dark-Mode-Kontrast); Formularfelder nie unter 16px (iOS-Autozoom).
  - Diese Regeln werden von `e2e/mobile-ux.spec.ts` und `e2e/a11y.spec.ts`
    maschinell durchgesetzt (blockierender CI-Check).
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
