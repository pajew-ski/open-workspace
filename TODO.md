# TODO - Open Workspace Development

> Roadmap auf Basis der vollständigen Analyse in [ANALYSE.md](./ANALYSE.md).
> Für den Graph-Ausbau gilt [GRAPH_CORE_SPEC.md](./GRAPH_CORE_SPEC.md)
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

## Kausal-Layer (CAUSAL_LAYER_SPEC — Entwurf, einzeln entschieden)

> Der Entwurf steht in [CAUSAL_LAYER_SPEC.md](./CAUSAL_LAYER_SPEC.md) und ist
> NICHT verbindlich. Umgesetzt ist bisher nur der zeitkritische Teil: die
> Erfassung. Sie kommt zuerst, weil Home Assistant Zustandswechsel nach
> `purge_keep_days` verwirft — jeder Tag ohne Erfassung ist ein verlorener Tag.

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
- [ ] **C0/C1 Kausalmodell und Identifikation**: DAG als Graph-Bürger,
      D-Separation, Backdoor/Frontdoor, minimale Adjustment Sets,
      Identifizierbarkeits-Entscheidung — reine Graphalgorithmik, läuft in
      allen drei Runtimes (CAUSAL_LAYER_SPEC §7 Tier 1)
- [ ] **C2 Causal Path Tracing** im Retrieval (§7.5-Erweiterung)
- [ ] **C4 Schätzung + Refutation**, `ow:CausalStudy` mit
      Reproduktions-Signatur
- [ ] **C5 Open-Data-Connector** `rest-timeseries` (Wetter, Strompreis,
      Sonnenstand, Feiertage) — die Confounder der Hausdomäne
- [ ] Backfill aus den Long-Term-Statistics (stündliche Aggregate,
      unbegrenzt aufbewahrt). Braucht die WebSocket-API
      (`recorder/statistics_during_period`) — die REST-API kennt sie nicht.
      Ändert nichts an der Dringlichkeit der Erfassung: die Ursachenseite
      steht in den Statistics ohnehin nicht

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
- [ ] CopilotKit: UI rendern oder Stack entfernen (Entscheidung, siehe ANALYSE §5 P0.3)

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
- [ ] Rate Limiting am Chat-Endpunkt — P2 (die anderen Routen haben es)
- [ ] Optionale Auth (Passkey/WebAuthn) als EIGENER Anmeldefluss — P2;
      heute führt ihn bewusst die Schicht davor (oauth2-proxy, HA-Ingress)

## Offen (priorisiert — Herkunft der Nummerierung: ANALYSE.md §5)

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
- [ ] Frontmatter-Parser durch yaml/gray-matter ersetzen

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
- [ ] A11y-Feinschliff: Chat-Verlauf als Live-Region, Dark-Mode-Scans auf alle Seiten ausweiten
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

---

*Last updated: 2026-08-10 (M15 Kalender/Chats/AI-Konfiguration als Graph-Bürger)*
