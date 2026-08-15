# SPEC-ENTWURF: Kausal-Layer — Neurosymbolik und Causal Inference im Graph-Kern

**Repo**: `pajew-ski/open-workspace`
**Typ**: Technische Spezifikation, **verbindlich für die Umsetzung von
C0–C5**. C7 (Experimente) und C8 (Tier-2-Sidecar) bleiben ausdrücklich
opt-in und werden einzeln entschieden — sie greifen in die physische Welt
bzw. bringen eine zweite Laufzeitumgebung mit.
**Umsetzungsstand**: **C3 (Erfassung) ist gebaut** — bewusst zuerst, weil
er als einziger zeitkritisch ist (§15.5). Alles Übrige ist spezifiziert
und nicht gebaut; es erscheint deshalb nirgends in der UI (Invariante 10).
Was gebaut ist, steht in [docs/beobachtungen.md](./docs/beobachtungen.md),
der offene Stand abhakbar in [TODO.md](./TODO.md); Reihenfolge und
Arbeitsmodus stehen in §18 und §19.
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
| **Dichte, zeitgestempelte Beobachtungen** | Recorder-History: multivariate Zeitreihen, minutengenau — aber nur `purge_keep_days` lang (Standard 10). Über Monate bleiben allein die Long-Term-Statistics: Stundenwerte, und die nur für numerische Größen mit `state_class`. Beides zusammen gibt es nicht (§15.5), und genau deshalb ist die eigene Erfassung (C3) der zeitkritische Meilenstein |
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
ow:Variable         eine Modellvariable; trägt Einheit, Skalenniveau,
                    Aggregationsregel, erlaubte Lags und den Quellschlüssel
                    (ow:observationSource). Die Verbindung zur Quelle macht
                    sosa:observes vom Sensor auf die Variable — fremdes
                    Vokabular vor eigenem (entschieden am 2026-08-14,
                    docs/spec-widersprueche.md Eintrag 8; die erste Fassung
                    nannte ein eigenes ow:observedBy in Gegenrichtung)
ow:CausalStudy      ein Lauf: Modell + Datenfenster + Estimand + Verfahren + Ergebnis
ow:Estimand         was geschätzt werden soll
ow:AdjustmentSet    die Menge, über die adjustiert wird (aus dem DAG berechnet)
ow:Refutation       ein Falsifikationsversuch mit Verfahren und Verdikt
ow:Experiment       eine aktiv randomisierte Intervention (§13.3)
```

**Identifikation und Verfahren sind ZWEI Angaben** (entschieden am
2026-08-14, docs/spec-widersprueche.md Eintrag 1; die erste Fassung nannte
einen gemeinsamen Wertebereich `backdoor | frontdoor | iv | did | its |
none`). Sie gehören getrennt, weil sie aus verschiedenen Quellen kommen:

```
ow:identificationStrategy   Antwort des DAGs: backdoor | frontdoor | iv | none
ow:estimator                gerechnetes Verfahren: stratification | regression |
                            ipw | did | its
```

`did` und `its` sind **Studiendesigns**, nicht Identifikationsstrategien —
sie setzen ihrerseits eine Backdoor-Identifikation voraus. In einem Feld
zusammengefasst wäre nicht mehr ablesbar, ob eine ITS-Studie überhaupt
identifiziert war.

**Die Chronik** (entschieden am 2026-08-14, Eintrag 3): Ergebnisse liegen im
Inferenz-Graphen und werden bei jedem Lauf ersetzt (Invariante C4), und
Inferenz-Graphen werden nie persistiert (§8.1). Damit gäbe es keine
Historie. Deshalb hält ein Lauf jede **Änderung** seines Ergebnisses in
`graph/<u>/causal-archive` fest — behauptet und persistiert, weil ein
Ereignis („am 14.08.2026 sagte diese Frage auf Revision 7 das hier") kein
abgeleiteter Zustand ist, sondern eine `prov:Activity`, die stattgefunden
hat. Der Effekt eines Chronik-Eintrags hängt **nie** am Reifier der Kante;
sonst lägen alte Läufe über der aktuellen Annahme.

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
    schema:unitText     "kWh" ;
    ow:ciLow            0.61 ; ow:ciHigh 1.04 ;
    ow:adjustedFor      ( :aussentemperatur :windgeschwindigkeit :tageszeit ) ;
    ow:refutationPassed true ;
    prov:wasGeneratedBy :study/2026-08-13-heizung .
```

