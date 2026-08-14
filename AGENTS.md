# AGENTS.md - Open Workspace Protocol

> Single Source of Truth für AI-Agent Interaktion mit dieser Codebase

## Hier weitermachen (Einstieg für neue Sessions)

> **Neu seit 2026-08-14 — Kausal-Layer, C3, C0, C1, C2, C4 und C5 gebaut.**
> Neben dem Graph-Kern gilt [CAUSAL_LAYER_SPEC.md](./CAUSAL_LAYER_SPEC.md)
> (verbindlich für C0–C5). Umgesetzt sind sechs Meilensteine:
>
> - **C3, die Erfassung** — zuerst, weil als einzige zeitkritisch: Home
>   Assistant verwirft vollständige Zustandswechsel nach
>   `purge_keep_days` (Standard 10 Tage), und was dort fehlt, ist
>   unwiederbringlich. Konkret: `homeassistant_api: true` im
>   Add-on-Manifest (lesend), der Connector `home-assistant` für die
>   Struktur (SOSA), `ow:Variable` in `graph/meta` für die
>   Erfassungsregel, NDJSON-Tagesdateien unter `data/observations/` für
>   die Werte (**nie im Store**, Invariante C3), ein Erfassungslauf mit
>   Backfill und Wasserzeichen, ein Zeitgeber im Serverprozess und die
>   Seite `/graph/observations`. Details:
>   [docs/beobachtungen.md](./docs/beobachtungen.md).
> - **C0, das Kausalmodell als Graph-Bürger** — der DAG ist eine
>   **Annahme** im Graphen, kein Ergebnis. Die kausale Kante ist fremdes
>   Vokabular (`obo:RO_0002411 causally upstream of`, Invariante C8);
>   eigen sind nur `ow:CausalModel` und die Annotationen am
>   RDF-1.2-Reifier (`ow:edgeClass`, `ow:evidenceLevel`,
>   `ow:temporalLag`). Ein Modell IST sein Named Graph
>   (`graph/<u>/causal/<modelId>`, dazu `causal-hypotheses`), beide im
>   Snapshot. SHACL-Shapes in `ontology/shapes/causal.ttl`. Details:
>   [docs/kausalmodell.md](./docs/kausalmodell.md).
> - **C1, die Identifikation** — die Frage VOR jeder Zahl: Ließe sich der
>   Effekt von A auf B aus Beobachtungsdaten überhaupt bestimmen, und
>   worüber müsste man adjustieren? Der Tier-1-Kern
>   (`src/lib/graph/causal/{dag,dsep,identify}.ts`) ist **pur** — kein
>   Store, kein Netz, keine Route (per Test erzwungen) — und rechnet
>   deshalb im Browser: Azyklizität mit Zeugen-Zyklus, topologische
>   Ordnung, D-Separation über den moralisierten Vorfahrengraphen,
>   implizierte Unabhängigkeiten, gedeckelte Pfad-Aufzählung für die
>   Erklärung, **Adjustment-Kriterium** (Shpitser/van der Zander) statt
>   des engeren Backdoor-Kriteriums, kanonische Menge als Entscheider,
>   minimale Adjustment Sets, Frontdoor und Instrumentvariablen.
>   **Beobachtbar heißt erfasst** (C3) — daraus entsteht die Antwort
>   „nicht identifizierbar, weil die Außentemperatur nicht erfasst wird",
>   getrennt von der Auskunft, ob die Struktur eine Antwort hergäbe.
>   Dazu: `/graph/causal` ist jetzt ein **DAG-Editor** (Variablen, Kanten
>   mit Herkunft und Zeitversatz; eine Kante, die einen Kreis schließt,
>   wird mit dem Kreis im Klartext abgelehnt; SHACL vor dem Schreiben,
>   blockierend nur bei NEUEN Verstößen), jede Änderung schreibt eine
>   Revision (`prov:Activity` + `schema:version`, Vorleistung für C7),
>   `capabilities.causalTier` steht auf `graph`, und Schreibziele kommen
>   aus **Scope-Mustern** (`causal/*`, `causal-hypotheses` im eigenen
>   Namensraum dürfen als NEUER Graph entstehen; vorhandene Graphen
>   bleiben allein Sache von `graph/acl`). Details:
>   [docs/kausalmodell.md](./docs/kausalmodell.md).
> - **C2, das kausal geerdete Retrieval** — dasselbe Multi-Hop-Retrieval
>   (§7.5), aber der Kausalstruktur folgend statt der semantischen
>   Nachbarschaft. Keine zweite Pipeline: `RetrievalRequest.causal`
>   (`mode` aus `ancestors|descendants|paths|markov-blanket`,
>   `treatment`, `outcome`, `model`, `blockedBy`, `minEvidence`). Der
>   Trace (`src/lib/graph/causal/trace.ts`) ist **pur** wie der übrige
>   Tier-1-Kern; Seed-Score ist die kausale Nähe `1/(1+Schritte)`; der
>   Modell-Graph kommt in den Traversal-Raum (Bestand und Grant klammern
>   ihn), und ein **Tor** in der Expansion hält Modellgrößen draußen, die
>   nicht zur Frage gehören — auch über den semantischen Umweg.
>   `explain.causal` trägt Modell samt Revision, Frage, Wege mit Richtung
>   und Offenheit, Adjustierung und jeden herausgefallenen Knoten mit
>   Grund; der linearisierte Kontext beginnt mit demselben Vorspann („die
>   Kette, nicht die Wolke"). Erdung schlägt fehl → **leeres** Ergebnis
>   mit Begründung statt eines semantischen, das kausal aussieht; das
>   Modell wird nie geraten. Auch im MCP-Werkzeug `graph_retrieve`, in
>   Retrieval-Profilen und im Graph-Explorer („Kausaler Pfad", ersetzt
>   das Bild durch die Kette). Details:
>   [docs/kausalmodell.md](./docs/kausalmodell.md).
> - **C4, die Schätzung mit ihrer Refutation** — hier entsteht die erste
>   **Zahl** dieses Layers, und nur unter Bedingungen. Der Tier-1-Kern
>   bleibt pur (`causal/{numeric,panel,estimate,refute,study}.ts`): fünf
>   Schätzer (Stratifikation, Regression mit Adjustierung, IPW, DiD, ITS),
>   Konfidenz aus dem **Moving Block Bootstrap** statt aus der
>   Lehrbuchformel (Beobachtungsreihen sind autokorreliert, §15.2), das
>   Panel mit gröbstem Raster, listenweisem Ausschluss, angewandtem
>   Zeitversatz und geprüfter Positivität. Danach **sechs Refutationen**:
>   Placebo (rotiert, nicht permutiert), zufällige gemeinsame Ursache,
>   Teilmengen-Stabilität, Negativkontrolle und die implizierten
>   Unabhängigkeiten gegen die Daten (§13.2) — dazu der E-Wert als
>   Kennzahl, die nie blockiert. „Nicht prüfbar" gilt **nicht** als
>   bestanden. Vier Ausgänge, drei davon ohne Zahl; ein durchgefallener
>   Effekt erscheint in **keiner** Form als Effekt (Invariante C5, auch
>   als SHACL-Shape). Die **Frage** (`ow:Estimand`) bleibt in `graph/meta`,
>   die **Antwort** (`ow:CausalStudy`) liegt in
>   `graph/<u>/inferred/causal/workspace` und wird bei jedem Lauf
>   vollständig ersetzt — deshalb rechnet ein Lauf immer alle Fragen. Der
>   Effekt hängt am selben Reifier wie die Kante, nur im Inferenz-Graphen,
>   und wird beim Lesen darübergelegt; erst dadurch greift `minEvidence`
>   aus C2 wirklich. Signatur (C7) erzwungen, Scope-Partitionierung (C6)
>   mit Negativtest. Details:
>   [docs/kausalmodell.md](./docs/kausalmodell.md).
>
> - **C5, die Störgrößen aus offenen Quellen** — die Lücke, die C4
>   sichtbar macht: Der häufigste Grund für „nicht identifizierbar" ist
>   keine fehlende Methode, sondern eine fehlende Störgröße. Der
>   Connector `rest-timeseries` holt sie über den EINEN Vertrag und
>   materialisiert dabei die **Angebotsseite**, nie einen Messwert
>   (Invariante C3, dieselbe Trennung wie bei `home-assistant` in C3);
>   die Revision folgt der Struktur, nicht der Zahl. Die Abbildung
>   (`mapping.ts`) ist pur und deklarativ und kennt die drei Formen
>   offener Kataloge — `points`, `columns`, `intervals` (mit dem Wert
>   **außerhalb** der Zeitspanne, ohne den eine Feiertagsreihe nur aus
>   Einsen bestünde). Katalog: Wetter (DWD/Bright Sky), Strompreis (EPEX
>   Spot/aWATTar), Einstrahlung (Open-Meteo), Feiertage (Nager.Date),
>   dazu `custom` ohne neuen Code. Die **Erfassung ist quellenagnostisch**
>   geworden (`observations/sources.ts`): Die Quellart kommt aus dem
>   Import-Graphen des Connectors, und eine unerreichbare Quellart legt
>   nur ihre eigenen Größen still. Der Nachweis ist der
>   **Adjustierungs-Kontrast**: dieselbe Frage, dasselbe Panel, derselbe
>   Startwert — einmal ohne Adjustierung. Der rohe Wert ist ein
>   **Zusammenhang, keine Wirkung** und trägt deshalb eigene Terme
>   (`ow:ConfoundingContrast`, `ow:crudeAssociation`,
>   `ow:confoundingShift`), nie `ow:effectSize`. Details:
>   [docs/kausalmodell.md](./docs/kausalmodell.md).
>
> - **Die Widersprüche der Spec sind entschieden** (14.08.2026, alle
>   sieben in
>   [docs/spec-widersprueche.md](./docs/spec-widersprueche.md); wo die
>   Entscheidung den Text betrifft, ist sie in die Spec eingearbeitet).
>   Drei brauchten Code: **`solar-position`** — eine berechnete Größe IST
>   eine Beobachtung, und zwar eine verlässlichere als eine gemessene;
>   Sonnenhöhe, Azimut, Tag/Nacht und extraterrestrische Einstrahlung
>   werden aus Ort und Zeit gerechnet (Astronomical Almanac, Fehler unter
>   0,01°), laufen über den EINEN Vertrag und bleiben durch das Verfahren
>   im Graphen erkennbar (`ssn:implements` → `sosa:Procedure`).
>   **`csv-observations`** — der Datei- statt des Netz-Wegs, Pfad-Politik
>   wie `obsidian-vault`, Skalenniveau je Spalte aus dem Bestand statt aus
>   dem Spaltennamen. Und die **Studien-Chronik**
>   (`graph/<u>/causal-archive`): Sie hält fest, was eine Frage wann
>   gesagt hat — behauptet und persistiert, weil ein Lauf ein Ereignis ist
>   und kein abgeleiteter Zustand. Der Effekt eines Eintrags hängt NIE am
>   Reifier der Kante, eingetragen wird nur eine Änderung, und beantwortet
>   wird eine Frage weiterhin nur aus dem Inferenz-Graphen.
>
> **Nicht gebaut** und deshalb nirgends in der UI: Hypothesen-Erzeugung
> (C6), Frontdoor- und IV-**Schätzer** (identifiziert, aber nicht
> gerechnet — die Studie sagt es), Struktur-Lernen und randomisierte
> Eingriffe. Was es an Quellen nicht gibt, gibt es weiterhin nicht: wer zu
> Hause war, ob das Fenster offen stand.
>
> **Nächster Meilenstein: C6** (neurosymbolische Schleife, SPEC §8 —
> LLM-Hypothesen mit Provenienz, symbolische Filter, Vergleich der drei
> Strukturquellen, Widerspruchs-UI). Reihenfolge und Begründung in
> CAUSAL_LAYER_SPEC §18, Arbeitsmodus in §19, offener Stand mit Abnahmen
> in TODO.md unter „Kausal-Layer". C7 und C8 nur nach ausdrücklicher
> Freigabe.

**Stand 2026-08-10 (12. Ausbaustufe, Graph Core M0–M14 inkl. §12.4 und
§18 — der Vollausbau der Spec ist damit abgeschlossen)**: Der
**RDF-Graph ist das kanonische Datenmodell — und seit der 6. Stufe die
einzige Wahrheit auch für die Schreibpfade**. Die verbindliche Spezifikation
inklusive aller Meilensteine M0–M14 liegt in
[GRAPH_CORE_SPEC.md](./GRAPH_CORE_SPEC.md) — **Arbeitsmodus: ein Meilenstein
= eine Session = ein Branch = ein PR**; jede Session liest zuerst diesen
Abschnitt und den jeweiligen Meilenstein-Abschnitt der Spec.
(Store-Entscheidung mit Messwerten in
[docs/decisions/0001-graph-store.md](./docs/decisions/0001-graph-store.md).)

- **Store** (`src/lib/graph/store/`): `GraphStore`-Interface + Oxigraph-WASM
  (SPARQL 1.1 Query/Update, RDF 1.2/RDF-star, Quads) + ehrliches
  In-Memory-Test-Double. Kein Default-Graph-Schreibpfad — jedes Tripel hat
  einen Named Graph, per Store erzwungen.
- **Vokabular** (`ontology/ow.ttl` + `src/lib/graph/vocab.ts`): 126 eigene
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
  Seit C2 kennt dieselbe Pipeline die **kausale Erdung**
  (`RetrievalRequest.causal`, CAUSAL_LAYER_SPEC §9): Trace über den DAG
  statt semantischer Nachbarschaft, kausale Nähe als Seed-Score, ein Tor
  gegen Modellgrößen außerhalb der Frage, `explain.causal` mit Modell,
  Wegen, Adjustierung und begründeten Ausschlüssen — Details in
  [docs/kausalmodell.md](./docs/kausalmodell.md).
  Retrieval-Profile sind `ow:RetrievalProfile`-Entitäten in `graph/meta`
  (`ow:retrievalConfig` als JSON-Literal, seit C2 auch mit `causal`).
  APIs: `GET /api/graph/search`
  (eigene Such-API mit ehrlicher Embedding-Diagnose),
  `POST /api/graph/retrieve` (zod-validiert; `profile` als Basis,
  Body-Felder überschreiben), `GET|POST /api/graph/retrieval-profiles`
  (+ `DELETE /[id]`). Der Global Finder (`/api/finder`,
  `workspace_finder`) ist auf den Graphen UMGESTELLT, nicht ersetzt:
  Dokumente/Aufgaben/Projekte kommen aus dem Index (Fuzzy-Verhalten und
  matchScore-Ranking erhalten); seit M15 gilt das auch für Termine und
  Chats — sie sind Graph-Bürger, der Sonderweg an ihren Storages vorbei
  ist entfallen (ein Treffer im Nachrichtentext führt zur Unterhaltung).
  Bekannte Grenze: oxigraph-js
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
  stehen in `OW_MCP_TOKENS` (zod-validiert, Vergleich über
  SHA-256-Digest ohne frühen Abbruch); seit M13 nennt ein Token nur noch
  den **Nutzer**, dessen ACL-Rechte gelten, und die Scope-Muster
  (`workspace`, `import/*`, `shared/<id>`, `*` — `graph/acl` trifft keins
  davon) sind eine optionale zusätzliche Verengung; ohne
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
- **Föderation (M11)** (`src/lib/graph/federation/` + `/graph/federation`):
  Fremde Endpoints anfragen, ohne zu kopieren — und selbst befragbar sein.
  **Registry**: `ow:FederatedEndpoint` mit `ow:sparqlEndpoint`/
  `ow:trustLevel` in `graph/meta` (`registry.ts`; API
  `/api/graph/federation/endpoints` + `/[id]` + `/[id]/probe`), Muster wie
  Connectors/Views/Profile — die Registry IST der Graph. Die SSRF-Politik
  greift schon beim Registrieren. **Ausgehend**: oxigraph-js hat keinen
  Service-Handler, also liegt die Föderation eine Schicht über dem Store —
  `service.ts` wertet das entfernte Muster beim Endpoint aus und ersetzt
  den `SERVICE`-Block durch die Lösungsmenge als `VALUES` (Semantik von
  SPARQL 1.1 Federated Query, Join lokal); `parse.ts` findet die Blöcke
  über eine positionstreue Maske (SERVICE in Kommentar/String/IRI zählt
  nicht). Nur registrierte Endpoints. `ow:trustLevel` hat **Wirkung**:
  `unknown` (Default) gesperrt, `known` eigenständige Auswertung — keine
  lokale Bindung verlässt den Rechner (Leak-Negativtest über den
  ausgehenden Query-Text) —, `trusted` Bound-Join (lokale Join-Schlüssel
  als `VALUES` mitgeschickt, gechunkt; die Sonde ist eine Lockerung der
  Query, ihre Treffer damit eine Obermenge der echten Schlüssel, und eine
  leere Sonde heißt nie „leeres Ergebnis"). Ausgehende Aufrufe über den
  SSRF-Guard (`connectors/http.ts`), Zeitbudget + Ergebnis-Limit sind
  Pflicht (Überschreitung = Fehler, nie stille Kürzung), `SERVICE SILENT`
  wird zur leeren Lösung samt Bericht (`X-OW-Federation`-Header am
  Endpoint, Feld `federation` in der Views-Vorschau). Blank Nodes des
  Endpoints sind nicht einsetzbar — solche Zeilen entfallen und stehen im
  Bericht. Eingebunden in `/api/graph/sparql` (Editor) und
  `/api/graph/views/preview`. **Eingehend**:
  `GET|POST /api/graph/federation/sparql` (read-only, CORS + `OPTIONS`):
  das erlaubte Dataset kommt aus dem Grant (dieselben M10-Tokens, Recht
  `sparql`) und wird über `resolveDataset` **injiziert**, nie
  nachgefiltert; ohne gültiges Token ist es leer (Query läuft, sieht
  nichts — kein 401, keine Existenzbestätigung), `SERVICE` ist gesperrt
  (Quelle, kein Relais), Rate-Limit pro Identität, Ergebnis-Limit (413).
  Die HTTP-Abbildung des Protokolls liegt jetzt einmal in
  `sparql/http.ts`. `capabilities.federationOutbound`/`federationInbound`
  = true für `server`/`ha-addon`. Abnahme:
  `tests/graph/federation.test.ts` (Negativtest mit manipuliertem `FROM`;
  Live-Query gegen Wikidata unter `OW_FEDERATION_LIVE=1`, sonst sichtbar
  übersprungen statt vorgetäuscht).
- **Runtime-Vollausbau (M12)** (`scripts/start.mjs`, `deploy/`,
  `src/lib/platform/`): **EIN Image** für `server` und `ha-addon` — der
  Unterschied ist ausschließlich das Packaging, und die Invariante ist ein
  Test (`tests/platform/packaging.test.ts`: genau ein Dockerfile im Repo,
  Add-on-Config und Compose zeigen auf dasselbe Image). Einstieg ist immer
  `scripts/start.mjs`: Base-Path ermitteln (Supervisor-API
  `/addons/self/info` bzw. `OW_BASE_PATH`), ihn in den fertigen Build
  einsetzen, `/data` verknüpfen und säen, Add-on-Optionen in
  Umgebungsvariablen übersetzen, root-Rechte abgeben (uid 1001), starten.
  **Warum ein Rewrite**: Next backt `basePath`/`assetPrefix` in den Build,
  der Ingress-Pfad steht erst zur Installationszeit fest — das Image baut
  einmal mit Platzhalter, `scripts/base-path.mjs` ersetzt ihn beim Start
  (Erlaubnisliste für Textdateien, Markierungsdatei, idempotent, folgt
  einem gewechselten Token, verweigert das nachträgliche Setzen nach einem
  Wurzel-Build ehrlich). **Fallstrick, als Test verankert**: Der
  Platzhalter darf im App-Code nicht als „ungültig" verworfen werden —
  vorgerenderte Seiten entstehen mit ihm als Base-Path, und genau diese
  Fundstellen sind es, die beim Start zum echten Pfad werden.
  **Ingress**: Der Supervisor ENTFERNT `/api/hassio_ingress/<token>` vor
  dem Weiterreichen und meldet es in `X-Ingress-Path`, Next erwartet es —
  `scripts/ingress-proxy.mjs` setzt es wieder vor den Pfad (Packaging,
  nicht Anwendung; die Wurzel bewusst ohne Schrägstrich, sonst 308-Schleife;
  gewechselter Token = 503 + Neustart statt falscher Links).
  **In der App** kennt keine Feature-Datei den Ingress:
  `src/lib/platform/base-path.ts` präfixt `fetch` an genau EINER Stelle
  (`installBasePathFetch`, im `BasePathProvider` installiert), `<Link>`,
  `next/image` und `_next/*` erledigt Next selbst, das Manifest ist eine
  Route (`/manifest.webmanifest`, ersetzt die statische Datei), der Service
  Worker liest seinen Base-Path aus `self.registration.scope`.
  **server-Compose** (`deploy/server/`): Caddy (TLS/ACME) → oauth2-proxy
  (OIDC-Anmeldefluss, Profil `oidc`) → App als uid 1001. Den Anmeldefluss
  führt bewusst der Proxy; die App liest die Identität.
  **Identität** (`src/lib/platform/auth/`, `OW_AUTH_MODE`): `single-user`
  (Default), `ha-ingress` (HA-Header), `proxy-header` (oauth2-proxy),
  `oidc-bearer` (Token der Anfrage, JWKS-Prüfung über WebCrypto — Signatur
  vor Ablauf/Issuer/Audience, Schlüsselrotation, `alg: none` abgelehnt;
  keine neue Abhängigkeit). Sie wird gelesen und angezeigt
  (`GET /api/runtime` + Karte „System" in `/settings`); die Durchsetzung
  pro Graph kam mit M13 (§17) und steht seither auf `multiUser: true`.
  **Runtime `local`**: Store im Web Worker
  (`runtime/worker/`: eigenes Term-Kodieren ohne Oxigraph im Haupt-Thread,
  Transaktionen bleiben offen, damit Lesen darin möglich ist), OPFS als
  `FileSystemLike` (`runtime/opfs.ts`, inklusive Frische-Signalen — trägt
  isomorphic-git nachweislich), Secrets im localStorage, ehrliche
  Capabilities (kein SPARQL-Endpoint, kein MCP-Server, keine eingehende
  Föderation). Speicher-Zustand nach §8.3 in den Einstellungen: dauerhaft
  oder löschbar, Belegung, Warnung ab 80 %, Knopf für die
  Persistenz-Anfrage. **Ehrliche Grenze**: Die Graph-Oberflächen laufen
  weiterhin gegen das Backend; die Umstellung der Anwendung auf einen
  Browser-Store ist NICHT Teil von M12 und wird nirgends angezeigt.
  Betriebsdoku: [docs/deployment.md](./docs/deployment.md). Abnahme:
  `tests/platform/{base-path,ingress,packaging,auth,opfs,worker-store}.test.ts`
  und `e2e/ingress.spec.ts` gegen die volle Kette
  (`scripts/e2e-ingress-server.mjs`: Supervisor-Simulation →
  Ingress-Proxy → Standalone-Build mit eingesetztem Pfad).
- **Multi-User und feingranularer Zugriff (M13)** (`src/lib/graph/authz/`
  + `src/lib/graph/server/context.ts` + `/graph/access`): Rechte sind
  **RDF im selben Store**, nicht Konfiguration — `graph/acl` trägt
  Web-Access-Control-Regeln (`acl:Authorization`, `acl:accessTo` auf die
  Graph-IRI, `acl:agent`/`agentGroup`/`agentClass`, `acl:mode`),
  Granularität pro Named Graph (§17.2). Die Modus-Implikation, die WAC
  offenlässt, ist festgelegt und begründet: `control` ⊃ `write` ⊃
  `append`/`read`; `append` allein ist die Briefkasten-Semantik
  (beitragen, ohne den Bestand zu sehen). Rollen (`reader`/`contributor`/
  `editor`/`owner`) sind benannte Modus-Bündel für die UI — die
  **Mitgliederliste eines Raums IST die Regelmenge auf seinem Graphen**,
  eine zweite Liste gäbe es nur, damit sie falsch sein kann.
  **Nichts ist per Default sichtbar, auch nicht für den Eigentümer**:
  Sein `control` steht als Tripel im Graphen (`ensureDefaultAuthorizations`
  füllt beim Start nur auf und überschreibt nie), damit Eigentum per
  SPARQL prüfbar ist statt in einer if-Bedingung zu leben; `graph/acl`
  selbst trifft kein Muster und keine Regel. **Durchsetzung** (§17.3) in
  zwei Stufen, beide nur verengend: `grantForIdentity` (Identität +
  `graph/acl` ⇒ `AccessGrant`), dann `resolveDataset` (SPARQL) bzw.
  `retrievalDataset` (Retrieval), die den Grant injizieren statt
  nachzufiltern. Deshalb hat sich die Grant-Schnittstelle aus M10 NICHT
  geändert — MCP-Server und eingehende Föderation liefen unverändert
  weiter; `OW_MCP_TOKENS` nennt jetzt nur noch den **Nutzer**, `scopes`
  ist eine optionale zusätzliche Verengung (ein Zugang darf weniger
  dürfen als sein Nutzer, nie mehr). Ein **Architekturtest** erzwingt
  §17.3 wörtlich: jede Datei unter `src/lib/graph`/`src/app/api`, die
  `store.query(` aufruft, muss ihr Dataset vom Resolver beziehen (dafür
  wurde auch `/api/graph` umgestellt). SPARQL UPDATE bekam
  `writableGraphs`: alles außerhalb ist geschützt — auch ein Graph, den es
  noch nicht gibt; die Ablehnung unterscheidet nicht zwischen
  systemverwaltet, fremd und nicht existent. **Anfrage-Kontext**
  (`server/context.ts`) bindet Identität (über `next/headers`, damit es
  keine zweite Quelle gibt), nutzerskalierte IRI-Fabrik und Grant
  zusammen; sicherheitskritisch und als Test verankert: Läuft ein
  Anmeldeverfahren und fehlt die geprüfte Identität, ist die Anfrage
  **anonym** — nicht der Einzelnutzer, sonst wäre jeder fehlende Header
  ein Generalschlüssel. **§17.5**: `graph/u/<id>/public` ist über die
  reguläre Standardregel (`foaf:Agent` Read) anonym lesbar und
  föderierbar, `GET /.well-known/void` beschreibt den Umfang DES
  ANFRAGENDEN als `void:Dataset`, Entitäts-IRIs dereferenzieren unter
  `/u/<userId>/<type>/<id>` (Turtle/JSON-LD/HTML mit eingebettetem
  JSON-LD) — ehrliche Grenze: nur mit HTTP-Instanz-Base, die
  Default-URN-Base kann es nicht und sagt das (404 statt Attrappe);
  Rate-Limit für anonyme Zugriffe über denselben `RateLimiter` wie
  M10/M11. **§17.4** hat je einen Test: Volltext-/Vektorindex pro Dataset
  gebaut (nicht global mit gefilterter Trefferliste), Retrieval-Klammer
  vor der Expansion, Reasoning je Nutzer, Bound-Join-Leak über den
  ausgehenden Query-Text, gesperrt und nicht existent byte-gleich.
  **Export und Git-Sync**: Export liefert nur die Verzeichnisse des
  Nutzers (`data/u/<id>/…`; instanzweite Bestände nur für Verwalter), ein
  `git-backup` verlangt `control` auf JEDEM Graphen des Snapshots (sonst
  403 mit Begründung). `graph/acl` wird als `data/graph/acl.nq` NEBEN dem
  Manifest gesichert: überlebt den Neustart, wird aber von keinem
  manifest-getriebenen Pfad angefasst (kein Restore, kein Nutzer-Export);
  ein Git-Backup direkt auf `data/graph` nimmt die Datei als Teil des
  Arbeitsverzeichnisses mit — zulässig, weil ein Backup `control` auf
  jedem enthaltenen Graphen voraussetzt. Neue Terme: `ow:Space` + `ow:spaceGraph` (bewusst nicht
  `ow:targetGraph` — dessen `rdfs:domain ow:Connector` machte über OWL RL
  jeden Raum zum Connector, und §4.4 verbietet Umdefinition); alles
  Übrige ist Standard-Vokabular (WAC, FOAF, VoID). `OW_ADMIN_USERS` ist
  nur der Seed der Verwalter beim Anlegen fehlender Regeln — danach ist
  `graph/acl` die Wahrheit. UI: `/graph/access` (Identität, sichtbare
  Graphen mit Modi, Räume, Freigaben — sichtbar ist nur, was man wirklich
  verwaltet). `capabilities.multiUser` = true für `server`/`ha-addon`.
  Betriebsdoku: [docs/multi-user.md](./docs/multi-user.md). Abnahme:
  `tests/graph/multi-user.test.ts` (Matrix §17.6, jede Zeile ein eigener
  Negativtest über einen ECHTEN Leak-Pfad — die Kante liegt im erlaubten
  Graphen, nur ihr Ziel nicht) und `tests/graph/acl.test.ts`.
- **Selbstmodell und Einführungsstrecke (M14)** (`src/lib/app/modules.ts`,
  `src/lib/graph/meta/self-model*.ts`, `src/lib/graph/onboarding/`,
  `/onboarding`): Der Workspace beschreibt sich in seinem eigenen Graphen
  (SPEC §18). In `graph/meta` liegen die Anwendung (`schema:SoftwareApplication`
  mit `ow:runtime`, `ow:capability`, `ow:availableConnectorKind`,
  `schema:softwareVersion`/`schema:schemaVersion`) und ihre Module
  (`ow:Module` mit `ow:route`, `ow:entityType`, `schema:isPartOf`) — beim
  Start GENERIERT aus dem Code, nie gepflegt. **Die eine Quelle ist die
  Modul-Registry** `src/lib/app/modules.ts`: Aus ihr entstehen die
  Sidebar-Navigation UND das Selbstmodell; Icons bleiben in der Sidebar,
  weil sie Darstellung sind. Die früher doppelt gepflegte
  `MODULE_CONTEXT`-Tabelle (Assistent + CopilotKit-Provider) ist gelöscht,
  und ein Test verbietet ihre Rückkehr genauso wie eine Registry, die von
  `src/app/**/page.tsx` abweicht. **Ehrlich statt vollständig**: Ein Modul,
  dessen Runtime-Fähigkeit fehlt (`/graph/sparql` in `local`), steht nicht
  im Modell. Der **Assistent** bezieht seinen Systemkontext aus der Abfrage
  (`readSelfModel` → `systemContextText`), serverseitig gelesen und vom
  Grant geklammert — was der Client mitschickt, ist Eingabe, keine
  Wahrheit; ohne Backend behauptet der Prompt nichts über das System.
  **Einführungsstrecke** `/onboarding`: vier reale Schritte — Selbstmodell
  abfragen, eigenen Knoten über die Store-first-CRUD anlegen,
  prima-materia über den EINEN Connector-Vertrag importieren, Herkunft
  vergleichen. Kein Übungsmodus, keine Beispieldaten; der Fortschritt ist
  eine `ow:OnboardingStep`-Aktivität pro Nutzer in `graph/meta`
  (`prov:used`/`prov:generated`), also geräteübergreifend und per SPARQL
  prüfbar, und „rückgängig" löscht das Erzeugte samt Aufzeichnung
  (Nachweis: kanonischer Dump vor/nach ist byte-identisch). Ein
  fehlgeschlagener Import gilt nicht als erledigt. Die Herkunfts-Zählung
  (`graph/provenance.ts`, `GET /api/graph/provenance`) speist auch den
  Abschnitt „Herkunft" im Graph-Explorer: nativ, importiert und inferiert
  mit denselben Zahlen, inferierte Kanten weiterhin gestrichelt und per
  Default aus. **Dabei repariert**: Der Grant kommt ausschließlich aus
  `graph/acl`, dessen Standardregeln beim Start entstehen — ein Graph, der
  erst zur Laufzeit angelegt wird (Connector-Import, Inferenz-Lauf), hatte
  keine Regel und war damit bis zum nächsten Neustart unsichtbar.
  `ensureGraphAuthorizations` (aufgerufen im Anfrage-Kontext, vor der
  Grant-Berechnung) zieht sie nach: Auffüller wie beim Start, No-Op ohne
  neue Graphen. Abnahme: `tests/graph/self-model.test.ts`,
  `tests/graph/onboarding.test.ts` (inkl. dieses Falls: erst ohne Regel
  unsichtbar, dann mit). Doku:
  [docs/selbstmodell.md](./docs/selbstmodell.md).
- **Invarianten** (Review-Blocker, SPEC §2/§17.3): RDF ist die eine
  Wahrheit; Wissen ≠ Präsentation; asserted ≠ inferred; ein
  Connector-Vertrag für alles Externe; kein `any` unter `src/lib/graph/`
  (ESLint-Error); Vokabular-Base niemals deployment-spezifisch; **jeder
  Lesepfad holt sein Dataset beim Resolver** — ein `store.query()` ohne
  Dataset aus `resolveDataset`/`retrievalDataset` bricht den
  Architekturtest in `tests/graph/acl.test.ts`.

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

Build, Typecheck, Lint (0 Errors), 717 Unit-Tests (plus der Live-Test
gegen Wikidata, der ohne `OW_FEDERATION_LIVE=1` sichtbar übersprungen
wird) und das **blockierende E2E-Gate** (`e2e/mobile-navigation`,
`e2e/mobile-ux`, `e2e/a11y` inkl. der Seiten `/ai`, `/skills`, `/tools`,
`/graph/connectors`, `/graph/observations`, `/graph/causal`, `/graph/sparql`,
`/graph/federation`, `/graph/access` und seit M14 `/onboarding`, dazu seit M12
`e2e/ingress.spec.ts` im eigenen Playwright-Projekt `ingress`)
laufen grün. Der Ingress-Lauf baut sich beim ersten Mal einen zweiten
Build (`.next-ingress`, Base-Path-Platzhalter) und startet die
Supervisor→Proxy→App-Kette selbst; für einen frischen Build das
Verzeichnis löschen. In Sandboxes ohne Playwright-Download zeigt
`CHROMIUM_PATH=/opt/pw-browsers/chromium bun run test:e2e` auf einen
vorinstallierten Browser (die Konfiguration wertet die Variable aus).

**Bevor du etwas Neues baust, lies in dieser Reihenfolge:**
1. [GRAPH_CORE_SPEC.md](./GRAPH_CORE_SPEC.md) — verbindliche Spec des
   Graph-Ausbaus (M0–M14, Invarianten, Abnahmen) — Pflicht für Graph-Arbeit
1b. [CAUSAL_LAYER_SPEC.md](./CAUSAL_LAYER_SPEC.md) — verbindliche Spec des
   Kausal-Layers (Invarianten C1–C10, Meilensteine C0–C8, §19 Arbeitsmodus)
   — Pflicht für jede Arbeit am Kausal-Layer, zusammen mit
   [docs/beobachtungen.md](./docs/beobachtungen.md) und
   [docs/kausalmodell.md](./docs/kausalmodell.md) (was gebaut ist und
   warum) sowie
   [docs/spec-widersprueche.md](./docs/spec-widersprueche.md) (wo die
   Spec sich widersprach, wie entschieden wurde und was die
   Gegenrichtung gekostet hätte)
2. [docs/multi-user.md](./docs/multi-user.md) — Identität, ACL und
   Durchsetzung (§17) — Pflicht, sobald ein Lesepfad berührt wird
3. [docs/selbstmodell.md](./docs/selbstmodell.md) — Selbstmodell,
   Modul-Registry und Einführungsstrecke (§18) — Pflicht, sobald eine
   Seite dazukommt oder verschwindet
4. [docs/ai-platform.md](./docs/ai-platform.md) — Architektur der AI-Schicht
5. [ANALYSE.md](./ANALYSE.md) — historische Bestandsaufnahme + **§5 Roadmap**
6. [TODO.md](./TODO.md) — Roadmap als abhakbare Liste (inkl. Graph Core)
7. Diesen Abschnitt hier für die Architektur-Prinzipien

**Nächste sinnvolle Schritte**: Der Graph-Ausbau nach GRAPH_CORE_SPEC ist
mit M14 **vollständig** — auch §18 ist umgesetzt. Punkt 2 der früheren
Liste ist mit M15 erledigt (Kalender, Chats, AI-Konfiguration sind
Graph-Bürger).

**Der laufende Arbeitsstrang ist der Kausal-Layer**
([CAUSAL_LAYER_SPEC.md](./CAUSAL_LAYER_SPEC.md), §16 Meilensteine, §19
Arbeitsmodus). C3 (Erfassung), C0 (Kausalmodell als Graph-Bürger), C1
(Identifikation: Azyklizität, D-Separation, Backdoor/Frontdoor, minimale
Adjustment Sets, Instrumente — reine Graphalgorithmik, läuft in allen drei
Runtimes), C2 (Causal Path Tracing im Retrieval: dieselbe Pipeline folgt
dem DAG statt der semantischen Nachbarschaft, `explain` trägt den Weg) und
C4 (Schätzung + Refutation: fünf Tier-1-Schätzer, Konfidenz aus dem
Moving Block Bootstrap, sechs Falsifikationsversuche, `ow:CausalStudy` mit
erzwungener Reproduktions-Signatur — ein Effekt ohne bestandene Refutation
wird in keiner Form ausgegeben) und C5 (Open-Data-Connector
`rest-timeseries`: die Störgrößen der Hausdomäne über den EINEN Vertrag,
quellenagnostische Erfassung, Adjustierungs-Kontrast als Nachweis) sind
gebaut; **als Nächstes C6** (neurosymbolische Schleife, §8) in genau
dieser Reihenfolge (Begründung in §18). Der offene Stand steht
abhakbar in [TODO.md](./TODO.md) unter „Kausal-Layer" — er ist die eine
Quelle dafür, was noch fehlt; die entschiedenen Widersprüche der Spec
stehen in [docs/spec-widersprueche.md](./docs/spec-widersprueche.md).

Unabhängig davon weiterhin offen, ohne Reihenfolge zum Kausal-Layer:

1. **Die Anwendung selbst auf die Runtime `local` stellen**. Die Bausteine
   stehen seit M12 (Store im Web Worker, OPFS als `FileSystemLike`,
   isomorphic-git), die Graph-Oberflächen laufen aber weiterhin gegen das
   Backend — das ist die größte ehrlich benannte Lücke im Repo. Umfang:
   rund 30 Routen unter `/api/graph` brauchen eine Bindung im Browser;
   das ist mehr als eine Session.
2. **Matrix-Chat** (`/communication`): die letzte Seite ohne
   Entitätstypen. Die Seite kennzeichnet ihren Planungsstand ehrlich;
   mit `matrix-js-sdk` bekäme sie echte Räume und Nachrichten — die
   Chat-Modellierung aus M15 (schema:Conversation/Message) steht bereit.

Parallel weiter sinnvoll: i18n mit `next-intl` (P0); CopilotKit-Entscheidung.
Der `no-explicit-any`-Abbau ist erledigt — `bun run lint` steht auf 0
Warnings, und das ist ab jetzt der Sollzustand: Wer eine neue Warnung
einführt, hat sie zu begründen oder zu beheben.

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
- Dokumente (`/docs`) durchsuchen, anlegen und bearbeiten
- Pinnwand-Karten (`/canvas`) erstellen und verknüpfen
- Aufgaben und Projekte (`/tasks`) verwalten und priorisieren
- Global Finder nutzen (`workspace_finder`, seit M8 auf dem Graph-Index)
- A2A-Agenten koordinieren und delegieren
- Werkzeuge aufrufen: Builtins, API-Tools, MCP-Tools
- Code generieren und analysieren

### Kontext-Informationen
Der Assistent erhält automatisch:
- Aktuelle Seite/Modul
- Sichtbare Inhalte im Browser (Dynamic `viewState`)
- Ausgewählte Elemente
- Letzte Aktionen des Nutzers
- Relevante Daten aus der Wissensbasis
- **Systemkontext aus dem Selbstmodell** (§18, M14): Module, ihre Routen,
  die von ihnen verwalteten Entitätstypen, die einbindbaren Quellen und
  die aktiven Fähigkeiten dieser Runtime — per SPARQL aus `graph/meta`
  abgefragt, nicht im Prompt gepflegt. Ohne erreichbares Backend fehlt
  dieser Block ehrlich, statt veraltet zu sein.

### Architektur

```
open-workspace/
├── src/
│   ├── app/                      # Seiten + API-Routen (App Router)
│   │   ├── page.tsx              # Übersicht (Dashboard)
│   │   ├── docs/ tasks/ canvas/ calendar/ communication/
│   │   ├── agents/ ai/ skills/ tools/ assistant/ settings/
│   │   ├── onboarding/           # Einführungsstrecke (§18)
│   │   ├── graph/                # Explorer + sparql/ connectors/
│   │   │                         #   federation/ access/
│   │   ├── u/[userId]/…          # Dereferenzierbare Entitäts-IRIs (§17.5)
│   │   └── api/                  # chat, docs, tasks, projects, canvas,
│   │                             #   calendar, finder, graph/*, mcp,
│   │                             #   onboarding, runtime, …
│   ├── components/               # ui, layout, a2ui, assistant, dashboard,
│   │                             #   finder, notifications, pwa, seo, …
│   └── lib/
│       ├── graph/                # DER Kern: store, serialize, workspace,
│       │                         #   connectors, sparql, reasoning, search,
│       │                         #   federation, authz, mcp, meta, onboarding
│       ├── platform/             # Runtime-Adapter, Auth, Base-Path
│       ├── ai/                   # Provider, Engine, MCP-/A2A-Clients
│       ├── app/modules.ts        # Modul-Registry (Navigation + Selbstmodell)
│       ├── skills/ tools/ agents/ chat/ calendar/ connections/ security/
│       └── storage/              # Fassaden über die Store-first-CRUD
├── ontology/                     # ow.ttl, rules/, shapes/
├── data/                         # Projektionen + Snapshot (siehe Data Layer)
├── deploy/                       # server-Compose, HA-Add-on
├── scripts/                      # start.mjs, base-path, migrate, checks
└── tests/ e2e/                   # Vitest + Playwright
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

**Die Wahrheit ist der RDF-Store** (SPEC §12.4/§16). Alles unter `data/`
außer `data/graph/` ist **Projektion**: lesbar für Git und Obsidian,
geschrieben von `src/lib/graph/workspace/files.ts`, nie direkt von der App
gelesen. Externe Bearbeitung dieser Dateien ist erlaubt und kommt über den
regulären Connector-Weg zurück (`obsidian-vault`, `git-backup`) — nicht
über einen zweiten Lesepfad.

### Dokumente (Projektion: `data/docs/*.md`)
- Markdown mit YAML-Frontmatter; Wikilinks `[[Ziel]]` sind `ow:linksTo`,
  Tags `skos:Concept` mit `skos:broader`.
- Typen: `ow:Document` ⊑ `schema:DigitalDocument`, polymorph verfeinert
  (`TechArticle`, `BlogPosting`, `HowTo`, `DefinedTerm`).
- Mehrsprachig gedacht: englische Slugs in der URL, deutscher Inhalt,
  `inLanguage: de`.

### Aufgaben und Projekte (Projektion: `data/tasks/*.json`)
- `ow:Task` ⊑ `schema:Action`, `ow:Project` ⊑ `schema:Project`; Status als
  `ActiveActionStatus`/`CompletedActionStatus`, der exakte native Zustand
  zusätzlich in Quelltreue-Termen (`ow:workflowStatus`, `ow:priority`, …).

### Pinnwände (Projektion: `data/canvas/*.json`)
- `ow:Canvas` ⊑ `schema:CreativeWork` im Wissensgraphen; **Layout**
  (Position, Größe, Farbe, Viewport) ausschließlich in
  `graph/<u>/presentation` (Invariante 2).

### Graph-Snapshot (`data/graph/`)
- Deterministische N-Quads je kanonischem Graphen plus `manifest.json`
  (RDFC-1.0, byte-identisch → git-tauglich). `acl.nq` liegt NEBEN dem
  Manifest (§17.4). `inferred/*` und die Suchindizes werden nie
  persistiert — sie entstehen beim Start neu.

### Kalender und Chats (Projektion: `data/calendar/*.json`, `data/chat/conversations.json`)
- Seit M15 Graph-Bürger und damit nutzerskaliert: `schema:DataFeed` +
  `schema:Event`, `schema:Conversation` + `schema:Message` in
  `graph/<u>/workspace`; Kalenderfarbe, A2UI-Oberfläche einer Antwort und
  die zuletzt geöffnete Unterhaltung liegen in `graph/<u>/presentation`
  (Invariante 2). `storage/calendar.ts` und `storage/chat.ts` sind
  Fassaden über `workspace/crud.ts`; der ICS-Abruf bleibt ein Netz-Lauf
  und schreibt sein Ergebnis in EINER Mutation mit replace-Semantik.

### Noch keine Graph-Bürger (instanzweit, nicht nutzerskaliert)
- Einstellungen: `data/settings.json`, `data/dashboard.json` — sie
  beschreiben die Installation, nicht ihr Wissen.
- AI-Schicht: `data/ai/`, `data/agents/`, `data/tools/` — bleiben operative
  Konfiguration, weil sie auch serverlos im Browser laufen; ihr Spiegel in
  `graph/meta` wird generiert (M9, seit M15 inklusive Inference-Provider
  als `ow:InferenceProvider` und ihrer konfigurierten `ow:Model`e — ohne
  Geheimnisse und ohne erfundenes Live-Modellinventar).

## Modul-Agenten

Die Anwendung unterstützt nun **Dynamisches Agenten-Management**:
- **Lokal**: Agenten, die im System-Context laufen (definiert durch System Prompt).
- **Remote (A2A)**: Agenten, die extern laufen und via HTTP/A2A kommunizieren.
- **Connections**: Remote Agenten können mit sicheren Credentials (z.B. Bearer Token) verknüpft werden.

Welche Module es gibt und was sie verwalten, steht nicht mehr in einer
Tabelle, sondern im **Selbstmodell** (`graph/meta`, erzeugt aus
`src/lib/app/modules.ts`) — abfragbar per SPARQL:

```sparql
SELECT ?label ?route ?typ WHERE {
  GRAPH <…graph/meta> { ?m a ow:Module ; schema:name ?label ; ow:route ?route .
                        OPTIONAL { ?m ow:entityType ?typ } }
} ORDER BY ?route
```

Der Assistent bezieht seinen Modul-Kontext genau daraus; eine gepflegte
Kopie wäre die vierte Wahrheit (§18).

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
- **UI-Labels**: Deutsch. Englisch ist geplant, aber NICHT gebaut —
  `next-intl` steht als P0 in TODO.md; bis dahin keine Sprach-Umschalter
  in der UI behaupten (Invariante 10)
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
