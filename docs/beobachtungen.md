# Beobachtungen: Zeitreihen erfassen, bevor sie weg sind

Der Kausal-Layer braucht zwei Dinge: eine Struktur (welcher Sensor misst
welchen Raum) und Beobachtungen (was hat er gemessen). Home Assistant hat
beides — behält aber nur eine Hälfte.

Seit C5 kommt die zweite Quellart dazu: **offene Zeitreihen** (Wetter,
Strompreis, Einstrahlung, Feiertage). Der Erfassungslauf ist derselbe;
was sich unterscheidet, ist nur das Holen der Rohpunkte. Siehe
[docs/kausalmodell.md](./kausalmodell.md) für den Katalog und die Rolle
dieser Größen im Modell.

## Was der Recorder wirklich aufbewahrt

Die kurze Antwort auf „aggregiert bei längeren Zeiträumen, verliert aber
nicht ganz, oder?": **Teils. Und ausgerechnet die falsche Hälfte geht
verloren.**

| Was | Wo | Wie lange | Auflösung |
|---|---|---|---|
| Vollständige Zustandswechsel (`states`) | Recorder-DB | `purge_keep_days`, Standard **10 Tage** | jeder Wechsel, exakt |
| Kurzzeit-Statistik | `statistics_short_term` | wenige Tage | 5 Minuten |
| **Long-Term-Statistics** | `statistics` | **unbegrenzt, wird nie gelöscht** | 1 Stunde |

Der Haken an der letzten Zeile: Long-Term-Statistics entstehen **nur für
Entitäten mit `state_class`** — also für numerische Messgrößen
(Temperatur, Leistung, Verbrauch, Feuchte). Gespeichert werden dort
`mean`/`min`/`max` bzw. `sum`/`state`.

Nicht dabei sind:

- Schalter, Lichter, Ventile, Automations-Zustände
- Fenster- und Türkontakte, Bewegungsmelder, alle `binary_sensor`
- Anwesenheit (`person`, `device_tracker`), Zonen
- Textzustände (`climate`-Modus, `media_player`, `select`)
- Der genaue **Zeitpunkt** eines Wechsels — ein Stundenmittel sagt nicht,
  ob das Fenster um 8:05 oder 8:55 aufging

Für eine Kausalanalyse ist das die schlechtestmögliche Aufteilung:
**Outcomes überleben, Treatments nicht.** Was man nach zwei Wochen noch
hat, ist die Temperaturkurve — aber nicht mehr, wann geheizt, gelüftet
oder wer zu Hause war. Ohne Ursachenseite lässt sich kein Effekt
schätzen, egal wie lang die Outcome-Reihe ist.

Deshalb erfasst der Workspace selbst. Nicht alles — das wäre ein zweiter
Recorder ohne Mehrwert — sondern **eine ausgewählte Teilmenge, dauerhaft,
in voller zeitlicher Auflösung des gewählten Rasters**.

## Was gebaut ist

### Zugang (`homeassistant_api`)

`deploy/ha-addon/config.yaml` setzt `homeassistant_api: true`. Erst damit
legt der Supervisor `SUPERVISOR_TOKEN` in die Umgebung, und erst damit ist
`http://supervisor/core/api` erreichbar. Ohne das Recht sieht das Add-on
von Home Assistant nichts.

Der Workspace nutzt das Recht **ausschließlich lesend**. Es gibt keinen
Service-Call, keinen Schreibpfad, keine Oberfläche zum Schalten
(CAUSAL_LAYER_SPEC C10, Invariante 10).

Außerhalb des Add-ons (Runtime `server`) läuft der Zugang über eine
konfigurierte URL plus Long-Lived Access Token. Der Token steht **nie** in
der Connector-Konfiguration — dort liegt nur der Name der
Umgebungsvariablen, die ihn trägt (Default `OW_HA_TOKEN`).

> Zeigt die URL auf eine private Adresse (`192.168.…`,
> `homeassistant.local`), greift der SSRF-Schutz der Connector-Schicht.
> Er wird mit `ALLOW_LOCAL_TOOL_URLS=1` geöffnet — derselbe Schalter wie
> beim Tool-Executor, eine Politik, ein Knopf. Im Add-on ist das nicht
> nötig: `supervisor` ist keine private IP.

### Struktur: der `home-assistant`-Connector

Läuft über den regulären Connector-Vertrag und materialisiert in
`graph/<u>/import/<id>`:

| Home Assistant | RDF |
|---|---|
| Etage | `schema:Place` |
| Bereich | `schema:Place` + `schema:containedInPlace` → Etage |
| Gerät | `sosa:Platform`, `schema:location` → Bereich |
| Entität (messend) | `sosa:Sensor` |
| Entität (schaltbar) | `sosa:Actuator` |
| `device_class` | `sosa:ObservableProperty`, `sosa:observes` |
| `unit_of_measurement` | `schema:unitText` |
| `entity_id` | `dcterms:identifier` |