Damit ist eine kausale Aussage **zitierfähig**: Effekt, Unsicherheit,
Adjustierung, Falsifikationsstatus und Studie hängen an der Kante selbst, nicht
in einer Nebentabelle.

**Die Einheit ist Text, keine QUDT-IRI** (entschieden am 2026-08-14,
docs/spec-widersprueche.md Eintrag 2; die erste Fassung zeigte
`ow:effectUnit qudt:KiloW-HR`). Grund: Die Erfassung (C3/C5) übernimmt
Einheiten quelltreu — Home Assistant liefert `unit_of_measurement`, Bright
Sky `°C`, aWATTar `ct/kWh` —, und eine QUDT-IRI liegt dort nirgends vor.
`schema:unitText` trägt beides, ein eigener Term wäre eine zweite
Schreibweise für dieselbe Sache (Invariante 8). Eine QUDT-Abbildung bleibt
möglich; sie gehört dann an die Variable, nicht an den Effekt.

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
   erheblichen Teil des LLM-Rauschens ohne eine einzige Schätzung.
   *Präzisiert am 14.08.2026 (docs/spec-widersprueche.md, Eintrag 11):
   Aus Zeitstempeln allein entscheidbar sind das **Vorzeichen des
   Zeitversatzes** und die **Abdeckung** (beginnt die Erfassung der
   Ursache erst nach dem Ende der Wirkung, kann keine erfasste Ursache
   einer erfassten Wirkung vorausgehen). Die Richtung der Wirkung aus
   Korrelationen zu erschließen wäre Struktur-Lernen und gehört zu C8.*
4. **Topologische Plausibilität** — ein Gerät in Raum B beeinflusst die
   Temperatur in Raum A nicht ohne Pfad. Die Device Registry ist hier ein
   echter Prior
5. Identifizierbarkeit — ist der Effekt aus den vorhandenen Variablen
   überhaupt schätzbar? Wenn nein: sagen, welche Variable fehlen würde. Das ist
   eine **konstruktive** Antwort und in der Praxis oft die nützlichste.
   *Präzisiert am 14.08.2026 (Eintrag 10): Dieser Filter **verwirft
   nicht**. Er hängt an der Datenlage, nicht an der Struktur, und eine
   Ablehnung ließe die Daten über die Annahme entscheiden — gegen
   Invariante C1. Er erzeugt das Urteil `open`; die vier harten Filter
   darüber erzeugen `rejected`.*

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

> *Präzisiert am 14.08.2026 (docs/spec-widersprueche.md, Eintrag 9):
> Struktur-Lernen aus Daten gehört nach §16 zu **C8** und darf nach §19
> ohne Freigabe nicht angefangen werden — C6 kann diese dritte Quelle
> nicht liefern. Gebaut sind stattdessen `llm`, `topology` und
> `wikidata` (§10, über die Föderation aus M11, ohne Import). Das
> Struktur-Lernen wird im Vergleich als **fehlende Quelle** geführt: Die
> Kantenklasse `learned` bleibt leer, und eine Übereinstimmung sagt dann
> etwas über zwei Quellen aus, nicht über drei. Eine erfundene dritte
> Stimme wäre schlechter als zwei ehrliche.*

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
| `solar-position` | materialize | Sonnenhöhe, Azimut, Tag/Nacht und extraterrestrische Einstrahlung — **gerechnet statt geholt** | alle |

