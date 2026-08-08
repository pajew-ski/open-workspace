# SPEC: Graph Core — Vollausbau

**Repo**: `pajew-ski/open-workspace`
**Typ**: Technische Spezifikation / Architecture Decision Record, verbindlich für die Umsetzung
**Status**: In Umsetzung — Fortschritt in [TODO.md](./TODO.md) („Graph Core"), Einstieg in [AGENTS.md](./AGENTS.md)
**Adressat**: Coding Agent
**Vorrang**: Diese Spec hat Vorrang vor `ANALYSE.md` §5 und `TODO.md`, wo sie ihnen widerspricht. `AGENTS.md` bleibt für Code-Konventionen, Mobile-First, Safety-Regeln und das E2E-Gate uneingeschränkt gültig.

> Arbeitsmodus: **Ein Meilenstein = eine Session = ein Branch = ein PR** (§13).
> Jede Session liest zuerst AGENTS.md („Hier weitermachen") und den
> Meilenstein-Abschnitt hier, setzt genau einen Meilenstein um und aktualisiert
> TODO.md + AGENTS.md. Umgesetzte Entscheidungen mit Messwerten liegen in
> `docs/decisions/`.

---

## 0. Auftrag in einem Satz

Der Graph wird von einer abgeleiteten Visualisierung zum kanonischen Datenmodell des gesamten Workspace: RDF-nativ, mit SPARQL-Endpoint, Föderation, Reasoning, einem generischen Connector-Framework für externe Wissensquellen, verlustarm bidirektionaler Obsidian-Kompatibilität, und lauffähig in drei Runtimes (Browser-only PWA, Home-Assistant-Add-on, Standalone-Docker) aus einer Codebase.

---

## 1. Ausgangslage (Ist-Stand bei Spec-Erstellung, geprüft)

| Stelle | Zustand | Konsequenz |
|---|---|---|
| `src/app/api/graph/route.ts` | Baute bei jedem Request ad hoc ein schema.org-`@graph` aus `listDocs/listTasks/listProjects/listCanvases`. Durchgehend `as any`. | **Ersetzt (M1)**: bleibt als abwärtskompatible View erhalten, generiert aus dem Store. |
| ebenda | Präsentations-Properties `color`, `val` lagen **im** JSON-LD | Verstoß gegen die Trennung Wissen/Präsentation. **Entfernt (M1).** |
| ebenda | `BASE_URL = 'https://exocortex.local'` hardcodiert | IRI-Strategie fehlte. **Ersetzt (M0)** durch Instanz-Base. |
| ebenda | Task-Dependencies als improvisiertes `dependencies`-Array | **Ersetzt (M0/M1)** durch `ow:blockedBy`. |
| `src/lib/ontology/` | `generator*.ts` mit `schema-dts`. Einbahnstraße interne Typen → JSON-LD. | **Gelöscht (M1)**, Nachfolger: `src/lib/graph/projection/`. |
| `src/lib/storage/*` | JSON/Markdown-Dateien unter `data/`, per Modul getrennt | Bleibt als Dateiformat, verliert die Rolle als Wahrheitsquelle (§12). |
| `src/lib/platform/backend.ts` | Backend-Verfügbarkeitsprobe, serverloser Pfad für die AI-Schicht | Muster für die Runtime-Adapter, wird generalisiert. |
| `src/lib/ai/a2a/client.ts`, `src/lib/ai/mcp/client.ts` | A2A-Agent-Card-Discovery und MCP-Client laufen | Agents, Skills, Tools und MCP-Server werden Graph-Bürger (M9), ohne die Protokoll-Clients neu zu bauen. |
| `src/lib/skills/` | SKILL.md-Konvention, Laden aus Datei/URL/GitHub/MCP-Prompt | Der GitHub-Ladeweg ist der Prototyp für den Connector-Vertrag. |

---

## 2. Architektur-Invarianten

Nicht verhandelbar. Jede Abweichung ist ein Review-Blocker.

1. **RDF ist das kanonische Modell.** Alles andere (JSON, Markdown, JSON-Canvas, schema.org-View) ist Projektion. Es gibt genau eine Wahrheit.
2. **Wissen und Präsentation sind getrennt.** Kein Layout-, Farb- oder Größenwert steht jemals im semantischen Graphen. Präsentation lebt im dafür vorgesehenen Named Graph (§9) und wird aus semantischen Queries per Default ausgeschlossen.
3. **Asserted und Inferred sind getrennt.** Reasoner-Output geht ausschließlich in `graph/inferred` und wird bei jedem Lauf vollständig ersetzt, nie gemerged.
4. **Jedes Tripel hat einen Named Graph.** Es gibt keinen Default-Graph-Schreibpfad. Provenienz ist strukturell erzwungen, nicht per Konvention erhofft.
5. **Ein Connector-Vertrag für alles Externe.** GitHub-RDF, Obsidian-Vault, JSON-Canvas, A2A-Card, MCP-Resource, SPARQL-Endpoint, und das eigene Git-Backup-Repo sind Instanzen desselben Interfaces. Kein Feature bekommt eine Sonderpipeline.
6. **Das System ist selbstbeschreibend.** Connectors, föderierte Endpoints, Sync-Zustände, Runtime-Konfiguration sind selbst Knoten im Graphen (`graph/meta`), nicht Einträge in einer parallelen JSON-Datei.
7. **Runtime-Austauschbarkeit.** Core-Code kennt nur Interfaces (`GraphStore`, `FileSystemLike`, `GitProvider`, `AuthProvider`). Kein `if (isBrowser)` außerhalb der Adapter.
8. **Fremdes Vokabular vor eigenem.** Ein eigenes Prädikat wird nur eingeführt, wenn nachweislich kein etablierter Standard-Term existiert. Die Begründung steht in der Ontologie-Datei als `rdfs:comment`.
9. **Kein `any` im neuen Graph-Code.** `@rdfjs/types` liefert die Typen. Neue Dateien unter `src/lib/graph/` erben keine Alt-Warnings.
10. **Keine Attrappen** (aus `AGENTS.md`): Ein nicht implementierter Connector erscheint nicht in der UI. Lieber ehrlich als geplant markiert.

---

## 3. Datenmodell

### 3.1 Kern

- RDF 1.2 Datenmodell, Quads (Subjekt, Prädikat, Objekt, Graph).
- **RDF-star / quoted triples** für Aussagen über Aussagen. Damit sind Kanten-Properties (Konfidenz, Herkunft, Gültigkeitszeitraum einer einzelnen Kante) darstellbar, ohne klassische Reifikations-Boilerplate. Das ersetzt jede Erwägung eines Property-Graph-Modells.
- Literale mit `xsd`-Datentypen und `@lang`-Tags. Deutsche Inhalte tragen `@de`, englische Slugs sind Teil der IRI, nicht des Literals.

### 3.2 IRI-Strategie

**Drei** Basen, strikt getrennt. Die Trennung von 1 und 2 ist die zentrale Voraussetzung dafür, dass zwei open-workspace-Installationen überhaupt föderieren können.

| | Zweck | Wert | variiert pro Deployment? |
|---|---|---|---|
| **1. Vokabular-Base** | Die Ontologie des Produkts. Für **jede** Installation weltweit identisch. | `https://pajew-ski.github.io/open-workspace/ns/v1#`, Prefix `ow:` | **nein, niemals** |
| **2. Erweiterungs-Base** | Terme, die eine konkrete Installation zusätzlich braucht und die es im Produktvokabular nicht gibt | `<deploymentBase>/ns/ext#`, Prefix `owx:` | ja |
| **3. Instanz-Base** | Die Entitäten dieser Installation | `OW_INSTANCE_BASE`, siehe unten | ja |

**Warum die Vokabular-Base nicht mitwandern darf**: Wenn Deployment A `https://a.example/ns/v1#Task` prägt und Deployment B `https://b.example/ns/v1#Task`, dann sind das für jeden RDF-Client zwei unterschiedliche, unverwandte Klassen. Eine Query gegen beide Instanzen findet nichts Gemeinsames, jede Föderation bräuchte eine handgepflegte `owl:equivalentClass`-Matrix, und das Vokabular wäre kein Vokabular mehr, sondern pro Installation ein neues. Das ist exakt der Grund, warum jede Website `https://schema.org/Person` benutzt und nicht `https://meinesite.de/ns/Person`. Das Vokabular ist Teil des **Produkts**, nicht des Deployments; es wandert mit dem Code, nicht mit dem Host.

Regeln:

- Die Vokabular-Base ist eine Konstante im Code (`src/lib/graph/vocab.ts`), **nicht** konfigurierbar. Ein Deployment kann sie nicht überschreiben.
- Jede Installation lädt beim Start eine mitgelieferte Kopie der Ontologie nach `graph/vocab`. Reasoning und Validierung funktionieren damit vollständig offline und ohne Netzzugriff auf die Vokabular-URL. Die URL muss dereferenzierbar sein, damit *fremde* Clients Terme auflösen können — die eigene Installation ist nicht darauf angewiesen.
- **Erweiterungsterme**: Braucht eine Installation ein eigenes Prädikat, entsteht es unter `owx:` an ihrem eigenen Base-Path und trägt `rdfs:subPropertyOf`/`rdfs:subClassOf` auf den nächstliegenden `ow:`- oder Standard-Term. Damit bleibt es für fremde Clients auf der Oberklasse auswertbar, auch wenn sie den Spezialterm nicht kennen. Die Erweiterungsontologie wird unter `<deploymentBase>/ns/ext` ausgeliefert.
- Ein Fork des Produkts, der das Vokabular substanziell ändert, prägt eine eigene Vokabular-Base und dokumentiert die Alignments. Das ist ein bewusster Akt, kein Konfigurationswert.

Regeln für die Instanz-Base:

- Runtime `server` oder `ha-addon` mit erreichbarer Adresse: `https://<host><basePath>/id/` — dereferenzierbar, damit föderierbar. Der HA-Ingress-Base-Path ist hier zwingend einzurechnen.
- Runtime `local` (Browser-only, ohne Domain): `urn:ow:<instance-uuid>:` — bei erster Initialisierung ein UUIDv4, persistiert. Nicht dereferenzierbar, aber kollisionsfrei; entscheidend, damit zwei lokale Installationen desselben Nutzers beim späteren Merge nicht dieselben Entitäten behaupten.
- Bei Multi-User (§17) ist die Nutzer-ID Teil des Entitäts-IRI-Pfads, nicht der Base.
- Ein Wechsel der Instanz-Base ist eine Migration mit `owl:sameAs`-Brücke, kein Suchen-und-Ersetzen. Implementiere `migrateInstanceBase(old, new)` inklusive Brückentripel. Der Fall tritt real ein: lokale PWA wird später auf einen Server gehoben.
- `https://exocortex.local` verschwindet ersatzlos aus dem Code.

Entitäts-IRI-Muster: `<instanceBase>[u/<userId>/]<type>/<stable-id>`, z. B. `urn:ow:8f3a…:doc/architecture-agents` oder `https://ws.example.org/id/u/michael/doc/architecture-agents`. Die ID ist stabil über Umbenennungen; der Slug ist ein `dcterms:identifier`, nicht die Identität.

### 3.3 Named Graphs

Alle inhaltstragenden Graphen sind **nutzerskaliert**, auch im Single-User-Betrieb. `<u>` steht für `u/<userId>`; in den Runtimes `local` und `ha-addon` ist das ein fester Default-Nutzer. Damit ist der Weg zu Multi-User (§17) eine Konfigurationsfrage und keine Datenmigration.

| Graph-IRI | Inhalt | Schreibrecht | Scope |
|---|---|---|---|
| `<base>graph/<u>/workspace` | Nativ erzeugte Aussagen des Nutzers | UI, Agent, API des Eigentümers | privat per Default |
| `<base>graph/<u>/public` | Bewusst veröffentlichter Teil des Nutzergraphen | Eigentümer | öffentlich lesbar |
| `<base>graph/<u>/import/<connectorId>` | Materialisierte externe Quelle | ausschließlich der Connector | erbt vom Eigentümer |
| `<base>graph/<u>/presentation` | Canvas-Layout, Positionen, Farben, Viewport | Canvas-UI | privat |
| `<base>graph/<u>/inferred/<scope>` | Reasoner-Output, **partitioniert nach Sichtbarkeits-Scope** (§7.3) | Reasoning-Pipeline, vollständiger Replace | wie der Scope |
| `<base>graph/shared/<spaceId>` | Von mehreren Nutzern geteilte Räume | Mitglieder laut ACL | laut ACL |
| `<base>graph/meta` | Connector-Registry, Endpoint-Registry, Sync-State, Schema-Version, Selbstmodell (§18) | Systemkomponenten | lesbar für Authentifizierte |
| `<base>graph/acl` | Zugriffsregeln (§17) | ausschließlich Admin-Pfad | nie über SPARQL lesbar |
| `<base>graph/shapes` | SHACL-Shapes | Konfiguration/Import | lesbar |
| `<base>graph/vocab` | Kopie der eigenen, der Erweiterungs- und importierter Vokabulare | Vokabular-Loader | öffentlich lesbar |

- `presentation` und `inferred` sind aus dem Default-Dataset jeder Nutzer-Query ausgeschlossen und nur über explizites `FROM NAMED` erreichbar.
- `graph/acl` ist aus **jedem** Dataset ausgeschlossen, auch mit explizitem `FROM NAMED`. Wer die Regeln lesen kann, kann sie kartieren. Zugriff ausschließlich über die Admin-API.

Implementiere beides im Query-Layer, nicht als Dokumentationshinweis.

---

## 4. Vokabular

### 4.1 Wiederverwendete Vokabulare

`schema:` (schema.org), `dcterms:`, `prov:`, `foaf:`, `skos:`, `rdfs:`, `owl:`, `sh:`, `xsd:`. Optional und nur bei Bedarf: `as:` (Activity Streams 2.0) für aktivitätsbasierte Föderation — bis dahin nicht laden.

### 4.2 Mapping-Tabelle (verbindlich)

| Workspace-Entität | Primärtyp | Zusatztypen | Schlüssel-Prädikate |
|---|---|---|---|
| Document | `schema:DigitalDocument` | `ow:Document`, polymorph weiter zu `schema:TechArticle`/`BlogPosting`/`HowTo` je Tag | `schema:text`, `dcterms:identifier` (Slug), `schema:inLanguage`, `ow:linksTo`, `schema:about` |
| Project | `schema:Project` | `ow:Project` | `schema:name`, `dcterms:created` |
| Task | `schema:Action` | `ow:Task` | `schema:actionStatus`, `ow:inProject`, `ow:blockedBy`, `ow:subTaskOf`, `schema:endTime` (due) |
| Canvas | `ow:Canvas` (`rdfs:subClassOf schema:CreativeWork`) | | `schema:hasPart` → Canvas-Knoten, `ow:rendersNode` |
| Skill | `ow:Skill` (`rdfs:subClassOf schema:HowTo`) | | `ow:trigger`, `ow:skillSource`, `schema:step` |
| Agent | `foaf:Agent` | `schema:SoftwareApplication`, `ow:Agent` | `ow:agentCardUrl`, `ow:providesSkill`, `ow:endpoint`, `ow:securityScheme` |
| Tool | `ow:Tool` | | `ow:inputSchema` (JSON-Schema als Literal), `ow:providedBy` → MCP-Server |
| MCP-Server | `ow:ToolProvider` | `schema:SoftwareApplication` | `ow:endpoint`, `ow:transport` |
| Tag | `skos:Concept` | | `skos:prefLabel`, `skos:broader` (verschachtelte Tags) |
| Conversation | `schema:Conversation` | | `schema:hasPart` → `schema:Message` |
| Message | `schema:Message` | | `schema:text`, `schema:sender`, `schema:dateSent` |
| Kalendereintrag | `schema:Event` | | `schema:startDate`, `schema:endDate`, `schema:location` |
| Person | `schema:Person` | `foaf:Person` | |
| Connector-Instanz | `ow:Connector` | `prov:Agent` | `ow:connectorKind`, `ow:locator`, `ow:revision`, `ow:syncState`, `ow:targetGraph` |
| Föderierter Endpoint | `ow:FederatedEndpoint` | `void:Dataset` (optional) | `ow:sparqlEndpoint`, `ow:trustLevel` |

### 4.3 Eigene Terme

Nur diese, jeder mit `rdfs:comment`-Begründung, warum kein Standard-Äquivalent existiert:

`ow:Document`, `ow:Project`, `ow:Task`, `ow:Canvas`, `ow:Skill`, `ow:Agent`, `ow:Tool`, `ow:ToolProvider`, `ow:Connector`, `ow:FederatedEndpoint`
`ow:linksTo` (`rdfs:subPropertyOf schema:mentions`, für untypisierte Wikilinks)
`ow:blockedBy` (`owl:inverseOf ow:blocks`), `ow:subTaskOf`, `ow:inProject`
`ow:trigger`, `ow:providesSkill`, `ow:agentCardUrl`, `ow:endpoint`, `ow:securityScheme`, `ow:transport`, `ow:inputSchema`, `ow:providedBy`
`ow:connectorKind`, `ow:locator`, `ow:revision`, `ow:syncState`, `ow:targetGraph`, `ow:sparqlEndpoint`, `ow:trustLevel`
`ow:inFolder` (Vault-Pfad als Konvention), `ow:rendersNode`

Die Agent-Prädikate spiegeln bewusst die Feldnamen der A2A-AgentCard (`endpoints`, `securitySchemes`, `skills`), damit eine spätere Brücke zu A2A eine Umbenennung ist und kein Remodelling.

### 4.4 Dereferenzierbarkeit (Pflicht, sonst ist „Föderation" nur ein Wort)

- Die Ontologie liegt als `ontology/ow.ttl` im Repo und wird per GitHub Pages unter der Vokabular-Base ausgeliefert.
- Content Negotiation: `text/turtle`, `application/ld+json`, `text/html` (menschenlesbare Doku, generiert). Da GitHub Pages keine echte Conneg kann: statische Ausgabe aller drei Repräsentationen plus HTML-Seite mit `<link rel="alternate">` und eingebettetem JSON-LD. Das ist die pragmatische, praktisch funktionierende Variante — dokumentiere die Einschränkung.
- Jeder `ow:`-Term hat `rdfs:label` (de+en), `rdfs:comment`, `rdfs:isDefinedBy`, und wo zutreffend `rdfs:subClassOf`/`rdfs:subPropertyOf`/`owl:equivalentClass` auf Standard-Vokabular.
- Versionierung: `/ns/v1#` ist eingefroren. Breaking Changes ergeben `/ns/v2#` plus `owl:equivalentClass`-Brücken. Nie ein bestehender Term umdefiniert.
- CI-Check: `ontology/ow.ttl` parst, jeder in `src/lib/graph/vocab.ts` verwendete `ow:`-Term existiert dort, jeder dort definierte Term ist erreichbar. Bricht den Build.

---

## 5. Store und Runtimes

### 5.1 Store-Interface

`src/lib/graph/store/types.ts`:

```ts
import type { Quad, NamedNode, DatasetCore } from '@rdfjs/types';

export interface QueryOptions {
  defaultGraphs?: NamedNode[];
  namedGraphs?: NamedNode[];
  timeoutMs?: number;
  /** Erzwingt Read-Only, auch wenn die Query ein UPDATE ist. */
  readOnly?: boolean;
}

export type QueryResult =
  | { type: 'bindings'; bindings: AsyncIterable<Record<string, Term>> }
  | { type: 'quads';    quads: AsyncIterable<Quad> }
  | { type: 'boolean';  value: boolean };

export interface LoadReport { added: number; removed: number; graph: NamedNode; }

export interface GraphStore {
  query(sparql: string, opts?: QueryOptions): Promise<QueryResult>;
  update(sparql: string, opts?: QueryOptions): Promise<void>;
  load(quads: AsyncIterable<Quad>, graph: NamedNode, opts?: { replace?: boolean }): Promise<LoadReport>;
  dump(graph?: NamedNode): AsyncIterable<Quad>;
  graphs(): Promise<NamedNode[]>;
  transaction<T>(fn: (tx: GraphStore) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}
```

**Implementierung**: [Oxigraph](https://github.com/oxigraph/oxigraph) über das npm-Paket (WASM). Vollständiges SPARQL 1.1 Query + Update, RDF-star, Quad-Store, läuft in Browser und Node aus demselben Artefakt. Damit ist die Store-Schicht über alle drei Runtimes identisch und `GraphStore` hat genau eine ernstzunehmende Implementierung plus ein In-Memory-Test-Double.

**Falls Oxigraph-WASM im Browser an Persistenz oder Bundle-Größe scheitert**: Fallback ist `quadstore` + `quadstore-comunica` über IndexedDB. Diese Entscheidung ist in M0 zu treffen und mit Messwerten (Bundle-Größe, Ladezeit, Query-Latenz auf 100k Tripeln) im Repo zu belegen — nicht nach Gefühl. *(Entschieden: Oxigraph — siehe `docs/decisions/0001-graph-store.md`.)*

### 5.2 Runtime-Adapter

```ts
export type RuntimeId = 'local' | 'ha-addon' | 'server';

export interface RuntimeAdapter {
  readonly id: RuntimeId;
  store(): Promise<GraphStore>;
  files(): FileSystemLike;      // OPFS-Wrapper | node:fs/promises
  git(): GitProvider;           // isomorphic-git | Prozess-git
  auth(): AuthProvider;
  secrets(): SecretStore;
  capabilities: {
    sparqlEndpoint: boolean;    // false bei 'local'
    mcpServer: boolean;         // false bei 'local' (braucht HTTP)
    federationOutbound: boolean;// CORS-abhängig bei 'local'
    federationInbound: boolean; // nur 'ha-addon' | 'server'
    multiUser: boolean;         // nur 'server'
    reasoningTier: 'rl' | 'rl+dl';
  };
}
```

**Namensklärung**: Die drei Runtimes heißen `local`, `ha-addon`, `server`. „Standalone" wird im gesamten Repo nicht mehr als Runtime-Bezeichnung verwendet, weil es je nach Kontext für „ohne Backend" und für „eigener Server" gelesen wurde.

| Runtime | Backend-Option | Store | Persistenz | Git | Auth | Multi-User |
|---|---|---|---|---|---|---|
| `local` | Option 1 | Oxigraph-WASM im Worker | OPFS + `navigator.storage.persist()` | `isomorphic-git` über OPFS-fs-Shim, Push über CORS-fähigen Host oder konfigurierbaren Proxy | keine (Single-User-Gerät) | nein |
| `ha-addon` | Option 2 | Oxigraph im Container | Add-on-`/data`-Volume | Prozess-`git` | Home Assistant (Ingress-Header, Long-Lived Token) | nein, ein Nutzer |
| `server` | Option 3 | Oxigraph im Container | Docker-Volume | Prozess-`git` | OIDC, `AuthProvider` liefert Identität + Gruppen | **ja, Zielausbau** |

`local` braucht weder SPARQL-Endpoint noch MCP-Server nach außen — der Store ist In-Process erreichbar. `ha-addon` und `server` exponieren beides. Die UI blendet nicht verfügbare Funktionen aus, statt sie tot anzuzeigen.

Zusätzliche Anforderungen:

- HA-Ingress proxied unter dynamischem Base-Path. Alle absoluten Pfade in der PWA müssen `basePath`-fähig sein; Service Worker Scope entsprechend. Das ist ein bekannter Stolperstein und gehört in den E2E-Test.
- `ha-addon` und `server` teilen **dasselbe Container-Image**. Unterschied ist ausschließlich das Packaging (`config.yaml` + `run.sh` vs. `docker-compose.yml`) und die Auth-Bindung. Ein zweiter Dockerfile ist ein Review-Blocker.
- Der Store läuft im Browser in einem Web Worker. Die UI blockiert nie auf einer Query.

### 5.3 Repo-Struktur

```
src/lib/graph/
  vocab.ts              # Prefixes, Term-Konstanten, IRI-Builder
  iri.ts                # Instanz-Base, Entitäts-IRIs, Migration
  store/                # GraphStore-Interface + Oxigraph-Impl + Memory-Double
  connectors/           # Connector-Framework + je ein Verzeichnis pro Kind
  reasoning/            # SHACL, OWL-RL-Regeln, Pipeline
  serialize/            # Turtle/N-Quads/JSON-LD/TriG, Kanonisierung
  projection/           # Ausgänge: schema.org-View, Obsidian, JSON-Canvas, GraphML
  federation/           # Endpoint-Registry, SERVICE-Proxy, Authz-Rewriting
  search/               # Volltext + Embeddings
src/lib/platform/
  runtime/              # RuntimeAdapter + 3 Implementierungen
ontology/
  ow.ttl                # Das Vokabular
  shapes/               # SHACL-Shapes
  rules/                # N3-Regeln für OWL RL
data/graph/             # Serialisierter Store (Git-Working-Tree, §8)
```

---

## 6. Connector-Framework

### 6.1 Vertrag

`src/lib/graph/connectors/types.ts`:

```ts
export type ConnectorMode = 'materialize' | 'federate';

export interface SourceRef {
  id: string;               // stabile Connector-Instanz-ID (auch Named-Graph-Suffix)
  kind: string;
  locator: string;          // Repo-URL, Vault-Pfad, SPARQL-Endpoint, Agent-Card-URL
  revision?: string;        // commit-sha | etag | mtime-hash
  fetchedAt?: string;       // xsd:dateTime
}

export interface ConnectorContext {
  store: GraphStore;
  runtime: RuntimeAdapter;
  iri: IriFactory;
  signal: AbortSignal;
  report(progress: { done: number; total?: number; note?: string }): void;
}

export interface QuadDelta { added: Quad[]; removed: Quad[]; }

export interface WriteReceipt {
  mode: 'direct' | 'pull-request';
  url?: string;             // html_url bei PR
  revision: string;
}

export interface Connector<TConfig = unknown> {
  readonly kind: string;
  readonly mode: ConnectorMode;
  readonly capabilities: { read: boolean; write: boolean; watch: boolean; lossyExport: boolean };

  configSchema(): JSONSchema;
  probe(config: TConfig, ctx: ConnectorContext): Promise<SourceRef>;

  /** mode === 'materialize' */
  pull?(ref: SourceRef, ctx: ConnectorContext): AsyncIterable<Quad>;

  /** mode === 'federate' */
  endpoint?(ref: SourceRef): { url: string; auth?: AuthHint };

  /** optional, bidirektional */
  push?(ref: SourceRef, delta: QuadDelta, ctx: ConnectorContext): Promise<WriteReceipt>;
  reconcile?(ref: SourceRef, ctx: ConnectorContext): Promise<ConflictReport>;
}
```

### 6.2 Regeln

- **Materialisierende Connectors** schreiben ausschließlich in `graph/import/<connectorId>`, immer mit `replace: true`. Kein inkrementelles Mergen in einen Import-Graphen — der Graph ist ein Spiegel, kein Arbeitsbereich.
- **Föderierende Connectors** schreiben nichts. Sie registrieren nur einen Endpoint in `graph/meta`.
- Jeder Connector schreibt bei jedem Lauf PROV-Tripel: `prov:wasDerivedFrom` auf die Quelle, `prov:generatedAtTime`, `prov:wasAttributedTo` auf die Connector-Instanz, `ow:revision`.
- **Schreibrichtung bei fremden Repos**: `push` nutzt grundsätzlich Branch → Commit → Pull Request und gibt die `html_url` im `WriteReceipt` zurück. Direct-Write nur, wenn der Nutzer es pro Connector-Instanz explizit aktiviert hat.
- Konflikterkennung über `revision`: Weicht die aktuelle Quell-Revision von der bei `pull` gespeicherten ab, ist `push` ohne vorheriges `reconcile` verboten.

### 6.3 Connector-Katalog

| Kind | Modus | Read | Write | Zweck |
|---|---|---|---|---|
| `rdf-file` | materialize | ✓ | – | Turtle/JSON-LD/N-Quads/RDF-XML von URL oder Upload |
| `github-rdf` | materialize | ✓ | ✓ (PR) | prima-materia und vergleichbare Repos: Ordner mit `.ttl`/`.jsonld`, commit-pinned |
| `git-backup` | materialize | ✓ | ✓ | Das eigene Backup-Repo (§8) — derselbe Connector, keine Sonderlogik |
| `obsidian-vault` | materialize | ✓ | ✓ (verlustbehaftet) | §10 |
| `json-canvas` | materialize | ✓ | ✓ | Fremde `.canvas`-Dateien → `graph/presentation` + Knotenreferenzen |
| `sparql-endpoint` | federate | ✓ | – | Wikidata, DBpedia, zweite eigene Instanz |
| `a2a-agent-card` | materialize | ✓ | – | Agent-Cards aus `src/lib/ai/a2a/client.ts` als `ow:Agent`-Knoten |
| `mcp-server` | materialize | ✓ | – | Tools/Prompts/Resources eines MCP-Servers als `ow:Tool`/`ow:Skill` |
| `graphml` | materialize | ✓ | ✓ | Gephi/yEd/Neo4j-Interop, verlustbehaftet (dokumentieren) |
| `skos-scheme` | materialize | ✓ | – | Fremde Taxonomien |
| `webpage-jsonld` | materialize | ✓ | – | Eingebettetes JSON-LD einer beliebigen URL ernten |

Reihenfolge der Umsetzung: siehe Meilensteine. Nicht alle auf einmal.

---

## 7. Query, Reasoning, Föderation

### 7.1 SPARQL

- `POST/GET /api/graph/sparql`: SPARQL 1.1 Protocol, Content Negotiation für SPARQL-Results-JSON/XML/CSV sowie Turtle/JSON-LD/N-Quads bei CONSTRUCT/DESCRIBE.
- Getrennter Update-Pfad, der Authz erzwingt. Ein GET darf nie ein UPDATE ausführen.
- Im Browser-only-Modus existiert der Endpoint als **In-Process-API** mit identischer Signatur, nicht als HTTP-Route. `capabilities.sparqlEndpoint = false` steuert die UI.
- SPARQL-Editor in der UI: Syntax-Highlighting, Prefix-Autovervollständigung aus `graph/vocab`, Ergebnistabelle, Ergebnis-als-Graph-Ansicht, gespeicherte Queries als `ow:`-Entitäten im Graph.

### 7.2 SHACL

- Shapes in `ontology/shapes/`, geladen nach `graph/shapes`.
- Validierung an drei Stellen: vor jedem Schreibvorgang aus der UI, nach jedem Connector-`pull`, und on demand im Graph-Explorer.
- Verletzungen blockieren nicht per Default, sondern erzeugen einen Validierungsbericht als Graph. Blockierend nur für Shapes mit `sh:severity sh:Violation` auf Kern-Entitäten.
- Library: `shacl-engine` oder `rdf-validate-shacl`, in M7 zu evaluieren.

### 7.3 OWL Reasoning, zwei Tiers

**Tier 1 — OWL RL, immer verfügbar, in allen drei Runtimes.** Regelbasiertes Forward-Chaining, Polynomialzeit. Implementierung über N3-Regeln mit `eye-js` (EYE als WASM, läuft in Browser und Node) oder eine eigene, auf das tatsächlich genutzte Fragment beschränkte Regelmenge. Abgedecktes Fragment mindestens: `rdfs:subClassOf`, `rdfs:subPropertyOf`, `rdfs:domain`/`range`, `owl:inverseOf`, `owl:TransitiveProperty`, `owl:SymmetricProperty`, `owl:equivalentClass`/`equivalentProperty`, `owl:sameAs`.

Praktischer Nutzen, der das rechtfertigt: `ow:blockedBy`/`ow:blocks` als Inverse, Tag-Hierarchien über `skos:broader` als transitiv, `owl:sameAs`-Brücken zwischen importierten und nativen Entitäten.

**Tier 2 — OWL DL, optional, nur `server`/`ha-addon`.** Sidecar-Container mit HermiT oder Pellet, per HTTP angebunden, für Konsistenzprüfung und komplexe Klassenausdrücke. Niemals eine Kern-Dependency — der Browser-Modus muss ohne JVM vollständig funktionsfähig bleiben. `capabilities.reasoningTier` steuert die UI.

**Materialisierung**: Der Reasoner läuft auf Anforderung und nach jedem Import, schreibt vollständig neu nach `graph/<u>/inferred/<scope>`, mit `prov:wasGeneratedBy` auf den Reasoning-Lauf. Kein Query-Time-Reasoning in v1.

**Inferenz-Leak (kritisch, sobald Multi-User aktiv ist)**: Reasoning über ein gemischtes Dataset erzeugt Tripel, die aus privaten *und* öffentlichen Aussagen folgen. Landen die im öffentlich lesbaren Bereich, ist die private Aussage rekonstruierbar, ohne dass sie je gelesen wurde. Beispiel: `owl:sameAs` zwischen einer öffentlichen und einer privaten Entität exportiert deren gesamte private Nachbarschaft in die öffentliche Sicht.

Konsequenz, verbindlich: Der Reasoner läuft **einmal pro Sichtbarkeits-Scope** über genau das Dataset, das dieser Scope sehen darf, und schreibt in einen scope-eigenen Inferenz-Graphen. Ein Inferenz-Graph darf niemals ein Dataset speisen, das weniger sieht als das Dataset, aus dem er erzeugt wurde. Ein Test muss das nachweisen: eine private Aussage plus eine öffentliche Regel darf im öffentlichen Inferenz-Graphen keine Spur hinterlassen.

### 7.4 Föderation

- Endpoint-Registry in `graph/meta` als `ow:FederatedEndpoint`-Knoten mit `ow:trustLevel`.
- `SERVICE`-Queries gegen registrierte Endpoints. Im Browser ist Föderation CORS-abhängig — probe pro Endpoint und markiere nicht erreichbare in der UI ehrlich als solche.
- **Föderations-Sicherheit ist Teil dieses Meilensteins, nicht danach.** Ein roher SPARQL-Endpoint kennt keine Berechtigungen: jede eingehende Query sieht, was der Store sieht. Deshalb:
  - Eingehende Queries laufen niemals direkt gegen den Store, sondern durch einen Rewriter, der das erlaubte Dataset (`FROM`/`FROM NAMED`) aus der authentifizierten Identität ableitet und in die Query injiziert. Nicht als Nachfilter auf dem Ergebnis.
  - Default für unauthentifizierte Zugriffe: leeres Dataset. Freigabe pro Named Graph explizit.
  - Ausgehende `SERVICE`-Aufrufe respektieren die bestehende SSRF-Absicherung aus `src/lib/net/private.ts`. Kein `SERVICE` auf private Adressbereiche ohne Whitelist.
  - Query-Timeouts und Ergebnis-Limits sind Pflicht, nicht optional.

### 7.5 Multi-Hop-Retrieval (nativ)

Erstklassige API, keine ad-hoc-Query. Das Verfahren, das temet-nosce als Neo4j-Prototyp erprobt hat, wird hier zur Kernfunktion des Stores — nicht als Portierung des Codes, sondern als Neuimplementierung gegen SPARQL und RDF-star.

**Pipeline**, vier Phasen, jede einzeln testbar und einzeln parametrisierbar:

1. **Seeding** — Einstiegsknoten bestimmen. Drei kombinierbare Quellen: exakte IRIs, Volltexttreffer (§7.7), Vektorähnlichkeit (§7.7). Jeder Seed trägt einen Score.
2. **Expansion** — von den Seeds über bis zu `maxHops` Kanten laufen. Steuerbar über: Kantentyp-Whitelist/Blacklist, Richtung (aus-, ein-, beidseitig), Named-Graph-Filter, Knotentyp-Filter, Grad-Kappung pro Knoten (verhindert Explosion an Hub-Knoten wie häufigen Tags).
3. **Scoring** — Relevanz je erreichtem Knoten aus: Seed-Score, Hop-Distanz mit konfigurierbarem Decay, Kantengewicht (aus RDF-star-Annotation, falls vorhanden), Knoten-Zentralität, Aktualität. Deterministisch und erklärbar.
4. **Assembly** — Ergebnis als Subgraph plus linearisierter Kontext. Beide Ausgänge sind Pflicht: der Subgraph für die UI und für weiterverarbeitende Agenten, der linearisierte Text als LLM-Kontext mit Token-Budget-Kappung entlang der Score-Reihenfolge.

```ts
export interface RetrievalRequest {
  seeds?: { iri?: string[]; text?: string; vector?: number[] };
  maxHops: number;                    // 1..4, Default 2
  maxNodes: number;                   // harte Kappung, Default 50
  edgeTypes?: { include?: string[]; exclude?: string[] };
  nodeTypes?: { include?: string[]; exclude?: string[] };
  direction: 'out' | 'in' | 'both';
  graphs?: string[];                  // Default: erlaubtes Dataset des Aufrufers
  decay: number;                      // 0..1 pro Hop, Default 0.5
  maxDegree?: number;                 // Hub-Kappung, Default 100
  includeInferred: boolean;           // Default false
  format: 'subgraph' | 'context' | 'both';
  tokenBudget?: number;               // nur bei 'context' | 'both'
}

export interface RetrievalResult {
  nodes: Array<{ iri: string; score: number; hop: number; types: string[]; label?: string }>;
  edges: Array<{ s: string; p: string; o: string; graph: string; inferred: boolean }>;
  context?: string;                   // linearisiert, zitierfähig
  provenance: Array<{ iri: string; sourceGraph: string; connector?: string }>;
  truncated: boolean;
  explain: { seedStrategy: string; hopsUsed: number; prunedAt?: string[] };
}
```

**Verbindliche Eigenschaften**:
- `explain` ist Pflicht, nicht optional. Ein Retrieval, dessen Auswahl nicht nachvollziehbar ist, ist als Agentenwerkzeug wertlos.
- `provenance` je Knoten: aus welchem Graphen, über welchen Connector. Ein Agent muss unterscheiden können, ob eine Aussage nativ, importiert oder inferiert ist.
- Das Dataset ist **immer** das für den Aufrufer erlaubte (§17). Retrieval ist der wahrscheinlichste Leak-Pfad, weil es Kanten überschreitet, die eine direkte Query nie angefasst hätte. Der Authz-Rewriter greift vor der Expansion, nicht danach.
- Zyklenschutz und harte Obergrenzen für Knoten, Kanten und Laufzeit. Kein unbegrenztes Traversieren.
- Gespeicherte Retrieval-Profile sind `ow:`-Entitäten im Graphen und damit selbst abfragbar.

### 7.6 MCP-Server (Retrieval nach außen)

Der Workspace ist bisher MCP-**Client** (`src/lib/ai/mcp/client.ts`). Er wird zusätzlich MCP-**Server**, damit externe Agenten auf dem Graphen retrieven können, ohne SPARQL zu sprechen.

Endpoint: `/api/mcp` (Streamable HTTP mit SSE-Fallback, `@modelcontextprotocol/sdk`). Nur in den Runtimes `ha-addon` und `server` (`capabilities.mcpServer`).

**Tools**:

| Tool | Zweck |
|---|---|
| `graph_search` | Volltext-/Vektorsuche, liefert Kandidaten-IRIs mit Score und Label |
| `graph_retrieve` | Multi-Hop-Retrieval nach §7.5, Parameter wie `RetrievalRequest`, Default `format: 'context'` |
| `graph_neighbors` | Direkte Nachbarschaft eines Knotens, ein Hop, günstig |
| `graph_describe` | Alle Aussagen über eine IRI, mit Provenienz |
| `graph_sparql` | Rohe SPARQL-Query, read-only, nur für Aufrufer mit entsprechendem Recht |
| `graph_write` | Optional, standardmäßig **aus**. Schreibt ausschließlich in einen dafür freigegebenen Graphen, immer mit `prov:wasAttributedTo` auf den aufrufenden Agenten. |

**Resources**: Knoten sind als MCP-Resources unter `graph://<iri>` adressierbar, mit `text/turtle`- und `application/ld+json`-Repräsentation. Damit können MCP-Clients Kontext referenzieren statt kopieren.

**Prompts**: gespeicherte Retrieval-Profile werden als MCP-Prompts exponiert.

**Sicherheit**: identische Authz wie SPARQL und Retrieval, kein zweiter Pfad. Ein MCP-Token ist an eine Identität und deren erlaubtes Dataset gebunden. Rate-Limits und Timeouts sind Pflicht. Der MCP-Server sieht nie mehr als der Nutzer, dessen Token er trägt.

### 7.7 Suche

SPARQL kann keine Ähnlichkeit. Ergänzend, gekoppelt über IRIs als gemeinsamen Schlüssel:

- **Volltext**: invertierter Index über alle Literale, im Browser über eine leichte JS-Lösung, serverseitig ebenso (keine Elasticsearch-Dependency). Exponiert als Custom-Function im Query-Layer plus als eigene API.
- **Embeddings**: optional, lokal über `transformers.js` (WebGPU, wo verfügbar) oder über einen konfigurierten Provider aus der bestehenden AI-Schicht. Vektorindex separat vom Triplestore. Jeder Vektor trägt die Subjekt-IRI.
- Der bestehende `workspace_finder` (Fuzzy/Levenshtein) wird auf den Graphen umgestellt, nicht durch ihn ersetzt.

---

## 8. Persistenz und Git-Sync

Git-Sync ist kein separates Feature, sondern die Serialisierung des Stores. Eine Implementierung, drei Runtimes.

### 8.1 Layout

```
data/graph/
  workspace.nq              # oder nach Subjekt-Präfix gesplittet bei Größe
  import/<connectorId>.nq
  presentation.nq
  meta.nq
  shapes/*.ttl
  vocab/*.ttl
  manifest.json             # Schema-Version, Graph-Liste, Kanonisierungs-Hashes
```

- `graph/inferred` wird **nicht** persistiert. Er ist reproduzierbar und würde bei jedem Reasoning-Lauf riesige Diffs erzeugen.
- Serialisierung deterministisch: Quads kanonisch sortiert, Blank-Node-Labels über RDF Dataset Canonicalization (RDFC-1.0, Paket `rdf-canonize`) stabilisiert. **Ohne das produziert jeder Dump einen anderen Diff und Git-Sync wird unbrauchbar.** Das ist eine harte Anforderung, kein Nice-to-have.
- Zusätzlich zur `.nq`-Serialisierung schreibt die Obsidian-Projektion (§10) ihre Markdown-Dateien in den Vault-Pfad, sofern konfiguriert. Beide Ausgänge, ein Store.

### 8.2 Sync-Modi

| Modus | Verhalten |
|---|---|
| `backup` | Einbahnstraße Store → Git. Commit + Push periodisch oder manuell. Store bleibt kanonisch. |
| `bidirectional` | Das Backup-Repo wird zusätzlich über den `git-backup`-Connector eingelesen. Externe Edits an `.ttl`/`.md`-Dateien fließen zurück. Konflikterkennung über `revision` wie bei jedem anderen Connector. |

Der zweite Modus darf **keine** eigene Codepfad-Familie bekommen. Wenn beim Bau der Eindruck entsteht, Backup-Logik dreimal zu schreiben, ist die Abstraktion falsch geschnitten.

### 8.3 Browser-Spezifika

- OPFS als Store-Backing, `navigator.storage.persist()` beim ersten Schreibvorgang anfordern, Ergebnis in der UI anzeigen (Nutzer muss wissen, ob seine Daten evictable sind).
- `isomorphic-git` mit fs-Shim auf OPFS. Push benötigt einen CORS-fähigen Git-Host oder einen konfigurierbaren CORS-Proxy — das ist eine echte Einschränkung des Browser-Modus und gehört ehrlich in die UI, nicht in eine Fußnote.
- Storage-Quota-Überwachung mit Warnung ab 80 %.
- Import/Export ohne Git: Download/Upload eines Zip mit dem kompletten `data/graph/`-Baum, plus Einzelformat-Export (Turtle, JSON-LD, N-Quads, TriG, GraphML, JSON-Canvas).

---

## 9. Canvas als Präsentationsschicht

- Ein Canvas ist ein `ow:Canvas`-Knoten im **semantischen** Graphen (er ist ein Ding, über das man Aussagen macht: Titel, Autor, Zugehörigkeit, Tags).
- Sein **Layout** — Position, Größe, Farbe, Gruppierung, Viewport — liegt ausschließlich in `graph/presentation` und referenziert semantische Knoten über `ow:rendersNode`.
- Ein Canvas ist damit ein gespeicherter, manuell kuratierter Subgraph-View: eine Auswahl von Knoten plus deren räumliche Anordnung. Er behauptet nichts über die Beziehungen der Dinge.
- **JSON-Canvas-Kompatibilität**: Import und Export nach der JSON-Canvas-1.0-Spec. Beim Export werden Kanten auf JSON-Canvas-`edges` abgebildet; Kantentypen gehen dabei verloren, da die Spec sie nicht kennt. Beim Import werden `edges` zu `ow:linksTo`, sofern kein Typ ableitbar ist. Die Verlustrichtung ist zu dokumentieren und in der UI vor dem Export anzuzeigen.
- Gruppen in JSON Canvas sind implizit über Position definiert, nicht über Parent-Child-Relationen. Nicht versuchen, daraus semantische Hierarchie zu rekonstruieren.
- Zusätzlich zu manuellen Canvases: **generierte Views** aus einer gespeicherten SPARQL-Query (Live-Subgraph). Diese haben kein persistiertes Layout, sondern ein Layout-Verfahren (force-directed, hierarchisch, radial).

---

## 10. Obsidian-Kompatibilität

Verlustbehaftete Projektion, in beide Richtungen, explizit als solche benannt.

| Obsidian | RDF | Richtung |
|---|---|---|
| Markdown-Datei | `ow:Document` mit `schema:text` | verlustfrei ↔ |
| YAML-Frontmatter-Key | Literal-Property auf der Node-IRI; bekannte Keys gemappt (`typ: begriff` → `ow:Document` + `skos:Concept`), unbekannte in `ow:`-Fallback-Namespace | ↔, unbekannte Keys per Round-Trip erhalten |
| `[[Wikilink]]` | `ow:linksTo` | Import verlustfrei; Export flacht **typisierte** Kanten (`prov:wasDerivedFrom` o. ä.) auf generische Wikilinks ab |
| `[[Ziel\|Alias]]` | `ow:linksTo` + Alias als RDF-star-Annotation an der Kante | ↔ |
| `#tag`, `#tag/unter` | `skos:Concept` mit `skos:broader` | ↔ |
| Backlinks | keine Speicherung; SPARQL-Query über eingehende Kanten | berechnet |
| Ordnerpfad | `ow:inFolder` (Literal) | ↔, keine erzwungene Hierarchie |
| `.canvas` | §9 | ↔ |
| Embeds `![[…]]` | `ow:linksTo` + RDF-star-Annotation `ow:embedded true` | ↔ |
| Dataview-Queries | nicht unterstützt | – |

Round-Trip-Test ist Pflicht: Vault → Store → Vault muss byte-nah identische Markdown-Dateien erzeugen (Frontmatter-Reihenfolge normalisiert). Jede Abweichung ist entweder ein Bug oder eine dokumentierte Verlustposition.

---

## 11. Graph-Explorer-UI

Ersetzt `src/app/graph/page.tsx`. Mobile-First nach `AGENTS.md`, unterliegt dem bestehenden a11y/mobile-E2E-Gate.

- **Visualisierung**: force-directed als Default, umschaltbar auf hierarchisch und radial. Knotengröße/Farbe aus Typ und Zentralitätsmaßen, berechnet, nicht gespeichert.
- **Filter**: nach Typ, Named Graph, Tag, Zeitraum, Provenienz (nativ vs. importiert vs. inferiert). Inferierte Kanten optisch unterscheidbar und per Default aus.
- **Navigation**: Fokus-Knoten mit Tiefenregler (1–3 Hops), Pfadsuche zwischen zwei Knoten, Nachbarschafts-Panel.
- **Inspektor**: alle ein- und ausgehenden Tripel eines Knotens, Provenienz, Quell-Link, Bearbeiten-Formular aus SHACL-Shapes generiert.
- **Query-Ansicht**: SPARQL-Editor mit Ergebnis-als-Graph, gespeicherte Queries.
- **Connector-Verwaltung**: Liste, Status, letzter Sync, Diff-Vorschau vor dem Übernehmen eines Imports, Konfliktanzeige.
- **Performance**: bei mehr als ~2000 sichtbaren Knoten Canvas/WebGL statt SVG, Level-of-Detail, Query-seitige Begrenzung statt clientseitigem Wegwerfen.

---

## 12. Migration vom Ist-Stand

Reihenfolge zwingend, jeder Schritt einzeln lauffähig und getestet.

1. ✅ `src/lib/graph/` neu anlegen, ohne Bestehendes anzufassen. Store + Vokabular + Serialisierung + Tests.
2. ✅ **Projektion aus dem Bestand**: ein einmaliger Migrator liest `data/docs/*.md`, `data/tasks/*.json`, `data/canvas/*.json` und erzeugt daraus `data/graph/workspace.nq`. Idempotent, wiederholbar, mit Vorher-Nachher-Bericht. (`bun run migrate:graph`)
3. ✅ `GET /api/graph` behält Route und Antwortformat (schema.org-`@graph`), generiert die Antwort aber per Query aus dem Store. **`color` und `val` fallen aus der Antwort weg**; die Graph-UI bezieht sie aus der Präsentationsschicht bzw. berechnet sie. Das ist ein bewusster Breaking Change am internen Contract.
4. ⬜ Schreibpfade umstellen: `src/lib/storage/*` schreibt weiterhin die Dateien (für Git-Lesbarkeit und Obsidian), aber über den Store als Wahrheitsquelle. Doppelte Wahrheit ist ein Übergangszustand mit Ablaufdatum, kein Zielzustand — markiere die Übergangsstellen mit `// MIGRATION:` und liste sie in `TODO.md`.
5. ✅ `src/lib/ontology/generator*.ts` wurde zu `src/lib/graph/projection/` und läuft nur noch aus dem Store bzw. als dessen View. Die alten Generatoren sind gelöscht, nicht auskommentiert.

---

## 13. Meilensteine

Jeder Meilenstein ist ein **eigener PR aus einer eigenen Session** mit eigenem Branch, grün durch das komplette Gate (`lint` 0 Errors, `typecheck`, `check:ontology`, `test:run`, `test:e2e`), mit aktualisierter `AGENTS.md`-Sektion und abgehaktem `TODO.md`.

**M0 — Fundament** ✅ *(PR #4)*
Vokabular `ontology/ow.ttl`, IRI-Strategie, `GraphStore`-Interface, Oxigraph-Anbindung (mit belegter Store-Entscheidung), deterministische Serialisierung inkl. RDFC-1.0.
*Abnahme*: Round-Trip Turtle → Store → N-Quads → Store ist RDF-isomorph inkl. Blank Nodes. Zweimaliger Dump desselben Zustands erzeugt byte-identische Dateien. Ontologie-CI-Check greift. **Erfüllt, als Tests verankert (`tests/graph/serialize.test.ts`).**

**M1 — Migration und Kompatibilität** ✅ *(PR #4; Rest: Schreibpfade, siehe §12.4)*
Migrator, `/api/graph` aus dem Store, Präsentations-Properties entfernt, `any` aus dem Graph-Pfad raus.
*Abnahme*: Bestehende Graph-UI funktioniert unverändert. Kein `data/`-Inhalt geht verloren, nachgewiesen durch Zähl-Assertions pro Entitätstyp. **Erfüllt.**

**M2 — SPARQL** ✅ *(Protokoll, PR #4)* / ⬜ *(Editor-UI)*
Endpoint (Runtime-abhängig HTTP oder In-Process), Editor-UI, gespeicherte Queries.
*Abnahme*: SELECT/CONSTRUCT/ASK/DESCRIBE und UPDATE über das Protokoll; Content Negotiation für mindestens SPARQL-JSON, Turtle, JSON-LD. **Protokoll erfüllt (`tests/graph/sparql-protocol.test.ts`); Editor-UI offen.**

**M3 — Connector-Framework + `rdf-file` + `github-rdf`** ⬜
prima-materia lässt sich per Repo-URL einbinden, commit-gepinnt, mit Provenienz. prima-materia ist der **Referenzfall** für Import und dient als mitgeliefertes Beispiel in der Onboarding-Strecke (§18).
*Abnahme*: Import erzeugt `graph/<u>/import/<id>`, PROV-Tripel vollständig, erneuter Pull bei unveränderter Revision ist ein No-Op, bei geänderter ein sauberer Replace.
*Zusätzliche Abnahme, weil die Quelle unreif ist*: Der Connector bricht bei fehlerhaftem Turtle, unbekannten Prädikaten, fehlenden Typen oder SHACL-Verletzungen **nicht** ab. Er importiert, was parst, quarantäniert den Rest in einem Fehlerbericht und meldet ihn in der UI. Ein Import darf nie an der Qualität der Quelle scheitern — das ist der Normalfall bei fremden Graphen, nicht die Ausnahme.

**M4 — Obsidian-Connector** ⬜
Import + Export, Round-Trip-Test, Verlustpositionen dokumentiert.
*Abnahme*: Vault → Store → Vault ist markdown-identisch bis auf normalisierte Frontmatter-Reihenfolge.

**M5 — Canvas und Präsentationsschicht** ⬜
`graph/presentation`, JSON-Canvas-Import/-Export, generierte Query-Views.
*Abnahme*: Ein in Obsidian erstelltes `.canvas` öffnet im Workspace und umgekehrt. Kein Layout-Wert im semantischen Graphen — durchgesetzt per Test, der `graph/workspace` gegen eine Blacklist von Präsentationsprädikaten prüft. *(Blacklist-Test existiert bereits: `tests/graph/migrate.test.ts`.)*

**M6 — Git-Sync in allen drei Runtimes** ⬜
`backup` und `bidirectional`, `git-backup` als regulärer Connector.
*Abnahme*: In jeder Runtime führt eine Änderung zu einem minimalen, lesbaren Diff. Eine externe Edit an einer `.ttl`-Datei kommt beim nächsten Pull im Store an.

**M7 — Reasoning** ⬜
SHACL-Validierung an den drei Stellen, OWL RL Tier 1, `graph/inferred`, DL-Sidecar optional.
*Abnahme*: `ow:blockedBy`/`ow:blocks` und `skos:broader`-Transitivität werden nachweislich inferiert. Kein inferiertes Tripel landet je in `graph/workspace`.

**M8 — Suche und Multi-Hop-Retrieval** ⬜
Volltext- und Embedding-Index, Retrieval-Pipeline nach §7.5, `workspace_finder` auf den Graphen umgestellt, Retrieval-Profile als Graph-Entitäten.
*Abnahme*: Ein Retrieval mit `maxHops: 2` über einen Seed liefert reproduzierbar dieselbe Knotenmenge in derselben Score-Reihenfolge. `explain` weist jeden aufgenommenen Knoten aus. Hub-Kappung greift nachweislich an einem Tag mit über 100 Dokumenten. Der linearisierte Kontext hält das Token-Budget ein.

**M9 — Agents, Skills, Tools als Graph-Bürger** ⬜
A2A-Cards, MCP-Server, Skills und Tools als Knoten.
*Abnahme*: Der Assistent kann per SPARQL beantworten, welche Skills welche Tools benötigen und welcher Agent sie anbietet.

**M10 — MCP-Server** ⬜
`/api/mcp` nach §7.6, Tools, Resources, Prompts, Rate-Limits.
*Abnahme*: Ein externer MCP-Client (Claude Desktop oder ein zweiter Workspace) verbindet sich, ruft `graph_retrieve` auf und erhält Kontext mit Provenienz. Ein Token ohne Leserecht auf einen Graphen sieht dessen Knoten auch über mehrere Hops nicht — Negativtest mit einem Seed, der über eine Kante in den gesperrten Graphen führt.

**M11 — Föderation** ⬜
Endpoint-Registry, `SERVICE`, Authz-Rewriting, SSRF-Schutz, Timeouts, eingehende Föderation für `ha-addon` und `server`.
*Abnahme*: Live-Query gegen Wikidata liefert Ergebnisse. Ein unauthentifizierter Zugriff auf den eigenen Endpoint sieht ausschließlich explizit freigegebene Named Graphs — nachgewiesen durch einen Negativtest, der eine Query mit manipuliertem `FROM` absetzt.

**M12 — Runtime-Vollausbau** ⬜
HA-Add-on-Packaging inkl. Ingress-Base-Path, `server`-Compose inkl. OIDC/TLS, aus einem Image.
*Abnahme*: Dasselbe Image läuft in beiden Kontexten. E2E-Test deckt den Ingress-Base-Path ab.

**M13 — Multi-User und feingranularer Zugriff (Zielausbau, nur `server`)** ⬜
Nutzergraphen, ACL-Modell, Public/Private-Split, geteilte Räume, scope-partitioniertes Reasoning, Admin-UI für Freigaben — vollständig nach §17.
*Abnahme*: Die Test-Matrix aus §17.6 läuft grün, jede Zeile als eigener Negativtest. Kein Pfad (SPARQL, Retrieval, MCP, Föderation, Volltext, Embeddings, Inferenz, Export, Fehlermeldung) gibt einem Nutzer Zugriff auf einen Graphen, für den er kein Leserecht hat.

---

## 14. Definition of Done (pro PR)

- `bun run lint` 0 Errors, `bun run typecheck` sauber, kein neues `any` unter `src/lib/graph/`.
- Unit-Tests für jede neue Serialisierung, jeden Connector, jedes Mapping.
- E2E-Gate (`mobile-navigation`, `mobile-ux`, `a11y`) grün, inklusive neuer Seiten.
- Ontologie-CI-Check grün (`bun run check:ontology`).
- Keine Attrappen: keine UI für nicht implementierte Connectors.
- `AGENTS.md` aktualisiert, `TODO.md` abgehakt, Migrationsstellen als `// MIGRATION:` markiert.
- Deutsche UI-Labels, du-Form, korrekte Umlaute, Mobile-First, FAB-Konventionen — unverändert nach `AGENTS.md`.

---

## 15. Nicht-Ziele für diesen Ausbau

Explizit ausgeschlossen, damit „alles was möglich ist" nicht in halbfertige Breite zerfällt:

- Kein Echtzeit-Collaborative-Editing (CRDT, gleichzeitige Bearbeitung desselben Dokuments). Multi-User im Sinne von §17 heißt: mehrere Nutzer, je eigene Graphen, geteilte Räume mit Zugriffssteuerung. Der Store bleibt single-writer **pro Graph**.
- Kein Solid-Pod, kein AT Protocol, kein DID, kein ActivityPub in v1. Das Vokabular ist so gesetzt, dass es später ohne Remodelling anschließbar ist — mehr nicht.
- Kein IPFS/IPLD-Content-Addressing.
- Kein Query-Time-Reasoning.
- Keine eigene Vektordatenbank als Service. Embeddings laufen im Prozess.
- Kein Neo4j/Property-Graph-Backend. RDF-star deckt den Bedarf ab.

---

## 16. Getroffene Entscheidungen

Verbindlich, nicht zur Diskussion des Agenten.

1. **Vokabular-Base-IRI**: global und produktweit konstant (§3.2). Deployment-spezifisch ist ausschließlich die **Erweiterungs**-Base `owx:` und die **Instanz**-Base. Ein Deployment prägt niemals Terme im `ow:`-Namespace. Begründung in §3.2.
2. **prima-materia**: reine Importquelle über `github-rdf`, kein Vokabular-Alignment in v1. Dient als Referenz- und Beispielfall für Import (M3) und in der Onboarding-Strecke (§18). Der Connector muss unreife Quellen vertragen — siehe M3-Abnahme.
3. **temet-nosce**: bleibt eigenständig, keine Föderation, keine Ablösung. Zwei Dinge werden übernommen, nicht der Code: das **Selbstverständnis-Muster** (§18) und das **Multi-Hop-Retrieval** (§7.5), Letzteres als Neuimplementierung gegen SPARQL statt als Portierung.
4. **Erreichbarkeit von außen**: `local` braucht keine externe Queryebarkeit. `ha-addon` und `server` exponieren SPARQL, MCP-Server und eingehende Föderation. Damit ist der Authz-Rewriter sicherheitskritisch und Teil von M11 und M13, nicht optional.
5. **Multi-User**: Zielausbau für Runtime `server` — siehe §17. `local` und `ha-addon` bleiben Ein-Nutzer-Systeme, verwenden aber dasselbe nutzerskalierte Graph-Layout, damit der Übergang keine Datenmigration ist.
6. **Store**: Oxigraph (WASM) — entschieden in M0 mit Messwerten, siehe `docs/decisions/0001-graph-store.md`. Fallback-Kriterium dort dokumentiert.

**Zur doppelten Wahrheit (Klarstellung)**: `data/docs/*.md` und `data/tasks/*.json` bleiben dauerhaft, aber asymmetrisch.

- Der RDF-Store ist die Wahrheit. Alle Dateien sind Projektion.
- Externe Bearbeitung der Dateien (Obsidian, Editor, Git-PR) ist erlaubt und **wird über den regulären Connector-Weg zurückgelesen** (`obsidian-vault`, `git-backup`), inklusive Revisionsprüfung und Konflikterkennung. Sie ist nicht „direkte Bearbeitung der Wahrheit", sondern ein Import.
- Was verschwindet, ist der dritte Zustand: die App liest nach der Migration nie wieder direkt aus `data/*.json`, um damit UI zu füllen. Genau diese Lesepfade sind mit `// MIGRATION:` markiert und haben ein Ablaufdatum — sie sind mit dem Abschluss von §12.4 beendet, nicht dauerhaft.

---

## 17. Multi-User, Nutzergraphen, feingranularer Zugriff

Gilt ausschließlich für Runtime `server`. `local` und `ha-addon` laufen mit einem impliziten Default-Nutzer durch dieselbe Codebahn.

### 17.1 Modell

- Jeder Nutzer ist ein Knoten (`schema:Person`, `foaf:Agent`) in `graph/meta` und besitzt einen eigenen Graph-Satz `graph/u/<userId>/*` (§3.3).
- Ein Nutzergraph zerfällt in mindestens zwei Sichtbarkeitsstufen: `workspace` (privat per Default) und `public` (bewusst veröffentlicht). Ein Knoten wandert nicht in den öffentlichen Graphen, er wird dorthin **kopiert oder verschoben** durch eine explizite Freigabehandlung, die als `prov:Activity` protokolliert wird.
- **Geteilte Räume** `graph/shared/<spaceId>` mit eigener Mitgliederliste. Ein Raum ist selbst eine Entität mit Eigentümer, Beschreibung und Mitgliedschaftsrollen.
- Gruppen als `foaf:Group`, Mitgliedschaft als Kante. Rechte werden an Nutzer **und** Gruppen vergeben.

### 17.2 ACL

- Regeln liegen in `graph/acl` als RDF, orientiert an **Web Access Control (WAC)** oder **ACP**. Nicht als eigenes JSON-Format — die Rechte gehören in dieselbe Welt wie die Daten, sonst gibt es zwei Wahrheiten.
- Granularität in v1: **pro Named Graph**, nicht pro Tripel. Tripel-Granularität ist eine offene Forschungsfrage mit erheblichen Kosten und kein Ziel dieses Ausbaus. Wer feiner unterscheiden will, schneidet den Graphen feiner.
- Modi: `read`, `append`, `write`, `control`. `append` ist wichtig für Räume, in denen jemand beitragen, aber nichts löschen darf.
- Prinzipale: konkreter Nutzer, Gruppe, `authenticated` (jeder eingeloggte), `public` (anonym).
- Default für jeden neu entstehenden Graphen: nur der Eigentümer, `control`. Nichts ist per Default sichtbar.

### 17.3 Durchsetzung

Ein einziger Punkt, durch den **alle** Lesepfade laufen: der Dataset-Resolver.

```ts
resolveDataset(identity: Identity, intent: 'read' | 'write'): { default: NamedNode[]; named: NamedNode[] }
```

- Jede Query, jedes Retrieval, jeder MCP-Aufruf, jede Föderationsanfrage und jeder Export bezieht sein Dataset ausschließlich hierüber.
- Das Ergebnis wird als `FROM`/`FROM NAMED` in die Query **injiziert**, vom Nutzer gelieferte `FROM`-Klauseln werden vorher entfernt. Kein Nachfiltern auf dem Ergebnis: ein Nachfilter verrät über Laufzeit, Ergebniszahl und Fehlermeldungen mehr, als er verbirgt.
- Eine Query, die auf einen gesperrten Graphen zielt, liefert ein leeres Ergebnis, keinen `403`. Ein `403` bestätigt die Existenz.
- Es gibt **keinen** zweiten Lesepfad am Resolver vorbei. Ein direkter `store.query()`-Aufruf außerhalb des Resolvers ist ein Review-Blocker und wird per Lint-Regel oder Architekturtest verhindert.

*(Vorstufe umgesetzt in M2: `src/lib/graph/sparql/protocol.ts#resolveDataset` — Single-User, aber bereits Injektion statt Nachfilter, acl-Sperre, leeres-Dataset-Semantik.)*

### 17.4 Nebenkanäle

Die Punkte, an denen Zugriffssteuerung in Graphsystemen erfahrungsgemäß scheitert. Jeder braucht einen eigenen Test:

- **Retrieval über Hops**: ein Seed im erlaubten Graphen, dessen Nachbar im gesperrten liegt. Die Expansion muss dort stoppen.
- **Inferenz**: siehe §7.3, scope-partitioniert.
- **Volltext- und Vektorindex**: pro Scope partitioniert oder mit Post-Resolver-Filter, der vor der Score-Rückgabe greift. Ein globaler Index, der nur die Trefferliste filtert, verrät über Scores und Nachbarschaft trotzdem Inhalte.
- **`owl:sameAs`** zwischen einer öffentlichen und einer privaten Entität: verbindet zwei Scopes und ist damit ein Rechte-Bypass. Reasoning über Scope-Grenzen hinweg ist verboten, nicht nur unerwünscht.
- **Föderation nach außen**: ein `SERVICE`-Aufruf sendet Bindings an einen fremden Endpoint. Wenn diese Bindings aus privaten Graphen stammen, ist das Datenabfluss per Design. Ausgehende Föderation aus privaten Graphen erfordert eine explizite Freigabe pro Endpoint.
- **Fehlermeldungen und Timings**: keine Existenzbestätigung, keine unterscheidbaren Laufzeiten zwischen „leer" und „gesperrt".
- **Export und Git-Sync**: der Export eines Nutzers enthält nur dessen Dataset. Das Git-Backup ist pro Nutzer getrennt oder das Repo ist privat — kein gemeinsames Repo mit gemischten Graphen.

### 17.5 Öffentlicher Teilgraph

- `graph/u/<userId>/public` ist ohne Authentifizierung lesbar und föderierbar. Damit wird jeder Nutzer zu einer eigenständigen Linked-Data-Quelle.
- Entitäts-IRIs im öffentlichen Teil müssen dereferenzieren: `GET <iri>` mit Content Negotiation liefert `DESCRIBE`-Ergebnis in Turtle/JSON-LD/HTML.
- Öffentliche Graphen bekommen eine `void:Dataset`-Beschreibung unter `/.well-known/void`, damit fremde Clients Umfang und Vokabular erkennen, ohne den ganzen Graphen zu ziehen.
- Rate-Limiting und Ergebnisgrenzen für anonyme Zugriffe sind Pflicht.

### 17.6 Test-Matrix (Abnahme M13)

Jede Zelle ist ein eigener Negativtest: Nutzer A hat keinen Lesezugriff auf Graph G von Nutzer B. Für jeden Pfad ist nachzuweisen, dass A nichts über den Inhalt von G erfährt — weder Tripel, noch Existenz, noch Struktur:

SPARQL SELECT · SPARQL DESCRIBE · SPARQL mit manipuliertem `FROM` · SPARQL UPDATE · Multi-Hop-Retrieval mit Seed in Nachbarschaft von G · MCP `graph_retrieve` · MCP `graph_describe` · MCP Resource `graph://<iri aus G>` · Volltextsuche · Vektorsuche · Inferenz-Graph · eingehende Föderation · ausgehende Föderation mit Bindings aus G · Export · Git-Sync · Canvas-Referenz auf einen Knoten aus G · Fehlermeldung bei nicht existentem vs. gesperrtem Knoten.

---

## 18. Selbstmodell des Systems

Übernommen als Muster aus temet-nosce, nicht als Code. Der Workspace beschreibt sich selbst in seinem eigenen Graphen.

- In `graph/meta` liegt ein Modell der Anwendung: Module, Seiten, Entitätstypen, verfügbare Connectors, Tools, Skills, Agenten, aktive Capabilities der Runtime, Schema-Version. Alles als reguläre Knoten mit demselben Vokabular wie Nutzerinhalte.
- Damit sind Fragen wie „was kann dieses System", „welche Quellen sind eingebunden", „welche Skills brauchen welche Tools", „was ist seit dem letzten Sync passiert" **abfragbar** statt hartkodiert — und über den MCP-Server auch für externe Agenten beantwortbar.
- Der Assistent bezieht seinen Systemkontext aus dieser Abfrage statt aus einem gepflegten Prompt-Text. Ein neues Modul, das sich im Selbstmodell registriert, ist damit dem Assistenten automatisch bekannt. Das ersetzt handgepflegte Kontextlisten und ist der eigentliche Grund für diesen Abschnitt.
- **Onboarding-Strecke**: eine geführte Einführung, die den Graphen an sich selbst erklärt — erst das Selbstmodell ansehen, dann einen eigenen Knoten anlegen, dann prima-materia als externe Quelle importieren und den Unterschied zwischen nativ, importiert und inferiert im Graph-Explorer sichtbar machen. Kein separates Tutorial-Format, sondern reale Aktionen im echten Graphen mit Rückgängig-Möglichkeit.
- Das Selbstmodell wird beim Start aus dem Code generiert und nach `graph/meta` geschrieben, nicht von Hand gepflegt. Eine handgepflegte Kopie wäre die vierte Wahrheit.
