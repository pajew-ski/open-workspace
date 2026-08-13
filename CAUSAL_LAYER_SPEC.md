# SPEC-ENTWURF: Kausal-Layer — Neurosymbolik und Causal Inference im Graph-Kern

**Repo**: `pajew-ski/open-workspace`
**Typ**: Architektur-Entwurf zur Entscheidung — **noch nicht verbindlich**
**Verhältnis zu bestehenden Dokumenten**: `GRAPH_CORE_SPEC.md` behält
uneingeschränkt Vorrang. Dieser Entwurf setzt auf ihm auf und darf keine
seiner Invarianten aufweichen. Wo er das täte, ist der Entwurf falsch, nicht
die Spec.
**Adressat**: Entscheider, danach Coding Agent

---

## 0. Auftrag in einem Satz

Der Graph-Kern beantwortet heute Beobachtungsfragen; der Kausal-Layer macht
ihn zusätzlich interventions- und kontrafaktisch-fähig, indem er die
**Struktur** aus dem Graphen und die **Beobachtungen** aus Home Assistant und
offenen Datenquellen zu identifizierbaren, refutierten und provenienz-
tragenden Effektschätzungen zusammenführt — in allen drei Runtimes, mit
ehrlich abgestufter Tiefe.

---

## 1. Befund: wo der Workspace auf Pearls Leiter steht

| Stufe | Frage | Status heute |
|---|---|---|
| 1 — Assoziation `P(Y\|X)` | „Was hängt womit zusammen?" | **Vollständig.** SPARQL, Volltext, Vektorähnlichkeit, Multi-Hop-Retrieval (§7.5), OWL RL, SHACL |
| 2 — Intervention `P(Y\|do(X))` | „Was passiert, wenn ich X ändere?" | **Fehlt.** |
| 3 — Kontrafaktisch | „Was wäre gewesen, wenn ich X nicht geändert hätte?" | **Fehlt.** |

Das ist kein Zufall, sondern die Bauart: RDF, OWL und SHACL sind
**deduktive** Kalküle. Sie leiten ab, was aus Aussagen folgt. Sie sagen nichts
darüber, was passiert, wenn man in die Welt eingreift. `ow:blockedBy`
transitiv zu schließen ist Logik; „das offene Fenster verursacht den
Heizspitzenverbrauch" ist eine kausale Behauptung, die kein Reasoner der Welt
aus dem Graphen ableiten kann — die braucht Daten und eine Annahme über die
Struktur.

**Die symbolische Hälfte der Neurosymbolik ist hier bereits ungewöhnlich
vollständig gebaut.** Named Graphs mit erzwungener Provenienz, getrennte
Asserted/Inferred-Bereiche, RDF-star für Kanten-Annotationen, SHACL-Validierung
an drei Stellen, scope-partitionierte Materialisierung, ein Connector-Vertrag
für alles Externe. Was fehlt, ist nicht Symbolik. Es fehlt die **kausale
Schicht** und eine disziplinierte Rolle für das neuronale Teil.

---

## 2. Bewertung der vorgelegten Causal-GraphRAG-Spezifikation

Die Vorlage ist in ihrer Grundfigur richtig und in einem Punkt strukturell
falsch. Beides muss beim Namen genannt werden, sonst baut man den Fehler mit.

### 2.1 Was trägt

- **Die Pipeline-Figur** Retrieval → Identifikation → Schätzung → Refutation
  ist die korrekte Reihenfolge und exakt die Arbeitsteilung von DoWhy. Dass
  Identifikation *vor* Schätzung kommt, ist der eigentliche Gewinn: erst wird
  gefragt, ob der Effekt aus den vorhandenen Variablen überhaupt
  identifizierbar ist, dann erst gerechnet. Genau das macht keine
  ML-Korrelationspipeline.
- **Causal Path Tracing und D-Separation als Retrieval-Metrik** ist die beste
  Einzelidee des Papiers und im Repo billig zu haben: die Expansions-Phase
  aus §7.5 kann bereits Kantentyp-Whitelists; ein kausaler Modus ist eine
  Erweiterung, kein neues Subsystem.
