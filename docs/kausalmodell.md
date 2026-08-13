# Kausalmodelle: der DAG als Graph-Bürger

Ein Kausalmodell ist eine **Annahme** darüber, was auf was wirkt. Es ist
kein Messergebnis und kein Nebenprodukt einer Auswertung — es ist die
Voraussetzung dafür, dass eine Auswertung überhaupt etwas bedeutet. Genau
deshalb liegt es im Graphen und nicht in einer Analyse-Bibliothek: Wer
später eine Zahl liest, muss die Annahme sehen können, aus der sie folgt
(CAUSAL_LAYER_SPEC, Invariante C1).

Dieses Dokument beschreibt, was mit den Meilensteinen **C0** (der DAG als
Graph-Bürger), **C1** (Identifikation, DAG-Editor, Revisionen), **C2**
(kausal geerdetes Retrieval) und **C4** (Schätzung und Refutation) gebaut
ist. Was noch nicht gebaut ist, steht am Ende — nicht als Ausblick,
sondern damit niemand nach Knöpfen sucht, die es nicht gibt.

Der Unterschied in einem Satz: C0 hat den DAG **hingelegt**, C1 rechnet
mit ihm — Azyklizität, D-Separation, Backdoor/Frontdoor, minimale
Adjustment Sets und die begründete Antwort „nicht identifizierbar, und
zwar weil X fehlt" —, C2 lässt das **Retrieval** ihm folgen, damit der
Kontext einer Frage die Kette enthält statt der Wolke, und C4 macht
daraus zum ersten Mal eine **Zahl** — allerdings nur eine, die ein
Konfidenzintervall und einen überstandenen Falsifikationsversuch
mitbringt.

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

Unter **Graph → Kausalmodelle** entsteht ein Modell mit Kennung und Name;
das legt seinen Named Graph an. Die Struktur schreibst du seit C1 **im
DAG-Editor** derselben Seite: Variablen aufnehmen (eine erfasste Größe aus
den Beobachtungen oder eine reine Modellvariable), Kanten ziehen mit
Herkunftsklasse und optionalem Zeitversatz, beides einzeln wieder
entfernen. Der SPARQL-Weg bleibt gleichwertig bestehen — jedes Modell
zeigt weiterhin eine Vorlage mit seinen echten IRIs.

Warum der Editor erst jetzt kommt: Ein DAG-Editor, der Kanten malen lässt,
ohne dass Azyklizität, Identifizierbarkeit und Adjustment Sets
dahinterstehen, erzeugt Struktur schneller, als sie jemand prüfen kann —
genau das Muster, gegen das §2.2 der Spec argumentiert. Mit C1 antwortet
er auf jede gezogene Kante, und deshalb gibt es ihn.

