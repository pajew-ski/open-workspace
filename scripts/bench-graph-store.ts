/**
 * Benchmark für die Store-Entscheidung (SPEC §5.1, M0).
 *
 * Reproduziert die Messwerte aus docs/decisions/0001-graph-store.md:
 *   bun run bench:graph-store
 */

import { performance } from 'node:perf_hooks';
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { Store, namedNode } from 'oxigraph';

const N = 100_000;
const GRAPH = namedNode('urn:ow:bench:graph/u/default/workspace');

function fmt(ms: number): string {
    return `${ms.toFixed(1)} ms`;
}

// Testdaten: 50k Subjekte, 7 Prädikate, Mix aus Literalen und Kanten.
let nq = '';
for (let i = 0; i < N; i++) {
    const s = `<urn:ow:bench:u/default/doc/${i % 50_000}>`;
    const p = `<urn:ow:bench:p/${i % 7}>`;
    const o = i % 3 === 0 ? `"Wert ${i}"@de` : `<urn:ow:bench:u/default/doc/${(i + 1) % 50_000}>`;
    nq += `${s} ${p} ${o} <${GRAPH.value}> .\n`;
}

const initStart = performance.now();
const store = new Store();
const initMs = performance.now() - initStart;

const loadStart = performance.now();
store.load(nq, { format: 'application/n-quads' });
const loadMs = performance.now() - loadStart;

const countStart = performance.now();
store.query('SELECT (COUNT(*) AS ?c) WHERE { GRAPH ?g { ?s ?p ?o } }');
const countMs = performance.now() - countStart;

const pointStart = performance.now();
store.query(`SELECT ?o WHERE { GRAPH <${GRAPH.value}> { <urn:ow:bench:u/default/doc/42> <urn:ow:bench:p/0> ?o } }`);
const pointMs = performance.now() - pointStart;

const joinStart = performance.now();
store.query('SELECT ?s ?o2 WHERE { GRAPH ?g { ?s <urn:ow:bench:p/1> ?o . ?o <urn:ow:bench:p/2> ?o2 } } LIMIT 1000');
const joinMs = performance.now() - joinStart;

const dumpStart = performance.now();
const dump = store.dump({ format: 'application/n-quads' });
const dumpMs = performance.now() - dumpStart;

const wasmBytes = statSync(join(process.cwd(), 'node_modules/oxigraph/web_bg.wasm')).size;

console.log(`Oxigraph-Benchmark (${N.toLocaleString('de-DE')} Quads):`);
console.log(`  Store-Initialisierung:        ${fmt(initMs)}`);
console.log(`  Bulk-Load (N-Quads-String):   ${fmt(loadMs)}  (${store.size.toLocaleString('de-DE')} Quads)`);
console.log(`  COUNT(*) über alles:          ${fmt(countMs)}`);
console.log(`  Punkt-Lookup:                 ${fmt(pointMs)}`);
console.log(`  2-Hop-Join (LIMIT 1000):      ${fmt(joinMs)}`);
console.log(`  Dump N-Quads:                 ${fmt(dumpMs)}  (${(dump.length / 1e6).toFixed(1)} MB)`);
console.log(`  WASM-Artefakt (web_bg.wasm):  ${(wasmBytes / 1e6).toFixed(2)} MB unkomprimiert`);
console.log(`  RSS:                          ${(process.memoryUsage().rss / 1e6).toFixed(0)} MB`);