- **Der erzwungene Refutations-Loop** ist die richtige Haltung und deckt sich
  mit Invariante 10 („Keine Attrappen"): ein Effekt, der die Falsifikation
  nicht überlebt, wird nicht angezeigt.
- **Die DAG-Pflicht mit temporaler Auflösung von Zyklen** ist korrekt und im
  Home-Assistant-Fall sogar geschenkt — jede Beobachtung trägt einen
  Zeitstempel, `t(Ursache) < t(Wirkung)` ist maschinell prüfbar.

### 2.2 Was bricht

**Der zentrale Konstruktionsfehler**: Die Vorlage vermischt zwei verschiedene
Dinge unter einem Namen.

1. Einen **kausalen Wissensgraphen** — Behauptungen *über* Kausalität, per
   LLM aus Text extrahiert („Ursache → Trigger → Wirkung").
2. Eine **kausale Inferenz-Pipeline** — ein DAG plus ein **Datensatz** ergibt
   einen geschätzten Effekt.

Schritt 4 der Vorlage („ATE auf Basis der im Sub-Graphen aggregierten
Gewichte") ist an dieser Stelle keine Näherung, sondern eine Kategorienfehler.
Ein ATE ist ein Erwartungswert über eine Verteilung. Er lässt sich nicht aus
Kantengewichten eines textextrahierten Graphen berechnen, weil diese Gewichte
keine Verteilung repräsentieren, sondern die Häufigkeit oder Zuversicht, mit
der ein Sprachmodell eine Formulierung gesehen hat. Wer das rechnet, bekommt
eine Zahl mit Konfidenzintervall, hinter der keine einzige Beobachtung steht —
Text-Mimesis mit Nachkommastellen, also exakt das, was die Vorlage überwinden
will.

Weitere Bruchstellen:

| Punkt der Vorlage | Problem | Konsequenz hier |
|---|---|---|
| DAG per LLM aus Text extrahieren | Der DAG ist die **Annahme**, die alles trägt, und zugleich der am wenigsten überprüfbare Artefakt. LLM-Extraktion liefert Hörensagen über Kausalität. | LLM darf **vorschlagen**, nie **behaupten**. Eigener Hypothesen-Graph, Beweislast bei den Daten (§8) |
| „Property Graph (Neo4j)" | `GRAPH_CORE_SPEC` §15 schließt Neo4j/Property-Graph explizit aus; RDF-star deckt Kanten-Properties ab | RDF-star, keine zweite Datenbank |
| Refutation = Placebo + Random Common Cause | Fängt **Pipeline-Fehler**, nicht Confounding. Ein Placebo-Test besteht auch ein hoffnungslos konfundiertes Modell | Refutation ausbauen: Negativkontrollen, Sensitivitätsanalyse (E-Value), und — nur hier verfügbar — echte Randomisierung (§13) |
| „deterministische Inferenz-Maschine" | Identifikation ist deterministisch, Schätzung ist es nie. Konfidenzintervalle sind kein Beiwerk | Jeder Effekt trägt CI und Annahmenliste, sonst wird er nicht ausgegeben |
| Zeitreihen unerwähnt | Sensordaten sind autokorreliert und nicht i.i.d. Naive ATE-Schätzung darauf ist systematisch falsch | Lag-Variablen, zeitbewusste DAGs, Blocked Bootstrap (§13) |

### 2.3 Urteil

Sinnvoll — **wenn** man die Rollen trennt: Der Graph liefert Struktur,
Provenienz und Retrieval. Die Daten liefern die Evidenz. Das LLM liefert
Hypothesen und Sprache, nie Wahrheit. In dieser Trennung ist der Vorschlag
nicht nur sinnvoll, sondern für dieses Repo ungewöhnlich passgenau — siehe §3.

---

## 3. Die eigentliche These: Home Assistant liefert beide Hälften

Kausale Inferenz scheitert in der Praxis fast immer an einem von zwei Dingen:
Man hat einen plausiblen DAG, aber keine Daten. Oder man hat Daten, aber der
DAG ist geraten.

Eine Home-Assistant-Installation ist einer der wenigen Orte, an denen beides
gleichzeitig vorliegt — und an denen zusätzlich noch etwas Drittes existiert,
das in der Kausalforschung als Goldstandard gilt:

| Was kausale Inferenz braucht | Woher es in `ha-addon` kommt |
|---|---|
| **Strukturelle Vorannahme (DAG)** | Device Registry, Areas, Floors, Integrationen. Ein Thermostat in Raum A kann die Temperatur in Raum A beeinflussen; ein Sensor in Raum B nicht direkt. Das ist **bekannte Physik und Topologie**, nicht LLM-Raterei |
| **Dichte, zeitgestempelte Beobachtungen** | Recorder-History und Long-Term-Statistics: multivariate Zeitreihen über Monate, minutengenau |
| **Zeitliche Ordnung** | Jeder State-Change trägt `last_changed`. Zyklen lassen sich temporal auflösen, statt sie wegzudefinieren |
| **Dokumentierte Interventionen** | **Jede Automation ist ein `do()`.** Jeder manuelle Schalterdruck ist ein `do()`. Automation-Traces protokollieren, wann was ausgelöst wurde und warum |
| **Natürliche Experimente** | Der Tag, an dem eine Automation aktiviert oder geändert wurde, ist ein Interventionszeitpunkt — Interrupted Time Series und Difference-in-Differences werden direkt anwendbar |
| **Echte Randomisierung** | Der Workspace kann Automationsparameter **selbst randomisieren** und damit ein RCT im eigenen Haus fahren (§13.3) — Level 2 per Konstruktion statt per Annahme |
| **Confounder aus offenen Daten** | Außentemperatur, Sonnenstand, Strompreis, Feiertag, Luftqualität sind die klassischen Störfaktoren der Hausdomäne — und alle offen verfügbar (§11) |

Das ist der Punkt, an dem sich der Aufwand rechtfertigt: **Es gibt kein
Werkzeug im Home-Assistant-Ökosystem, das kausale Fragen beantwortet.** Es gibt
Dashboards (Level 1), es gibt Automationen (blinde Interventionen ohne
Wirkungsmessung), und es gibt neuerdings LLM-Assistenten, die über Sensorwerte
plaudern. Niemand beantwortet „hat diese Automation je etwas bewirkt".

---

## 4. Invarianten des Kausal-Layers

Ergänzend zu den zehn Invarianten aus `GRAPH_CORE_SPEC.md` §2. Verletzung ist
Review-Blocker.

**C1 — Struktur ist Annahme, nicht Ergebnis.** Ein Effekt wird nie ohne den
DAG ausgegeben, aus dem er abgeleitet wurde. Der DAG ist in der UI sichtbar
und editierbar. Wer den DAG ändert, ändert das Ergebnis — das ist keine
Schwäche, das ist die Aussage.

**C2 — Kausale Kanten sind typisiert nach Herkunft.** Vier disjunkte Klassen,
nie vermischt: `hypothesis` (LLM/Text), `structural` (Geräte-Topologie,
Physik), `learned` (Struktur-Lernen aus Daten), `asserted` (der Mensch hat es
gesetzt). Jede Kante trägt ihre Klasse. Eine Hypothese sieht in der UI niemals
aus wie ein bestätigter Effekt.

**C3 — Zahlen gehören nicht in den Triplestore.** Beobachtungsreihen liegen in
einem separaten spaltenorientierten Speicher, der Graph trägt nur Variablen,
Metadaten und Ergebnisse. Präzedenz: der Vektorindex aus §7.7 liegt ebenfalls
separat und wird über die Subjekt-IRI gekoppelt.

**C4 — Effektschätzungen sind inferiert.** Sie gehen ausschließlich in
`graph/<u>/inferred/causal/<scope>`, werden bei jedem Lauf vollständig
ersetzt, nie gemerged (Invariante 3), und tragen `prov:wasGeneratedBy` auf
einen `ow:CausalStudy`-Knoten.

**C5 — Ein Effekt ohne Refutation existiert nicht.** Schlägt die Falsifikation
fehl, wird der Pfad als fehlerhaft markiert und **nicht ausgegeben** —
Invariante 10 in kausaler Form. Ein fehlgeschlagener Test wird als solcher
angezeigt, nicht verschwiegen.

**C6 — Kein Inferenz-Leak, verschärft.** §7.3 gilt unverändert und wiegt hier
schwerer: Ein ATE über ein gemischtes Dataset ist eine Zahl, in der private
Beobachtungen stecken. Kausale Läufe sind scope-partitioniert wie
Reasoning-Läufe. Negativtest ist Abnahmebedingung.

**C7 — Jede Studie ist reproduzierbar.** `ow:CausalStudy` trägt: DAG-Revision,
Datensatz-Revision (Zeitfenster + Aggregation + Quell-Revisionen), Estimand,
Schätzverfahren, Seed, Refutations-Ergebnisse, Softwareversion. Ohne diese
Angaben wird nicht geschrieben.

**C8 — Fremdes Vokabular vor eigenem** (Invariante 8, hier besonders relevant):
Für kausale Relationen existieren etablierte Terme. Prüfauftrag vor jedem
eigenen Term: OBO Relations Ontology (`RO:0002410 causally related to`,
`RO:0002411 causally upstream of`), Wikidata (`P828 has cause`, `P1542 has
effect`), PROV für Ableitung (aber: `prov:wasDerivedFrom` ist **keine**
Kausalität und darf nicht dafür missbraucht werden), SOSA/SSN für Sensoren und
Beobachtungen, QUDT für Einheiten. Eigene `ow:`-Terme nur für das, was
nachweislich fehlt (Estimand, Adjustment Set, Refutation).

**C9 — Runtime-Ehrlichkeit.** Was in einer Runtime nicht geht, erscheint dort
nicht. `capabilities.causalTier` steuert die UI, exakt wie
`capabilities.reasoningTier`.

**C10 — Interventionen in der echten Welt sind opt-in, reversibel und
protokolliert.** Der Kausal-Layer darf nur schalten, was der Mensch pro
Entität freigegeben hat, nie sicherheitsrelevante Geräte, immer mit
Not-Aus und vollständigem `prov`-Protokoll (§13.3).

---

## 5. Datenmodell

### 5.1 Named Graphs (Ergänzung zu §3.3)

| Graph-IRI | Inhalt | Schreibrecht |
|---|---|---|
| `<base>graph/<u>/causal/<modelId>` | Der DAG: Variablen, kausale Kanten, Klasse nach C2, temporale Lags | Mensch (UI), Struktur-Import |
| `<base>graph/<u>/causal-hypotheses` | LLM- und textextrahierte Vorschläge, nie Teil eines Studien-Datasets ohne Beförderung | Hypothesen-Generator |
| `<base>graph/<u>/inferred/causal/<scope>` | Studien, Estimands, Effekte, Refutationen — vollständiger Replace | Kausal-Pipeline |
| `<base>graph/<u>/import/<connectorId>` | unverändert: HA-Registry, Open-Data-Metadaten | Connector |

### 5.2 Kern-Entitäten

```
ow:CausalModel      ein DAG, versioniert, einem Kontext zugeordnet (Wohnung, Projekt, …)
ow:Variable         eine Modellvariable; verweist per ow:observedBy auf die Quelle
                    (HA-Entity, Open-Data-Reihe, Task-Aggregat) und trägt Einheit,
                    Skalenniveau, Aggregationsregel, erlaubte Lags
ow:CausalStudy      ein Lauf: Modell + Datenfenster + Estimand + Verfahren + Ergebnis
ow:Estimand         was geschätzt werden soll, samt Identifikationsstrategie
                    (backdoor | frontdoor | iv | did | its | none)
ow:AdjustmentSet    die Menge, über die adjustiert wird (aus dem DAG berechnet)
ow:Refutation       ein Falsifikationsversuch mit Verfahren und Verdikt
ow:Experiment       eine aktiv randomisierte Intervention (§13.3)
```

### 5.3 RDF-star statt Kantentabelle

Die kausale Kante ist ein Tripel; alles über sie steht am Reifier — genau der
Mechanismus, den §3.1 für Konfidenz und Gültigkeit vorgesehen hat, und der
Grund, warum kein Property-Graph nötig ist:

```turtle
<<:fenster_offen ro:causallyUpstreamOf :heizenergie>>
    ow:edgeClass        "structural" ;
    ow:temporalLag      "PT15M"^^xsd:duration ;
    ow:evidenceLevel    "estimated" ;
    ow:effectSize       0.83 ;
    ow:effectUnit       qudt:KiloW-HR ;
    ow:ciLow            0.61 ; ow:ciHigh 1.04 ;
    ow:adjustedFor      ( :aussentemperatur :windgeschwindigkeit :tageszeit ) ;
    ow:refutationPassed true ;
    prov:wasGeneratedBy :study/2026-08-13-heizung .
```

Damit ist eine kausale Aussage **zitierfähig**: Effekt, Unsicherheit,
Adjustierung, Falsifikationsstatus und Studie hängen an der Kante selbst, nicht
in einer Nebentabelle.

---

## 6. Observation Store — die Zahlen

`ow:Variable` ist der Brückenkopf. Der Graph weiß, *dass* es eine Reihe gibt,
woher sie kommt, was sie bedeutet und wie sie aggregiert wird. Die Werte selbst
liegen daneben:

- **Materialisierung**: `data/observations/<u>/<variableId>.parquet` (oder
  Arrow/NDJSON, Entscheidung mit Messwerten wie bei Store und SHACL-Library),
  eine Datei pro Variable, Zeitstempel + Wert + Qualitätsflag.
- **Studien-Tabelle**: Ein Lauf baut aus mehreren Variablen ein reguläres Panel
  (gemeinsames Zeitraster, Resampling, Lag-Spalten, Missing-Behandlung). Diese
  Tabelle ist das, was ein Schätzer sieht. Sie wird nicht persistiert, aber ihre
  **Definition** ist Teil von `ow:CausalStudy` und damit reproduzierbar (C7).
- **Warum nicht in den Triplestore**: Zehn Sensoren über ein Jahr in
  Minutenauflösung sind ~5 Mio. Messpunkte. Als Quads wären das ~20 Mio. Tripel
  für Daten, auf denen nie eine Graph-Query läuft. Oxigraph-WASM im Browser
  stirbt daran, und es gäbe keinen Gegenwert.
- **Ehrliche Grenze in `local`**: Im Browser übernimmt OPFS die Rolle des
  Datenverzeichnisses; die zumutbare Datenmenge ist kleiner und muss im
  Speicher-Panel (§8.3) sichtbar sein.

---

## 7. Zwei Tiers — exakt das Muster aus §7.3

Die Standardwerkzeuge (DoWhy, EconML, causal-learn, Tigramite) sind Python.
Der Browser hat kein Python. Die Antwort ist dieselbe wie bei OWL RL vs. OWL
DL — nicht „dann eben nur auf dem Server", sondern ein ehrlich abgestufter
Kern.

### Tier 1 — nativ in TypeScript, in allen drei Runtimes

Alles Graphentheoretische ist reine Algorithmik und braucht keine
Numerik-Bibliothek:

- DAG-Validierung, Azyklizität, topologische Ordnung
- **D-Separation** und implizierte bedingte Unabhängigkeiten
- **Backdoor-/Frontdoor-Kriterium**, Suche minimaler Adjustment Sets
- Instrumentvariablen-Erkennung im Graphen
- Identifizierbarkeits-Entscheidung (ID-Algorithmus im abgedeckten Fragment;
  „nicht identifizierbar" ist ein **wertvolles** Ergebnis und wird als solches
  ausgegeben)
- Schätzer für den Standardfall: Stratifikation, lineare Regression mit
  Adjustierung, IPW mit logistischer Propensity, Difference-in-Differences,
  Interrupted Time Series
- Refutation: Placebo, Random Common Cause, Subset-Stabilität, Negativkontrolle,
  E-Value-Sensitivität

Damit ist der komplette Weg Frage → Identifikation → Schätzung → Refutation
**offline und im Browser** lauffähig. Das ist ungewöhnlich und passt zum
Local-First-Anspruch.

### Tier 2 — optionaler Sidecar, nur `server` und `ha-addon`

Ein Python-Container (DoWhy, EconML, causal-learn, Tigramite) per HTTP
angebunden, nie Kern-Dependency:

- Struktur-Lernen (PC, FCI, GES; für Zeitreihen PCMCI+, VAR-LiNGAM)
- Doubly-Robust- und ML-Schätzer, CATE/Heterogenität (Causal Forests)
- Synthetic Control und BSTS für Kontrafaktische Verläufe
- Formale Sensitivitätsanalyse

`capabilities.causalTier ∈ {none, graph, full}`. Was nicht läuft, erscheint
nicht (C9). Anders als der DL-Sidecar aus §7.3, der mangels Bedarf nie gebaut
wurde, hat dieser einen konkreten Anwendungsfall — trotzdem gilt: erst Tier 1,
dann messen, dann entscheiden.

---

## 8. Die neurosymbolische Schleife

Der eigentliche Gehalt von „neurosymbolisch" ist eine Arbeitsteilung mit
klarer Beweislast. Drei Rollen, streng getrennt:

**Das LLM schlägt vor.** Aus Dokumenten, HA-Entitätsnamen, Automations-YAML,
Chats und importierten Quellen extrahiert es Kandidatenkanten und, mindestens
so wichtig, **Kandidaten-Confounder** („bei Heizungsfragen ist Außentemperatur
fast immer ein Störfaktor"). Ausgabe geht ausschließlich nach
`causal-hypotheses`, mit `prov:wasAttributedTo` auf Modell und Prompt-Version.
Das ist der Punkt, an dem die Vorlage recht hat: LLMs sind gut darin, den
Hypothesenraum aufzuspannen. Sie sind schlecht darin, ihn zu entscheiden.

**Die Symbolik richtet.** Jede Hypothese durchläuft harte, billige Filter,
bevor sie überhaupt geschätzt wird:

1. Azyklizität — bricht sie den DAG, fliegt sie raus oder wird temporal aufgelöst
2. SHACL-Shapes für kausale Kanten (Typverträglichkeit, Einheiten, Lag-Plausibilität)
3. **Temporale Zulässigkeit** — die Ursache muss der Wirkung vorausgehen. Mit
   HA-Zeitstempeln ist das maschinell entscheidbar und eliminiert einen
   erheblichen Teil des LLM-Rauschens ohne eine einzige Schätzung
4. **Topologische Plausibilität** — ein Gerät in Raum B beeinflusst die
   Temperatur in Raum A nicht ohne Pfad. Die Device Registry ist hier ein
   echter Prior
5. Identifizierbarkeit — ist der Effekt aus den vorhandenen Variablen
   überhaupt schätzbar? Wenn nein: sagen, welche Variable fehlen würde. Das ist
   eine **konstruktive** Antwort und in der Praxis oft die nützlichste

**Die Daten entscheiden.** Was die Filter überlebt, wird geschätzt und
refutiert. Zusätzlich, und das ist die schärfste Klinge: Der DAG impliziert
bedingte Unabhängigkeiten (D-Separation). Diese lassen sich **gegen die realen
Daten testen**. Sagt das Modell „A ⫫ C | B" und die Daten widersprechen, ist
das Modell falsifiziert — unabhängig von jeder Effektschätzung. Das ist eine
echte Falsifikation und deutlich stärker als der Placebo-Test der Vorlage.

**Die Rückkopplung.** Drei Quellen für Struktur — LLM-Vorschlag, physische
Topologie, Struktur-Lernen aus Daten — werden verglichen. Übereinstimmung
heißt hohe Konfidenz. **Widerspruch ist der interessante Fall** und wird dem
Menschen vorgelegt: „Die Daten zeigen einen Pfad, den weder deine Topologie
noch die Literatur kennt." Das ist der Moment, in dem so ein System etwas
sagt, was niemand vorher wusste.

---

## 9. Causal Path Tracing im bestehenden Retrieval

Keine neue Pipeline — eine Erweiterung von §7.5 um wenige Felder:

```ts
interface RetrievalRequest {
  // … bestehend
  causal?: {
    mode: 'ancestors' | 'descendants' | 'paths' | 'markov-blanket';
    treatment?: string;          // IRI
    outcome?: string;            // IRI
    model?: string;              // ow:CausalModel; Default: aktives Modell
    blockedBy?: string[];        // Konditionierungsmenge; d-separierte Pfade fallen raus
    minEvidence?: 'hypothesis' | 'estimated' | 'refuted-clean';
  };
}
```

Wirkung: Die Expansions-Phase folgt kausalen Kanten statt semantischer, die
Scoring-Phase gewichtet kausale Nähe statt Kosinus-Ähnlichkeit, und `explain`
— bereits Pflichtfeld — trägt den kausalen Pfad statt nur der Hop-Distanz. Der
LLM-Kontext, der daraus assembliert wird, enthält damit **die Kette, nicht die
Wolke**. Genau das reduziert halluzinierte „weil"-Sätze, und zwar messbar:
Wenn der Kontext nur Knoten enthält, die kausal mit der Frage verbunden sind,
kann das Modell keine korrelative Nachbarschaft als Erklärung anbieten.

Das ist die billigste Einzelmaßnahme dieses Entwurfs mit dem höchsten
Sofortnutzen für die bestehende Assistenz.

---

## 10. Quellen: der neue Connector-Bedarf

Alles über den bestehenden Vertrag (§6.1). Kein Feature bekommt eine
Sonderpipeline (Invariante 5).

| Kind | Modus | Was er holt | Runtime |
|---|---|---|---|
| `home-assistant` | materialize | Registry, Areas, Floors, Entities, Integrationen → Struktur-Prior; Automations + Traces → Interventionslog; History/Statistics → Beobachtungen | `ha-addon` nativ, `server` per Long-Lived Token |
| `rest-timeseries` | materialize | generischer Zeitreihen-Holer für offene APIs (JSON/CSV, Mapping-Konfiguration, Rate-Limit, Caching) | alle |
| `sparql-endpoint` | federate | **existiert bereits** — Wikidata für Hintergrundwissen und Confounder-Kandidaten | alle |
| `csv-observations` | materialize | manueller Import eigener Messungen, Self-Tracking-Exporte | alle, besonders `local` |

**Für den `ha-addon`-Fall fehlt heute eine Kleinigkeit mit großer Wirkung**:
`deploy/ha-addon/config.yaml` setzt kein `homeassistant_api: true`. Ohne das
gibt es keinen `SUPERVISOR_TOKEN`-Zugriff auf `http://supervisor/core/api`, und
das Add-on sieht von Home Assistant genau nichts. Das ist eine Zeile — und die
Voraussetzung für alles in diesem Dokument. Sie ist bewusst zu treffen, denn
sie erweitert die Rechte des Add-ons erheblich und gehört in DOCS.md begründet.

### Open-Data-Katalog (Auswahl, DE/EU)

| Quelle | Liefert | Rolle im Kausalmodell |
|---|---|---|
| DWD Open Data / Bright Sky | Temperatur, Wind, Strahlung, Niederschlag, Sonnenscheindauer | **Der** Confounder der Hausdomäne. Ohne Außentemperatur ist jede Heizungsanalyse wertlos |
| SMARD, ENTSO-E, aWATTar/Tibber | Strompreis, Erzeugungsmix, Netzlast | Treatment (Preissignal) und Outcome (Kosten) |
| UBA Luftdaten, Sensor.Community, OpenAQ | Außenluftqualität | Confounder für Lüftungs- und Innenraumluft-Fragen |
| PVGIS, Sonnenstandsrechner | Einstrahlung, Azimut/Elevation | Confounder für PV-Ertrag, Verschattung, Innentemperatur |
| Feiertags-/Schulferien-APIs, eigener Kalender | Anwesenheitsmuster | Klassischer Confounder für Verbrauch — und seit M15 ist der Kalender bereits Graph-Bürger |
| Destatis GENESIS, Eurostat | Referenzwerte, Benchmarks | Einordnung, Vergleichsgruppen |
| Wikidata, DBpedia | Geräteklassen, physikalische Zusammenhänge, Einheiten | Struktur-Prior und Vokabular-Alignment — **über die vorhandene Föderation, ohne Import** |
| OSM/Overpass | Gebäudegeometrie, Ausrichtung, Umgebung | Struktur-Prior für Wärmemodelle |
| GTFS/DELFI | Fahrpläne, Verspätungen | Für Mobilitäts- und Anwesenheitsfragen |

Der Punkt bei Open Data ist nicht Vollständigkeit, sondern **Confounder-
Verfügbarkeit**: Der häufigste Grund, warum eine kausale Frage nicht
identifizierbar ist, ist eine fehlende Störvariable. In der Hausdomäne sind die
wichtigsten Störvariablen öffentlich, kostenlos und maschinenlesbar. Das ist
ein seltener Glücksfall.

---

## 11. Verteilung über die drei Runtimes

| | `ha-addon` | `server` | `local` |
|---|---|---|---|
| **Struktur-Quelle** | Device Registry, Areas (stark) | Manuell + LLM + Import | Manuell + LLM |
| **Beobachtungen** | Recorder/Statistics (dicht) | Open Data, HA per Token, eigene Module | Eigene Module, CSV-Import, HA-Snapshot |
| **Interventionen** | Automationen, Skripte, **aktive Randomisierung** | begrenzt (nur was der Server steuert) | keine |
| **Tier** | 1 + optional 2 | 1 + optional 2 | **nur 1** |
| **Leitfrage** | „Was bewirkt mein Haus?" | „Was bewirkt meine Arbeitsweise?" | „Stimmt mein Modell?" |
| **Kernwert** | Volle Kausalleiter bis Stufe 3 | Analyse + Föderation + Multi-User | Modellierung, Identifikation, kleine Studien — offline |

`local` ist bewusst nicht kastriert: Der DAG-Editor, D-Separation,
Identifikation, Adjustment-Set-Suche und die einfachen Schätzer laufen
vollständig im Browser. Was fehlt, ist die Datenfülle, nicht die Methode. Ein
Nutzer kann sein Kausalmodell offline bauen, prüfen und mitnehmen — und es
später an eine Instanz mit Daten hängen. Der Übergang ist wie bei Multi-User
eine Konfigurations-, keine Migrationsfrage.

---

## 12. Was man damit anstellen kann

Priorisiert nach Verhältnis von Nutzen zu Aufwand.

### 12.1 „Hat diese Automation je etwas bewirkt?"

Die stärkste Einzelanwendung. Jede Automation hat ein Aktivierungsdatum, einen
Outcome-Kandidaten und eine Kontrollperiode. Interrupted Time Series mit
Wetteradjustierung liefert eine Zahl mit Konfidenzintervall statt eines
Bauchgefühls. Ergebnis in drei Varianten, alle wertvoll: „hat gewirkt, +X",
„hat nichts bewirkt" (dann kann sie weg), „nicht entscheidbar, weil Y fehlt".

Kein bestehendes Werkzeug im HA-Ökosystem beantwortet das.

### 12.2 Ursachensuche statt Korrelationsliste

Heute: „Diese fünf Sensoren korrelieren mit dem Verbrauchsanstieg." Mit DAG:
Die Markov-Decke des Outcomes eingrenzen, d-separierte Kandidaten ausschließen,
übrig bleiben die tatsächlich möglichen Ursachen — mit der Angabe, welche
Beobachtung fehlt, um zwischen ihnen zu unterscheiden. Das ist eine
Diagnostik, keine Statistik-Anzeige.

### 12.3 Kontrafaktische Abrechnung

„Was hätte ich letzten Monat ohne die neue Heizkurve verbraucht?" — Synthetic
Control gegen die eigene Vergangenheit, wetterbereinigt. Das ist die Frage,
die Energieberichte suggerieren und nie beantworten, weil sie
Jahresvergleiche ohne Adjustierung zeigen.

### 12.4 Automations-Vorschläge mit Beleg

Der Assistent schlägt eine Automation erst vor, wenn der geschätzte Effekt die
Refutation überlebt hat, und legt sie mit Effektgröße, CI, Annahmen und
Adjustierungsmenge vor. „Keine Attrappen" (Invariante 10), angewandt auf
Handlungsempfehlungen. Nach Umsetzung misst das System nach — und korrigiert
sich, wenn der Effekt ausbleibt.

### 12.5 Selbstexperiment (`server`/`local`)

Kalender, Aufgaben, Dokumente und Chats sind seit M15 Graph-Bürger, tragen
Zeitstempel und liegen im selben Store. Damit sind Fragen beantwortbar wie:
Wie wirkt sich Meeting-Dichte vor 10 Uhr auf erledigte Aufgaben aus,
adjustiert für Wochentag und Auftragslage? Wie wirkt Raumtemperatur oder
CO₂-Gehalt auf Fokuszeit? Hier ist der Effekt klein und das Rauschen groß —
die ehrliche Antwort ist oft „nicht identifizierbar", und genau diese Antwort
zu geben statt einer bunten Korrelation ist der Fortschritt.

### 12.6 Kausal geerdetes Retrieval für den Assistenten (§9)

Wirkt sofort auf alles Bestehende, ohne dass eine einzige Studie laufen muss.

### 12.7 Das Selbstmodell wird kausal (§18)

Der Workspace beschreibt sich bereits selbst. Der Kausal-Layer erlaubt ihm,
seine **eigene Wirkung** zu modellieren: Verändert die Nutzung eines Moduls
messbar die Aufgabenerledigung? Das ist die konsequente Fortsetzung von §18 —
von „was bin ich" zu „was bewirke ich" — und ein ungewöhnlich sauberer
Testfall, weil die Daten vollständig im eigenen Store liegen.

---

## 13. Die drei Falsifikationsebenen

Die Vorlage kennt eine. Verfügbar sind drei, mit stark steigender Härte.

**13.1 Pipeline-Refutation** (die der Vorlage): Placebo-Treatment, Random
Common Cause, Datensubset, Unobserved-Common-Cause-Simulation. Fängt
Implementierungsfehler. Notwendig, nicht hinreichend. So kommunizieren.

**13.2 Modell-Refutation** (die schärfere): Die vom DAG implizierten bedingten
Unabhängigkeiten gegen die Daten testen. Widerspruch falsifiziert das Modell,
nicht nur die Schätzung. Zusätzlich Negativkontrollen (ein Outcome, das der
Treatment nicht beeinflussen *kann*, muss Nulleffekt zeigen) und
E-Value-Sensitivität (wie stark müsste ein unbeobachteter Confounder sein, um
das Ergebnis zu kippen).

**13.3 Experimentelle Refutation** (die eigentliche): Der Workspace kann in
`ha-addon` eine Intervention **randomisieren**. Beispiel: Eine Automation, die
den Sollwert absenkt, wird zwei Wochen lang zufällig an manchen Tagen
angewendet und an anderen nicht. Das Ergebnis ist ein RCT — kein
Adjustierungs-Argument mehr nötig, weil die Randomisierung die Confounder
per Konstruktion neutralisiert.

Das ist der Punkt, an dem dieses System etwas kann, das keine Cloud-Analyse
kann: Es hat **Aktoren**. Der Preis sind harte Leitplanken (C10):

- Randomisierung nur auf explizit freigegebenen, reversiblen, nicht
  sicherheitsrelevanten Entitäten. Keine Heizung unter Frostgrenze, kein
  Rauchmelder, kein Schloss, keine medizinischen Geräte
- Vorab definierte Grenzen (Wertebereich, Dauer, Abbruchbedingungen), Not-Aus
  jederzeit, automatischer Abbruch bei Grenzverletzung
- Vollständiges Protokoll als `ow:Experiment` mit `prov` — jede Randomisierung
  ist im Nachhinein nachvollziehbar
- Informierte Zustimmung pro Experiment, nie pauschal. Andere Bewohner sind
  betroffen und werden nicht heimlich randomisiert — das ist eine ethische
  Frage, keine technische, und gehört in die UI

---

## 14. Föderation: Kausalwissen teilen, Rohdaten behalten

Der interessanteste Nebeneffekt und ein möglicher Alleinstellungspunkt.

Rohdaten aus dem eigenen Haus sind maximal privat. Ein **validiertes
Kausalmodell** ist es nicht: Der DAG und die Effektgröße mit
Konfidenzintervall tragen keine einzelne Beobachtung. Damit gilt:

- Der öffentliche Teilgraph (§17.5) kann Struktur und Effekte tragen, während
  die Beobachtungen privat bleiben
- Über die bestehende Föderation (M11) sind fremde Kausalmodelle abfragbar
- Mehrere Instanzen ergeben eine **verteilte Meta-Analyse**: „In N Haushalten
  mit Baujahr < 1980 liegt der Effekt von Stoßlüften auf den Heizverbrauch bei
  X ± Y." Niemand hat dafür Rohdaten geteilt
- Ein neuer Nutzer startet nicht bei null, sondern mit einem Struktur-Prior aus
  der Gemeinschaft, den seine eigenen Daten dann bestätigen oder widerlegen

Das ist föderiertes Lernen ohne Föderiertes-Lernen-Infrastruktur — möglich,
weil das Vokabular geteilt und die Vokabular-Base produktweit konstant ist
(§3.2). Genau der Grund, aus dem diese Entscheidung damals getroffen wurde,
zahlt hier ein zweites Mal.

**Ehrliche Warnung**: Effektgrößen sind nicht so anonym, wie sie aussehen. Bei
kleinen Datenfenstern und seltenen Ereignissen kann ein Effekt eine einzelne
Beobachtung durchscheinen lassen. Mindest-Stichprobengrößen vor
Veröffentlichung, Rundung, und im Zweifel keine Veröffentlichung — dieselbe
Logik wie beim Inferenz-Leak (C6), nur numerisch.

---

## 15. Ehrliche Grenzen

Was jeder wissen muss, der das baut oder benutzt:

1. **Der DAG ist die Annahme.** Kausale Inferenz erzeugt keine Kausalität, sie
   überträgt Annahmen in Zahlen. Ein falscher DAG liefert eine
   selbstbewusste falsche Zahl. Deshalb C1.
2. **Zeitreihen sind kein i.i.d.-Datensatz.** Autokorrelation, Saisonalität,
   Trends, Regime-Wechsel. Naive Standardfehler sind zu klein; Blocked
   Bootstrap und zeitbewusste Modelle sind Pflicht, nicht Kür.
3. **Wenig Varianz, kein Effekt.** Wenn ein Thermostat immer auf 21° steht,
   lässt sich sein Effekt nicht schätzen — egal wie viele Monate Daten
   vorliegen. Positivität ist eine Annahme, die geprüft und berichtet werden
   muss.
4. **Sensorqualität.** Ausfälle, Drift, „unavailable"-Zustände,
   Batteriewechsel. Fehlende Werte sind selten zufällig fehlend, und das
   verzerrt.
5. **Recorder-Aufbewahrung.** Volle States meist nur wenige Tage,
   Long-Term-Statistics nur Aggregate. Der Kausal-Layer muss früh anfangen,
   selbst zu materialisieren, sonst gibt es keine Historie.
6. **Der Aufwand ist real.** Das ist kein Wochenendprojekt. Tier 1 allein
   sind mehrere Meilensteine, und der Nutzen kommt erst mit den Daten, also
   Wochen nach dem Bau.
7. **Textextrahierte Kausalität bleibt Hörensagen.** Sie ist als
   Hypothesenquelle nützlich und als Evidenz wertlos. Nie vermischen (C2).

---

## 16. Meilensteinvorschlag

Im Arbeitsmodus der Spec: ein Meilenstein, eine Session, ein Branch, ein PR.

| | Inhalt | Abnahme |
|---|---|---|
| **C0** | Vokabular (nach C8 fremdes zuerst), Named Graphs, SHACL-Shapes für kausale Kanten, `ow:CausalModel`/`Variable` als Graph-Bürger, DAG-Editor read-only | Ontologie-CI grün; ein von Hand modellierter DAG ist per SPARQL abfragbar; Layout-Blacklist hält |
| **C1** | Tier-1-Kern: Azyklizität, D-Separation, Backdoor/Frontdoor, minimale Adjustment Sets, Identifizierbarkeits-Entscheidung. Reine Graphalgorithmik, keine Daten | Testsuite gegen bekannte Lehrbuch-DAGs; „nicht identifizierbar" wird korrekt und begründet zurückgegeben; läuft im Browser |
| **C2** | Causal Path Tracing im Retrieval (§9) + Anzeige im Explorer | `explain` trägt den kausalen Pfad; d-separierte Knoten fallen bei gegebener Konditionierung nachweislich raus |
| **C3** | Observation Store + `home-assistant`-Connector (Registry → Struktur, History/Statistics → Reihen, Traces → Interventionslog) + `homeassistant_api` im Add-on | Ein realer HA-Bestand erzeugt Variablen und Reihen; Reproduzierbarkeit über zwei Läufe; Scope-Leak-Negativtest |
| **C4** | Schätzung + Refutation Tier 1, `ow:CausalStudy` mit vollständiger Reproduktions-Signatur, Ergebnis-UI mit DAG, CI und Refutations-Badge | Ein bekannter Effekt aus synthetischen Daten wird korrekt geschätzt; ein konfundierter Fall wird als solcher erkannt; ein durchgefallener Effekt erscheint **nicht** als Effekt |
| **C5** | Open-Data-Connector `rest-timeseries` + Confounder-Katalog (Wetter, Preis, Sonnenstand, Feiertag) | Dieselbe Frage mit und ohne Adjustierung liefert nachweislich unterschiedliche Ergebnisse, und die Differenz wird erklärt |
| **C6** | Neurosymbolische Schleife: LLM-Hypothesen mit Provenienz, symbolische Filter, Vergleich der drei Strukturquellen, Widerspruchs-UI | Keine Hypothese erreicht ohne Filter den Studien-Pfad; ein temporal unmöglicher Vorschlag wird automatisch verworfen |
| **C7** | *Optional, eigene Entscheidung*: Experimente (§13.3) mit allen Leitplanken | Nur freigegebene Entitäten; Not-Aus getestet; vollständiges `prov`-Protokoll; Grenzverletzung bricht ab |
| **C8** | *Optional*: Tier-2-Sidecar, Struktur-Lernen, Föderation von Kausalmodellen | `capabilities.causalTier` steuert die UI ehrlich; ohne Sidecar ist nichts sichtbar, was ihn braucht |

---

## 17. Nicht-Ziele

- Keine eigene Zeitreihendatenbank als Service. Der Observation Store ist ein
  Dateiformat im Datenverzeichnis, kein Prozess.
- Kein Ersatz für Home Assistants Recorder, Energy Dashboard oder Statistics.
  Der Workspace liest, er verwaltet nicht.
- Kein automatisches Schalten ohne ausdrückliche, entitätsscharfe Freigabe.
- Kein Query-Time-Reasoning, auch nicht kausal (§15 gilt weiter).
- Keine Behauptung von Kausalität in der UI, wo nur Assoziation vorliegt. Die
  Wortwahl der Oberfläche ist Teil der Spezifikation, nicht Kosmetik.
- Kein Property-Graph, kein Neo4j. RDF-star trägt den Bedarf (§5.3).

---

## 18. Empfehlung

Bauen — aber in der Reihenfolge C2 → C0/C1 → C3 → C4, nicht in der Reihenfolge
der Vorlage.

Begründung: **C2 zahlt sofort und ohne Daten ein.** Kausal geerdetes Retrieval
verbessert die bestehende Assistenz messbar, sobald ein einziger von Hand
modellierter DAG existiert. C0/C1 sind reine Algorithmik, vollständig testbar,
ohne externe Abhängigkeit und ohne Sidecar — sie laufen in allen drei Runtimes
und sind damit die einzige kausale Fähigkeit, die zum Local-First-Anspruch
ohne Einschränkung passt. Erst C3 bringt den Datenaufwand, und erst C4 bringt
Zahlen, die man falsch verstehen kann.

Der umgekehrte Weg — zuerst LLM-Extraktion großer Kausalgraphen aus Text, wie
die Vorlage vorschlägt — erzeugt schnell viel Struktur, die niemand prüfen
kann, und genau dafür hat dieses Repo mit Invariante 10 bereits eine Haltung.