Beide Wege sind **ein** Schreibweg im Sinn, der zählt: Ziel ist der Named
Graph des Modells, und die Erlaubnis kommt aus `graph/acl` bzw. — für ein
Modell, das es noch nicht gibt — aus dem Scope-Muster des eigenen
Kausal-Namensraums (siehe „Wer darf schreiben"). Jede Änderung erzeugt
außerdem eine **Revision**.

Praktisch heißt Modellieren: Fang mit der Frage an, die dich interessiert
(„bringt die Nachtabsenkung etwas?"), nimm die beiden Größen auf, um die
es geht, und dann die Störgrößen, die auf **beide** wirken. Die letzte
Gruppe ist die eigentliche Arbeit — und der Grund, warum die
Außentemperatur in fast jedem Heizungsmodell auftaucht.

## Identifikation: die Frage vor jeder Zahl (C1)

Zu jedem Paar aus Ursache und Wirkung beantwortet die Seite: **Ließe sich
dieser Effekt aus Beobachtungsdaten überhaupt bestimmen — und worüber
müsste man dafür adjustieren?** Geschätzt wird dabei nichts; es gibt keine
Effektstärke und kein Konfidenzintervall (das ist C4).

Gerechnet wird im **Browser**. Der Tier-1-Kern
(`src/lib/graph/causal/{dag,dsep,identify}.ts`) ist pur — kein Store, kein
Netz, keine Route —, läuft damit in allen drei Runtimes und antwortet
sofort. `capabilities.causalTier` steht deshalb überall auf `graph`
(Invariante C9); `full` gäbe es erst mit dem Sidecar aus C8, und der ist
nicht gebaut.

Was der Kern kann:

- **Azyklizität** mit Zeugen: Ein Kreis wird nicht nur gemeldet, sondern
  benannt (`A → B → C → A`). Eine Kante, die einen Kreis schließen würde,
  lehnt der Editor ab — in einem Kreis ist keine Aussage über
  Identifizierbarkeit mehr möglich.
- **D-Separation** über den moralisierten Vorfahrengraphen, dazu die
  implizierten bedingten Unabhängigkeiten (die testbaren Aussagen des
  Modells).
- **Adjustment-Kriterium** (Shpitser/van der Zander) statt des engeren
  Backdoor-Kriteriums: Eine Menge ist zulässig, wenn sie keinen Nachfahren
  eines Wirkweg-Knotens enthält und im *proper backdoor graph* alles
  blockiert. Für den Standardfall fällt das mit Pearls Hintertür zusammen.
- **Minimale Adjustment Sets** innerhalb der kanonischen Menge
  `An(X ∪ Y) \ ({X, Y} ∪ dpcp)`. Sie entscheidet die Identifizierbarkeit:
  Ist sie unzulässig, ist es keine Menge.
- **Frontdoor** über beobachtbare Mediatoren und **Instrumentvariablen**
  (auch bedingte, mit ihrer Konditionierungsmenge).

**Beobachtbar heißt erfasst** (C3): Eine Variable, die im Modell steht,
aber keine Erfassungsregel hat, kann niemand adjustieren. Genau daraus
entsteht die nützlichste Auskunft der Seite:

> Nicht identifizierbar: Zum Schließen der Hintertür wird
> *Außentemperatur* gebraucht, diese Größe wird aber nicht erfasst.

Dazu sagt die Seite, ob die **Struktur** eine Antwort hergäbe — dann fehlt
nur die Erfassung, und der Weg dorthin ist ein Link auf die
Beobachtungen. „Nicht identifizierbar" ist damit kein Fehler, sondern ein
Ergebnis mit Adresse.

Zwei ehrliche Grenzen: Die Suche nach minimalen Mengen ist gedeckelt
(Größe und Anzahl geprüfter Mengen). Findet sie nichts, obwohl die
kanonische Menge zulässig und vollständig erfasst ist, wird **diese**
ausgegeben — zulässig, aber größer als nötig, und genau so beschriftet.
Wird überhaupt gedeckelt, sagt das Ergebnis es (`truncated`), statt
Vollständigkeit vorzutäuschen.

## Kausal geerdetes Retrieval (C2)

Das Multi-Hop-Retrieval aus GRAPH_CORE_SPEC §7.5 folgt normalerweise der
**semantischen** Nachbarschaft: Von einem Einstiegsknoten aus wird über
Kanten expandiert, gescort und linearisiert. Mit dem Feld `causal` folgt
dieselbe Pipeline stattdessen **deinem Kausalmodell**. Es ist keine zweite
Pipeline und kein zweiter Endpunkt — dieselben vier Phasen, drei
Änderungen:

```jsonc
POST /api/graph/retrieve
{
  "causal": {
    "mode": "paths",              // ancestors | descendants | paths | markov-blanket
    "treatment": "…/variable/nachtabsenkung",
    "outcome":   "…/variable/heizenergie",
    "model":     "wohnung",       // Kennung, Modell-IRI oder Graph-IRI
    "blockedBy": ["…/variable/aussentemperatur"],
    "minEvidence": "hypothesis"   // hypothesis | estimated | refuted-clean
  },
  "maxHops": 2,
  "format": "both"
}
```

1. **Seeding**: Einstieg sind die Größen, die zur Frage gehören — die
   Ursachenseite (`ancestors`), die Folgenseite (`descendants`), die Wege
   dazwischen (`paths`) oder der Markov-Kragen. Ihr Seed-Score ist die
   **kausale Nähe** (`1 / (1 + Schritte im DAG)`), nicht die
   Wortähnlichkeit — genau das meint §9 mit „kausale Nähe statt
   Kosinus-Ähnlichkeit".
2. **Expansion**: Der Modell-Graph kommt in den Traversal-Raum, die
   kausalen Kanten sind also selbst begehbar. Dazu ein **Tor**: Eine
   Größe, die im Modell steht, aber nicht zur Frage gehört, kommt auch
   über einen semantischen Umweg nicht herein. Alles andere — Notizen,
   Geräte, Aufgaben — passiert unverändert; das ist das Material *zur*
   Kette.
3. **`explain`**: trägt Modell samt Revision, die Frage, die Wege mit
   Richtung und Offenheit, die Adjustierung und alles, was herausgefallen
   ist, je mit Grund. Der linearisierte Kontext beginnt mit demselben
   Vorspann, damit ein Modell im LLM-Kontext die Kette vor sich hat und
   nicht die Wolke.

**Die Konditionierung ist der Kern.** `blockedBy` ist die Menge, über die
adjustiert wird — und was gegeben dieser Menge d-separiert ist, trägt
nichts mehr bei und fällt heraus. Am Beispiel:

> Zeitschaltuhr → Nachtabsenkung → Raumtemperatur → Heizenergie

Ohne Adjustierung liefert `ancestors` auf die Heizenergie alle vier
Größen — und mit ihnen die Notiz, die an der Zeitschaltuhr hängt.
Adjustiert man über die Nachtabsenkung, verschwindet die Zeitschaltuhr:
Gegeben die Nachtabsenkung sagt sie über die Heizenergie nichts mehr. Sie
verschwindet aber nicht stillschweigend, sondern steht in
`explain.causal.dropped` mit Grund — und im Kontext unter „Nicht
enthalten". Dasselbe gilt für Wege: Ein Knoten, der nur auf geschlossenen
Wegen liegt, fällt mit dem Grund `blocked-path` heraus.

Umgekehrt ist auch der unangenehme Fall sichtbar: Konditioniert man auf
einen **Collider**, öffnet das einen Weg, der vorher zu war. Das Ergebnis
zeigt es (der Weg ist dann `open`), statt es zu glätten.

**Im Explorer** (`/graph`, Einstellungen → „Kausaler Pfad") wählst du
Modell, Frage, Ursache, Wirkung und die Adjustierung; „Kette zeigen"
ersetzt das Bild durch den kausalen Teilgraphen. Ursache und Wirkung sind
hervorgehoben, adjustierte Größen tragen die Warnfarbe, Material zur Kette
bleibt grau. Darunter stehen die Wege im Klartext, die Adjustierung und
was nicht enthalten ist. Der Abschnitt erscheint nur, wenn
`capabilities.causalTier` es hergibt (Invariante C9).

Dieselbe Anfrage geht über den MCP-Server (`graph_retrieve`, Feld
`causal`) und lässt sich als Retrieval-Profil speichern — ein Profil kann
damit eine kausale Frage tragen, nicht nur Traversal-Parameter.

Was **nicht** im Ergebnis landet, obwohl es im Modell-Graphen steht: die
Revisionen. Sie hängen am Modell-Knoten und wären damit von jeder
Variablen zwei Hops entfernt — ein kausaler Kontext aus zwanzigmal „Kante
hinzugefügt" wäre keiner. Sie gehören zur Herkunft des Modells und stehen
weiterhin unter `/graph/causal` im Verlauf.

Drei Ehrlichkeiten:

- **Kein stiller Rückfall.** Lässt sich nicht erden — kein Modell, mehrere
  Modelle ohne Angabe, Ursache nicht im Modell —, kommt ein **leeres**
  Ergebnis mit Begründung zurück, kein semantisches, das kausal aussieht.
- **Kein geratenes Modell.** §9 sagt „Default: aktives Modell". Ein
  aktives Modell kennt das Datenmodell nicht, und eines einzuführen wäre
  eine Spec-Entscheidung. Bis dahin gilt: Gibt es genau ein lesbares
  Modell, ist es gemeint; gibt es mehrere, wird gefragt. Ein still
  gewähltes Kausalmodell wäre eine unausgesprochene Annahme.
- **`minEvidence` ist bis C4 wirkungslos oder leer.** Es gibt keine
  geschätzten Kanten, solange nichts schätzt. `estimated` liefert deshalb
  heute einen leeren DAG — mit genau diesem Hinweis in den Notizen.

Abnahme: `tests/graph/causal-retrieval.test.ts`.

## Schätzung und Refutation (C4)

Hier entsteht die erste Zahl dieses Layers. Sie kommt spät, und das ist
Absicht: Vor ihr stehen die Struktur (C0), die Identifikation (C1) und die
Erfassung (C3). Ohne diese drei wäre sie die selbstbewusste
Scheinpräzision, gegen die die ganze Spec argumentiert.

### Die Frage bleibt, die Antwort wird ersetzt

| | Wo | Wann ersetzt |
|---|---|---|
| **Frage** (`ow:Estimand`) | `graph/meta` | nie — sie ist eine Setzung des Menschen |
| **Antwort** (`ow:CausalStudy`) | `graph/<u>/inferred/causal/workspace` | bei **jedem** Lauf, vollständig |

Das ist Invariante C4 („Effektschätzungen sind inferiert") plus
Invariante 3 („Inferenz-Graphen werden ersetzt, nie gemerged"). Damit ein
Replace kein Verlust ist, rechnet ein Lauf immer **alle** Fragen neu.
Genau deshalb liegt die Frage woanders als die Antwort: Läge beides im
Inferenz-Graphen, verschwände mit jedem Lauf die Frage; läge beides in
`graph/meta`, häuften sich die Antworten an, statt ersetzt zu werden.

Eine Frage nennt Behandlung, Wirkung, Verfahren, Startwert des Zufalls und
optional Fenster, Eingriffszeitpunkt und Kontroll-Wirkung. Sie gehört per
`schema:isPartOf` zu ihrem Modell — wer das Modell verwirft, verwirft die
Frage, denn ohne Annahme hat sie keinen Sinn.

### Was gerechnet wird (Tier 1, in allen drei Runtimes)

Fünf Schätzer, alle aus der Standardliteratur, alle ohne
Numerik-Bibliothek — und deshalb auch im Browser lauffähig (Invariante
C9):

| Verfahren | Wofür | Braucht |
|---|---|---|
| **Stratifikation** | der durchsichtigste Vergleich: innerhalb gleicher Störgrößen-Klassen, dann gemittelt | binäre Behandlung |
| **Regression mit Adjustierung** | Standardfall, auch für stetige Behandlung | — |
| **IPW** | modelliert die Behandlungs*zuweisung* statt der Wirkung; falsch spezifiziert ist damit ein anderes Modell als bei der Regression | binäre Behandlung |
| **Difference-in-Differences** | rechnet einen gemeinsamen Trend heraus | Eingriffszeitpunkt + Kontroll-Wirkung |
| **Interrupted Time Series** | Niveausprung und Trendbruch an einem Eingriff | Eingriffszeitpunkt |

Ohne Vorgabe wählt der Lauf: mit Eingriffszeitpunkt DiD bzw. ITS, sonst
IPW bei binärer und Regression bei stetiger Behandlung. Was gerechnet
wurde, steht danach am Ergebnis.

**Das Konfidenzintervall kommt aus dem Moving Block Bootstrap**, nie aus
der Lehrbuchformel. Beobachtungsreihen sind autokorreliert (§15.2): Der
Wert um 8:05 weiß fast alles über den um 8:00, und ein klassischer
Standardfehler wäre deshalb systematisch zu klein. Ein zu enges Intervall
ist die gefährlichste aller Zahlen, weil es Sicherheit behauptet, die
niemand hat. Gezogen werden zusammenhängende Blöcke der Länge `n^(1/3)`,
200-mal, aus einem **gesetzten** Startwert — sonst wäre keine Studie
reproduzierbar (Invariante C7).

### Vom Messwert zur Tabelle

Ein Schätzer sieht keine Zeitreihen, sondern Zeilen. Die Umformung
(`panel.ts`) ist der Ort, an dem die meisten stillen Fehler entstünden,
wenn man sie nicht benennt:

- **Das Raster ist das gröbste der beteiligten Reihen.** Eine
  Fünf-Minuten-Reihe auf ein Minutenraster zu heben, hieße vier von fünf
  Werten erfinden. Verdichten ist zulässig, Verfeinern nicht.
- **Eine Lücke kippt die ganze Zeile** (listenweiser Ausschluss) — und
  wird gezählt, je Größe. Fehlende Werte sind selten zufällig fehlend
  (§15.4); wer sie interpoliert, verzerrt unsichtbar.
- **Der Zeitversatz der Kante wird angewandt**, nicht bloß angezeigt:
  Trägt die Kante `ow:temporalLag PT15M`, wird die Ursache 15 Minuten
  früher gelesen.
- **Positivität wird geprüft und berichtet** (§15.3): Ein Thermostat, das
  immer auf 21° steht, hat keinen schätzbaren Effekt — egal wie lang die
  Reihe ist. Das ist keine Schwäche des Verfahrens, sondern die Lage, und
  sie wird als solche ausgegeben.

### Refutation: der Versuch, die eigene Zahl zu widerlegen

Invariante C5 ist die härteste dieses Layers: **Ein Effekt ohne
Refutation existiert nicht.** Sechs Versuche laufen nach jeder Schätzung:

| Versuch | Ebene | Blockiert |
|---|---|---|
| **Placebo-Behandlung** — die Behandlung wird zeitlich verschoben, ihre Struktur bleibt | §13.1 | ja |
| **Zufällige gemeinsame Ursache** — eine erfundene Störgröße in die Adjustierung | §13.1 | ja |
| **Stabilität über Teilmengen** — zusammenhängende Zeitfenster statt Zufallszeilen | §13.1 | ja |
| **Negativkontrolle** — eine Wirkung, die die Behandlung laut DAG nicht erreichen kann | §13.2 | ja, wenn es eine gibt |
| **Implizierte Unabhängigkeiten** — die Behauptungen des DAG gegen die Daten (partielle Korrelation, Bonferroni) | §13.2 | ja |
| **E-Wert** — wie stark ein unbeobachteter Störfaktor sein müsste | §13.2 | nie (Kennzahl) |

Zwei Feinheiten, die zählen: Die Placebo-Behandlung wird **rotiert** und
nicht permutiert — eine Permutation zerstörte die Autokorrelation und wäre
ein zu leichter Gegner. Und `nicht prüfbar` gilt **nicht** als bestanden:
„Wir konnten es nicht prüfen" und „es hat gehalten" sind verschiedene
Aussagen, und sie zu vermengen wäre die bequemste Art, C5 zu unterlaufen.

Fällt ein blockierender Versuch durch, ist nicht nur die Zahl fraglich —
bei der Modell-Refutation ist die **Annahme** widerlegt. Dann gibt es
keinen Effekt: nicht im Graphen, nicht in der Oberfläche, in keiner Form.
Der durchgefallene Versuch dagegen steht da, mit Verfahren, Verdikt und
Begründung.

### Vier Ausgänge, drei davon ohne Zahl

| `ow:studyVerdict` | Heißt |
|---|---|
| `not-identifiable` | Der DAG oder die Erfassung geben die Frage nicht her — mit dem Namen der fehlenden Größe |
| `not-estimable` | Identifizierbar, aber die Datenlage trägt nicht (keine Variation, keine gemeinsamen Zeilen, kollineare Störgrößen — oder eine Strategie, für die Tier 1 keinen Schätzer hat) |
| `refuted` | Geschätzt und durchgefallen; **kein** Effekt wird ausgegeben |
| `passed` | Geschätzt und allen blockierenden Versuchen standgehalten |

Frontdoor und Instrumentvariablen werden von C1 **identifiziert**, aber
von C4 nicht gerechnet. Das ist keine Lücke, die versteckt wird: Die
Studie sagt es im Klartext, statt ersatzweise eine Zahl aus einem anderen
Verfahren auszugeben.

### Wo der Effekt hängt

Am selben Reifier wie die Kante — nur im Inferenz-Graphen statt im Modell:

```turtle
# in graph/<u>/inferred/causal/workspace
<…/link/causal/wohnung/fenster-offen/heizenergie>
    rdf:reifies       <<( :fenster_offen obo:RO_0002411 :heizenergie )>> ;
    ow:effectSize     0.83 ;
    ow:ciLow          0.61 ; ow:ciHigh 1.04 ;
    ow:standardError  0.11 ;
    schema:unitText   "kWh" ;
    ow:refutationPassed true ;
    ow:evidenceLevel  "refuted-clean" ;
    ow:edgeClass      "asserted" ;
    prov:wasGeneratedBy <…/study/heizen-auf-verbrauch> .
```

Damit bleibt die Annahme frei von Ergebnissen (C4), und trotzdem reden
beide über **dieselbe** Kante. Beim Lesen eines Modells wird die
Annotation darübergelegt: Die Kante zeigt ihren Effekt und ihren
erwiesenen Belegstand, ohne dass im Modell-Graphen ein Byte davon steht.
Erst dadurch greift `minEvidence` aus C2 wirklich — vor C4 war jede Kante
„behauptet".

Fragt jemand nach einer Wirkung über mehrere Schritte, gibt es keine
Kante, die man annotieren könnte. Eine zu erfinden hieße, Struktur zu
behaupten, die das Modell nicht enthält; dann trägt ein studieneigener
Knoten die Zahl.

### Die Signatur (Invariante C7)

Ohne diese Angaben wird **nicht geschrieben** — geprüft doppelt, im Code
und in den Shapes:

- Modell und **Modell-Revision** (`ow:modelRevision`) — wer den DAG
  ändert, ändert das Ergebnis, und ohne die Nummer gehörte die Zahl zu
  keiner Annahme
- Behandlung, Wirkung, Identifikationsstrategie, Schätzverfahren
- **Startwert des Zufalls** (`ow:seed`) und Softwareversion
- Datenfenster (`schema:temporalCoverage`) und Zeilenzahl
- je Eingabe ein Knoten mit eingefrorener Erfassungsregel: Quelle, Rolle,
  Verdichtung, Raster, Zeitversatz, Anzahl Beobachtungen
- jeder Refutationsversuch mit Verfahren, Verdikt und Kennzahl

Fällt eine Studie durch diese Prüfung, wird sie nicht geschrieben — die
Oberfläche meldet es als abgewiesene Studie, statt eine unvollständige zu
zeigen.

### Kein Inferenz-Leak (Invariante C6)

Kausale Läufe sind scope-partitioniert wie Reasoning-Läufe: Nur was
**ausschließlich** aus dem öffentlichen Graphen stammt, käme in den
öffentlichen Inferenz-Graphen. Beobachtungsreihen liegen im
Datenverzeichnis des Nutzers und ihre Definitionen in `graph/meta` —
beides ist nicht öffentlich. Der öffentliche Kausal-Inferenz-Graph ist
deshalb in dieser Ausbaustufe **stets leer**, und das ist keine Lücke,
sondern das Ergebnis der Regel. Ein verengter Zugang sieht aus demselben
Grund an einer Kante keinen Effekt.

Abnahme: `tests/graph/causal-estimation.test.ts`.

## Revisionen: woran sich eine Studie später beruft

Jede Änderung am Modell schreibt eine `prov:Activity` **in den
Modell-Graphen** (Nummer, Zeitpunkt, Beschreibung, Urheber) und hebt
`schema:version` am Modell. Die Anlage selbst ist Revision 1.

Das ist eine Vorleistung für Invariante C7: Eine Studie (C4) muss die
DAG-Revision nennen, auf der sie beruht. Wer die Historie erst dann
anlegt, hat sie nicht — nachträglich lässt sie sich nicht herstellen. Sie
gehört zum Modell und fällt mit ihm: Ein gelöschtes Modell nimmt seinen
Verlauf mit, weil der Named Graph die Modellgrenze ist.

## Wer darf schreiben

Ein Kausalmodell IST sein Named Graph — wer ein Modell anlegt, legt einen
Graphen an. Für vorhandene Graphen entscheidet wie überall `graph/acl`.
Für einen Graphen, den es **noch nicht gibt**, kann dort nichts stehen;
deshalb gibt es seit C1 Schreibziele aus **Scope-Mustern**:
`causal/*` und `causal-hypotheses` im **eigenen** Namensraum
(`authz/grant.ts`, `PROSPECTIVE_WRITE_SCOPES`).

Das ist die verallgemeinerte Fassung der Ausnahme, die der Start für
`workspace`/`public`/`presentation` von Hand macht: Deren Regeln lassen
sich vorab anlegen, weil es endlich viele sind; Kausalmodelle sind
unbegrenzt viele. Die Standardregel (Eigentümer, `control`) entsteht mit
dem Graphen und sagt danach dasselbe.

Eng bleibt es trotzdem, je mit Negativtest in
`tests/graph/causal-editor.test.ts`:

- Fremde Namensräume: nein.
- Systemgraphen (`meta`, `acl`, `import/*`, `inferred/*`): nein, auch als
  „Kausalmodell" getarnt.
- Ein **vorhandener** Graph: Das Muster macht ihn nicht auf — dort gilt
  weiterhin nur die ACL.
- Anonyme Zugriffe und verengte Zugänge (ein Token nur für `workspace`):
  kein Muster.

## Was die Oberfläche zeigt — und was nicht

- Jede Kante trägt sichtbar ihre Herkunftsklasse. Eine Hypothese ist
  gestrichelt und beschriftet; sie sieht nie aus wie eine gesetzte oder
  gar belegte Kante (Invariante C2).
- Der Belegstand steht daneben. Ohne Studie ist er `unbelegt`; mit einer
  bestandenen Studie springt er auf `refutiert bestanden`, und der Effekt
  samt Intervall steht an derselben Kante.
- Die Identifikation nennt Mengen, Wege und fehlende Größen — nie eine
  Zahl. Im Bild ist die vorgeschlagene Adjustierung gestrichelt
  hervorgehoben, damit die Antwort nicht nur als Satz dasteht.
- Fragen und Ergebnisse stehen **im** Modell und nicht auf einer eigenen
  Seite: Ein Effekt wird nie ohne den DAG ausgegeben, aus dem er folgt
  (Invariante C1).
- Ein durchgefallener Effekt erscheint als durchgefallener Versuch, nie
  als kleinerer Effekt (Invariante C5). Neben dem Urteil steht, welcher
  Versuch gescheitert ist und warum.
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
- seit C4: eine Frage mit Kennung, Behandlung, Wirkung und Startwert; eine
  Studie mit Urteil, Modell-Revision, Startwert, Softwareversion und
  Zeitpunkt; ein Falsifikationsversuch mit Verfahren und Verdikt
- seit C4 und am schärfsten: **eine Effektstärke ohne bestandene
  Refutation ist ein Verstoß**, kein Mangel (`ow:refutationPassed` muss
  vorhanden und `true` sein) — Invariante C5, in SHACL geschrieben. Ebenso
  eine Effektstärke ohne Konfidenzintervall.

Nicht geprüft werden Azyklizität, D-Separation und Identifizierbarkeit.
Das ist Graphalgorithmik, SHACL kann es nicht — sie kommt aus dem
Tier-1-Kern (siehe oben). Der Editor validiert zusätzlich vor jedem
Schreibvorgang gegen dieselben Shapes und blockiert nur Verstöße, die die
Änderung **neu** einführt (§7.2 Stelle 1); Altbestand mit Mängeln bleibt
bearbeitbar.

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
| Confounder | Wetter, Strompreis, Sonnenstand, Feiertage als Open-Data-Reihen | C5 |
| Hypothesen-Erzeugung | LLM-Vorschläge mit Provenienz und symbolischen Filtern | C6 |
| Frontdoor- und IV-Schätzer | identifiziert (C1), aber nicht gerechnet — die Studie sagt es | C8 (Sidecar) |
| Struktur-Lernen, CATE, formale Sensitivität | Python-Sidecar, `causalTier: full` | C8, nur nach Freigabe |
| Randomisierte Eingriffe | die dritte Falsifikationsebene (§13.3) über Aktoren | C7, nur nach Freigabe |

Der Hypothesen-Graph existiert bereits als Ort, aber bis C6 schreibt
niemand automatisch hinein: Was dort steht, hat ein Mensch geschrieben.

Der häufigste Grund für `not-identifiable` ist eine fehlende Störgröße —
und die wichtigsten der Hausdomäne sind offen verfügbar. Genau diese Lücke
schließt C5.

## Abweichungen von der Spec, zur Entscheidung vorgelegt

§19 verbietet einer Session, die Spec neu zu verhandeln. Drei Stellen in
§5 ließen sich beim Bauen von C4 nicht wörtlich umsetzen; sie sind hier
festgehalten, damit darüber entschieden werden kann — geändert wurde an
der Spec nichts.

1. **`ow:Estimand` und die Identifikationsstrategie (§5.2).** Die Spec
   nennt als Wertebereich `backdoor | frontdoor | iv | did | its | none`.
   Das mischt zwei verschiedene Dinge: Die ersten drei und `none` kommen
   aus dem **DAG** (Adjustment-Kriterium, C1), `did` und `its` sind
   **Studiendesigns**, die aus der Zeitachse kommen und dieselbe
   Backdoor-Strategie voraussetzen. Umgesetzt ist die Trennung:
   `ow:identificationStrategy` trägt die Graph-Antwort,
   `ow:estimator` das gerechnete Verfahren. Sonst wäre nicht mehr
   ablesbar, ob eine ITS-Studie überhaupt identifiziert war.
2. **`ow:effectUnit` (§5.3).** Die Spec zeigt `ow:effectUnit
   qudt:KiloW-HR`. Umgesetzt ist `schema:unitText` mit der Einheit als
   Text, weil die Erfassung (C3) Einheiten quelltreu aus Home Assistant
   übernimmt (`unit_of_measurement`, ebenfalls `schema:unitText`) und dort
   keine QUDT-IRI vorliegt. Ein eigener Term wäre eine zweite Schreibweise
   für dasselbe (Invariante 8). Eine QUDT-Abbildung bleibt möglich — sie
   gehört dann an die Variable, nicht an den Effekt.
3. **Ergebnisse sind flüchtig (C4 + §8.1).** Studien liegen im
   Inferenz-Graphen, werden bei jedem Lauf vollständig ersetzt (C4) und
   nie persistiert (§8.1) — nach einem Neustart sind sie fort, bis
   jemand rechnet. Das ist mit C7 vereinbar (reproduzierbar heißt
   herstellbar, nicht aufbewahrt), heißt aber auch: Es gibt **keine
   Historie** von Effekten über Modell-Revisionen hinweg. Wer „was sagte
   dieselbe Frage vor drei Monaten?" beantworten will, braucht einen
   dauerhaften Ort für abgeschlossene Studien — das wäre eine Erweiterung
   der Spec, keine Auslegung, und ist deshalb nicht gebaut.
