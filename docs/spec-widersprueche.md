# Widersprüche in der Spec — festgehalten, vorgelegt, entschieden

CAUSAL_LAYER_SPEC §19 verbietet einer Session, die Spec neu zu
verhandeln. Wer beim Bauen auf einen echten Widerspruch stößt, hält ihn
fest und legt ihn vor. Diese Datei ist dieser Ort.

**Wie sie zu lesen ist**: Jeder Eintrag nennt die Stelle, den
Widerspruch, wie er beim Bauen aufgelöst wurde und was es kosten würde,
ihn anders aufzulösen. Die Einträge 1–8 sind am **14.08.2026**
entschieden worden, die Einträge 9–11 kamen beim Bauen von C6 hinzu und
sind mit ihm entschieden; wo die Entscheidung den Text der Spec betrifft,
ist sie dort eingearbeitet. Wer beim Bauen auf einen neuen stößt, trägt
ihn hier ein. **Kein Eintrag steht offen.**

| # | Stelle | Meilenstein | Stand |
|---|---|---|---|
| 1 | §5.2 Identifikationsstrategie mischt DAG-Antwort und Studiendesign | C4 | entschieden, Spec angepasst |
| 2 | §5.3 `ow:effectUnit` mit QUDT-IRI | C4 | entschieden, Spec angepasst |
| 3 | C4 + §8.1: Ergebnisse sind flüchtig, es gibt keine Historie | C4 | entschieden, **Chronik gebaut** |
| 4 | §10 „Sonnenstand" ist keine Zeitreihen-API | C5 | entschieden, **gerechnete Quelle gebaut** |
| 5 | §10 `rest-timeseries` „materialize" gegen Invariante C3 | C5 | entschieden, Spec präzisiert |
| 6 | §16 C5-Abnahme liest sich wie zwei gleichrangige Ergebnisse | C5 | entschieden, umgesetzt |
| 7 | §10 nennt vier Connector-Arten, §16 verlangt für C5 eine | C5 | entschieden, **`csv-observations` gebaut** |
| 8 | §5.2 `ow:observedBy` gegen Invariante 8 | C3/C5 | entschieden, Spec angepasst |
| 9 | §8 verlangt für C6 drei Strukturquellen, eine davon ist C8 | C6 | entschieden, **fehlende Quelle wird benannt** |
| 10 | §8 zählt Identifizierbarkeit zu den Filtern — gegen Invariante C1 | C6 | entschieden, umgesetzt |
| 11 | §8 „temporale Zulässigkeit maschinell entscheidbar" — wie weit? | C6 | entschieden, Spec präzisiert |

---

## 1. §5.2 — die Identifikationsstrategie mischt zwei Dinge (C4)

**Die Stelle.** §5.2 nannte als Wertebereich der Strategie
`backdoor | frontdoor | iv | did | its | none`.

**Der Widerspruch.** Die ersten drei und `none` sind Antworten des
**DAGs** (Adjustment-Kriterium, C1). `did` und `its` sind
**Studiendesigns**, die aus der Zeitachse kommen und ihrerseits eine
Backdoor-Identifikation voraussetzen. In einem Feld zusammengefasst wäre
nicht mehr ablesbar, ob eine ITS-Studie überhaupt identifiziert war.

**Entschieden.** Zwei Terme: `ow:identificationStrategy` trägt die
Antwort des Graphen, `ow:estimator` das gerechnete Verfahren. Beide
stehen an der Studie. §5.2 der Spec sagt das jetzt.

**Was die Gegenrichtung gekostet hätte.** Ein Feld weniger im Graphen —
und die Auskunft „identifiziert, aber mit einem Zeitdesign gerechnet"
wäre nicht mehr formulierbar.

## 2. §5.3 — `ow:effectUnit` mit QUDT-IRI (C4)

**Die Stelle.** Das Beispiel in §5.3 zeigte `ow:effectUnit qudt:KiloW-HR`.

**Der Widerspruch.** Die Erfassung übernimmt Einheiten **quelltreu**: Home
Assistant liefert `unit_of_measurement`, Bright Sky `°C`, aWATTar
`ct/kWh`. Eine QUDT-IRI liegt dort nirgends vor. Ein eigener Term wäre
eine zweite Schreibweise für dieselbe Sache (Invariante 8).

**Entschieden.** `schema:unitText`, Einheit als Text — an der Variablen
wie am Effekt. §5.3 zeigt es jetzt so.

**Was die Gegenrichtung gekostet hätte.** Eine Abbildung Text → QUDT-IRI.
Sie gehört dann an die **Variable**, nicht an den Effekt, und ist ohne
Einheiten-Normalisierung nicht verlustfrei.

