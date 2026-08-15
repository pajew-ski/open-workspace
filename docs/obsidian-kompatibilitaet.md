# Obsidian-Kompatibilität (Graph Core M4 + M5)

> Verbindliche Referenz: [GRAPH_CORE_SPEC](./specs/graph-core.md) §9/§10.
> Implementierung: `src/lib/graph/connectors/obsidian/` (Vault-Import),
> `src/lib/graph/projection/obsidian.ts` (Vault-Export),
> `src/lib/graph/connectors/json-canvas/` + `src/lib/graph/projection/json-canvas.ts` (`.canvas`, M5).
> Abnahme als Tests: `tests/graph/obsidian-vault.test.ts`,
> `tests/graph/json-canvas.test.ts`.

Der `obsidian-vault`-Connector materialisiert einen lokalen Obsidian-Vault
(Markdown-Ordner) in den Import-Graphen und schreibt ihn verlustbehaftet
zurück. **Verlustbehaftet ist eine Eigenschaft der Projektion, kein Bug** —
dieses Dokument benennt jede Position.

## Mapping (umgesetzt)

| Obsidian | RDF | Richtung |
|---|---|---|
| Markdown-Datei | `ow:Document` + `schema:DigitalDocument`, Body byte-genau in `schema:text`, Pfad ohne `.md` als `dcterms:identifier` | verlustfrei ↔ |
| YAML-Frontmatter-Key | Quelltreue: jeder Key als `fm:`-Property (`…/ns/frontmatter#<key>`) — Strings wörtlich, Strukturiertes (Listen/Maps/Zahlen/Booleans) als `rdf:JSON`-Literal. Wissen: bekannte Keys zusätzlich gemappt (`title`→`schema:name`, `aliases`→`schema:alternateName`, `created`/`updated`→`dcterms:created`/`modified`, `lang`→`schema:inLanguage`, `author`→`schema:author`, `typ: begriff`→`skos:Concept`) | ↔, unbekannte Keys per Round-Trip erhalten |
| `[[Wikilink]]` | `ow:linksTo` (Ziel-Auflösung wie Obsidian: exakter Pfad, sonst Basename; unaufgelöste Ziele werden Phantom-Knoten) | Import verlustfrei; Export siehe Verlustpositionen |
| `[[Ziel\|Alias]]` | `ow:linksTo` + Alias als `schema:alternateName` am benannten Reifier (`<reifier> rdf:reifies <<( doc ow:linksTo ziel )>>`, RDF 1.2) | ↔ (Alias steht im Body) |
| `![[Einbettung]]` | `ow:linksTo` + `ow:embedded true` am Reifier | ↔ (Syntax steht im Body) |
| `#tag`, `#tag/unter` | `skos:Concept` mit `skos:prefLabel` und `skos:broader`-Kette; Dokument→Tag als `schema:about`. Frontmatter-`tags`/`tag` und Inline-Tags gemeinsam | ↔ (Tags stehen im Body/Frontmatter) |
| Backlinks | keine Speicherung — SPARQL-Query über eingehende `ow:linksTo`-Kanten | berechnet |
| Ordnerpfad | `ow:inFolder` (Literal), zusätzlich Teil des Identifiers | ↔ |
| Dataview-Queries | nicht unterstützt (bleiben als Text im Body erhalten) | – |

**Round-Trip-Garantie (M4-Abnahme, als Test verankert):** Vault → Store →
Vault ist markdown-identisch bis auf die normalisierte
Frontmatter-Reihenfolge. Der Body ist byte-genau; kanonisch formatiertes
Frontmatter (Reihenfolge `title`, `aliases`, `tags`, Rest alphabetisch;
Block-Listen; 2er-Einrückung) kommt byte-identisch zurück. Der zweite
Round-Trip (Export → Import → Export) ist vollständig byte-identisch —
die Normalisierung ist ein Fixpunkt.

## Revision und Konflikte

- Revision = SHA-256 über den sortierten Datei-Bestand (`pfad + Inhalts-Hash`).
  Unveränderter Vault ⇒ Sync ist ein No-Op; Änderung ⇒ vollständiger
  Replace des Import-Graphen (SPEC §6.2, Spiegel-Semantik).
