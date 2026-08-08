# ADR 0001: Graph-Store — Oxigraph (WASM)

**Status**: Angenommen (M0, 2026-08-08)
**Kontext**: SPEC „Graph Core — Vollausbau" §5.1 verlangt eine belegte
Entscheidung zwischen Oxigraph (WASM) und `quadstore` + `quadstore-comunica`
(IndexedDB), mit Messwerten statt Gefühl.

## Entscheidung

**Oxigraph über das npm-Paket (`oxigraph@0.5.9`)** ist die eine
`GraphStore`-Implementierung für alle drei Runtimes (`local`, `ha-addon`,
`server`). Daneben existiert nur das In-Memory-Test-Double
(`MemoryGraphStore`), das ehrlich kein SPARQL kann.

## Messwerte

Reproduzierbar mit `bun run bench:graph-store` (Node 22 / Bun 1.3, Container
dieser Umgebung, 100 000 Quads: 50k Subjekte, 7 Prädikate, Literal-/Kanten-Mix):

| Messung | Wert |
|---|---|
| Store-Initialisierung | 0,3 ms |
| Bulk-Load aus N-Quads-String, 100k Quads | 470–780 ms (Node/Bun) |
| Einzel-`add()` über die WASM-Grenze, 100k | ~11,7 s → **deshalb lädt `GraphStore.load()` gebatcht über N-Quads-Serialisierung** |
| `COUNT(*)` über 100k Quads | 51–92 ms |
| Punkt-Lookup (s+p gebunden) | 0,3–1,6 ms |
| 2-Hop-Join, LIMIT 1000 | 17–21 ms |
| Dump als N-Quads (100k) | 240–280 ms (12,5 MB) |
| WASM-Artefakt | 4,07 MB unkomprimiert, **1,43 MB gzip** |
| RSS bei 100k Quads | ~210–250 MB (Prozess inkl. Runtime) |

Funktional verifiziert (tests/graph/*.test.ts):

- SPARQL 1.1 Query **und** Update, `ASK`/`SELECT`/`CONSTRUCT`/`DESCRIBE`
- Dataset-Klammern (`default_graph`/`named_graphs`) **überschreiben `FROM` im
  Query-Text** — die Grundlage des Authz-Rewritings (SPEC §17.3)
- RDF 1.2: Reifier-Syntax (`~ ex:r`) und Triple Terms (`<<( … )>>`) in
  Turtle/TriG/N-Quads und SPARQL
- Formate: Turtle, TriG, N-Triples, N-Quads, JSON-LD, RDF/XML — Parser und
  Serialisierer aus demselben Motor
- Ergebnis-Serialisierung nativ (`results_format: 'json'|'csv'|…`)

## Warum nicht quadstore + quadstore-comunica

- Zwei Engines (Storage + Comunica-Query-Stack) statt einer; Comunica allein
  liegt als Bundle deutlich über dem gzip-Fußabdruck von Oxigraph-WASM.
- Kein SPARQL-Update-Pfad in derselben Qualität; RDF-star/RDF-1.2-Support
  uneinheitlich über die Comunica-Aktoren.
- Der erhoffte Vorteil — inkrementelle IndexedDB-Persistenz — löst das
  falsche Problem: Persistenz ist bei uns ohnehin die **deterministische
  Serialisierung nach `data/graph/`** (SPEC §8). Ein zweiter
  Persistenzmechanismus wäre eine zweite Wahrheit.

## Konsequenzen und akzeptierte Grenzen

1. **In-Memory-Betrieb mit Snapshot-Persistenz.** Oxigraph-WASM hält den
   Graphen im Speicher; Dauerhaftigkeit liefert der kanonische Snapshot
   (`data/graph/*.nq`, RDFC-1.0, byte-deterministisch — M0-Tests). Bei 100k
   Quads kostet ein voller Dump ~0,3 s; Snapshots werden debounced
   geschrieben. Im Browser (`local`) ist das Backing OPFS statt `data/`.
2. **Synchrone Query-Ausführung.** WASM ist nicht unterbrechbar;
   `QueryOptions.timeoutMs` ist ein weiches Budget (Messung nach Lauf).
   Harte Kappung kommt mit dem Web-Worker-Betrieb der Runtime `local`
   (UI blockiert nie auf einer Query, SPEC §5.2) bzw. wäre bei Bedarf über
   einen Oxigraph-Server-Sidecar erreichbar — ohne Änderung am
   `GraphStore`-Interface.
3. **Einzel-`add()` ist teuer.** Alle Ladepfade batchen über
   N-Quads-Strings (implementiert in `OxigraphStore.load()`).
4. **Wachstumspfad.** Ab niedrigen Millionen Quads oder für
   Multi-User-Server-Betrieb kann derselbe `GraphStore`-Vertrag von einem
   nativen Oxigraph-Server (RocksDB) erfüllt werden; die Schnittstelle
   ändert sich nicht.

## Fallback-Kriterium

Die Entscheidung wird revidiert, wenn Oxigraph-WASM im Browser-Feldtest an
Speicher (OPFS-Snapshot > Quota) oder Ladezeit (WASM-Init + Snapshot-Load
> 3 s auf Mittelklasse-Mobilgerät bei ≤ 250k Quads) scheitert. Dann greift
der in der SPEC benannte Fallback (`quadstore` + `quadstore-comunica`),
hinter demselben `GraphStore`-Interface.