Kein eigenes Geräte-Vokabular: SOSA ist der W3C/OGC-Standard für Sensorik
(Invariante 8).

Die Registry (Bereiche, Etagen, Geräte) ist über die REST-API nicht direkt
abrufbar — sie lebt hinter der WebSocket-API. Erreichbar wird sie über
`POST /api/template`: die Template-Funktionen `area_id`, `area_name`,
`floor_name`, `device_id`, `device_attr` lösen genau diese Zuordnungen auf.
Ein Aufruf liefert damit das ganze Inventar samt Topologie, ohne eine
zweite Protokollschicht.

Die Revision hängt an der **Struktur**, nicht am Messwert. Sonst wäre sie
bei jedem Sensorwechsel neu und der Import-Graph würde minütlich ersetzt.

### Erfassung: Beobachtungsgrößen

Eine `ow:Variable` ist eine Quelle plus Erfassungsregel: Skalenniveau,
Verdichtung, Abtastabstand, Aufbewahrung. Sie liegt in `graph/meta` —
dasselbe Muster wie Retrieval-Profile und Query-Views, weil sie
Systemkonfiguration ist und jeden Workspace-Replace überleben muss.

**Die Werte liegen nicht im Graphen.** Zehn Sensoren über ein Jahr in
Minutenauflösung sind ~5 Mio. Punkte; als Quads wären das ~20 Mio. Tripel
für Daten, auf denen nie eine SPARQL-Query läuft. Stattdessen:

```
data/observations/<userId>/<variableId>/2026-08-13.ndjson
{"t":1786000000000,"v":21.5}
{"t":1786000300000,"v":21.6}
{"t":1786000600000,"v":null,"q":"unavailable"}
```

Eine Datei pro Größe und Tag, streng aufsteigend, nur angehängt. Warum
Tagesdateien: `FileSystemLike` garantiert kein Anhängen (OPFS braucht dafür
einen Schreib-Handle mit Seek). Wo `appendFile` fehlt, wird gelesen,
verkettet und geschrieben — bei einer Tagesdatei ein kleiner, begrenzter
Betrag, bei einer Jahresdatei wäre es quadratisch.

Warum NDJSON und nicht Parquet: Parquet bräuchte eine Abhängigkeit für
alle drei Runtimes und würde das Anhängen verlieren. NDJSON ist
zeilenweise streambar, mit jedem Werkzeug lesbar und im Zweifel von Hand
zu reparieren — richtig für einen Bestand, der über Jahre wachsen und
Formatwechsel überleben soll.

Im Graphen steht dafür, was abfragbar sein muss: `ow:capturedFrom`,
`ow:capturedThrough`, `ow:observationCount`. Damit beantwortet SPARQL die
Frage, die vor jeder Studie steht — *wie weit reicht mein Bestand?*

### Der Lauf

1. **Fenster bestimmen.** Ohne Wasserzeichen ist es ein Backfill über 14
   Tage (deckt den Recorder-Horizont mit Reserve). Mit Wasserzeichen nur
   der Zuwachs. Offene Quellen halten ihre Archive länger vor — dort ist
   das Fenster eine Höflichkeit, keine Grenze.
2. **Rohwerte holen** — bei Home Assistant in 24-Stunden-Scheiben, bei
   einer offenen Quelle in den Fenstern, die ihre Abbildung erlaubt.
3. **Verdichten** auf den Abtastabstand.
4. **Anhängen**, strikt nach dem Wasserzeichen — jeder Lauf ist
   idempotent, ein Wiederholen erzeugt keine Dubletten.
5. **Aufräumen** nach Aufbewahrungsfrist (Default: unbegrenzt), nur ganze
   abgelaufene Tage.
6. **Zustand schreiben.**

Ein Fehler bei einer Größe beendet nie den Lauf der anderen — und seit
C5 gilt das auch für die **Quellart**: Ein fehlender
Home-Assistant-Zugang legt genau die Größen still, die ihn brauchen. Die
Wetterreihen laufen weiter.

**Woher die Quellart kommt.** Sie steht an der Größe (`schema:category`
am `ow:Variable`-Knoten) und wird beim Aufnehmen aus dem **Import-Graphen
der Quelle** abgeleitet: Der Sensor liegt im Graphen genau des
Connectors, der ihn materialisiert hat, und die Registry weiß, welcher
Art dieser Connector ist. Eine zweite Angabe am Knoten wäre eine zweite
Wahrheit — und irgendwann falsch.

### Zwei Regeln der Verdichtung, die inhaltlich zählen