- **Push-Konfliktregel** (SPEC §6.2): Weicht die Vault-Revision von der
  zuletzt gepullten ab (externe Bearbeitung), wird nichts geschrieben —
  Zustand `conflict` mit dateigenauer Abweichungsliste; erst erneut
  synchronisieren. Ein nie synchronisierter, nicht-leerer Vault kann nicht
  Ziel eines Exports sein.
- Export schreibt direkt (kein Branch→PR): Der Vault ist ein lokaler
  Ordner dieser Installation, kein fremdes Repo.

## Pfad-Politik (Sicherheit)

Vault-Pfade sind Nutzereingaben und der Connector läuft serverseitig.
Erlaubt sind nur Wurzeln unter `data/vaults/` sowie explizit über
`OW_VAULT_ROOTS` (mit `:` getrennte absolute Pfade) freigegebene Ordner —
analog zur SSRF-Politik des Connector-Fetch. Symlinks werden nicht
aufgelöst: Wer eine Wurzel freigibt, gibt frei, was darunter erreichbar ist.

## Verlustpositionen (dokumentiert, teils als Test verankert)

1. **Typisierte Kanten flachen beim Export ab.** Kanten zwischen
   Dokumenten, die nicht aus dem Body stammen (z. B. per SPARQL ergänztes
   `prov:wasDerivedFrom`), werden als generische Wikilinks an den Body
   angehängt — der Kantentyp geht im Markdown verloren. Bereits im Body
   verlinkte Ziele werden nicht dupliziert. *(Test: „VERLUSTPOSITION …".)*
2. **Kanten-Annotationen nur aus dem Graphen** (Alias/`ow:embedded`, die
   nicht aus der Body-Syntax stammen) gehen beim Abflachen verloren —
   erhalten bleibt, was im Body steht.
3. **Kaputtes Frontmatter**: Die Einheit wird quarantäniert (Fehlerbericht
   in der UI), der Body wird importiert; der nicht parsebare
   Frontmatter-Block ist beim Export weg. *(Test: „Fehlertoleranz …".)*
4. **YAML-Formatierung wird normalisiert**: Key-Reihenfolge (kanonisch),
   Flow-Listen → Block-Listen, Quoting-Stil, Einrückung. Inhalt und
   Listen-Reihenfolge bleiben erhalten (`rdf:JSON`-Träger). Ein leerer
   Frontmatter-Block (`---`/`---` ohne Keys) wird beim Export weggelassen.
5. **Heading-Anteile von Links** (`[[Notiz#Kapitel]]`): Die Kante zielt
   auf die Notiz (Datei-Granularität), der Heading-Anteil bleibt nur im
   Body-Text erhalten — kein eigenes Fragment-Ziel im Graphen.
6. **Anhänge**: `![[bild.png]]` u. ä. erzeugen keine Kanten und werden
   nicht importiert (nur `.md`). Nicht-Markdown-Dateien im Vault bleiben
   beim Export unangetastet. `.canvas`-Dateien liest der Vault-Connector
   nicht mit — sie werden einzeln über den `json-canvas`-Connector
   eingebunden (siehe unten, M5).
7. **Löschungen propagieren nicht vom Graphen in den Vault**: Der Export
   überschreibt bzw. legt Dateien an, löscht aber keine — eine im Graphen
   entfernte Notiz bleibt als Datei liegen (und käme beim nächsten Sync
   zurück). Löschungen gehören in den Vault (dann Sync).
8. **Versteckte Ordner** (`.obsidian`, `.trash`, …) werden ignoriert —
   Obsidian-Konfiguration ist nicht Teil des Wissensgraphen.
9. **Mehrdeutige Basenamen**: Verweist `[[Name]]` auf mehrere gleichnamige
   Notizen, wird deterministisch der lexikografisch kleinste Pfad gewählt
   (Obsidian wählt den „kürzesten" — bei echter Mehrdeutigkeit ist jede
   Wahl eine Heuristik).
10. **Dataview**: Query-Blöcke werden nicht ausgewertet (SPEC §10),
    bleiben aber als Text im Body erhalten.

---

# JSON Canvas / `.canvas` (Graph Core M5)

Zwei Wege, beide über dieselben puren Module
(`src/lib/graph/connectors/json-canvas/format.ts` parst/serialisiert
JSON Canvas 1.0, https://jsoncanvas.org):

1. **UI-Import/-Export** (Pinnwand): `.canvas`-Datei hochladen unter
   `/canvas` → öffnet als native Pinnwand; „Exportieren" auf der
   Pinnwand-Seite lädt eine `.canvas`-Datei herunter — mit
   Verlust-Hinweis **vor** dem Export (SPEC §9).
2. **`json-canvas`-Connector**: eine `.canvas`-Datei (Pfad-Politik wie
   beim Vault) wird als Quelle materialisiert — Wissens-Schicht in den
   Import-Graphen, Layout-Schicht nach `graph/<u>/presentation`
   (`ow:CanvasNode`/`ow:CanvasEdge`, `ow:rendersNode` auf die
   semantischen Gegenstücke). `push` schreibt die Datei normalisiert
   zurück (Konfliktregel §6.2). Der Connector-Pfad erhält ALLE
   JSON-Canvas-Attribute (auch Anker-Seiten, Pfeilenden, Kantenfarben,
   Gruppen-Hintergründe) — Round-Trip Datei → Graph → Datei ist
   inhaltsgleich, der zweite Push byte-identisch (als Test verankert).

## Mapping (Graph-Pfad, umgesetzt)

| JSON Canvas 1.0 | RDF | Graph |
|---|---|---|
| Canvas-Datei | `ow:Canvas` + `schema:CreativeWork`, Name = Dateiname, Pfad als `dcterms:identifier` | Import |
| `text`-Knoten | Gegenstück `schema:CreativeWork` mit `schema:text` (Markdown wörtlich) | Import |
| `file`-Knoten | Gegenstück `schema:DigitalDocument` (Name = Pfad); Pfad+`subpath` quelltreu als `ow:filePath` am Layout-Knoten | Import + Presentation |
| `link`-Knoten | Gegenstück `schema:WebPage` mit `schema:url` | Import |
| `group`-Knoten | **kein** semantisches Gegenstück (implizit über Position, keine Hierarchie-Behauptung — SPEC §9); Label/Hintergrund am Layout-Knoten | nur Presentation |
| `edges` | `ow:linksTo` zwischen den Gegenstücken („sofern kein Typ ableitbar", SPEC §9); Kanten an Gruppen bleiben reine Zeichnung | Import |
| x/y/width/height/color, Anker (`fromSide`/`toSide`), Pfeilenden (`fromEnd`/`toEnd`), Kanten-Label/-Farbe | `ow:CanvasNode`/`ow:CanvasEdge` mit `ow:xPosition`/`ow:yPosition`, `schema:width`/`height`/`color`, `ow:fromSide`/… — nur explizit gesetzte Werte werden materialisiert | nur Presentation |

## Verlustpositionen `.canvas` (dokumentiert, als Test verankert)

1. **UI-Pfad (native Pinnwand)**: Anker-Seiten (`fromSide`/`toSide`),
   Kanten-Farben und Gruppen-Hintergründe kennt das native Modell nicht —
   sie gehen beim UI-Import verloren (der Connector-Pfad erhält sie).
   Eine Kante mit Pfeil nur am Start wird als gedrehte gerichtete
   Verbindung übernommen (sichtbare Pfeilspitze bleibt).
2. **Export aus der Pinnwand**: Verbindungstypen flachen auf Pfeilenden
   ab (`bidirectional`→`fromEnd: arrow`, `simple`→`toEnd: none`,
   `directional`→Spec-Defaults); Viewport (Zoom/Position) und
   Karten-Zeitstempel entfallen (JSON Canvas kennt beides nicht);
   Positionen werden auf Integer gerundet (Spec-Vorgabe); Karten-Titel
   werden zur ersten Markdown-Überschrift (`# Titel`) des Text-Knotens —
   der Re-Import trennt sie wieder.
3. **Normalisierung**: Export/Push sortieren Knoten/Kanten nach ID und
   schreiben eine feste Schlüsselreihenfolge (Tab-Einrückung wie
   Obsidian). Die Reihenfolge der Original-Datei ist keine Information,
   die der Graph trägt.
4. **Unbekannte Zusatzfelder** fremder Werkzeuge (außerhalb der
   1.0-Spec) werden beim Parsen ignoriert und fehlen nach dem Push.
5. **Kantentypen**: JSON Canvas kennt keine typisierten Kanten — im
   Graphen ergänzte typisierte Aussagen zwischen Gegenstücken erscheinen
   beim Export nicht als eigene `edges` (Verlustrichtung Graph → Datei,
   SPEC §9).