## 3. C4 + §8.1 — Ergebnisse waren flüchtig (C4)

**Die Stelle.** Invariante C4 (Ergebnisse liegen im Inferenz-Graphen und
werden bei jedem Lauf ersetzt) und §8.1 (Inferenz-Graphen werden nie
persistiert).

**Der Widerspruch.** Zusammen hieß das: Nach einem Neustart gab es keine
Studie mehr, bis jemand rechnete — und es gab **keine Historie** von
Effekten über Modell-Revisionen hinweg. „Was sagte dieselbe Frage vor drei
Monaten?" war nicht beantwortbar.

**Entschieden: die Chronik.** `graph/<u>/causal-archive` hält fest, was
eine Frage wann gesagt hat — behauptet, persistiert, im Snapshot.

**Warum das keine Invariante bricht.** Der Inferenz-Graph behauptet: *So
ist es nach heutiger Datenlage.* Die Chronik behauptet: *Am 14.08.2026
lief diese Frage auf Revision 7 und sagte das hier.* Das ist ein
**Ereignis**, kein abgeleiteter Zustand — in PROV-Begriffen eine
`prov:Activity`, die stattgefunden hat. Ereignisse werden behauptet, nicht
inferiert (Invariante 3 bleibt unberührt).

**Drei Regeln halten sie ehrlich:**

1. Der Effekt eines Eintrags hängt **nie** am Reifier der Kante, sondern
   an einem studieneigenen Knoten. Sonst lägen drei Jahre alter Läufe über
   derselben Kante, und `minEvidence` (C2), Adjustierung und Modellansicht
   wüssten nicht mehr, welcher gilt.
2. Eingetragen wird nur, was sich **geändert** hat: der erste Lauf einer
   Frage, danach ein anderes Urteil, eine andere Modell-Revision oder ein
   Effekt außerhalb des zuletzt festgehaltenen Intervalls. Zwanzig
   identische Läufe sind keine Historie, sondern Rauschen.
3. Beantwortet wird eine Frage weiterhin **nur** aus dem Inferenz-Graphen.
   Die Chronik zeigt, was war — sie sagt nie, was gilt.

**Verwerfen ja, ändern nein.** Die Chronik hält fest, was ein Lauf gesagt
hat — nicht, dass er hätte stattfinden sollen. Ein Lauf auf falsch
erfassten Daten oder auf einem Modell im Bau ist keine Geschichte, sondern
Störung, und wer sie nicht loswird, hört auf, in die Chronik zu schauen.
Verworfen wird deshalb ein **ganzer** Eintrag, ausdrücklich und einzeln
(`DELETE /api/graph/causal/archive/<id>`). Einen Eintrag zu ändern gibt es
nicht: Dann stünde dort etwas, das so nie gerechnet wurde.

Abnahme: `tests/graph/causal-archive.test.ts`.

## 4. §10 — „Sonnenstand" ist keine Zeitreihen-API (C5)

**Die Stelle.** Der Open-Data-Katalog in §10 nennt „PVGIS,
Sonnenstandsrechner → Einstrahlung, Azimut/Elevation".

**Der Widerspruch.** Azimut und Elevation sind eine **Rechnung** aus Ort
und Zeit, kein Abruf. Es gibt dafür keine offene Zeitreihen-API, die ein
`rest-timeseries`-Connector holen könnte.

**Die Frage, die dahinter stand**: Ist eine berechnete Größe eine
Beobachtung?

**Entschieden: ja.** Und damit fällt der Widerspruch weg. Eine gerechnete
Reihe ist sogar **verlässlicher** als eine gemessene — exakt, lückenlos,
ohne Ausfall und ohne Messfehler. Gebaut ist der Connector
`solar-position`: Sonnenhöhe, Azimut, Tag/Nacht und die extraterrestrische
Einstrahlung, nach dem Verfahren niedriger Genauigkeit des Astronomical
Almanac (Fehler unter 0,01°).

**Was ihn ehrlich hält.** Er läuft über denselben Connector-Vertrag wie
alles Externe (keine zweite Pipeline, Invariante 5), und im Graphen steht
das Verfahren: `ssn:implements` → `sosa:Procedure`. SOSA lässt das
ausdrücklich zu — ein Sensor ist dort alles, was eine Beobachtung
ausführt, auch ein Rechenverfahren. Wer eine Reihe adjustiert, sieht
damit, dass sie aus Ort und Zeit entstand und nicht aus einem Gerät, ohne
dass die UI es dazuerzählen müsste.