**Was „materialize" für diese Connectors heißt** (entschieden am
2026-08-14, docs/spec-widersprueche.md Eintrag 5): die **Angebotsseite**,
nicht die Reihe. Messwerte gehören nie in den Store (Invariante C3);
materialisiert wird, welche Größen eine Quelle liefert, in welcher
Einheit, an welchem Ort, mit welchem Skalenniveau. Die Werte holt der
Erfassungslauf in den Beobachtungs-Speicher — dieselbe Trennung wie bei
`home-assistant`.

**Eine berechnete Größe IST eine Beobachtung** (entschieden am 2026-08-14,
Eintrag 4). Der Sonnenstand hat keine offene Zeitreihen-API und braucht
auch keine: Azimut und Elevation sind eine Funktion von Ort und Zeit,
exakt, lückenlos und ohne Ausfall. Sie laufen deshalb über denselben
Connector-Vertrag wie alles Externe (Invariante 5) und bleiben ehrlich
über das Verfahren im Graphen: `ssn:implements` → `sosa:Procedure`. SOSA
lässt das ausdrücklich zu — ein Sensor ist dort alles, was eine
Beobachtung ausführt, auch ein Rechenverfahren.

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
| Sonnenstand (gerechnet, `solar-position`) | Azimut, Elevation, Tag/Nacht, extraterrestrische Einstrahlung | Exogen und lückenlos: die geometrische Hälfte der Einstrahlung, während das Wetter die atmosphärische liefert |
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
5. **Recorder-Aufbewahrung — und zwar asymmetrisch.** Volle
   Zustandswechsel hält Home Assistant nur `purge_keep_days` (Standard 10
   Tage). Was bleibt, sind Long-Term-Statistics: stündliche Aggregate,
   unbegrenzt aufbewahrt — aber **nur für Entitäten mit `state_class`**,
   also für numerische Messgrößen. Schalter, Fenster, Bewegung,
   Anwesenheit, Automations-Zustände und Textzustände sind danach
   ersatzlos fort.

   Das ist die schlechtestmögliche Aufteilung für kausale Inferenz:
   **Outcomes überleben, Treatments nicht.** Man behält die
   Temperaturkurve und verliert, wann geheizt und gelüftet wurde. Ohne
   Ursachenseite ist keine Schätzung möglich, egal wie lang die
   Outcome-Reihe ist. Deshalb ist die Erfassung (C3) der zeitkritische
   Meilenstein und deshalb wurde er zuerst gebaut — jeder Tag ohne sie ist
   ein verlorener Tag.
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
| **C3** ✅ | Observation Store + `home-assistant`-Connector (Registry → Struktur, History → Reihen) + `homeassistant_api` im Add-on. **Gebaut** — Abnahme in `tests/graph/observations.test.ts` und `tests/graph/home-assistant.test.ts`, Doku in `docs/beobachtungen.md`. Der **LTS-Backfill** ist nachgezogen (`recorder/statistics_during_period` über die WebSocket-API — Abnahme in `tests/graph/observations-backfill.test.ts`): Er verlängert den Bestand in Stundenschritten nach hinten, füllt nur Tage ohne Messpunkte und weist die aggregierte Strecke als solche aus. Offen geblieben und einzeln notiert: Automations-Traces als Interventionslog | Zwei Läufe erzeugen keine Dublette (Wasserzeichen); kein Messwert landet im Store; Lücken werden erfasst statt fortgeschrieben; ein Fehler bei einer Größe lässt die anderen laufen |
| **C4** | Schätzung + Refutation Tier 1, `ow:CausalStudy` mit vollständiger Reproduktions-Signatur, Ergebnis-UI mit DAG, CI und Refutations-Badge | Ein bekannter Effekt aus synthetischen Daten wird korrekt geschätzt; ein konfundierter Fall wird als solcher erkannt; ein durchgefallener Effekt erscheint **nicht** als Effekt |
| **C5** ✅ | Open-Data-Connector `rest-timeseries` + Confounder-Katalog (Wetter, Preis, Sonnenstand, Feiertag), dazu `csv-observations` und `solar-position`. **Gebaut** — Abnahme in `tests/graph/open-data.test.ts`, Doku in `docs/kausalmodell.md` | Dieselbe Frage mit und ohne Adjustierung liefert nachweislich unterschiedliche Ergebnisse, und die Differenz wird erklärt |
| **C6** ✅ | Neurosymbolische Schleife: LLM-Hypothesen mit Provenienz, symbolische Filter, Vergleich der drei Strukturquellen, Widerspruchs-UI. **Gebaut** — Abnahme in `tests/graph/causal-hypotheses.test.ts`, Doku in `docs/kausalmodell.md`. Die dritte Strukturquelle ist `wikidata` statt Struktur-Lernen (gehört zu C8, §19) — die fehlende Quelle wird im Vergleich benannt, nicht erfunden (docs/spec-widersprueche.md, Eintrag 9) | Keine Hypothese erreicht ohne Filter den Studien-Pfad; ein temporal unmöglicher Vorschlag wird automatisch verworfen |
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

