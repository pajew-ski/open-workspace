# Kausalmodelle: der DAG als Graph-Bürger

Ein Kausalmodell ist eine **Annahme** darüber, was auf was wirkt. Es ist
kein Messergebnis und kein Nebenprodukt einer Auswertung — es ist die
Voraussetzung dafür, dass eine Auswertung überhaupt etwas bedeutet. Genau
deshalb liegt es im Graphen und nicht in einer Analyse-Bibliothek: Wer
später eine Zahl liest, muss die Annahme sehen können, aus der sie folgt
(CAUSAL_LAYER_SPEC, Invariante C1).

Dieses Dokument beschreibt, was mit Meilenstein **C0** gebaut ist. Was
noch nicht gebaut ist, steht am Ende — nicht als Ausblick, sondern damit
niemand nach Knöpfen sucht, die es nicht gibt.

## Wo ein Modell liegt

| Graph-IRI | Inhalt |
|---|---|
| `graph/<u>/causal/<modelId>` | Ein Modell: Modell-Knoten, seine Variablen, seine Kanten |
| `graph/<u>/causal-hypotheses` | Vorschläge, die zu keinem Modell gehören |

Ein Modell **ist** sein Named Graph. Damit ist die Modellgrenze
strukturell und nicht per Konvention: Ein Modell lässt sich als Ganzes
ersetzen, vergleichen, exportieren und löschen, ohne dass irgendwo ein
Rest liegen bleibt. Beide Graphen werden in den Snapshot geschrieben
(`data/graph/causal/<modelId>.nq`) — ein von Hand modellierter DAG hat
keine Quelle, aus der er wiederherstellbar wäre.

Aus dem OWL-RL-Lauf bleiben Kausalgraphen bewusst draußen: Eine Annahme
ist kein Axiom, und ein Reasoner, der aus ihr weitere Aussagen ableitet,
würde die Grenze zwischen Behauptung und Folgerung verwischen. Für die
SHACL-Validierung sind sie dagegen ein reguläres Ziel.

## Vokabular: fremdes zuerst

Invariante C8 verlangt den Nachweis, dass kein etablierter Term existiert,
bevor ein eigener entsteht. Für die kausale Kante existiert einer:

```turtle
<…/variable/fenster-offen> obo:RO_0002411 <…/variable/heizenergie> .
```

`obo:RO_0002411` ist `causally upstream of` aus der **OBO Relations
Ontology**: eine OWL-Objekteigenschaft, deren Definition Richtung *und*
zeitliche Vorordnung enthält — die Ursache geht der Wirkung voraus. Genau
das behauptet eine Kante in einem DAG.

Geprüft und verworfen:

| Kandidat | Warum nicht |
|---|---|
| `wdt:P828 has cause` | Nur innerhalb von Wikidata definiert — und zeigt von der Wirkung auf die Ursache. Die umgekehrte Leserichtung wäre bei jedem Export eine Fehlerquelle |
| `wdt:P1542 has effect` | Dieselbe Einschränkung; als Prädikat außerhalb von Wikidata ohne Semantik |
| `prov:wasDerivedFrom` | Ist ausdrücklich **keine** Kausalität (C8) und darf nicht dafür missbraucht werden |
| `obo:RO_0002410 causally related to` | Symmetrische Oberrelation ohne Richtung — ein DAG braucht die Richtung |

Eigene Terme gibt es nur für das, was **über** eine Kante gesagt wird —
und für das Modell selbst, das keine Entsprechung hat:

| Term | Rolle |
|---|---|
| `ow:CausalModel` | Der DAG als Artefakt (Titel, Kennung, Datum, Variablen per `schema:hasPart`) |
| `ow:edgeClass` | Herkunft: `hypothesis`, `structural`, `learned`, `asserted` (Invariante C2) |
| `ow:evidenceLevel` | Belegstand: `hypothesis`, `estimated`, `refuted-clean` (Invariante C5) |
| `ow:temporalLag` | Erwarteter Zeitversatz als `xsd:duration` |

Die Variablen sind `ow:Variable` — dieselbe Klasse wie bei den
[Beobachtungen](./beobachtungen.md). Das ist Absicht und kein Zufall: Eine
Modellvariable, die auch erfasst wird, ist derselbe Knoten. Erfassungsregel
und Fortschritt stehen in `graph/meta`, die Modellzugehörigkeit im
Modellgraphen; wer eine Variable im Modell sieht, sieht auch, ob sie Daten
hat. Eine Variable ohne Erfassung ist zulässig — sie ist später nur nicht
schätzbar, und die Oberfläche sagt das.

## Alles über die Kante hängt am Reifier

Eine kausale Aussage muss zitierfähig sein: Herkunft, Zeitversatz und
später Effektstärke, Konfidenzintervall und Refutationsstatus gehören an
**die Kante**, nicht in eine Nebentabelle. RDF 1.2 leistet das mit einem
benannten Reifier (`rdf:reifies` + Triple Term) — derselbe Mechanismus,
den der Graph-Kern schon für Wikilink-Aliasse (M4) und Kantengewichte (M8)
nutzt. Ein Property-Graph ist dafür nicht nötig:

```turtle
<…/link/causal/wohnung/fenster-offen/heizenergie>
    rdf:reifies <<( <…/variable/fenster-offen> obo:RO_0002411 <…/variable/heizenergie> )>> ;
    ow:edgeClass     "asserted" ;
    ow:evidenceLevel "hypothesis" ;
    ow:temporalLag   "PT15M"^^xsd:duration .
```

Die Reifier-IRI ist aus der Kante abgeleitet und damit stabil: Dieselbe
Kante bekommt beim Neuschreiben denselben Reifier.

## Ein Modell anlegen und modellieren

Unter **Graph → Kausalmodelle** entsteht ein Modell mit Kennung und Name.
Das legt den Named Graph an und sonst nichts — die Struktur schreibst du
selbst im **SPARQL-Editor**; jedes Modell zeigt dafür eine Vorlage mit
seinen echten IRIs, die sich kopieren lässt.

Warum kein Editor? Weil C0 die Ansicht liefert und nicht die Bearbeitung.
Ein DAG-Editor, der Kanten malen lässt, ohne dass Azyklizität,
Identifizierbarkeit und Adjustment Sets dahinterstehen (C1), erzeugt
Struktur schneller, als sie jemand prüfen kann — genau das Muster, gegen
das §2.2 der Spec argumentiert. Der Umweg über SPARQL ist deshalb kein
Provisorium, sondern die ehrliche Reihenfolge.

Praktisch heißt Modellieren: Fang mit der Frage an, die dich interessiert
(„bringt die Nachtabsenkung etwas?"), nimm die beiden Größen auf, um die
es geht, und dann die Störgrößen, die auf **beide** wirken. Die letzte
Gruppe ist die eigentliche Arbeit — und der Grund, warum die
Außentemperatur in fast jedem Heizungsmodell auftaucht.

## Was die Oberfläche zeigt — und was nicht

- Jede Kante trägt sichtbar ihre Herkunftsklasse. Eine Hypothese ist
  gestrichelt und beschriftet; sie sieht nie aus wie eine gesetzte oder
  gar belegte Kante (Invariante C2).
- Der Belegstand steht daneben, und er ist bis C4 immer `unbelegt`. Das
  ist die Wahrheit: Bisher hat nichts geschätzt und nichts falsifiziert.
- Die Anordnung des DAG wird beim Zeichnen berechnet und steht nirgends im
  Graphen (Invariante 2). Ein Modell ist ohne fremde Bildschirmkoordinaten
  föderierbar.
- SHACL-Befunde stehen unter dem Modell. Sie blockieren nichts — sie sagen,
  wo ein Modell später nicht tragen wird.

## Was die Shapes prüfen

`ontology/shapes/causal.ttl`, ausgewertet über
`POST /api/graph/validate` und bei jedem Lesen der Kausal-Seite:

- Modell mit Name und Kennung; Variablen als IRIs
- Kantenklasse aus genau den vier Klassen, höchstens eine je Kante
- Evidenzstufe aus genau den drei Stufen, und nie ohne Kantenklasse
- Zeitversatz als `xsd:duration`
- Ursache und Wirkung sind `ow:Variable` (Warnung, kein Fehler — die
  Struktur verantwortet der Mensch)
- kein Layout-Wert im Modellgraphen

Nicht geprüft werden Azyklizität, D-Separation und Identifizierbarkeit.
Das ist Graphalgorithmik, SHACL kann es nicht, und es hier anzudeuten wäre
eine Attrappe. Es kommt mit C1.

## Beispiel: eine Abfrage, die sich lohnt

Welche Größen wirken laut Modell auf die Heizenergie — und wie belegt ist
das jeweils?

```sparql
PREFIX ow:  <https://pajew-ski.github.io/open-workspace/ns/v1#>
PREFIX obo: <http://purl.obolibrary.org/obo/>
PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
PREFIX schema: <https://schema.org/>

SELECT ?ursacheName ?klasse ?evidenz ?versatz WHERE {
  GRAPH ?modell {
    ?ursache obo:RO_0002411 ?wirkung .
    ?wirkung schema:name "Heizenergie" .
    OPTIONAL { ?ursache schema:name ?ursacheName }
    OPTIONAL {
      ?r rdf:reifies <<( ?ursache obo:RO_0002411 ?wirkung )>> .
      OPTIONAL { ?r ow:edgeClass     ?klasse }
      OPTIONAL { ?r ow:evidenceLevel ?evidenz }
      OPTIONAL { ?r ow:temporalLag   ?versatz }
    }
  }
}
```

## Noch nicht gebaut

| | Was fehlt | Meilenstein |
|---|---|---|
| Identifikation | Azyklizität, D-Separation, Backdoor/Frontdoor, minimale Adjustment Sets, „nicht identifizierbar, weil X fehlt" | C1 |
| Retrieval | Kausale Pfade im Multi-Hop-Retrieval, `explain` mit Kette statt Wolke | C2 |
| Schätzung | Effektstärke, Konfidenzintervall, Refutation, `ow:CausalStudy` | C4 |
| Confounder | Wetter, Strompreis, Sonnenstand, Feiertage als Open-Data-Reihen | C5 |
| Hypothesen-Erzeugung | LLM-Vorschläge mit Provenienz und symbolischen Filtern | C6 |

Der Hypothesen-Graph existiert bereits als Ort, aber bis C6 schreibt
niemand automatisch hinein: Was dort steht, hat ein Mensch geschrieben.