**Zustände halten an.** Ein Schalter, der um 8:00 eingeschaltet wird, ist
um 9:00 immer noch an, auch ohne neuen Eintrag. Der letzte bekannte Wert
wird über leere Intervalle fortgeschrieben. Ohne das entstünde in jedem
ruhigen Intervall eine Lücke — und die ruhigen sind die häufigsten.

**Eine Lücke bleibt eine Lücke.** Meldet die Quelle
`unavailable`/`unknown`, wird *nicht* fortgeschrieben. Der Sensor sagt
gerade nichts, und das ist etwas anderes als „unverändert". Fehlende Werte
sind selten zufällig fehlend; wer sie glättet, verzerrt jede spätere
Schätzung unsichtbar.

Ebenso: Eine Summe gilt für ihr Intervall, nicht für das nächste — ein
leeres Intervall bekommt bei `sum` eine 0, keine Wiederholung.

Und: Eine unzulässige Verdichtung wird abgelehnt, nicht stillschweigend
korrigiert. Ein Mittelwert über kategoriale Zustände ist keine grobe
Näherung, sondern eine Falschaussage.

### Zeitgeber

Der Serverprozess erfasst alle 10 Minuten (`OW_CAPTURE_INTERVAL` in
Sekunden, Minimum 60, `0` schaltet ab). Ein Erfassungslauf auf Knopfdruck
nützt nichts: Was Home Assistant verwirft, ist weg, und niemand drückt
zuverlässig alle zehn Minuten einen Knopf.

Ohne aktive Größe endet jeder Takt sofort, ohne Home Assistant überhaupt
anzusprechen. Überlappende Läufe werden übersprungen.

Die Runtime `local` hat keinen dauerhaft laufenden Prozess und damit auch
keine Erfassung — ein Browser-Tab, der zufällig offen ist, wäre kein
Zeitgeber, sondern ein Zufallsgenerator.

## Bedienung

`/graph/observations`. Aktoren stehen in der Kandidatenliste oben: Sie
tragen die Treatment-Seite und sind genau das, was am schnellsten
verloren geht. Offene Störgrößen stehen in derselben Liste — sie tragen
im Modell dieselbe Rolle wie ein Sensor aus dem Haus, und eine zweite
Liste gäbe es nur, damit sie irgendwann abweicht. Ein Merkmal
(„Home Assistant" / „offene Quelle") sagt, woher eine Reihe kommt.

**Womit anfangen**, wenn die Installation groß ist: Fenster- und
Türkontakte, Bewegungsmelder, Anwesenheit, Heizungs- und Lichtschalter,
Automations-Zustände. Die numerischen Sensoren überleben in den
Long-Term-Statistics — sie sind wichtig, aber nicht dringend.

## API

| Route | Zweck |
|---|---|
| `GET /api/graph/observations` | Größen, Kandidaten, Zeitgeber-Zustand |
| `POST /api/graph/observations` | Quelle aufnehmen (muss im Graphen bekannt sein) |
| `GET/PATCH/DELETE /api/graph/observations/<id>` | lesen, pausieren, entfernen (`?purge=1` löscht auch den Bestand) |
| `GET /api/graph/observations/<id>/series` | Messreihe (`from`, `to`, `limit`) |
| `POST /api/graph/observations/capture` | Lauf auf Anforderung |

Das Entfernen ist zweistufig: Der erfasste Bestand ist genau das, was die
Quelle nicht mehr hat — ihn mit der Definition wegzuwerfen wäre für einen
Fehlklick eine unwiederbringliche Strafe.

## Grenzen, ehrlich

- **Der Backfill reicht nur so weit wie der Recorder.** Long-Term-
  Statistics sind über die REST-API nicht erreichbar (sie brauchen die
  WebSocket-Kommandos `recorder/statistics_during_period`). Ein einmaliger
  Rückgriff auf die Stundenaggregate ist deshalb nicht gebaut — er wäre
  eine sinnvolle Ergänzung, ändert aber nichts an der Dringlichkeit: die
  Ursachenseite steht dort ohnehin nicht.
- **Vor der ersten Erfassung gibt es keine Daten.** Wer heute anfängt, hat
  in drei Monaten drei Monate. Das ist der ganze Punkt.
- **Ein Wechsel des Abtastabstands ändert die Größe.** Die alte Reihe
  bleibt in ihrem alten Raster liegen; Definition und Bestand
  auseinanderlaufen zu lassen wäre schlimmer, deshalb ist der Abstand
  heute nicht änderbar — eine neue Größe anlegen ist der ehrliche Weg.
- **Volumen.** Eine Größe im 5-Minuten-Raster kostet rund 105 000 Punkte
  pro Jahr, als NDJSON etwa 3 MB. Zwanzig Größen sind ~60 MB im Jahr.
  Beherrschbar, aber nicht kostenlos — die Aufbewahrungsfrist steht pro
  Größe zur Verfügung.