## 18. Reihenfolge

**C3 → C0 → C1 → C2 → C4 → C5 → C6**, und C7/C8 nur nach eigener
Entscheidung. **C3, C0, C1, C2, C4, C5 und C6 sind gebaut. Damit ist der
verbindliche Teil dieser Spec vollständig; was bleibt, ist opt-in.**

> **Korrektur gegenüber der ersten Fassung dieses Dokuments.** Dort stand
> „C2 zuerst", weil kausal geerdetes Retrieval ohne Daten einzahlt. Das ist
> als Nutzen richtig, als Reihenfolge falsch: C2 folgt kausalen Kanten, und
> kausale Kanten gibt es erst mit dem Vokabular und den Named Graphs aus
> C0. Ein von Hand modellierter DAG ist keine Vorbedingung von C0, sondern
> sein Ergebnis. Verbindlich ist die Reihenfolge oben.

Begründung der einzelnen Schritte:

- **C3 zuerst, und das ist erledigt.** Als einziger Meilenstein ist er
  zeitkritisch: Home Assistant verwirft die Ursachenseite nach zehn Tagen
  (§15.5). Jeder Tag ohne Erfassung ist unwiederbringlich; alles andere
  kann warten, ohne dass etwas verloren geht.
- **C0 und C1 sind reine Algorithmik** — Vokabular, DAG als Graph-Bürger,
  D-Separation, Backdoor/Frontdoor, Adjustment Sets, Identifizierbarkeit.
  Vollständig testbar gegen Lehrbuch-DAGs, ohne Netz, ohne Daten, ohne
  Sidecar. Sie laufen in allen drei Runtimes und sind damit die einzige
  kausale Fähigkeit, die den Local-First-Anspruch ohne Einschränkung hält.
- **C2 danach**: Sobald kausale Kanten existieren, verbessert kausal
  geerdetes Retrieval die bestehende Assistenz sofort — noch bevor eine
  einzige Zahl geschätzt wird.
- **C4 zuletzt vor den Quellen**: Erst hier entstehen Zahlen, die man
  falsch verstehen kann. Sie brauchen die Identifikation aus C1 und die
  Refutation aus demselben Meilenstein, sonst wären sie genau die
  selbstbewusste Scheinpräzision, gegen die §2.2 argumentiert.
- **C5 schließt die Lücke**, die C4 sichtbar macht: Der häufigste Grund für
  „nicht identifizierbar" ist eine fehlende Störvariable, und die
  wichtigsten der Hausdomäne sind offen verfügbar (§11).
- **C6 ganz zuletzt, und genau deshalb tragfähig**: Erst jetzt gibt es
  alles, was ein Vorschlag durchlaufen muss, bevor er etwas wert ist — den
  DAG (C0), die Azyklizitäts- und Identifikationsprüfung (C1), die
  Erfassung samt Zeitstempeln für die temporale Zulässigkeit (C3) und die
  Geräte-Topologie als Prior (C3/C5). Dieselben Vorschläge am Anfang
  hätten ungeprüft im Graphen gelegen.

Der umgekehrte Weg — zuerst LLM-Extraktion großer Kausalgraphen aus Text, wie
die Vorlage vorschlägt — erzeugt schnell viel Struktur, die niemand prüfen
kann, und genau dafür hat dieses Repo mit Invariante 10 bereits eine Haltung.
Dass C6 am Ende steht und nicht am Anfang, ist die praktische Fassung
dieser Haltung.

