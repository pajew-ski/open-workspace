# Selbstmodell und Einführungsstrecke (§18)

> Was dieses System über sich selbst weiß — und wie es das erklärt.
> Umgesetzt mit Meilenstein M14, verbindlich beschrieben in
> [GRAPH_CORE_SPEC.md](../GRAPH_CORE_SPEC.md) §18.

## Das Prinzip in drei Sätzen

Der Workspace beschreibt sich in seinem **eigenen Graphen**, mit demselben
Vokabular wie Nutzerinhalte. Das Modell wird beim Start aus dem Code
**generiert** und nach `graph/meta` geschrieben — eine handgepflegte Kopie
wäre die vierte Wahrheit. Wer wissen will, was das System kann, fragt es
ab; niemand pflegt dafür eine Liste im Prompt.

## Was in `graph/meta` steht

Ein Knoten für die Anwendung:

| Prädikat | Bedeutung |
|---|---|
| `rdf:type schema:SoftwareApplication` | die Installation selbst |
| `ow:runtime` | `local` \| `ha-addon` \| `server` (§5.2) |
| `ow:capability` | **aktive** Fähigkeiten: `sparqlEndpoint`, `mcpServer`, `federationOutbound`, `federationInbound`, `multiUser`, dazu `reasoning:<tier>` |
| `ow:availableConnectorKind` | Connector-Arten, die dieser Build anbietet |
| `schema:softwareVersion` | Version der Anwendung |
| `schema:schemaVersion` | Schema-Version der Persistenz (Snapshot-Manifest) |

Ein Knoten je Modul (`ow:Module` ⊑ `schema:WebPage`):

| Prädikat | Bedeutung |
|---|---|
| `ow:route` | Anwendungspfad (`/tasks`) — bewusst nicht `schema:url`: die URL hängt am Base-Path (Ingress, M12), die Route nicht |
| `schema:name` / `schema:description` | Beschriftung und ein Satz Zuständigkeit |
| `ow:entityType` | Klassen, deren Entitäten das Modul verwaltet (`ow:Task`, `ow:Document`, …) |
| `schema:isPartOf` | Elternmodul (`/graph/sparql` → `graph`) bzw. die Anwendung |

Dazu — schon seit M9 — der **AI-Spiegel**: Skills, Agenten, Werkzeuge und
Werkzeug-Anbieter dieser Installation (`ow:Skill`, `ow:Agent`, `ow:Tool`,
`ow:ToolProvider`). Beide Abschnitte werden unabhängig voneinander ersetzt
und fassen sich gegenseitig nicht an.

**Ehrlich statt vollständig**: Ein Modul, dessen Runtime-Fähigkeit fehlt
(`/graph/sparql` in der Runtime `local`), steht nicht im Modell, und
`ow:capability` trägt nur, was wirklich geht (Invariante 10).

## Abfragen

```sparql
PREFIX ow: <https://pajew-ski.github.io/open-workspace/ns/v1#>
PREFIX schema: <https://schema.org/>

SELECT ?label ?route ?typ WHERE {
  GRAPH ?meta {
    ?m a ow:Module ; schema:name ?label ; ow:route ?route .
    OPTIONAL { ?m ow:entityType ?typ }
  }
} ORDER BY ?route
```

Ohne SPARQL geht es auch: `GET /api/graph/self-model` liefert dieselbe
Sicht als JSON — geklammert vom Grant des Anfragenden (§17.3). Wer
`graph/meta` nicht lesen darf, bekommt ein leeres Modell, keine
Fehlermeldung.

## Ein Modul hinzufügen

1. Seite unter `src/app/<route>/page.tsx` anlegen.
2. Eintrag in `src/lib/app/modules.ts` ergänzen (`id`, `route`, `label`,
   `description`, `entityTypes`, `navigation`, optional `partOf` und
   `requiresCapability`).

