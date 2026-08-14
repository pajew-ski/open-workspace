# Widersprüche in der Spec — festgehalten, nicht eigenmächtig gelöst

CAUSAL_LAYER_SPEC §19 verbietet einer Session, die Spec neu zu
verhandeln. Wer beim Bauen auf einen echten Widerspruch stößt, hält ihn
fest und legt ihn vor. Diese Datei ist dieser Ort.

**Wie sie zu lesen ist**: Jeder Eintrag nennt die Stelle, den
Widerspruch, wie er beim Bauen aufgelöst wurde und was es kosten würde,
ihn anders aufzulösen. An der Spec wurde nichts geändert. Solange ein
Eintrag „offen" ist, gilt die hier beschriebene Auslegung — sie ist
umgesetzt und getestet, aber sie ist eine Auslegung.

| # | Stelle | Meilenstein | Stand |
|---|---|---|---|
| 1 | §5.2 Identifikationsstrategie mischt DAG-Antwort und Studiendesign | C4 | offen |
| 2 | §5.3 `ow:effectUnit` mit QUDT-IRI | C4 | offen |
| 3 | C4 + §8.1: Ergebnisse sind flüchtig, es gibt keine Historie | C4 | offen |
| 4 | §10 „Sonnenstand" ist keine Zeitreihen-API | C5 | offen |
| 5 | §10 `rest-timeseries` „materialize" gegen Invariante C3 | C5 | aufgelöst |
| 6 | §16 C5-Abnahme liest sich wie zwei gleichrangige Ergebnisse | C5 | aufgelöst |
| 7 | §10 nennt vier Connector-Arten, §16 verlangt für C5 eine | C5 | offen |

---

## 1. §5.2 — die Identifikationsstrategie mischt zwei Dinge (C4)

**Die Stelle.** §5.2 nennt als Wertebereich der Strategie
`backdoor | frontdoor | iv | did | its | none`.

**Der Widerspruch.** Die ersten drei und `none` sind Antworten des
**DAGs** (Adjustment-Kriterium, C1). `did` und `its` sind
**Studiendesigns**, die aus der Zeitachse kommen und ihrerseits eine
Backdoor-Identifikation voraussetzen. In einem Feld zusammengefasst wäre
nicht mehr ablesbar, ob eine ITS-Studie überhaupt identifiziert war.

**Wie aufgelöst.** Zwei Terme: `ow:identificationStrategy` trägt die
Antwort des Graphen, `ow:estimator` das gerechnete Verfahren. Beide
stehen an der Studie.

**Was die Gegenrichtung kostet.** Ein Feld weniger im Graphen — und die
Auskunft „identifiziert, aber mit einem Zeitdesign gerechnet" wäre nicht
mehr formulierbar.

## 2. §5.3 — `ow:effectUnit` mit QUDT-IRI (C4)

**Die Stelle.** Das Beispiel in §5.3 zeigt `ow:effectUnit qudt:KiloW-HR`.

**Der Widerspruch.** Die Erfassung (C3) übernimmt Einheiten **quelltreu**
aus Home Assistant (`unit_of_measurement`) und legt sie als
`schema:unitText` ab. Eine QUDT-IRI liegt dort nicht vor. Ein eigener
Term wäre eine zweite Schreibweise für dieselbe Sache (Invariante 8).

**Wie aufgelöst.** `schema:unitText`, Einheit als Text — an der Variablen
wie am Effekt. Seit C5 gilt dasselbe für offene Quellen: Bright Sky
liefert `°C`, aWATTar `ct/kWh`, und beides steht als Text da.

**Was die Gegenrichtung kostet.** Eine Abbildung Text → QUDT-IRI. Sie
gehört dann an die **Variable**, nicht an den Effekt, und ist ohne
Einheiten-Normalisierung nicht verlustfrei.

## 3. C4 + §8.1 — Ergebnisse sind flüchtig (C4)

**Die Stelle.** Invariante C4 (Ergebnisse liegen im Inferenz-Graphen und
werden bei jedem Lauf ersetzt) und §8.1 (Inferenz-Graphen werden nie
persistiert).

**Der Widerspruch.** Zusammen heißt das: Nach einem Neustart gibt es
keine Studie mehr, bis jemand rechnet — und es gibt **keine Historie**
von Effekten über Modell-Revisionen hinweg. „Was sagte dieselbe Frage vor
drei Monaten?" ist nicht beantwortbar. Mit C7 (Reproduzierbarkeit) ist
das vereinbar, mit der Erwartung an ein Forschungswerkzeug nicht
unbedingt.

**Wie aufgelöst.** So gebaut, wie die Spec es sagt. Ein dauerhafter Ort
für abgeschlossene Studien wäre eine **Erweiterung** der Spec, keine
Auslegung.

**Was die Gegenrichtung kostet.** Einen dritten Ablageort neben Frage
(`graph/meta`) und Antwort (Inferenz-Graph) — und die Entscheidung, wann
eine Studie „abgeschlossen" ist.

## 4. §10 — „Sonnenstand" ist keine Zeitreihen-API (C5)

**Die Stelle.** Der Open-Data-Katalog in §10 nennt „PVGIS,
Sonnenstandsrechner → Einstrahlung, Azimut/Elevation", und §18 zählt den
Sonnenstand zu den Störgrößen, die C5 bringen soll.