**Bewusst nicht gerechnet**: Refraktion und Parallaxe. Beides ist für eine
Störgröße ohne Belang und wäre eine Näherung mehr, die jemand für
Genauigkeit halten könnte. Ausgegeben wird die geometrische Position. Und
die **atmosphärische** Hälfte der Einstrahlung kommt weiterhin aus dem
Wetter (Bright Sky, Open-Meteo) — dieses Verfahren behauptet kein
Clear-Sky-Modell.

## 5. §10 — `rest-timeseries` „materialize" gegen Invariante C3 (C5)

**Die Stelle.** Die Tabelle in §10 führt `rest-timeseries` im Modus
`materialize` mit der Aufgabe „generischer Zeitreihen-Holer".

**Der Widerspruch.** Ein materialisierender Connector schreibt laut §6.2
Quads in `graph/<u>/import/<id>`. Invariante C3 verbietet Messwerte im
Store. Wörtlich genommen widersprach sich das.

**Entschieden.** Genau wie bei `home-assistant` in C3, und damit ohne neue
Regel: Der Connector materialisiert die **Angebotsseite** — welche Größen
die Quelle liefert, in welcher Einheit, an welchem Ort, mit welchem
Skalenniveau (SOSA). Die **Werte** holt der Erfassungslauf und legt sie
als NDJSON neben den Store. §10 sagt das jetzt für alle vier Quellarten.

**Warum das kein Kompromiss ist.** Struktur und Werte haben verschiedene
Takte. Das Angebot einer Wetter-API ändert sich fast nie, die Werte alle
Stunde. Beides in einen Lauf zu legen hieße, den Import-Graphen stündlich
zu ersetzen.

## 6. §16 — die C5-Abnahme liest sich wie zwei gleichrangige Ergebnisse (C5)

**Die Stelle.** „Dieselbe Frage mit und ohne Adjustierung liefert
nachweislich unterschiedliche Ergebnisse, und die Differenz wird erklärt."

