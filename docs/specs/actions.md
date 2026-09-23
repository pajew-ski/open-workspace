# ACTIONS_SPEC — Der Aktionsvertrag

> Kürzel im Text: `ACTIONS_SPEC`. Übergeordnet zu
> [agent-tools.md](./agent-tools.md), das nur noch beschreibt, was KEINE
> Aktion ist (API-Tools, MCP-Client-Tools, `use_skill`, Delegation).
> Herkunft: Issue #34. Gilt für `src/lib/actions/` und jedes Modul, das
> Aktionen definiert.

## 0. Auftrag in einem Satz

Jede Fähigkeit des Workspace wird genau einmal definiert; Routen,
Assistenten-Tools, MCP-Werkzeuge und das Selbstmodell werden daraus
abgeleitet, nie daneben geschrieben.

## 1. Ausgangslage

Vor A1 war eine Fähigkeit bis zu dreimal definiert, und die Definitionen
wussten nichts voneinander: 81 Route-Handler unter `src/app/api/` mit
Zod-Schemas in `validation.ts`, vier handgeschriebene Builtins in
`tools.shared.ts` mit eigenen JSON-Schemas, ein drittes Set `graph_*` im
MCP-Server. AGENTS.md versprach dem Assistenten Vollzugriff; gebaut war
ein Bruchteil, und nichts meldete die Lücke. Der Selbstmodell-Spiegel
beschrieb die Handliste, nicht das System.

## 2. Der Vertrag

Eine **Aktion** (`src/lib/actions/contract.ts`, `defineAction`) trägt:

| Feld | Bedeutung |
|---|---|
| `name` | stabil, englisch, `^[a-z0-9_]{1,64}$` — der Tool-Name der Provider. Bestehende Namen (`workspace_finder`, `workspace_create_task`, `workspace_update_task`, `graph_*`) bleiben: Skills referenzieren sie über `[[TOOL:…]]`, der AI-Spiegel leitet `ow:requiresTool` daraus ab. |
| `description` | agentenwirksam, deutsch. |
| `input` | Zod-Schema. Das JSON-Schema für Function Calling, MCP und `ow:inputSchema` wird daraus erzeugt (`schema.ts`, `z.toJSONSchema`, `io: 'input'`). Es gibt kein zweites Schema. |
| `effect` | `read` \| `constructive` \| `destructive`. Teil des Vertrags: entscheidet die Sichtbarkeit je Oberfläche (§3). |
| `target` | wie der Named Graph bestimmt wird (§2.1). Eine Aktion ohne bestimmbares Ziel ist ein Vertragsfehler; `defineAction` wirft beim Laden. |
| `requires` | was der Kontext liefern muss (`workspace`, `platform`, `surface`). Fehlt es, ist die Aktion dort UNSICHTBAR, nicht scheiternd (Invariante 10). |
| `changes` | Entitätstypen (IRIs), die eine schreibende Aktion verändert. Pflicht für `constructive`/`destructive` (A3, §5). |
| `run(input, ctx)` | läuft IM PROZESS mit Identität und Grant des Aufrufers — nie über einen HTTP-Aufruf an die eigene Route (ein Selbstaufruf verliert die Identität). |
| `signals` | optional: weitere Signale aus dem Ergebnis, etwa eine Navigationsabsicht (§5). |

Ort: `src/lib/actions/` (Vertrag, Registry, Adapter). Die Aktionen selbst
liegen beim Modul, dem sie gehören (`src/lib/<modul>/actions.ts`), und
registrieren sich (`registerActions`). `catalog.ts` lädt die Module; dass
keines fehlt, prüft der Paritätstest.

### 2.1 Ziel und Erlaubnis

Autorisierung wird nicht je Aktion programmiert, sondern in
`authorize.ts` aus dem Grant abgeleitet, den `graph/acl` hergibt
(`grantForIdentity`, `resolveWriteGraph`, `mayCreateGraph`). Kein zweites
Rechtesystem neben WAC (GRAPH_CORE_SPEC §17). Eine Aktion, die eine
eigene Rechteprüfung einführt, ist ein Review-Blocker; eine Aktion mit
zwei Zielen (Freigabehandlung) wendet für das zweite dieselbe Regel an
(`mayAccessGraph`).