**Der Widerspruch.** Azimut und Elevation sind eine **Rechnung** aus Ort
und Zeit, kein Abruf. Es gibt dafür keine offene Zeitreihen-API, die ein
`rest-timeseries`-Connector holen könnte. Ein lokal gerechneter Wert wäre
keine Quelle, sondern eine zweite Erfassungspipeline neben dem
Connector-Vertrag (Invariante 5) — und obendrein die einzige Reihe im
System, die keine Herkunft hätte.

**Wie aufgelöst.** Geliefert wird die **Einstrahlung**: Globalstrahlung
und Sonnenscheindauer über Bright Sky (DWD), Global- und Direktstrahlung
über Open-Meteo. Das ist die Größe, über die der Sonnenstand kausal
überhaupt wirkt — für Verschattung, PV-Ertrag und Innentemperatur ist
Einstrahlung der Confounder, Azimut nur seine Ursache.

**Was die Gegenrichtung kostet.** Einen Sonnenstands-Rechner als eigene
Quellart in `observations/sources.ts` (rund 60 Zeilen Astronomie, ohne
Netz, deterministisch) — und die Entscheidung, dass eine *gerechnete*
Reihe im Beobachtungs-Speicher denselben Rang hat wie eine gemessene.
Das ist eine Spec-Frage, keine Implementierungsfrage: **Ist eine
berechnete Größe eine Beobachtung?**

## 5. §10 — `rest-timeseries` „materialize" gegen Invariante C3 (C5)

**Die Stelle.** Die Tabelle in §10 führt `rest-timeseries` im Modus
`materialize` mit der Aufgabe „generischer Zeitreihen-Holer".

**Der Widerspruch.** Ein materialisierender Connector schreibt laut §6.2
Quads in `graph/<u>/import/<id>`. Invariante C3 verbietet Messwerte im
Store. Wörtlich genommen widerspricht sich das: Der Connector soll
Zeitreihen holen und darf sie nirgends hinschreiben.

**Wie aufgelöst.** Genau wie bei `home-assistant` in C3, und damit ohne
neue Regel: Der Connector materialisiert die **Angebotsseite** — welche
Größen die Quelle liefert, in welcher Einheit, an welchem Ort, mit
welchem Skalenniveau (SOSA). Die **Werte** holt der Erfassungslauf und
legt sie als NDJSON neben den Store. Der Connector bleibt Zugangs- und
Strukturquelle; „holen" heißt für ihn: die Quelle bekannt machen.

**Warum das kein Kompromiss ist.** Struktur und Werte haben verschiedene
Takte. Das Angebot einer Wetter-API ändert sich fast nie, die Werte alle
Stunde. Beides in einen Lauf zu legen hieße, den Import-Graphen stündlich
zu ersetzen.

## 6. §16 — die C5-Abnahme liest sich wie zwei gleichrangige Ergebnisse (C5)

**Die Stelle.** „Dieselbe Frage mit und ohne Adjustierung liefert
nachweislich unterschiedliche Ergebnisse, und die Differenz wird erklärt."

**Der Widerspruch.** Wörtlich gelesen verlangt das eine Oberfläche, die
**zwei Ergebnisse** nebeneinanderstellt. Genau das verbietet §17
(„Keine Behauptung von Kausalität in der UI, wo nur Assoziation
vorliegt") und Invariante C5 (kein Effekt ohne bestandene Refutation):
Der unadjustierte Wert ist ein Zusammenhang und dürfte nie wie ein
zweiter Effekt aussehen.

**Wie aufgelöst.** Der Vergleich ist **eine** Aussage, kein zweites
Ergebnis: `ow:ConfoundingContrast` mit eigenen Termen
(`ow:crudeAssociation`, `ow:crudeCiLow/-High`, `ow:confoundingShift`).
Bewusst NICHT `ow:effectSize` — dieser Term zieht per SHACL die Pflicht
zu `ow:refutationPassed true` nach sich, und die hat der rohe Wert nicht.
In der Oberfläche heißt er „ohne Adjustierung", nie „Effekt", und die
Erklärung sagt den Unterschied ausdrücklich.

Gerechnet wird der rohe Wert auf **demselben Panel**, mit **demselben
Verfahren** und **demselben Startwert** — sonst wäre die Differenz nicht
der Adjustierung zuzuschreiben, sondern der Datenlage.

## 7. §10 nennt vier Connector-Arten, §16 verlangt für C5 eine (C5)

**Die Stelle.** §10 listet `home-assistant`, `rest-timeseries`,
`sparql-endpoint` und `csv-observations`. §16 definiert C5 als
„Open-Data-Connector `rest-timeseries` + Confounder-Katalog".

**Der Widerspruch.** Kein echter, aber eine Lücke: `csv-observations`
(manueller Import eigener Messungen, laut §10 „besonders `local`") hat
keinen Meilenstein. Nach §19 ist die Meilenstein-Definition maßgeblich —
gebaut wurde deshalb nur `rest-timeseries`.

**Wie aufgelöst.** Nicht gebaut, und nirgends angedeutet (Invariante 10).
Die Abbildungsschicht trägt CSV bereits (`format: 'csv'`), das Fehlende
ist der Datei-Weg statt des Netz-Wegs — eine überschaubare Ergänzung,
sobald sie einen Meilenstein hat.

**Was die Gegenrichtung kostet.** Wenig Code, aber eine Entscheidung: Ein
Datei-Connector für Messwerte braucht dieselbe Pfad-Politik wie
`obsidian-vault` (`OW_VAULT_ROOTS`) und in `local` einen Weg über OPFS.