**Der Widerspruch.** Wörtlich gelesen verlangt das eine Oberfläche, die
**zwei Ergebnisse** nebeneinanderstellt. Genau das verbietet §17 („Keine
Behauptung von Kausalität in der UI, wo nur Assoziation vorliegt") und
Invariante C5 (kein Effekt ohne bestandene Refutation).

**Entschieden.** Der Vergleich ist **eine** Aussage, kein zweites
Ergebnis: `ow:ConfoundingContrast` mit eigenen Termen
(`ow:crudeAssociation`, `ow:crudeCiLow/-High`, `ow:confoundingShift`).
Bewusst NICHT `ow:effectSize` — dieser Term zieht per SHACL die Pflicht zu
`ow:refutationPassed true` nach sich, und die hat der rohe Wert nicht. In
der Oberfläche heißt er „ohne Adjustierung", nie „Effekt".

Gerechnet wird der rohe Wert auf **demselben Panel**, mit **demselben
Verfahren** und **demselben Startwert** — sonst wäre die Differenz nicht
der Adjustierung zuzuschreiben, sondern der Datenlage.

## 7. §10 nennt vier Connector-Arten, §16 verlangte für C5 eine (C5)

**Die Stelle.** §10 listet `home-assistant`, `rest-timeseries`,
`sparql-endpoint` und `csv-observations`. §16 definiert C5 als
„Open-Data-Connector `rest-timeseries` + Confounder-Katalog".

**Der Widerspruch.** Kein echter, aber eine Lücke: `csv-observations`
(manueller Import eigener Messungen, laut §10 „besonders `local`") hatte
keinen Meilenstein.

**Entschieden: gebaut.** Die Abbildungsschicht trug CSV bereits
vollständig; gefehlt hat der **Datei**- statt des Netz-Wegs. Der Connector
liest eine CSV-Datei unter derselben Pfad-Politik wie `obsidian-vault` und
`json-canvas` (`data/vaults/…` oder eine Wurzel aus `OW_VAULT_ROOTS` — eine
dritte Politik zu erfinden hieße, drei Stellen zu haben, an denen ein
Serverpfad falsch freigegeben werden kann). Das Skalenniveau jeder Spalte
kommt aus dem **Bestand**, nicht aus dem Spaltennamen: nur Zahlen heißt
numerisch, nur 0/1 zweiwertig, alles andere kategorial.

`sparql-endpoint` bleibt, was §10 sagt: existiert bereits als Föderation
(M11), materialisiert nichts.

## 8. §5.2 — `ow:observedBy` gegen Invariante 8 (C3/C5)

**Die Stelle.** §5.2 beschrieb `ow:Variable` als „verweist per
`ow:observedBy` auf die Quelle".

**Der Widerspruch.** Ein eigener Term für „diese Größe wird von jener
Quelle beobachtet" ist genau das, was Invariante 8 verbietet, solange ein
Standard ihn trägt — und SOSA trägt ihn: `sosa:observes` verbindet einen
Sensor mit der beobachteten Größe. Aufgefallen ist es erst beim vierten
Quellentyp (C5), weil dort dieselbe Größe aus zwei Quellen kommen kann
(Außentemperatur vom DWD **und** vom Zigbee-Sensor) und die Richtung
plötzlich zählt.

**Entschieden: `sosa:observes`, und zwar vom Sensor auf die Variable.**
Die Gegenrichtung wäre beim Föderieren falsch herum lesbar: SOSA sagt
„der Sensor beobachtet X", nicht „X wird beobachtet von". Der
Quellschlüssel selbst (HA-`entity_id`, `<quelle>#<reihe>`) steht als
Literal in `ow:observationSource` an der Variablen — er ist eine
Zeichenkette, kein Knoten, und dafür gibt es keinen Standard-Term.

**Was die Gegenrichtung gekostet hätte.** Einen 127. eigenen Term, der
dasselbe sagt wie ein W3C-Standard — und einen Export, den ein fremder
SOSA-Client nicht mehr versteht.

## 9. §8 verlangt drei Strukturquellen, eine davon gehört zu C8 (C6)

**Die Stelle.** §8 („Die Rückkopplung"): „Drei Quellen für Struktur —
LLM-Vorschlag, physische Topologie, **Struktur-Lernen aus Daten** — werden
verglichen." §16 definiert C6 als „Vergleich der drei Strukturquellen".

**Der Widerspruch.** Struktur-Lernen aus Daten steht in derselben Tabelle
(§16) als Inhalt von **C8** — „*Optional*: Tier-2-Sidecar, Struktur-Lernen,
Föderation von Kausalmodellen". §19 verbietet einer Session ausdrücklich,
C7 oder C8 ohne Freigabe anzufangen. C6 kann also nicht liefern, was C6
verlangt. Hinzu kommt, dass TODO.md unter C6 eine **vierte** Quelle nennt,
die §8 nicht kennt: Wikidata über die Föderation (§10, seit M11
verfügbar).

**Entschieden: drei Quellen, aber diese drei.** Gebaut sind
`llm` (§8, das Sprachmodell), `topology` (§8, die Device Registry als
Prior) und `wikidata` (§10 + TODO, fremdes Weltwissen ohne Import). Das
Struktur-Lernen bleibt aus — und wird **benannt**: Der Quellenvergleich
führt es als fehlende Quelle mit Begründung, die Kantenklasse `learned`
bleibt leer, und die Oberfläche sagt, dass eine Übereinstimmung hier eine
von zwei Quellen ist und nicht von dreien.

**Warum nicht andersherum.** Die Alternative wäre gewesen, ein einfaches
Struktur-Lernen (PC-Algorithmus über partielle Korrelationen) in C6
mitzubauen. Das hätte drei Dinge gekostet: Es hätte C8 angefangen, ohne
gefragt zu haben (§19); es hätte in einem Meilenstein zwei Meilensteine
vermischt (§19: „Kein Meilenstein wird aufgeteilt, keine zwei werden
zusammengelegt"); und es hätte die Richtung von Kanten aus Korrelationen
abgeleitet, also genau die Sorte selbstbewusster Struktur erzeugt, gegen
die §18 im letzten Absatz argumentiert. Ein Vergleich mit einer erfundenen
dritten Stimme ist schlechter als einer mit zwei ehrlichen.

**Was zu tun bliebe**, wenn die Freigabe kommt: `learned` ist als
Kantenklasse (C0), als Quelle im Vergleich und als Filterstrecke bereits
vorgesehen — eine vierte Quelle einzuhängen ist eine Funktion, kein
Umbau.

## 10. §8 zählt Identifizierbarkeit zu den Filtern (C6)

**Die Stelle.** §8 nummeriert fünf Filter, die eine Hypothese durchläuft,
„bevor sie überhaupt geschätzt wird". Nummer 5: „Identifizierbarkeit — ist
der Effekt aus den vorhandenen Variablen überhaupt schätzbar?"

**Der Widerspruch.** Identifizierbarkeit hängt daran, welche Störgrößen
**erfasst** sind (C3) — sie ist eine Frage der Datenlage, nicht der
Struktur. Ein Filter, der deshalb ablehnt, ließe die Daten über die
Annahme entscheiden. Genau das verbietet Invariante C1: „Struktur ist
Annahme, nicht Ergebnis." Ein Modell darf eine Kante behaupten, für die
noch niemand die passende Störgröße erfasst hat — das ist der Normalfall
und der Grund, warum man überhaupt einen DAG zeichnet. §8 sagt das im
selben Absatz auch selbst: „Wenn nein: sagen, welche Variable fehlen
würde. Das ist eine **konstruktive** Antwort und in der Praxis oft die
nützlichste."

**Entschieden: ein drittes Urteil statt einer Ablehnung.** Die vier harten
Filter (`cycle`, `shacl`, `temporal`, `topology`) verwerfen; die
Identifizierbarkeit erzeugt das Urteil `open` samt der fehlenden Größe.
`accepted` und `open` dürfen ins Modell übernommen werden, `rejected`
nicht — serverseitig geprüft.

**Warum das die Abnahme nicht aufweicht.** „Keine Hypothese erreicht ohne
Filter den Studien-Pfad" bleibt wahr: Der Studien-Pfad beginnt bei einer
Frage (`ow:Estimand`), und die gibt seit C4 für einen nicht
identifizierbaren Effekt ohnehin `not-identifiable` zurück statt einer
Zahl. Ein `open`-Vorschlag im Modell führt also zu keiner Zahl, sondern zu
der Auskunft, welche Größe zu erfassen wäre — dieselbe konstruktive
Antwort, nur an der Stelle, an der man etwas dagegen tun kann.

**Was die Gegenrichtung gekostet hätte.** Die nützlichsten Vorschläge
wären die ersten gewesen, die durchfallen: Ein Confounder, der noch nicht
erfasst wird, macht die Kante, an der er hängt, per Definition nicht
identifizierbar. Ein Filter, der ihn verwirft, verwirft genau das, wofür
man ihn gebaut hat.

## 11. §8: „temporale Zulässigkeit ist maschinell entscheidbar" (C6)

**Die Stelle.** §8, Filter 3: „**Temporale Zulässigkeit** — die Ursache
muss der Wirkung vorausgehen. Mit HA-Zeitstempeln ist das maschinell
entscheidbar und eliminiert einen erheblichen Teil des LLM-Rauschens ohne
eine einzige Schätzung."

**Der Widerspruch.** „Die Ursache geht der Wirkung voraus" ist als
Aussage über die **Richtung der Kausalität** aus Zeitstempeln gerade
nicht entscheidbar. Was man aus Beobachtungsreihen über zeitliche
Vorordnung gewinnen kann — Kreuzkorrelation bei positivem und negativem
Versatz, Granger-artige Tests — ist Richtungsschluss aus Daten, also
**Struktur-Lernen**. Das gehört zu C8 (§16) und darf hier nicht
angefangen werden (§19). Zudem sind Beobachtungsreihen autokorreliert;
dass die Lehrbuchformel darauf nicht trägt, hat C4 bereits an anderer
Stelle festgehalten (§15.2, Moving Block Bootstrap).

**Entschieden: entscheidbar heißt Abdeckung und Vorzeichen.** Der Filter
prüft zwei Dinge, beide allein aus Zeitstempeln:

1. **Das Vorzeichen des Zeitversatzes.** `-PT15M` behauptet, die Wirkung
   ginge der Ursache voraus — dann ist die vorgeschlagene Richtung die
   falsche.
2. **Die Abdeckung.** Beginnt die Erfassung der Ursache (um ihren Versatz
   verschoben) nach dem Ende der Erfassung der Wirkung, kann keine
   erfasste Ursache einer erfassten Wirkung vorausgehen. Das ist die
   Fassung von „zeitlich unmöglich", die ein Zeitstempel wirklich hergibt.

Fehlt eine der Angaben, wird **nicht** abgelehnt: Unwissen ist kein
Befund. Und ein Vorschlag, der die im Modell gesetzte Richtung umdreht,
fällt schon beim Azyklizitäts-Filter — mit dem Kreis im Klartext, was die
bessere Auskunft ist.

**Was die Gegenrichtung gekostet hätte.** Ein korrelationsbasierter
Richtungstest hätte mehr Vorschläge weggenommen — und dabei genau die
Fehler gemacht, gegen die dieser Layer gebaut ist: Bei zwei Größen mit
gemeinsamer Ursache (Außentemperatur → Heizen, Außentemperatur →
Verbrauch) zeigt die Kreuzkorrelation eine Richtung, die es nicht gibt.
Ein Filter, der so etwas verwirft oder bestätigt, wäre eine Schätzung im
Gewand einer Formprüfung.
