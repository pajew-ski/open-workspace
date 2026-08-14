# Widersprüche in der Spec — festgehalten, vorgelegt, entschieden

CAUSAL_LAYER_SPEC §19 verbietet einer Session, die Spec neu zu
verhandeln. Wer beim Bauen auf einen echten Widerspruch stößt, hält ihn
fest und legt ihn vor. Diese Datei ist dieser Ort.

**Wie sie zu lesen ist**: Jeder Eintrag nennt die Stelle, den
Widerspruch, wie er beim Bauen aufgelöst wurde und was es kosten würde,
ihn anders aufzulösen. Alle sieben Einträge sind am **14.08.2026**
entschieden worden; wo die Entscheidung den Text der Spec betrifft, ist
sie dort eingearbeitet. Wer beim Bauen auf einen neuen stößt, trägt ihn
hier ein.

| # | Stelle | Meilenstein | Stand |
|---|---|---|---|
| 1 | §5.2 Identifikationsstrategie mischt DAG-Antwort und Studiendesign | C4 | entschieden, Spec angepasst |
| 2 | §5.3 `ow:effectUnit` mit QUDT-IRI | C4 | entschieden, Spec angepasst |
| 3 | C4 + §8.1: Ergebnisse sind flüchtig, es gibt keine Historie | C4 | entschieden, **Chronik gebaut** |
| 4 | §10 „Sonnenstand" ist keine Zeitreihen-API | C5 | entschieden, **gerechnete Quelle gebaut** |
| 5 | §10 `rest-timeseries` „materialize" gegen Invariante C3 | C5 | entschieden, Spec präzisiert |
| 6 | §16 C5-Abnahme liest sich wie zwei gleichrangige Ergebnisse | C5 | entschieden, umgesetzt |
| 7 | §10 nennt vier Connector-Arten, §16 verlangt für C5 eine | C5 | entschieden, **`csv-observations` gebaut** |

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