| Ziel | Bedeutung | Erlaubnis aus dem Grant |
|---|---|---|
| `dataset` | liest über das erlaubte Dataset | Klammer im Dataset-Resolver (`readableGraphs`) |
| `graph` mit Scope-Schlüssel oder Funktion der Eingabe | ein bestimmter Named Graph (`workspace`, `public`, `causal/<id>`, `shared/<id>`, `meta`, …) | Bestand: `readableGraphs` / `appendableGraphs` / `writableGraphs` / `controlGraphs` je Modus. Noch nicht existierend: `writableScopes` (C1), der eigene Namensraum (Standardregel §17.2 vorweggenommen) oder ein neuer geteilter Raum für Angemeldete (§17.1). |
| `grant-write` | der vom Zugang freigegebene Schreibgraph | `grant.writableGraph` (MCP-Token-Muster) |
| `sparql` | rohes SPARQL über das Dataset | `grant.sparql` |
| `surface` | die Oberfläche des Aufrufers | nur mit Oberfläche im Kontext (Chat) |
| `instance` | instanzweite Konfiguration außerhalb des Graphen (AGENTS.md „Noch keine Graph-Bürger") | Lesen: `graph/meta` lesbar; Ändern: `control` auf `graph/meta` — dieselbe Schwelle wie für Gruppen (§17.1) |

Der Modus eines `graph`-Ziels folgt der Effektklasse (read → `read`,
constructive → `append`, destructive → `write`) oder steht ausdrücklich
im Ziel (`mode: 'control'`).

Der Grant kennt seit A1 auch Graphen, für die eine Regel existiert, die
aber noch kein Quad haben (`authz/resolve.ts`): Ein Nutzergraph oder ein
Raum bekommt seine Regel VOR dem ersten Schreibvorgang, und ein Grant, der
nur den Bestand kennte, verweigerte genau diesen.

### 2.2 Kontext

`ActionContext` trägt Identität, Grant, Graph-Handle und die Bausteine,
die der Adapter liefern kann: `workspace()` (Store-first-CRUD),
`retrieval()` (Index-Cache), `platform` (Dateibaum, Runtime), `persist`
(Snapshot, ACL, Reasoning, Reprojektion, AI-Spiegel), `activity`,
`surface`, `origin`, `now`. Auf dem Server baut `context.server.ts` den
Kontext aus der Anfrage; Tests bauen ihn aus einem nackten Store. Kein
`if (isBrowser)` — Invariante 7.

## 3. Abgeleitete Oberflächen

| Oberfläche | Ableitung | Sichtbar |
|---|---|---|
| Route (`src/app/api/**`) | dünner Adapter (`route.ts#respondWithAction`): Eingabe aus Pfad/Query/Body, `ctx` aus der Anfrage, `run`, Fehler auf Status (400 Validierung, 403 Grant, 404 `notFound`, 422 SHACL, 500 sonst) | alle Klassen |
| Tool-Loop Server (`/api/chat`) | `tools.ts#actionEngineTools`: Registry → Tool-Definitionen, Ausführung im Prozess mit dem `ctx` des Chat-Requests | `read`, `constructive` |
| Tool-Loop Browser (`transport.ts`) | dieselben Definitionen über `GET /api/actions`, Ausführung über `POST /api/actions/<name>` (`browser.ts`). Ohne Backend gibt es keine Aktionen, und dann erscheinen sie nicht als Werkzeug | `read`, `constructive` |
| MCP-Server (`/api/mcp`) | Registry → MCP-Tools (A2) | `read` per Default, `constructive` nur mit Schreibrecht des Tokens |
| Selbstmodell | jede Aktion als `ow:Tool` mit `ow:inputSchema` und `ow:effectClass` im AI-Spiegel (A2) | alle |

`destructive` erscheint auf keiner Agenten-Oberfläche. Das ist die Regel
„gelöscht wird über kein Tool", jetzt vom Vertrag erzwungen statt vom
Weglassen; die Oberfläche ruft destruktive Aktionen erst nach dem
Bestätigungsdialog auf (AGENTS.md, Safety-Regeln). `POST /api/actions/<name>`
kennt destruktive Aktionen nicht.

## 4. Mengengrenzen

Listen-Aktionen tragen ein `limit` (Default 100, Route 500). Die Engine
kappt jedes Tool-Ergebnis vor dem Rückspeisen (`MAX_TOOL_RESULT_CHARS`).
Beides zusammen ist die Antwort auf die offene Frage aus Issue #34: Die
Routen brauchen keine Grenze, die Tools bekommen sie im Vertrag.

## 5. Kontext und Rückfluss (A3)

Wird mit A3 gebaut; siehe die Abnahme dort.

## 6. Abnahme

A1, als Tests:

1. `tests/platform/action-parity.test.ts` — jeder exportierte Handler
   unter `src/app/api/` ist Aktions-Adapter oder steht mit Begründung auf
   „bewusst ausgenommen" oder auf „noch nicht migriert"; eine erfundene
   Route ohne beides lässt den Test scheitern; die zweite Liste darf nur
   schrumpfen (Obergrenze im Test), jedes Aktionsmodul steht im Katalog.
2. `tests/ai/actions.test.ts` — das an das Modell gelieferte JSON-Schema
   ist das aus Zod erzeugte, kein handgeschriebenes Workspace-Tool mehr in
   `tools.shared.ts`; `destructive` in keiner Tool-Liste; Server- und
   Browser-Loop liefern identische Definitionen; eine über den Server-Loop
   angelegte Aufgabe landet im Graphen des anfragenden Nutzers (Aufbau wie
   `tests/graph/multi-user.test.ts`).

A2: `tests/graph/self-model.test.ts` (die `ow:Tool` mit Effektklasse unter
„Open Workspace" sind gleich der Registry), `tests/graph/mcp-server.test.ts`
(ein Lese-Token sieht keine `constructive`-Aktion).

Dazu die Definition of Done nach GRAPH_CORE_SPEC §14.

## 7. Nicht

- Keine Umbenennung bestehender Tool-Namen.
- Keine Verlagerung von Wahrheit in eine Datenbank oder einen zweiten
  Store: Aktionen schreiben über die Store-first-CRUD, RDF bleibt die eine
  Wahrheit (Invariante 1).
- Keine CLI, keine A2A-Exposition der Aktionen. Beides ist mit dem Vertrag
  billig nachzuziehen und hat heute keinen Aufrufer.
- Kein Agent, der den Code der Anwendung zur Laufzeit ändert.
- Kein Umbau von API-Tools und MCP-Client-Tools (Fremdfähigkeiten) und
  ihrer Relais (`/api/tools/execute`, `/api/ai/mcp/[id]`, `/api/ai/a2a`).
- Kein Bestätigungsdialog für den Agenten.

## 8. Offen

- Ob ein Agent destruktive Aktionen VORSCHLAGEN darf, die der Nutzer über
  ein A2UI-Element bestätigt. Braucht einen Rückkanal von der Bühne in eine
  wartende Aktion, den es nicht gibt.
- Rückfluss bei fremden Schreibern (MCP-Client, Connector-Lauf): Das
  Änderungsereignis aus A3 deckt den eigenen Client. Ob eine Revision je
  Named Graph mit Server-Sent Events reicht, ist ungeklärt.
