# TODO - Open Workspace Development

> Roadmap auf Basis der vollständigen Analyse in [Analyse (2026-08)](./docs/analyse-2026-08.md).
> Für den Graph-Ausbau gilt [GRAPH_CORE_SPEC](./docs/specs/graph-core.md)
> (hat Vorrang vor ANALYSE §5, wo sie widersprechen). Arbeitsmodus:
> ein Meilenstein = eine Session = ein Branch = ein PR.

## Graph Core (SPEC „Vollausbau", M0–M14)

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
- [x] **M7 Reasoning**: SHACL an den DREI Stellen aus §7.2 —
      (1) vor jedem UI/API-Schreibvorgang (`workspace/crud.ts`, blockierend
      NUR bei sh:Violation und nur wenn die Mutation den Verstoß NEU
      einführt; API antwortet 422), (2) nach jedem Connector-Pull
      (Sync-Runner: berichtend, nie blockierend — Bericht als
      sh:ValidationReport-Graph in `graph/meta`, Kurzfassung im
      Connector-Lesemodell und auf `/graph/connectors`), (3) on demand
      (`POST /api/graph/validate` + Explorer-Panel). Kern-Shapes
      `ontology/shapes/core.ttl` (inkl. Layout-Blacklist als Shape,
      Invariante 2), beim Start nach `graph/shapes`;
      Library-Entscheidung mit Messwerten:
      docs/decisions/0002-shacl-library.md (rdf-validate-shacl,
      `bun run bench:shacl`). OWL RL Tier 1 als eigene Regelmenge über
      das §7.3-Fragment (`src/lib/graph/reasoning/owl-rl.ts`; subClassOf/
      subPropertyOf, domain/range, inverseOf, Transitive/Symmetric,
      equivalentClass/-Property, sameAs), Schema-Axiome
      `ontology/rules/reasoning.ttl` (skos:broader transitiv);
      Materialisierung scope-partitioniert nach
      `graph/<u>/inferred/<workspace|public>` mit vollständigem Replace +
      PROV (`reasoning/run.ts`), läuft beim Start, nach jedem Import/
      Connector-Löschen und auf Anforderung (`POST /api/graph/reasoning`);
      nie persistiert, nie im Default-Dataset. Explorer zeigt inferierte
      Kanten gestrichelt, per Default aus. DL-Sidecar bleibt optional
      (nicht gebaut — kein Bedarf, Invariante 10) — Abnahme
      (blockedBy/blocks + skos:broader-Transitivität inferiert, kein
      inferiertes Tripel in graph/workspace, Scope-Leak-Negativtest):
      `tests/graph/reasoning.test.ts`, `tests/graph/shacl.test.ts`