---

## 19. Arbeitsmodus der Sessions

Wie beim Graph-Kern: **ein Meilenstein = eine Session = ein Branch = ein
PR** (GRAPH_CORE_SPEC §13). Kein Meilenstein wird aufgeteilt, keine zwei
werden zusammengelegt. Dasselbe gilt für die **Nacharbeiten** unter der
Meilensteinliste in TODO.md: Seit der verbindliche Teil (C0–C6) fertig
ist, sind sie es, die eine Session ohne Freigabe beginnen darf — und eine
davon ist eine Session, ein Branch, ein PR, genau wie ein Meilenstein.

Jede Session:

1. liest `AGENTS.md` („Hier weitermachen"), dieses Dokument und den
   Abschnitt zum anstehenden Meilenstein in §16, dazu `TODO.md`
   („Kausal-Layer") für den offenen Stand;
2. setzt **genau einen** Punkt vollständig um, inklusive seiner Abnahme:
   bei einem Meilenstein die aus §16, bei einer **Nacharbeit** die, die
   in ihrem TODO-Eintrag steht — §16 hat für Nacharbeiten keine Zeile,
   und eine Session, die deshalb ohne Abnahme arbeitete, wäre die
   schlechteste Auslegung von zweien
   (docs/spec-widersprueche.md, Eintrag 14). Beides gilt gleich streng:
   ein Punkt, ein Branch, ein PR;
3. erfüllt die Definition of Done aus GRAPH_CORE_SPEC §14 — Lint 0,
   Typecheck sauber, kein `any` unter `src/lib/graph/`, Ontologie-Check
   grün, Unit-Tests für jedes neue Mapping, E2E-Gate grün inklusive neuer
   Seiten, deutsche UI-Labels, Mobile-First;
4. hakt in `TODO.md` ab und aktualisiert `AGENTS.md`;
5. hält die Invarianten C1–C10 aus §4 ein. Sie sind Review-Blocker, nicht
   Empfehlungen.

**Wo diese Spec sich widerspricht**, steht es gesammelt in
[docs/spec-widersprueche.md](./docs/spec-widersprueche.md) — mit
Auflösung, Stand und den Kosten der Gegenrichtung. Einträge mit dem Stand
„entschieden" sind hier eingearbeitet; „offen" heißt: die dort
beschriebene Auslegung gilt und ist umgesetzt, aber sie ist eine
Auslegung. Wer beim Bauen auf einen neuen stößt, trägt ihn dort ein.

**Was eine Session NICHT tut**: diese Spec neu verhandeln. Die
Entscheidungen in §2 (Bewertung der Vorlage), §4 (Invarianten), §7 (zwei
Tiers) und §18 (Reihenfolge) sind getroffen. Wer beim Bauen auf einen
echten Widerspruch stößt, hält ihn fest und legt ihn vor, statt ihn
eigenmächtig aufzulösen.

**Was eine Session zusätzlich nicht tut**: C7 (Experimente in der echten
Welt) oder C8 (Python-Sidecar) anfangen. Beide brauchen eine ausdrückliche
Freigabe — C7 greift über Aktoren in die Wohnung ein und betrifft
Mitbewohner, C8 bringt eine zweite Laufzeitumgebung ins Deployment.

Startpunkt einer Session, wenn nichts anderes gesagt ist: **der oberste
nicht abgehakte Punkt unter „Kausal-Layer" in TODO.md, den eine Session
ohne Freigabe beginnen darf.** C7 und C8 stehen dort als „opt-in" und
werden übersprungen — nicht abgehakt, nicht angefangen. Ohne diesen
Zusatz zeigte der Startpunkt seit C6 auf genau die beiden Meilensteine,
die der Absatz darüber verbietet (docs/spec-widersprueche.md, Eintrag
12): Eine Reihenfolgeregel hebt keine Sicherheitsregel auf.
