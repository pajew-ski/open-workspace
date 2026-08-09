# Obsidian-Kompatibilität (Graph Core M4)

> Verbindliche Referenz: [GRAPH_CORE_SPEC.md](../GRAPH_CORE_SPEC.md) §10.
> Implementierung: `src/lib/graph/connectors/obsidian/` (Import),
> `src/lib/graph/projection/obsidian.ts` (Export).
> Abnahme als Tests: `tests/graph/obsidian-vault.test.ts`.

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
6. **Anhänge und Canvas**: `![[bild.png]]` u. ä. erzeugen keine Kanten und
   werden nicht importiert (nur `.md`); `.canvas` folgt mit M5
   (Präsentationsschicht). Nicht-Markdown-Dateien im Vault bleiben beim
   Export unangetastet.
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