- [x] **M8 Suche + Multi-Hop-Retrieval** (`src/lib/graph/search/`):
      Volltext-Index über ALLE Literale (eigene JS-Lösung, invertierter
      Index + Levenshtein-Fuzzy + Präfix, Einträge tragen IRI/Prädikat/
      Graph → scope-filterbar §17.4, nie persistiert — WeakMap-Cache mit
      Invalidierung im Mutations-Pfad und in der SPARQL-Update-Route);
      optionaler Embedding-/Vektorindex (separat vom Store, Vektor trägt
      Subjekt-IRI; Provider aus der AI-Schicht via OW_EMBEDDING_PROVIDER/
      OW_EMBEDDING_MODEL, openai-kompatibel + Ollama, ohne Konfiguration
      ehrlich „nicht verfügbar"); Retrieval-Pipeline nach §7.5 als vier
      einzeln testbare Phasen (Seeding IRI/Volltext/Vektor → Expansion mit
      Richtung, Kanten-/Knotentyp-Filtern, Grad-Kappung, Zyklenschutz,
      harten Obergrenzen → deterministisches Scoring seed×decay^hop×
      ow:weight-Pfad×Zentralität×Aktualität → Assembly: Kanten-Hülle +
      zitierfähiger [n]-Kontext mit Token-Budget); explain/provenance
      Pflicht (hop, via, scoreParts pro Knoten; Quell-Graph + Connector);
      Dataset-Klammer VOR der Expansion (Wissens-Graphen; presentation/
      acl/vocab nie, inferred nur per includeInferred); Retrieval-Profile
      als ow:RetrievalProfile in graph/meta (ow:retrievalConfig als
      JSON-Literal); APIs GET /api/graph/search, POST /api/graph/retrieve
      (zod, Profil als Basis + Overrides), /api/graph/retrieval-profiles;
      `workspace_finder`/`/api/finder` auf den Index umgestellt (Fuzzy
      erhalten; Chats/Termine ehrlich weiter aus Storages bis M9+) —
      Abnahme (Reproduzierbarkeit inkl. zweitem Store, explain vollständig,
      Hub-Kappung an Tag mit 120 Dokumenten + Gegenprobe, Token-Budget):
      `tests/graph/retrieval.test.ts`, `tests/graph/search.test.ts`
- [x] **M9 Agents/Skills/Tools als Graph-Bürger**: zwei neue Connectors
      über den EINEN Vertrag — `a2a-agent-card` (Card-Discovery-Reihenfolge
      aus dem A2A-Client, Revision = Inhalts-Hash; foaf:Agent/ow:Agent/
      schema:SoftwareApplication mit ow:agentCardUrl/ow:endpoint/
      ow:securityScheme [JSON-Literal], Card-Skills als ow:Skill mit
      ow:providesSkill; unbrauchbare Cards/Skills → Quarantäne, nie fatal)
      und `mcp-server` (ECHTER SDK-Client, `describeMcpServer` über EINE
      Verbindung mit injiziertem SSRF-Guard-fetch; Revision = Hash des
      sortierten Inventars; Server → ow:ToolProvider mit ow:endpoint/
      ow:transport, Tools → ow:Tool mit ow:inputSchema [JSON-Literal] +
      ow:providedBy, Prompts → ow:Skill mit ow:providesSkill); NATIV der
      AI-Spiegel `src/lib/graph/meta/ai.ts` (§18-Muster) nach graph/meta:
      Skills (ow:trigger/ow:skillSource/schema:text, [[TOOL:…]]-Bedarf als
      neues `ow:requiresTool` ⊑ schema:tool), Agenten (Remote-A2A inkl.
      Card-Capabilities als Skills), Builtins + API-Tools unter dem
      Anbieter „Open Workspace" (Beschreibungen aus tools.shared.ts),
      MCP-Server-Configs als ow:ToolProvider ohne erfundenes Inventar;
      generiert beim Start + nach jeder Mutation (`refreshAiMirror` in den
      Skills-/Agents-/Tools-/MCP-Routen), deterministisch, abschnittsweiser
      Replace neben der Connector-Registry; UI: beide Arten unter
      /graph/connectors — Abnahme (SPARQL beantwortet „welche Skills
      welche Tools benötigen und welcher Agent sie anbietet" über Spiegel +
      Import-Graphen; MCP end-to-end gegen Streamable-HTTP-Stub):
      `tests/graph/agents-skills-tools.test.ts`
- [x] **M10 MCP-Server** (`/api/mcp`): Streamable HTTP über die
      Web-Standard-Bindung derselben SDK, die schon den Client trägt
      (`src/lib/graph/mcp/` — `http.ts` Sitzungen/Auth/Limits, `server.ts`
      Werkzeug-Registrierung, `tools.ts` Graph-Operationen). Werkzeuge nach
      §7.6: graph_search/retrieve/neighbors/describe (immer),
      graph_sparql (nur mit SPARQL-Recht, read-only über denselben
      `executeSparqlProtocol`), graph_write (Default AUS, nur mit
      Schreibfreigabe; schreibt ausschließlich in workspace/public/
      shared/<id> und hängt prov:wasAttributedTo + prov:Activity an).
      Resources `graph://<iri>` (prozentkodiert, Turtle + JSON-LD),
      Prompts = gespeicherte Retrieval-Profile aus M8. Authz ist KEIN
      zweiter Pfad: `AccessGrant` (`src/lib/graph/authz/grant.ts`) verengt
      `resolveDataset`/`retrievalDataset` über `allowedGraphs` — die
      Klammer greift vor der Expansion; zusätzlich nimmt die Expansion nur
      Knoten auf, über die im erlaubten Dataset etwas ausgesagt ist.
      Tokens in `OW_MCP_TOKENS` (zod-validiert, Digest-Vergleich ohne
      frühen Abbruch, Scope-Muster, `graph/acl` nie erreichbar); ohne
      Konfiguration ist der Endpunkt ehrlich aus (503). Sitzungen
      token-gebunden (fremde Session-ID → 404), Rate-Limit pro Token
      (429 + Retry-After), Zeitbudget pro Werkzeug.
      `capabilities.mcpServer` = true für server/ha-addon; UI: read-only
      Status-Karte auf `/tools` + `GET /api/mcp/status` (ohne Geheimnisse).
      Abnahme (externer SDK-Client ruft graph_retrieve mit Provenienz ab;
      Negativtest über alle Pfade): `tests/graph/mcp-server.test.ts`
- [x] **M11 Föderation** (`src/lib/graph/federation/`): Endpoint-Registry
      als `ow:FederatedEndpoint` + `ow:trustLevel` in `graph/meta`
      (`registry.ts`, UI `/graph/federation`, API
      `/api/graph/federation/endpoints` + `/[id]` + `/[id]/probe`).
      **Ausgehend**: `SERVICE <url>` läuft über einen eigenen Planer
      (`parse.ts` maskiert Kommentare/Strings/IRIs positionstreu,
      `service.ts` ersetzt den Block durch die entfernte Lösungsmenge als
      `VALUES` — oxigraph-js hat keinen Service-Handler, die Semantik von
      SPARQL 1.1 Federated Query bleibt erhalten). Nur registrierte
      Endpoints; die Vertrauensstufe hat Wirkung: `unknown` gesperrt,
      `known` eigenständige Auswertung (keine lokale Bindung geht raus,
      als Leak-Negativtest verankert), `trusted` Bound-Join mit lokalen
      Join-Schlüsseln (Sonde ist eine Lockerung der Query → Obermenge der
      echten Schlüssel, gechunkt). Ausgehende Aufrufe über den
      SSRF-Guard (`connectors/http.ts`), Zeitbudget + Ergebnis-Limit
      Pflicht (Überschreitung = Fehler, keine stille Kürzung),
      `SERVICE SILENT` wird zur leeren Lösung samt Bericht;
      Erreichbarkeits-Probe als echte ASK-Query, in der UI ehrlich
      markiert. **Eingehend**: `GET|POST /api/graph/federation/sparql`
      (read-only, CORS, `OPTIONS`) — das erlaubte Dataset kommt aus dem
      Grant (M10-Token, Recht `sparql`) und wird über `resolveDataset`
      INJIZIERT, nie nachgefiltert; ohne gültiges Token das leere
      Dataset, `SERVICE` gesperrt (Quelle, kein Relais), Rate-Limit,
      Zeit- und Ergebnis-Limit. `capabilities.federationOutbound`/
      `federationInbound` = true für server/ha-addon.
      Abnahme: `tests/graph/federation.test.ts` (Negativtest mit
      manipuliertem `FROM`; Live-Query gegen Wikidata unter
      `OW_FEDERATION_LIVE=1`, sonst ehrlich übersprungen)
- [x] **M12 Runtime-Vollausbau**: EIN Image für `server` und `ha-addon`
      (per Test erzwungen: genau ein Dockerfile im Repo, Add-on-Config und
      Compose zeigen darauf). Einstieg ist immer `scripts/start.mjs` —
      Base-Path ermitteln (Supervisor-API bzw. `OW_BASE_PATH`), den beim
      Bauen eingesetzten Platzhalter im fertigen Build ersetzen
      (`scripts/base-path.mjs`: Textdatei-Erlaubnisliste, Markierung,
      idempotent, folgt gewechseltem Ingress-Token), Daten nach `/data`
      verknüpfen, Add-on-Optionen übernehmen, root-Rechte abgeben, starten.
      **Ingress**: der Supervisor ENTFERNT das Präfix, Next erwartet es —
      `scripts/ingress-proxy.mjs` setzt es wieder vor den Pfad (Packaging,
      nicht Anwendung); gewechselter Token = 503 + Neustart statt falscher
      Links. **App**: `src/lib/platform/base-path.ts` präfixt `fetch` an
      genau EINER Stelle (Feature-Code kennt den Ingress nirgends),
      Manifest als Route `/manifest.webmanifest`, Service Worker liest
      seinen Base-Path aus `registration.scope`. **server-Compose**:
      Caddy (TLS/ACME) → oauth2-proxy (OIDC-Anmeldefluss, Profil `oidc`) →
      App unprivilegiert. **Identität** (`OW_AUTH_MODE`): `single-user`,
      `ha-ingress`, `proxy-header`, `oidc-bearer` (JWKS-Prüfung über
      WebCrypto, ohne neue Abhängigkeit) — gelesen und angezeigt
      (`GET /api/runtime`, Karte „System"), Durchsetzung pro Graph bleibt
      M13, `multiUser` = false. **Runtime `local`**: Store im Web Worker
      (`runtime/worker/`, GraphStore inkl. offener Transaktionen mit Lesen
      darin), OPFS als `FileSystemLike` (trägt isomorphic-git),
      Persistenz-Anfrage + Quota-Warnung ab 80 % (§8.3) in den
      Einstellungen. Doku: docs/deployment.md — Abnahme:
      `tests/platform/{base-path,ingress,packaging,auth,opfs,worker-store}.test.ts`
      und `e2e/ingress.spec.ts` (volle Supervisor→Proxy→Build-Kette über
      `scripts/e2e-ingress-server.mjs`)
- [x] **M13 Multi-User/ACL**: Rechte sind RDF im selben Store —
      `graph/acl` trägt Web-Access-Control-Regeln (`acl:Authorization`,
      `acl:accessTo` auf die Graph-IRI, `acl:agent`/`agentGroup`/
      `agentClass`, `acl:mode`), Granularität pro Named Graph (§17.2).
      Modus-Implikation festgelegt: `control` ⊃ `write` ⊃ `append`/`read`;
      `append` allein ist die Briefkasten-Semantik. Rollen sind benannte
      Modus-Bündel, die Mitgliederliste eines Raums IST die Regelmenge auf
      seinem Graphen. **Nichts per Default sichtbar** — auch das Recht des
      Eigentümers steht als Tripel im Graphen (`ensureDefaultAuthorizations`
      füllt beim Start nur auf, überschreibt nie); `graph/acl` selbst
      trifft kein Muster und keine Regel. **Durchsetzung** (§17.3) in zwei
      Stufen: `grantForIdentity` (Identität + ACL ⇒ `AccessGrant`), dann
      `resolveDataset`/`retrievalDataset`, die den Grant als Verengung
      injizieren — die Grant-Schnittstelle aus M10 blieb unverändert,
      `OW_MCP_TOKENS` nennt nur noch den Nutzer (Scopes = optionale
      zusätzliche Verengung). Architekturtest erzwingt: kein
      `store.query(`-Aufruf ohne Dataset vom Resolver. SPARQL UPDATE
      bekommt `writableGraphs` (auch neue Graphen außerhalb des Rechts
      entstehen nicht); Ablehnung unterscheidet nicht zwischen
      systemverwaltet, fremd und nicht existent. **Anfrage-Kontext**
      (`server/context.ts`): Identität aus `next/headers`, nutzerskalierte
      IRI-Fabrik, Grant — und die Kernregel, dass eine Anfrage OHNE
      geprüfte Identität anonym ist, nicht der Einzelnutzer. **§17.5**:
      `public` anonym lesbar über die reguläre Regel, `/.well-known/void`
      beschreibt den Umfang des Anfragenden, Entitäts-IRIs dereferenzieren
      unter `/u/<userId>/<type>/<id>` (Turtle/JSON-LD/HTML; ehrliche
      Grenze: nur mit HTTP-Instanz-Base), Rate-Limit für anonyme Zugriffe.
      **§17.4** je ein Test: Index pro Dataset statt global gefiltert,
      Retrieval-Klammer vor der Expansion, Reasoning je Nutzer,
      Bound-Join-Leak über den ausgehenden Query-Text, gesperrt vs. nicht
      existent byte-gleich. Export nur eigene Verzeichnisse
      (`data/u/<id>/…`), `git-backup` verlangt `control` auf JEDEM Graphen
      des Snapshots; `graph/acl` wird als `acl.nq` NEBEN dem Manifest
      gesichert (überlebt Neustart; kein Restore und kein Nutzer-Export
      fasst ihn an — ein Git-Backup direkt auf `data/graph` nimmt die
      Datei mit, was zulässig ist, weil es `control` auf allem verlangt). Neue Terme
      `ow:Space`/`ow:spaceGraph`, sonst Standard-Vokabular (WAC, FOAF,
      VoID). UI `/graph/access`, `capabilities.multiUser` = true.
      Doku: docs/multi-user.md — Abnahme: `tests/graph/multi-user.test.ts`
      (Matrix §17.6, jede Zeile ein Negativtest) und
      `tests/graph/acl.test.ts`
- [x] **M14 Selbstmodell + Einführungsstrecke (§18)**: Modell der Anwendung
      in `graph/meta` — Anwendung (`ow:runtime`, `ow:capability`,
      `ow:availableConnectorKind`, `schema:softwareVersion`/`schemaVersion`)
      und Module (`ow:Module` mit `ow:route`, `ow:entityType`,
      `schema:isPartOf`), beim Start GENERIERT aus der EINEN Code-Quelle
      `src/lib/app/modules.ts` (aus ihr kommt auch die Sidebar); ein Modul
      ohne aktive Runtime-Fähigkeit erscheint nicht. Der **Assistent**
      bezieht seinen Systemkontext aus der SPARQL-Abfrage
      (`GET /api/graph/self-model`, serverseitig gelesen und vom Grant
      geklammert) — die doppelt gepflegte `MODULE_CONTEXT`-Tabelle ist
      gelöscht, ein Test verbietet ihre Rückkehr und erzwingt Registry ↔
      `src/app/**/page.tsx`. **Einführungsstrecke** `/onboarding`: vier
      reale Schritte (Selbstmodell abfragen → eigenen Knoten anlegen →
      prima-materia importieren → Herkunft vergleichen), Fortschritt als
      `ow:OnboardingStep` in `graph/meta` (`prov:used`/`prov:generated`),
      Rückgängig stellt den Vorzustand kanonisch byte-identisch her, ein
      fehlgeschlagener Import gilt nicht als erledigt. Herkunfts-Zählung
      (`GET /api/graph/provenance`) auch als Abschnitt „Herkunft" im
      Graph-Explorer. Dabei repariert: Graphen, die erst zur Laufzeit
      entstehen (Import, Inferenz), bekommen ihre ACL-Standardregeln
      nachgezogen (`ensureGraphAuthorizations` im Anfrage-Kontext) — vorher
      waren sie bis zum nächsten Neustart unsichtbar — Abnahme:
      `tests/graph/self-model.test.ts` und `tests/graph/onboarding.test.ts`
- [x] **Nachtrag: Wikilinks lösten nie auf.** `[[…]]` nennt den Titel des
      Ziels, aufgelöst wurde aber nur gegen den Slug — sobald beide
      auseinanderfielen (Dokument nach dem Anlegen umbenannt), entstand die
      `ow:linksTo`-Kante auf eine IRI ohne Knoten und verschwand in jeder
      Ansicht. Im Bestand betraf das alle vier Dokument-Wikilinks. Der
      Auflösungsindex kennt jetzt Slug *und* Titel (Slug sticht bei
      Gleichstand) — Abnahme: `tests/graph/migrate.test.ts`
- [x] **Nachtrag: Dokumente ohne Frontmatter fielen still heraus.**
      `data/docs/architecture_agents.md` hatte keines und war damit in
      keinem Graphen und keiner Ansicht — sichtbar nur als Datei. Es hat
      jetzt Frontmatter (`sys-doc-004`) und heißt nach seinem Slug
      `architecture-agents.md`, weil die Projektion Dateien so benennt.
      Damit das nicht wiederkommt, prüft `docFromMarkdown` die Pflichtfelder
      (id, slug, title, createdAt, updatedAt) und meldet begründet, was
      übergangen wird, statt es zu verschlucken — Abnahme:
      `tests/graph/workspace-roundtrip.test.ts`
- [x] **Nachtrag: „Bestand" im Graph-Explorer.** Die Herkunfts-Zahlen sind
      Aussagen (Tripel), nicht Knoten — 208 Aussagen sind 23 Knoten. Das
      war als Knotenzahl lesbar und damit irreführend. Jetzt sind sie als
      „Aussagen" beschriftet, und ein eigener Abschnitt nennt sichtbare vs.
      vorhandene Knoten und Kanten; jeder Filter zeigt seine Anzahl

## Kausal-Layer (CAUSAL_LAYER_SPEC, C0–C6 verbindlich — vollständig)

> Die Spec steht in [CAUSAL_LAYER_SPEC](./docs/specs/causal-layer.md) und ist für
> **C0–C6 verbindlich**; C7 (Experimente) und C8 (Sidecar) bleiben opt-in.
> Arbeitsmodus: ein Meilenstein = eine Session = ein Branch = ein PR (§19).
> **Die Liste ist in Baureihenfolge** — der nächste ist der oberste offene
> Punkt, **den eine Session ohne Freigabe beginnen darf**: Die
> Opt-in-Zeile (C7/C8) wird übersprungen, nicht abgehakt und nicht
> angefangen (§19 sagt das seit dem Rückgriff auf die Statistik selbst,
> [docs/spec-widersprueche.md](./docs/spec-widersprueche.md) Eintrag 12).
> C3 steht zuerst und ist erledigt, weil er als einziger
> zeitkritisch war: Home Assistant verwirft Zustandswechsel nach
> `purge_keep_days`, jeder Tag ohne Erfassung war unwiederbringlich.
> **Gebaut sind C3, C0, C1, C2, C4, C5 und C6 — der verbindliche Teil
> dieser Spec ist damit vollständig**, dazu der aus C3 offen gebliebene
> **Backfill aus den Long-Term-Statistics** und die erste Nacharbeit
> darunter (**das Rechenraster an der Frage**). Offen sind nur noch die
> beiden Opt-in-Meilensteine und die übrigen einzeln erledigbaren
> Nacharbeiten. Eine Nacharbeit wird gearbeitet wie ein Meilenstein —
> eine Session, ein Branch, ein PR (§19, seit Widerspruch 14). Alle
> vierzehn Widersprüche, die beim Bauen auffielen, sind in
> [docs/spec-widersprueche.md](./docs/spec-widersprueche.md)
> **entschieden** festgehalten (1–8 aus C3/C4/C5 am 14.08.2026, 9–11 aus
> C6, 12–13 aus dem Statistik-Rückgriff, 14 aus dem Rechenraster); wo die
> Entscheidung den Text betrifft, ist sie in die Spec eingearbeitet. Kein
> Eintrag steht offen.

- [x] **C3 Erfassung („früh materialisieren")**:
      `homeassistant_api: true` im Add-on-Manifest (lesend, begründet in
      DOCS.md); Connector `home-assistant` materialisiert die STRUKTUR
      (Etagen/Bereiche als `schema:Place`, Geräte als `sosa:Platform`,
      Entitäten als `sosa:Sensor`/`sosa:Actuator`, `device_class` als
      `sosa:ObservableProperty`) — Registry über `POST /api/template`, weil
      die REST-API sie nicht kennt; Revision folgt der Struktur, nicht dem
      Messwert. Beobachtungsgrößen als `ow:Variable` in `graph/meta` (Muster
      Retrieval-Profile), Werte NIE im Store, sondern als NDJSON-Tagesdateien
      unter `data/observations/<u>/<id>/` — im Graphen nur Erfassungsregel und
      Abdeckung (`ow:capturedFrom`/`-Through`, `ow:observationCount`).
      Erfassungslauf mit Backfill (14 Tage), Wasserzeichen (idempotent),
      Verdichtung auf festes Raster (Zustände halten an, Lücken bleiben
      Lücken, Summen werden nicht fortgeschrieben, unzulässige Verdichtung
      wird abgelehnt), Aufbewahrung pro Größe; Zeitgeber im Serverprozess
      (`OW_CAPTURE_INTERVAL`, Default 600 s, `0` = aus, `local` hat ihn
      nicht). UI `/graph/observations` mit Aktoren zuerst (Treatment-Seite
      geht zuerst verloren). 11 neue `ow:`-Terme, alles Übrige aus SOSA und
      schema.org (Invariante 8) — Abnahme: `tests/graph/observations.test.ts`
      (Idempotenz, kein Messwert im Store, Lücken, Carry-Forward,
      Fehlerisolation, Backfill-Fenster), `tests/graph/home-assistant.test.ts`
      (Zugangsauflösung, SOSA-Mapping, Topologie, Revision, Quarantäne,
      read-only). Doku: [docs/beobachtungen.md](./docs/beobachtungen.md)
- [x] **C0 Kausalmodell als Graph-Bürger** (SPEC §5, §16): Die kausale
      Kante ist FREMD — `obo:RO_0002411 causally upstream of` aus der OBO
      Relations Ontology (Richtung + zeitliche Vorordnung); Wikidata
      P828/P1542 geprüft und verworfen (nur innerhalb von Wikidata
      definiert, P828 zeigt rückwärts), `prov:wasDerivedFrom` ist
      ausdrücklich keine Kausalität. Eigen sind nur `ow:CausalModel` und
      die drei Annotationen am RDF-1.2-Reifier (§5.3): `ow:edgeClass`
      (vier disjunkte Klassen, Invariante C2), `ow:evidenceLevel`,
      `ow:temporalLag`. Named Graphs `causal/<modelId>` (ein Modell IST
      sein Graph) und `causal-hypotheses`, beide im Snapshot-Layout —
      ein handmodellierter DAG hat keine Quelle, aus der er
      wiederherstellbar wäre. Modellvariablen sind dieselben
      `ow:Variable`-Knoten wie in der Erfassung (C3). SHACL-Shapes in
      `ontology/shapes/causal.ttl`, ausgewertet über den On-demand-Pfad
      (Kausal-Graphen sind jetzt Validierungsziel, bleiben aber aus dem
      OWL-RL-Lauf draußen: eine Annahme ist kein Axiom). Seite
      `/graph/causal` read-only mit DAG-Bild, Herkunfts-Badges und
      SPARQL-Vorlage; angelegt wird ein leeres Modell, die Struktur
      schreibt der Mensch im Editor. Nebenbefund behoben: ein
      erfolgreiches SPARQL-UPDATE schrieb bisher keinen Snapshot — alles
      per SPARQL Geschriebene war nach dem Neustart weg.
      Abnahme: `tests/graph/causal.test.ts` (fremdes Vokabular, von Hand
      modellierter DAG per SPARQL abfragbar, Herkunft je Kante, Hypothesen
      getrennt, Shapes melden erfundene Klasse/kaputten Versatz/fehlende
      Herkunft, Layout-Blacklist hält, Modell überlebt den Neustart) +
      Ontologie-CI. Doku: [docs/kausalmodell.md](./docs/kausalmodell.md)
- [x] **C1 Identifikation** (SPEC §7 Tier 1): Der Tier-1-Kern liegt in
      `src/lib/graph/causal/{dag,dsep,identify}.ts` und ist **pur** —
      kein Store, kein Netz, keine Route; ein Test erzwingt das, und der
      DAG-Editor rechnet damit im Browser. Enthalten: Azyklizität mit
      Zeugen-Zyklus, topologische Ordnung, D-Separation (moralisierter
      Vorfahrengraph) plus implizierte Unabhängigkeiten, Pfad-Aufzählung
      für die Erklärung (gedeckelt, meldet Deckelung), das
      **Adjustment-Kriterium** (Shpitser/van der Zander) statt des
      engeren Backdoor-Kriteriums, kanonische Menge als Entscheider,
      minimale Adjustment Sets, Frontdoor über beobachtbare Mediatoren
      und Instrumentvariablen (auch bedingte). **Beobachtbar heißt
      erfasst** (C3): Daraus entsteht die Antwort „nicht identifizierbar,
      weil die Außentemperatur nicht erfasst wird" — und getrennt davon
      die Auskunft, ob die Struktur eine Antwort hergäbe. Keine
      Schätzung, keine Zahl (das bleibt C4).
      Mit erledigt, wie nach C0 entschieden:
      - `capabilities.causalTier` (Invariante C9) steht auf `graph` in
        `server` und `local` — Tier 1 ist pur und läuft überall; `full`
        gäbe es erst mit dem Sidecar (C8), und der ist nicht gebaut
      - Schreibziele aus **Scope-Mustern** (`authz/grant.ts`,
        `PROSPECTIVE_WRITE_SCOPES`): `causal/*` und `causal-hypotheses`
        im eigenen Namensraum dürfen als NEUER Graph entstehen — die
        verallgemeinerte Fassung der Bootstrap-Ausnahme für
        workspace/public/presentation. Ein vorhandener Graph bleibt allein
        Sache von `graph/acl`; fremde Namensräume, Systemgraphen, anonyme
        und verengte Zugänge sind gesperrt, je mit Negativtest
      - Modell-Revisionen: `prov:Activity` pro Änderung IM Modell-Graphen
        plus `schema:version` am Modell (Anlage = Revision 1)
      - DAG-Editor auf `/graph/causal`: Variablen aufnehmen (erfasste
        Größe oder reine Modellvariable), Kanten mit Herkunft und
        Zeitversatz ziehen und entfernen; eine Kante, die einen Kreis
        schließt, wird mit dem Kreis im Klartext abgelehnt; SHACL läuft
        vor dem Schreiben und blockiert nur NEUE Verstöße
      Abnahme: `tests/graph/causal-identification.test.ts` (Lehrbuch-DAGs:
      Konfundierung, Kette, Collider, M-Bias, Frontdoor, Instrument,
      kein Wirkweg, Zyklus; „nicht identifizierbar" mit Namen der
      fehlenden Variablen; Browser-Tauglichkeit als Import-Test; Laufzeit
      bei 40 Störgrößen) und `tests/graph/causal-editor.test.ts`
      (Schreibweg, Revisionen, Zyklus-Ablehnung, Scope-Muster mit fünf
      Negativtests, Brücke Modell → DAG). Doku:
      [docs/kausalmodell.md](./docs/kausalmodell.md)
- [x] **C2 Causal Path Tracing** im Retrieval (SPEC §9, Erweiterung von
      GRAPH_CORE_SPEC §7.5 um `causal`-Feld): Keine zweite Pipeline —
      dieselben vier Phasen, drei Änderungen. Der Trace
      (`src/lib/graph/causal/trace.ts`) ist **pur** wie der übrige
      Tier-1-Kern (Import-Test erzwingt es) und kennt vier Modi
      (`ancestors`, `descendants`, `paths`, `markov-blanket`);
      Seed-Score ist die **kausale Nähe** `1/(1+Schritte)` statt der
      Wortähnlichkeit; der Modell-Graph kommt in den Traversal-Raum
      (Bestand und Grant klammern ihn), sodass die kausalen Kanten selbst
      begehbar sind; ein **Tor** in der Expansion hält Modellgrößen
      draußen, die nicht zur Frage gehören — auch über den semantischen
      Umweg. `explain.causal` trägt Modell samt Revision, Frage, Wege mit
      Richtung und Offenheit, Adjustierung und jeden herausgefallenen
      Knoten mit Grund (`d-separated`, `blocked-path`, `off-chain`); der
      linearisierte Kontext beginnt mit demselben Vorspann („die Kette,
      nicht die Wolke"). Erdung schlägt fehl → **leeres** Ergebnis mit
      Begründung statt eines semantischen, das kausal aussieht; das
      Modell wird nie geraten (genau eines → gemeint, mehrere → gefragt).
      Dazu: `causal` im MCP-Werkzeug `graph_retrieve` und in
      Retrieval-Profilen, `minEvidence` über die Belegstands-Ordnung
      (bis C4 hat keine Kante mehr als „behauptet" — das sagt der
      Hinweis), und im Graph-Explorer der Abschnitt „Kausaler Pfad", der
      das Bild durch die Kette ersetzt (nur bei passendem
      `causalTier`, Invariante C9).
      Abnahme: `tests/graph/causal-retrieval.test.ts` — `explain` trägt
      den kausalen Pfad (Wirkweg mit Richtung, Rolle und Weg je Knoten,
      Vorspann im Kontext); d-separierte Knoten fallen bei gegebener
      Konditionierung nachweislich raus (Zeitschaltuhr verschwindet samt
      ihrer Notiz, sobald über die Nachtabsenkung adjustiert wird —
      Gegenprobe ohne Adjustierung), dazu Collider-Öffnung, Tor gegen den
      semantischen Umweg, Grant-Klammer (C6) und Determinismus.
      Doku: [docs/kausalmodell.md](./docs/kausalmodell.md)
- [x] **C4 Schätzung + Refutation** (SPEC §13.1/13.2): Hier entsteht die
      erste **Zahl** — und nur unter Bedingungen. Der Tier-1-Kern bleibt
      pur (`causal/{numeric,panel,estimate,refute,study}.ts`, per Test
      erzwungen) und rechnet damit in allen drei Runtimes:
      - **Fünf Schätzer**: Stratifikation, Regression mit Adjustierung,
        IPW (logistische Propensity, Hájek-Gewichtung, Beschneidung bei
        dünnem Overlap), Difference-in-Differences und Interrupted Time
        Series. Ohne Vorgabe wählt der Lauf nach einer nachlesbaren Regel.
      - **Konfidenz aus dem Moving Block Bootstrap**, nie aus der
        Lehrbuchformel (§15.2): Beobachtungsreihen sind autokorreliert,
        ein klassischer Standardfehler wäre systematisch zu klein.
      - **Panel statt Zeitreihen** (`panel.ts`): gröbstes Raster
        (verfeinern hieße Werte erfinden), listenweiser Ausschluss bei
        Lücken je Größe gezählt, Zeitversatz der Kante angewandt,
        Positivität geprüft und berichtet (§15.3).
      - **Sechs Refutationen**: Placebo (rotiert statt permutiert — eine
        Permutation zerstörte die Autokorrelation), zufällige gemeinsame
        Ursache, Teilmengen-Stabilität über zusammenhängende Fenster,
        Negativkontrolle aus dem DAG und die implizierten bedingten
        Unabhängigkeiten gegen die Daten (§13.2, Bonferroni) — dazu der
        E-Wert als Kennzahl, die nie blockiert. „Nicht prüfbar" gilt
        **nicht** als bestanden.
      - **Vier Ausgänge, drei ohne Zahl**: `not-identifiable`,
        `not-estimable` (auch bei Frontdoor/IV — identifiziert, aber in
        Tier 1 nicht gerechnet, und das wird gesagt statt ersatzweise
        etwas anderes auszugeben), `refuted`, `passed`.
      - **Frage und Antwort getrennt**: `ow:Estimand` in `graph/meta`
        (bleibt), `ow:CausalStudy` in `graph/<u>/inferred/causal/workspace`
        (bei jedem Lauf vollständig ersetzt, Invariante C4 + Invariante 3).
        Damit der Replace kein Verlust ist, rechnet ein Lauf **alle**
        Fragen neu.
      - **Der Effekt hängt am Reifier der Kante** (§5.3), nur im
        Inferenz-Graphen; beim Lesen wird er über das Modell gelegt. Erst
        dadurch greift `minEvidence` aus C2 wirklich. Ohne Kante
        (Wirkung über mehrere Schritte) trägt ein studieneigener Knoten
        die Zahl — eine Kante zu erfinden wäre Struktur-Behauptung.
      - **Signatur erzwungen** (C7): Modell-Revision, Startwert,
        Softwareversion, Zeitpunkt, Datenfenster, Zeilenzahl und je
        Eingabe die eingefrorene Erfassungsregel. Geprüft doppelt — im
        Code und in den Shapes; was durchfällt, wird nicht geschrieben,
        sondern gemeldet. Schärfste Regel: eine Effektstärke ohne
        `ow:refutationPassed true` ist ein SHACL-**Verstoß** (C5).
      - **Scope-partitioniert** (C6): Beobachtungen sind privat, also
        bleibt der öffentliche Kausal-Inferenz-Graph leer; ein verengter
        Zugang sieht an einer Kante keinen Effekt.
      - 4 Klassen und 18 Eigenschaften neu im `ow:`-Namensraum, alles
        Übrige aus PROV und schema.org (Invariante 8/C8).
      - UI auf `/graph/causal`: Frage stellen, alle Fragen rechnen,
        Ergebnis mit DAG, Effekt, Konfidenzintervall, Refutations-Badges
        und Signatur — Fragen und Ergebnisse stehen IM Modell, nie
        daneben (Invariante C1).
      Abnahme: `tests/graph/causal-estimation.test.ts` (bekannter Effekt
      aus synthetischen Daten korrekt geschätzt, mit und ohne Adjustierung
      nachweislich verschieden; „nicht identifizierbar" mit Namen der
      fehlenden Störgröße; durchgefallener Effekt erscheint weder in der
      Rückgabe noch im Graphen; vollständiger Replace; Panel-Regeln; DiD
      und ITS; C6-Negativtests; C7-Signatur; Reinheit des Kerns).
      Doku: [docs/kausalmodell.md](./docs/kausalmodell.md)
- [x] **C5 Open-Data-Connector** `rest-timeseries` (SPEC §10/§11): Die
      Störgrößen der Hausdomäne über den EINEN Connector-Vertrag — kein
      zweiter Import-Pfad, keine Sonderpipeline.
      - **Der Connector materialisiert die Angebotsseite, nie den Wert**
        (Invariante C3): welche Größen die Quelle liefert, in welcher
        Einheit, an welchem Ort, mit welchem Skalenniveau — als SOSA in
        den Import-Graphen, genau wie `home-assistant` in C3. Revision
        folgt der Struktur, nicht der Zahl (andere Werte = No-Op); eine
        beschriebene, aber nicht gelieferte Größe wird quarantäniert
        statt behauptet. Dass §10 diesen Connector „materialize" nennt
        und trotzdem keine Reihe schreiben darf, ist als Widerspruch
        festgehalten (docs/spec-widersprueche.md, Eintrag 5)
      - **Die Abbildung ist deklarativ und pur**
        (`connectors/rest-timeseries/mapping.ts`) und kennt die drei
        Formen, in denen offene Kataloge liefern: `points`
        (Datensatzliste), `columns` (parallele Arrays) und `intervals`
        (Zeitspannen mit einem Wert **außerhalb** — ohne den bestünde
        eine Feiertagsreihe nur aus Einsen). Dazu Fenster-Zerlegung,
        Einheiten-Umrechnung, Filter je Datensatz (Bundesland),
        Drosselung je Host und ein Zwischenspeicher: Bright Sky liefert
        acht Größen in EINEM Dokument, und die Erfassung holt es einmal
      - **Confounder-Katalog** als Vorlagen: Wetter (DWD über Bright
        Sky), Strompreis (EPEX Spot über aWATTar), Einstrahlung
        (Open-Meteo), Feiertage (Nager.Date) — dazu `custom` für eine
        eigene JSON-/CSV-API ohne neuen Code. „Sonnenstand" aus §10
        liefert der Katalog als **Einstrahlung** — den atmosphärischen
        Teil; den geometrischen rechnet seit der Entscheidung vom
        14.08.2026 der Connector `solar-position`
        (docs/spec-widersprueche.md, Eintrag 4)
      - **Die Erfassung ist quellenagnostisch geworden**
        (`observations/sources.ts`): Die Quellart steht an der Größe und
        wird aus dem Import-Graphen abgeleitet — der Sensor liegt im
        Graphen genau des Connectors, der ihn materialisiert hat. Eine
        unerreichbare Quellart legt nur ihre eigenen Größen still; ein
        fehlender Home-Assistant-Zugang lässt die Wetterreihen laufen
        (vor C5 riss er den ganzen Lauf mit)
      - **Der Adjustierungs-Kontrast** ist der Nachweis: Ein Lauf mit
        Adjustierung rechnet dieselbe Frage ein zweites Mal ohne sie —
        auf DEMSELBEN Panel, mit demselben Verfahren und demselben
        Startwert, sonst wäre die Differenz nicht der Adjustierung
        zuzuschreiben. Der rohe Wert ist ein **Zusammenhang, keine
        Wirkung**: eigene Terme (`ow:ConfoundingContrast`,
        `ow:crudeAssociation`, `ow:crudeCiLow/-High`,
        `ow:confoundingShift`), nie `ow:effectSize` — dieser Term zöge
        per SHACL die bestandene Refutation nach sich (Invariante C5).
        Warum die Abnahme wörtlich gelesen zwei gleichrangige Ergebnisse
        verlangte: docs/spec-widersprueche.md, Eintrag 6
      - Nebenbefund behoben: Das Formular unter Graph → Quellen zeigte
        für `home-assistant` die GitHub-Felder und legte stillschweigend
        eine Supervisor-Verbindung an
      Abnahme: `tests/graph/open-data.test.ts` — die geforderte
      Gegenprobe über die ganze Kette (Connector anlegen → Struktur
      importieren → Störgröße aus der Kandidatenliste aufnehmen → Werte
      erfassen → rechnen): vorher „nicht identifizierbar, weil die
      Außentemperatur nicht erfasst wird", nachher die wahre Wirkung
      **und** daneben der rohe Zusammenhang, der Heizen wirkungslos
      aussehen lässt, samt Erklärung der Differenz. Dazu: drei
      Reihenformen, kein Messwert im Store, Revision an der Struktur,
      Zwischenspeicher, Quarantäne, Fehlerisolation zwischen Quellarten.
      Doku: [docs/kausalmodell.md](./docs/kausalmodell.md),
      [docs/beobachtungen.md](./docs/beobachtungen.md)
- [x] **Widersprüche der Spec entschieden** (14.08.2026,
      [docs/spec-widersprueche.md](./docs/spec-widersprueche.md)) — drei
      davon brauchten Code:
      - **Eine berechnete Größe IST eine Beobachtung** (Eintrag 4): Der
        Connector `solar-position` rechnet Sonnenhöhe, Azimut, Tag/Nacht
        und die extraterrestrische Einstrahlung aus Ort und Zeit
        (Astronomical Almanac, Fehler unter 0,01°) — ohne Netz, ohne
        Lücken, über den EINEN Connector-Vertrag. Ehrlich bleibt sie durch
        das Verfahren im Graphen (`ssn:implements` → `sosa:Procedure`);
        Refraktion, Parallaxe und jedes Atmosphärenmodell fehlen bewusst
      - **`csv-observations` gebaut** (Eintrag 7): der Datei- statt des
        Netz-Wegs. Pfad-Politik wie `obsidian-vault`, Skalenniveau je
        Spalte aus dem **Bestand** statt aus dem Spaltennamen, Revision =
        Inhalts-Hash
      - **Die Studien-Chronik** (Eintrag 3): `graph/<u>/causal-archive`
        hält fest, was eine Frage wann gesagt hat — behauptet und
        persistiert, weil ein Lauf ein **Ereignis** ist und kein
        abgeleiteter Zustand. Der Effekt eines Eintrags hängt NIE am
        Reifier der Kante, eingetragen wird nur eine Änderung (Urteil,
        Modell-Revision oder Effekt außerhalb des letzten Intervalls), und
        beantwortet wird eine Frage weiterhin nur aus dem Inferenz-Graphen.
        Ein Eintrag lässt sich **verwerfen** (`DELETE
        /api/graph/causal/archive/<id>`, Knopf in der Chronik): Ein Lauf
        auf falsch erfassten Daten ist keine Geschichte, sondern Störung —
        wer ihn nicht loswird, hört auf hinzuschauen. Geändert wird ein
        Eintrag nie, sonst stünde dort etwas, das so nie gerechnet wurde
      - Ohne Code entschieden: getrennte Terme für Identifikation und
        Verfahren (Eintrag 1), `schema:unitText` statt QUDT (Eintrag 2),
        „materialize" heißt Angebotsseite (Eintrag 5), der rohe
        Zusammenhang ist kein zweites Ergebnis (Eintrag 6)
      Abnahme: `tests/graph/causal-archive.test.ts` (Chronik: erster Lauf,
      unveränderter zweiter, geänderte Revision, Effekt nicht am Reifier,
      Neustart) und die Sonnenstand-/CSV-Abschnitte in
      `tests/graph/open-data.test.ts` (bekannte Sonnenstände, Nacht ohne
      Rest-Einstrahlung, Verfahren im Graphen, lückenlose Erfassung;
      Skalenniveau aus dem Bestand, Kopfzeile als Wahrheit, Pfad-Politik)
- [x] **C6 Neurosymbolische Schleife** (SPEC §8): „Das LLM schlägt vor,
      die Symbolik richtet, die Daten entscheiden" — und die Trennung ist
      an den Named Graphs ablesbar. Vorschläge gehen ausschließlich nach
      `graph/<u>/causal-hypotheses`, gesetzte Struktur bleibt im
      Modell-Graphen, und dazwischen liegt genau EIN Weg, der prüft.
      - **Drei Quellen, je mit eigener Herkunft** (`propose.ts`, pur):
        `llm` (Kandidatenkanten und vor allem **Störgrößen** aus Namen,
        Einheiten, Orten, Quellarten — Kantenklasse `hypothesis`),
        `topology` (Aktor → Sensor am selben Gerät oder im selben Bereich
        aus der Registry, deterministisch, ohne Netz — `structural`) und
        `wikidata` (P828/P1542 zwischen den **Größenarten**, über die
        Föderation aus M11, ohne Import — `hypothesis`). Die Klasse hängt
        an der Quelle und ist nicht wählbar, sonst könnte ein Vorschlag
        sich als Struktur ausgeben (Invariante C2). Wikidata zu **lesen**
        ist die Gegenprobe zu C0, wo P828/P1542 als eigenes Kantenvokabular
        geprüft und verworfen wurden
      - **Herkunft ist Pflicht**: `prov:wasAttributedTo` auf einen
        `prov:SoftwareAgent` je Modell und Quelle, mit dem benutzten
        Sprachmodell (`schema:name`) und der Prompt-Version
        (`schema:softwareVersion`) — §8 wörtlich. Ein Vorschlag ohne
        Agenten fällt durch die Shapes. **Ein Reifier je Quelle, nicht je
        Kante**: Zwei Quellen auf demselben Triple sind zwei benannte
        Reifier (RDF 1.2, §5.3), und daraus entsteht der Quellenvergleich
        ohne Nebentabelle
      - **Die Filter in der Reihenfolge aus §8** (`filters.ts`, **pur** wie
        der übrige Tier-1-Kern, per Test erzwungen): `cycle` (mit dem Kreis
        im Klartext), `shacl` (im Schreibpfad, weil es die Shapes braucht),
        `temporal`, `topology` — und als fünfter die Identifizierbarkeit,
        die **nicht verwirft**, sondern das Urteil `open` samt fehlender
        Größe erzeugt. Der erste, der greift, entscheidet
      - **Der eine Weg ins Modell**: Übernehmen prüft das Urteil
        **serverseitig** — eine Regel, die nur im Client steht, ist keine.
        Eine noch nicht modellierte Störgröße wird dabei mit aufgenommen
        (§8 hält Confounder-Vorschläge für den wertvolleren Teil), jeder
        Schritt schreibt eine Revision. Der Vorschlag bleibt danach stehen
        und ist als „übernommen" markiert — löschen hieße Herkunft
        verlieren
      - **Ein Lauf ersetzt seine eigene Quelle** (§6.2-Muster): Wer nur das
        Sprachmodell laufen lässt, verliert die topologischen Vorschläge
        nicht. Eine Quelle, die ausfällt, legt die anderen nicht still
        (Fehlerisolation wie C5); unbrauchbare LLM-Antworten landen einzeln
        in der Quarantäne wie bei jedem Connector. Vorschläge sind
        behauptet und persistiert — ein Sprachmodell-Aufruf wird nicht
        zweimal bezahlt
      - **Der Quellenvergleich** (`compare.ts`) liest, was ohnehin im
        Graphen steht; Widersprüche stehen oben, weil §8 sie „den
        interessanten Fall" nennt. Das gesetzte Modell zählt als vierte
        Stimme. Die **fehlende** Quelle wird benannt statt erfunden
      - Nebenbefund behoben: `sosa:observes` zeigt seit Widerspruch 8 vom
        Sensor auf die Variable, wurde beim Lesen aber unter den Quads MIT
        der Variablen als Subjekt gesucht — wo sie nie stehen kann. Weil
        der Schreibpfad die Quads aus dem Lesemodell neu baut, verlor jedes
        `saveVariable` die Kante zur Messquelle still, und mit ihr Ort,
        Gerät und Größenart
      Abnahme: `tests/graph/causal-hypotheses.test.ts` — die beiden
      geforderten Sätze je als eigener Test: ein verworfener Vorschlag
      wird beim Übernehmen abgelehnt (der Studien-Pfad bleibt ihm
      verschlossen), und ein temporal unmöglicher Vorschlag (Ursache erst
      ab Mai erfasst, Wirkung nur bis Februar) wird im Lauf selbst
      verworfen. Dazu: die vier harten Filter einzeln, die konstruktive
      Antwort bei fehlender Störgröße, Purität der Filter, Quarantäne
      erfundener Größen, Fehlerisolation zwischen Quellen, Wikidata über
      einen Stub-Endpoint, Übereinstimmung und Widerspruch im Vergleich,
      die Shapes und die Persistenz. Doku:
      [docs/kausalmodell.md](./docs/kausalmodell.md)
- [x] **Drei weitere Widersprüche der Spec entschieden** (C6,
      [docs/spec-widersprueche.md](./docs/spec-widersprueche.md),
      Einträge 9–11; in die Spec eingearbeitet):
      - **§8 verlangt drei Strukturquellen, eine davon ist C8** (9):
        Struktur-Lernen aus Daten steht in §16 unter C8 und darf nach §19
        ohne Freigabe nicht angefangen werden. Gebaut sind `llm`,
        `topology` und `wikidata`; die fehlende Quelle wird im Vergleich
        **benannt**, `learned` bleibt leer. Eine erfundene dritte Stimme
        wäre schlechter als zwei ehrliche
      - **Identifizierbarkeit als Filter widerspricht Invariante C1** (10):
        Sie hängt an der Datenlage, nicht an der Struktur — eine Ablehnung
        ließe die Daten über die Annahme entscheiden. Sie erzeugt deshalb
        das Urteil `open` statt `rejected`; die Abnahme bleibt erfüllt,
        weil C4 für einen nicht identifizierbaren Effekt ohnehin
        `not-identifiable` zurückgibt statt einer Zahl
      - **„Temporal maschinell entscheidbar" — wie weit?** (11): Aus
        Zeitstempeln allein folgen das Vorzeichen des Zeitversatzes und die
        Abdeckung, nicht die Richtung der Wirkung. Die aus Korrelationen zu
        erschließen wäre Struktur-Lernen (C8) — und bei zwei Größen mit
        gemeinsamer Ursache schlicht falsch
- [ ] *Opt-in, nicht ohne ausdrückliche Freigabe*: **C7 Experimente**
      (randomisierte Automationen, SPEC §13.3 samt Leitplanken C10) und
      **C8 Tier-2-Sidecar** (DoWhy/EconML/causal-learn, Struktur-Lernen,
      Föderation von Kausalmodellen)
- [x] **Backfill aus den Long-Term-Statistics** (stündliche Aggregate,
      unbegrenzt aufbewahrt; offen geblieben aus C3): Der Bestand wächst
      nach hinten — über die **WebSocket-API**
      (`recorder/statistics_during_period`), die die REST-API nicht kennt.
      Der Kanal ist so schmal wie möglich (öffnen, anmelden, ein Kommando,
      schließen — kein Abonnement, keine Wiederverbindung) und läuft unter
      derselben SSRF-Politik wie der HTTP-Abruf: nur ws(s), keine privaten
      Ziele ohne `ALLOW_LOCAL_TOOL_URLS=1`. Als **einmalige, angeforderte
      Handlung** je Größe (`POST /api/graph/observations/<id>/backfill`,
      Knopf „Aus Statistik nachfüllen"), nicht als zweiter Erfassungslauf:
      Vor dem Bestand entsteht nichts Neues mehr. Die Regeln, jede gegen
      eine bestimmte stille Unwahrheit: **ein Aggregat je Stunde bleibt
      ein Punkt je Stunde** (Verfeinern erfände elf von zwölf Messungen und
      bliese jede Fallzahl auf), **ein Tag mit Messpunkten wird nie
      angefasst** (der feine Bestand hat Vorrang, keine Datei mischt
      beides), das Fenster endet dort, **wo die Erfassung noch selbst
      hinkommt**, **nur numerische Größen** (die Ursachenseite steht in der
      Statistik nicht — deshalb ändert der Rückgriff nichts an der
      Dringlichkeit der Erfassung), **Summen abgelehnt** (das Feld `sum`
      ist ein fortlaufender Zählerstand, keine Intervallsumme), und das
      Feld folgt der Verdichtung der Größe statt ersatzweise ein anderes zu
      nehmen. Die nachgefüllte Strecke wird **benannt** statt verschwiegen:
      drei neue `ow:`-Terme (`aggregatedFrom`, `aggregatedThrough`,
      `aggregateInterval`) plus eigener `prov:Activity`-Knoten, damit der
      nächste Erfassungslauf sie nicht überschreibt. Abnahme:
      `tests/graph/observations-backfill.test.ts` (Protokoll samt
      abgewiesenem Token, Zeitstempel in drei Schreibweisen, Feldwahl,
      Speicher füllt nur leere Tage, Fenstergrenze, Idempotenz, kein
      Messwert im Graphen, ws-Politik). Doku:
      [docs/beobachtungen.md](./docs/beobachtungen.md)

### Nacharbeiten aus C5 und C6 (kein Meilenstein, einzeln erledigbar)

> Nichts davon blockiert etwas. Es sind die Kanten, die beim Bauen von C5
> und C6 und beim Auflösen der Widersprüche sichtbar geworden sind — in
> Reihenfolge ihres Nutzens. **Jede einzelne ist eine Session, ein Branch,
> ein PR** (§19); ihre Abnahme steht in ihrem eigenen Eintrag, weil §16
> für Nacharbeiten keine Zeile hat (docs/spec-widersprueche.md,
> Eintrag 14). Die oberste ist abgehakt; die nächste ist die oberste
> offene darunter.

- [x] **Studien auf grobem Raster rechnen lassen.** Das Panel liest einen
      Wert nur so lange, wie das Raster SEINER Reihe reicht — eine Größe im
      Fünf-Minuten-Raster trägt in der aus Stundenaggregaten nachgefüllten
      Strecke deshalb nur die vollen Stunden bei, der Rest fällt als Lücke
      heraus. Das ist die konservative Seite (verlieren statt erfinden),
      kostet aber elf von zwölf Zeilen. Gebaut ist das Raster an der Frage
      (`ow:studyInterval` am `ow:Estimand`, ein neuer Term), das
      `PanelOptions.intervalSeconds` füllt — dann rechnet eine Frage über
      die alte Strecke bewusst stündlich. Der Stundenwert wird dabei NICHT
      fortgeschrieben (das bliese die Fallzahl aufs Zwölffache, ohne dass
      eine Beobachtung dazukäme): Die Toleranz bleibt das Raster jeder
      einzelnen Reihe, gefragt wird nur seltener. Vier Regeln tragen es:
      - **Feiner als die gröbste beteiligte Reihe wird abgelehnt**, nicht
        stillschweigend angehoben — sonst trüge die Studie ein Raster, nach
        dem niemand gefragt hat, und Zeilen, die niemand gemessen hat
      - **Dasselbe Raster gilt für das breite Panel** der Refutationen;
        ein anderes hieße, die Zahl auf anderen Daten zu widerlegen als sie
        entstanden ist
      - **Das Raster ist Signatur** (C7): Es steht an der Frage, an der
        Studie und in der Chronik — auch wenn es aus der gröbsten Reihe kam.
        Eine Zeilenzahl ohne ihr Raster ist eine Zahl ohne Maßstab
      - **Ein leeres Panel nennt den Ausweg**: Wo jede Zeile an einer Lücke
        gescheitert ist, steht das gerechnete Raster im Klartext dabei; die
        Oberfläche zeigt zusätzlich je Frage, welche beteiligte Größe eine
        nachgefüllte Strecke hat und welches Raster diese braucht
      Abnahme: `tests/graph/causal-study-interval.test.ts` (die alte Strecke
      ist auf dem feinen Raster unerreichbar und auf dem gesetzten
      vollständig; elf von zwölf Rasterpunkten als Lücke nachgewiesen; die
      alten Zeilen sind Wert für Wert die gemessenen Stundenwerte;
      Ablehnung des zu feinen Rasters; Frage, Lauf und Shapes). Doku:
      [docs/kausalmodell.md](./docs/kausalmodell.md) und
      [docs/beobachtungen.md](./docs/beobachtungen.md)

- [ ] **Der Vorschlagslauf sieht keine Dokumente.** §8 nennt als Quellen
      für das Sprachmodell „Dokumente, HA-Entitätsnamen, Automations-YAML,
      Chats und importierte Quellen". Im Prompt stehen bisher nur die
      Größen samt Einheit, Ort und Quellart. Der nächstliegende Schritt ist
      das **Automations-YAML**: Es sagt, was heute schon wen schaltet, und
      das ist ein Prior in derselben Qualität wie die Geräte-Topologie —
      dafür braucht es allerdings die HA-Config-API, die der Connector
      heute nicht liest. Dokumente und Chats liegen bereits im Graphen und
      wären über das Retrieval (M8) erreichbar; was fehlt, ist die
      Entscheidung, wie viel Kontext ein Vorschlagslauf kosten darf
- [x] **Vorschläge je Quelle einzeln anstoßen.** Der Lauf ersetzt je
      Quelle, die Oberfläche bot aber nur „alle drei" an — wer nach dem
      Umzug eines Geräts bloß die Topologie neu ableiten wollte, zahlte
      einen Sprachmodell-Aufruf mit. Die Wahl steht jetzt über dem Knopf,
      voreingestellt auf alle drei; ohne gewählte Quelle bleibt er aus.
      Was in den Body kommt, entscheidet eine reine Funktion neben den
      Quellen (`proposalRunBody`), damit zwei Dinge nicht verrutschen: die
      **Reihenfolge** (der Lauf hält sie ein, die Klickfolge nicht) und die
      Bedeutung von **„alles"** — vollständig gewählt fährt die Anfrage
      OHNE `sources` und trifft die Voreinstellung der Route statt einer
      zufällig identischen Liste. Abnahme:
      `tests/graph/causal-hypotheses.test.ts` (einzelne Quelle,
      Vollauswahl ohne Liste, Reihenfolge, leere Auswahl ohne Lauf); dass
      eine Quelle nur ihre eigenen Vorschläge ersetzt, steht dort seit C6
- [ ] **Wikidata trifft selten.** Gefragt wird über die `device_class` als
      englisches Label; wo Home Assistant keine setzt, gibt es keinen
      Suchbegriff, und geraten wird nichts. Eine gepflegte Abbildung
      `device_class` → Wikidata-Q-ID wäre der ehrliche Weg — sie gehört
      dann in den Graphen und nicht in eine Konstante im Code

- [ ] **Weitere Vorlagen aus dem §10-Katalog**: SMARD/ENTSO-E
      (Erzeugungsmix, Netzlast), UBA Luftdaten / Sensor.Community / OpenAQ
      (Außenluftqualität als Confounder für Lüftungsfragen), Destatis
      GENESIS / Eurostat (Vergleichsgruppen), GTFS/DELFI (Mobilität und
      Anwesenheit). Alle vier gehen heute schon als `custom`-Abbildung —
      was fehlt, ist die Vorlage mit ihren Parametern und der Angabe, wozu
      die Quelle im Modell taugt
- [ ] **Aufbewahrung der Chronik**: Sie wächst nur bei Änderung, aber
      unbegrenzt. Eine Regel (Höchstzahl je Frage oder Alter) fehlt —
      solange sie klein bleibt, ist das kein Problem, aber es wird eines,
      wenn eine Frage jahrelang läuft
- [ ] **Chronik-Vergleich**: zwei Einträge nebeneinander, mit der
      Differenz und ihrer wahrscheinlichen Ursache (andere Revision,
      anderes Datenfenster, andere Adjustierung). Heute steht die Liste
      da, den Vergleich macht der Mensch im Kopf
- [ ] **Einheiten für CSV-Spalten**: Eine Datei sagt nicht, ob eine Spalte
      Kilogramm oder Kilowattstunden trägt. Heute bleibt die Einheit leer;
      eine Angabe je Spalte in der Connector-Konfiguration wäre die
      ehrliche Ergänzung (raten wäre es nicht)
- [ ] **Formular statt JSON für eigene Quellen**: Die `custom`-Abbildung
      des `rest-timeseries`-Connectors ist im UI ein Textfeld mit JSON.
      Für den Fall „eine API, die dem Katalog fehlt" ist das zumutbar,
      schön ist es nicht
- [ ] **Live-Test gegen die echten Quellen**, opt-in wie
      `OW_FEDERATION_LIVE=1` bei Wikidata: Bright Sky, aWATTar,
      Open-Meteo und Nager.Date antworten heute in den Tests nur als
      Stub. Ein Vertragsbruch der Anbieter (umbenanntes Feld, geänderte
      Struktur) fiele erst im Betrieb auf
- [ ] **Erfassung in `local`**: `solar-position` und `csv-observations`
      brauchen weder Netz noch Serverprozess und wären damit die einzigen
      Quellarten, die im Browser vollständig liefen. Was fehlt, ist der
      Beobachtungs-Speicher über OPFS und ein Zeitgeber — hängt an der
      großen `local`-Baustelle (siehe unten)
- [ ] **Sonnenstand: abgeleitete Zeitpunkte** (Sonnenauf- und -untergang,
      Tageslänge) als eigene Reihen. Heute gibt es Höhe, Azimut,
      Tag/Nacht und die extraterrestrische Einstrahlung; Zeitpunkte
      wären eine Nullstellensuche über dieselbe Funktion. Nur bauen, wenn
      eine Frage sie braucht

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
- [x] Graph (/graph + /graph/sparql|connectors|federation|access): Explorer
      mit Filtern, Herkunft und Reasoning-Panel, SPARQL-Editor,
      Connector-Verwaltung, Föderation, Zugriff & Freigaben
- [x] Einführung (/onboarding): geführte Strecke durch den eigenen Graphen
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
      Download-Fortschritt und Cache-Status (offline-fähig); Modell-Liste
      auf dem Stand des mitgelieferten Builds inkl. der Modelle mit
      Tool-Calling-Freigabe, plus durchsuchbarer Voll-Katalog
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
- [x] **CopilotKit: Stack entfernt** (Entscheidung zu Analyse §5 P0.3).
      Er rendert keine Oberfläche, sein Runtime-Endpunkt hing an einem
      hartkodierten Ollama/OpenAI vorbei am AI-Hub, und zwei seiner fünf
      Actions sprachen einen Vertrag, den die Routen seit M5 nicht mehr
      haben. Die beiden tragenden Actions leben als Builtins im EINEN
      Tool-Loop weiter: `workspace_create_task` und
      `workspace_update_task`, auf Server- und Browser-Pfad, mit den
      Zod-Schemas der Routen und im AI-Spiegel des Graphen. Nicht
      übernommen und benannt statt stillschweigend fallengelassen:
      `navigate` (reiner Client-Effekt, bräche die Symmetrie der Engine)
      und `createCanvasCard` (sein Body wird seit M5 abgelehnt; eine
      korrekte Fassung bräuchte eine Canvas-Auflistung, die der Tool-Loop
      nicht hat). Abnahme: `tests/ai/workspace-tools.test.ts`,
      `tests/graph/agents-skills-tools.test.ts`

## Sicherheit & Datenqualität

- [x] Zod-Validierung aller schreibenden API-Routen
- [x] Atomare JSON-Writes + Dateilocks, defensives Lesen mit Quarantäne
- [x] Path-Traversal-Fix, Upload-Härtung (Allowlist, Magic Bytes, 10 MB), SVG-XSS entschärft
- [x] Credentials: kein Ciphertext-Leak, WORKSPACE_MASTER_KEY-Option, Keyfile 0600
- [x] API-Key nur serverseitig (LLM_API_KEY)
- [x] Tool-Executor: SSRF-Schutz, Timeout, JSON-sichere Platzhalter
- [x] Identität aus der Umgebung (`OW_AUTH_MODE`: ha-ingress, proxy-header,
      oidc-bearer mit JWKS-Prüfung) — ohne geprüfte Identität ist eine
      Anfrage anonym, nicht der Einzelnutzer (M12/M13)
- [x] Rechte pro Named Graph als Web-Access-Control-RDF in `graph/acl`,
      durchgesetzt im Dataset-Resolver (M13, §17)
- [x] Rate Limiting an MCP-, Föderations- und anonymen Routen (gleitendes
      Minutenfenster, 429 + Retry-After)
- [x] Rate Limiting am Chat-Endpunkt: derselbe gleitende RateLimiter wie
      an den MCP-, Föderations- und anonymen Routen, geprüft VOR jeder
      Arbeit (ein abgelehnter Turn kostet weder Modell noch Store).
      Gezählt wird pro **geprüfter** Identität, sonst pro Absenderadresse
      — „ohne geprüfte Identität ist eine Anfrage anonym, nicht der
      Einzelnutzer" (M12/M13) gilt auch fürs Zählen. 20/min,
      `OW_CHAT_RATE_LIMIT` verstellt es, `0` schaltet ab. Abnahme:
      `tests/ai/chat-limits.test.ts`
- [ ] Optionale Auth (Passkey/WebAuthn) als EIGENER Anmeldefluss — P2;
      heute führt ihn bewusst die Schicht davor (oauth2-proxy, HA-Ingress)

## Offen (priorisiert — Herkunft der Nummerierung: [Analyse](./docs/analyse-2026-08.md) §5)

> Der Graph-Ausbau nach GRAPH_CORE_SPEC ist mit M14 vollständig. Was hier
> steht, ist bewusst NICHT Teil der Spec und will einzeln entschieden
> werden.

### P0
- [ ] i18n mit next-intl (de/en, Umschalter, dynamisches html lang)
- [x] no-explicit-any-Abbau: `bun run lint` ist auf 0 Warnings. Kein
      `any` mehr außerhalb der A2UI-Protokollgrenze, wo es begründet und
      als `A2UIValue` benannt steht. Ebenso erledigt: unbenutzte
      Bindungen und die React-Hook-Dependencies (die verbliebenen
      Ausnahmen tragen eine Begründung am Code)
- [x] Frontmatter-Parser durch `yaml` ersetzt (dieselbe Bibliothek wie im
      Obsidian-Connector). Der handgeschriebene Vorgänger schnitt am ersten
      Doppelpunkt ab, zerlegte Tags am Komma und schrieb bei einem
      Anführungszeichen im Titel unparsbares YAML zurück. Das
      Ausgabeformat bleibt byte-gleich (Schlüsselreihenfolge, doppelte
      Quotes, Tags als Flow-Liste); neu sind die Maskierung und dass ein
      kaputter Block begründet übergangen wird statt halb gelesen.
      Abnahme: `tests/graph/workspace-roundtrip.test.ts`

### P1
- [x] A2A, MCP (Client UND Server), natives Tool-Calling (siehe AI-Integration)
- [x] Git-Sync über den Connector-Vertrag: `git-backup` (Backup oder
      bidirektional mit Konfliktregel §6.2) und `github-rdf` (lesend,
      commit-gepinnt) — M6/M3. Offen bleibt nur der bequemere Zugang:
- [ ] GitHub OAuth Device Flow statt Token aus der Umgebung
- [ ] **Anwendung auf die Runtime `local` stellen**: die Bausteine stehen
      seit M12 (Store im Web Worker, OPFS, isomorphic-git), die
      Graph-Oberflächen laufen aber weiterhin gegen das Backend — rund 30
      Routen unter `/api/graph` brauchen eine Browser-Bindung. Ersetzt den
      früheren Punkt „IndexedDB-Spiegel für Workspace-Inhalte"
- [x] **Chats und Termine zu Graph-Bürgern machen (M15)**: Kalender als
      `schema:DataFeed` + `schema:Event`, Chats als `schema:Conversation`
      + `schema:Message`, Store-first wie Aufgaben und Dokumente; die
      AI-Konfiguration als generierter Spiegel (`ow:InferenceProvider`,
      `ow:Model`). Sie erben damit Nutzergraphen, ACL, Volltextsuche und
      Export ohne neuen Mechanismus und stehen als `entityTypes` an ihren
      Modulen. Einstellungen bleiben bewusst instanzweit — sie
      beschreiben die Installation, nicht ihr Wissen.
- [ ] Matrix-Chat (matrix-js-sdk, E2EE)

### P2
- [x] Accessibility-Durchgang (Fokus-Management, ARIA, Reduced Motion, Kontraste,
      Touch-Targets — automatisiert abgesichert via e2e/a11y + e2e/mobile-*)
- [x] A11y-Feinschliff: Chat-Verlauf als Live-Region (`role="log"` an
      Widget und ganzseitigem Assistenten; `aria-busy` während der Antwort,
      sonst spräche der Screenreader die gestreamten Schnipsel einzeln,
      dazu eine verborgene Statuszeile), Dark-Mode-Scans auf alle zwanzig
      Seiten ausgeweitet. Der erweiterte Scan fand vier ernste
      Kontrastfehler mit zwei gemeinsamen Ursachen: sechs **Phantom-Token**
      in 26 Deklarationen (`--color-background`, `--color-text`,
      `--color-surface-hover`, `--color-surface-variant`,
      `--color-primary-hover`, `--color-surface-translucent` — CSS meldet
      das nicht: ohne Fallback fällt die Deklaration still weg, mit
      Fallback gilt der fest eingetragene Wert) und 26 Stellen, die die
      **Primärfarbe als Textfarbe** setzten statt `--color-primary-text`.
      Beides durchgängig nachgezogen und gegen Wiederkehr abgesichert:
      `tests/platform/design-tokens.test.ts` (kein `var()` ins Leere, jedes
      Farb-Token mit Dark-Mode-Wert oder begründet themenkonstant)
- [ ] Versionshistorie für Dokumente als UI (die Daten liegen mit
      `git-backup` bereits versioniert vor)
- [x] Export: Workspace-Backup als JSON-Download (Settings → Daten;
      nutzerskaliert seit M13 — nur die eigenen Verzeichnisse)
- [x] Restore aus dem Snapshot: `git-backup` im Modus `bidirectional`
      liest kanonische Graphen laut Manifest zurück (acl/vocab/shapes/
      inferred nie) und projiziert die Dateien danach neu (M6)
- [ ] Import/Restore aus einem JSON-Backup in der UI (mit Validierung und
      Sicherung des Ist-Stands)
- [ ] Kollaboration (CRDT/Yjs) — für v1 bewusst ausgeschlossen (SPEC §15:
      der Store bleibt single-writer pro Graph)
- [ ] GitLab-Sync (Plugin-Erweiterung: MCP und der Connector-Vertrag sind
      die beiden vorgesehenen Erweiterungspunkte)

### Beim Aufräumen gefunden, bewusst offen gelassen

> Kleinigkeiten, die beim Durchgang vom 15.08.2026 sichtbar wurden. Keine
> davon blockiert etwas; sie stehen hier, damit sie nicht wieder als
> Überraschung auftauchen.

- [ ] **Rohe `z-index`-Werte in zwölf CSS-Modulen** (5, 10, 30) neben der
      Token-Skala `--z-*`. Sie sind lokale Stapelordnungen INNERHALB einer
      Komponente und deshalb nicht falsch — aber die Konvention nennt nur
      die Skala, und der eine Fall, der wirklich eine Ebene war
      (`.floatingSettings` auf 100, numerisch gleich `--z-dropdown`), ist
      bereits umgestellt. Zu entscheiden ist, ob die Konvention „nur die
      Skala" oder „die Skala für Ebenen, freie Werte lokal" heißen soll
- [ ] **`--color-surface-hover` zeigt jetzt auf `--color-surface-sunken`.**
      Das Phantom-Token war an sechs Stellen gemeint als „die Fläche unter
      dem Zeiger" — eine eigene Entscheidung, die eine gesenkte Fläche nur
      annähert. Ein echtes Hover-Token wäre ehrlicher, ist aber eine
      Design-Entscheidung, keine Aufräumarbeit
- [ ] **Der Assistent kann Aufgaben anlegen und ändern, aber keine
      Pinnwand-Karten.** Die alte CopilotKit-Action dafür war seit M5
      kaputt; eine korrekte Fassung bräuchte eine Canvas-Auflistung im
      Tool-Loop (der Finder kennt Canvas nicht). Erst bauen, wenn jemand
      es im Chat vermisst
- [ ] **`createLocalRuntimeAdapter` ruft niemand auf** — weder Code noch
      Test. Der Adapter ist die Vorleistung aus M12 für die Runtime
      `local` (siehe P1, „Anwendung auf `local` stellen"), und bis die
      Umstellung kommt, ist er der einzige Baustein ohne Rückhalt: Seine
      Teile sind geprüft (`tests/platform/opfs.test.ts`,
      `worker-store.test.ts`), ihr Zusammenspiel nicht. Solange das so
      bleibt, kann er unbemerkt verrotten

---

*Last updated: 2026-08-15 (Aufräum-Session: CopilotKit abgelöst, Frontmatter über YAML,
Chat-Limit, Live-Region, Dark-Mode-Scan auf allen Seiten, Doku nach `docs/` konsolidiert)*
