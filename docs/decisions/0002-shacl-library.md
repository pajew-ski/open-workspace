# ADR 0002: SHACL-Library — rdf-validate-shacl

**Status**: Angenommen (M7, 2026-08-09)
**Kontext**: SPEC „Graph Core — Vollausbau" §7.2 verlangt die Evaluation
von `shacl-engine` gegen `rdf-validate-shacl` in M7, mit Messwerten statt
Gefühl. Die Validierung läuft an drei Stellen (vor UI-Schreibvorgängen,
nach jedem Connector-Pull, on demand im Explorer) und muss perspektivisch
auch in der Runtime `local` im Browser laufen.

## Entscheidung

**`rdf-validate-shacl@0.6.5`** (Zazuko) ist die SHACL-Engine des
Graph-Kerns, gekapselt in `src/lib/graph/reasoning/shacl.ts` — kein
anderes Modul importiert die Library direkt, ein späterer Tausch bleibt
lokal. Als DatasetCore-Fabrik kommt `@rdfjs/dataset` dazu (13 KB-Klasse,
ohnehin transitive Abhängigkeit).

## Messwerte

Reproduzierbar mit `bun run bench:shacl` (Bun 1.3, Container dieser
Umgebung; Datenbasis: die realen Kern-Shapes `ontology/shapes/core.ttl`
gegen generierte Aufgaben mit ~5 % Verstößen; beide Kandidaten sehen
identische `@rdfjs/dataset`-Datasets; Median aus 5 Läufen). Für den
Vergleichslauf war `shacl-engine@1.1.2` temporär installiert
(`bun add shacl-engine`).

| Messung | rdf-validate-shacl | shacl-engine |
|---|---|---|
| Validierung 500 Aufgaben / 2 925 Quads (Median) | 115 ms | 105 ms |
| Validierung 5 000 Aufgaben / 29 250 Quads (Median) | 1 298 ms | 1 047 ms |
| Shapes kompilieren | 22–33 ms | 4–5 ms |
| Gefundene Ergebnisse (beide identisch) | 1 000 | 1 000 |
| Transitive Installation (isoliert, `bun add`) | **13 MB / 364 JS-Dateien** | 69 MB / 3 947 JS-Dateien |
| TypeScript-Deklarationen | **ja (index.d.ts + src/*.d.ts)** | nein |

## Begründung

1. **Laufzeit ist auf unseren realen Shapes kein Unterscheidungsmerkmal.**
   Die 15–26×-Beschleunigung, mit der shacl-engine wirbt, entsteht bei
   rekursionslastigen Shapes (shacl-shacl). Auf den flachen Kern-Shapes
   dieses Repos liegen beide Engines bei identischem Befund ~1,1–1,2×
   auseinander; bei realer Workspace-Größe (~500 Aufgaben) sind es 10 ms
   Unterschied pro Lauf.
2. **Abhängigkeits-Fußabdruck.** shacl-engine zieht für SPARQL-basierte
   Constraints den Comunica-Stack (`@comunica/query-sparql-rdfjs-lite`)
   mit — 69 MB / 3 947 Dateien transitiv gegenüber 13 MB / 364. Der
   Comunica-Import ist zwar opt-in (`shacl-engine/sparql.js`), aber der
   Baum wird installiert, auditiert und vom Bundler-Tree-Shaking
   abhängig. SPARQL-Constraints braucht SPEC §7.2 nicht.
3. **Typisierung.** rdf-validate-shacl liefert eigene
   TypeScript-Deklarationen; shacl-engine hat keine — unter der
   `kein any unter src/lib/graph/`-Regel (Invariante 9) hätte das eigene
   Ambient-Deklarationen für fremde Interna bedeutet.
4. **Berichts-API.** Beide liefern vollständige
   W3C-Validation-Reports (focusNode, path, severity, message,
   sourceShape). Gleichstand — kein Ausschlag.

## Revisionskriterium

Wächst die Validierungslast um Größenordnungen (z. B. Validierung großer
Importe > 100k Quads pro Lauf im Browser-Worker) und wird die
SHACL-Validierung dort zum messbaren Engpass, ist shacl-engine über die
Kapselung in `reasoning/shacl.ts` erneut zu evaluieren — dann mit
Messwerten auf genau dieser Last.

## Nebenentscheidung: OWL-RL-Engine (SPEC §7.3)

Für OWL RL Tier 1 erlaubt die SPEC ausdrücklich „eine eigene, auf das
tatsächlich genutzte Fragment beschränkte Regelmenge" als Alternative zu
`eye-js` (EYE als WASM). Umgesetzt ist die eigene Regelmenge
(`src/lib/graph/reasoning/owl-rl.ts`): deterministisches
Forward-Chaining über exakt das in §7.3 geforderte Fragment
(subClassOf/subPropertyOf inkl. Transitivität, domain/range, inverseOf,
TransitiveProperty, SymmetricProperty, equivalentClass/-Property,
sameAs), ~200 Zeilen ohne neue Abhängigkeit. Gründe: kein zweites
WASM-Artefakt neben Oxigraph im Browser-Bundle der Runtime `local`,
identisches Verhalten in Node und Browser, jede Regel einzeln testbar
(`tests/graph/reasoning.test.ts`). Wird später mehr als das Fragment
gebraucht (N3-Regeln, RL-Vollständigkeit über Listen-Konstrukte), ist
eye-js der benannte Kandidat — die Pipeline (`reasoning/run.ts`) kennt
nur `deriveOwlRlInferences(schema, data)` und bliebe unverändert.