Mehr nicht. Aus der Registry entstehen **beide** Enden: die Navigation in
`components/layout/Sidebar.tsx` (dort liegt nur noch das Icon — das ist
Darstellung, kein Wissen) und das Selbstmodell im Graphen, aus dem der
Assistent seinen Systemkontext bezieht.

Ein Test erzwingt, dass beides deckungsgleich bleibt: jede statische
`src/app/**/page.tsx` braucht einen Registry-Eintrag und umgekehrt
(`tests/graph/self-model.test.ts`). Eine zweite, handgepflegte
Modul-Tabelle im Client-Code ist ebenfalls per Test verboten — genau die
gab es vor M14 doppelt.

## Systemkontext des Assistenten

`/api/chat` liest das Selbstmodell **serverseitig** und setzt es in den
System-Prompt (`systemContextText`). Was der Client mitschickt, ist
Eingabe, keine Wahrheit über das System. Im serverlosen Browser-Betrieb
gibt es kein Modell — dann behauptet der Prompt nichts über Module und
Fähigkeiten, statt eine veraltete Liste zu wiederholen.

## Einführungsstrecke (`/onboarding`)

Kein Tutorial-Format, kein Übungsmodus, keine Beispieldaten: vier reale
Aktionen auf den regulären Pfaden.

| Schritt | Was wirklich passiert | Rückgängig |
|---|---|---|
| Selbstmodell abfragen | SPARQL auf `graph/meta` | Aufzeichnung entfernen |
| Eigenen Knoten anlegen | Dokument über die Store-first-CRUD (Datei folgt als Projektion) | Dokument löschen |
| prima-materia importieren | `github-rdf`-Connector anlegen und einmal synchronisieren (commit-gepinnt) | Connector löschen — der Import-Graph geht mit |
| Herkunft vergleichen | Aussagen je Graph zählen: nativ, importiert, inferiert | Aufzeichnung entfernen |

Der **Fortschritt ist RDF**, kein UI-Zustand: je Schritt eine
`ow:OnboardingStep` (⊑ `prov:Activity`) in `graph/meta`, mit
`prov:wasAttributedTo`, `prov:endedAtTime` und — je nach Schritt —
`prov:used` (betrachtet) oder `prov:generated` (erzeugt). Damit ist er
nutzerskaliert, geräteübergreifend und per SPARQL prüfbar, und
„rückgängig" heißt: das Erzeugte und die Aufzeichnung löschen. Der
Abnahme-Test vergleicht den kanonischen Dump (RDFC-1.0) vor der Strecke
mit dem danach — byte-identisch.

Ein fehlgeschlagener Import (kein Netz, GitHub nicht erreichbar) wird
**nicht** als erledigt verbucht; der Connector bleibt stehen, damit der
zweite Versuch ein Klick ist, und der Fehlschlag steht am Lauf-Knoten.

## Herkunft

`GET /api/graph/provenance` zählt die Aussagen der eigenen Graphen je
Herkunft:

* **nativ** — `graph/u/<du>/workspace` und `…/public`
* **importiert** — `graph/u/<du>/import/<connector>`
* **inferiert** — `graph/u/<du>/inferred/<scope>`

Dieselben Zahlen zeigt der Abschnitt „Herkunft" im Graph-Explorer.
Präsentation (`…/presentation`) zählt nicht mit: Layout ist kein Wissen
(Invariante 2). Inferiertes wird nie behauptet — es lebt in eigenen
Graphen, entsteht bei jedem Start neu und erscheint im Bild nur über die
Überlagerung „Inferierte Kanten anzeigen".

## Grenzen

* Kalender, Chats und die AI-Konfiguration sind noch keine Graph-Bürger;
  sie erscheinen deshalb nicht als Entitätstypen eines Moduls. Werden sie
  es, genügt der Eintrag `entityTypes` in der Registry.
* Das Selbstmodell ändert sich nur mit dem Build, deshalb wird es beim
  Start erzeugt und nicht bei jeder Mutation — anders als der AI-Spiegel,
  der der laufenden Konfiguration folgt.
