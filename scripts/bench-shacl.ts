/**
 * Benchmark für die SHACL-Library-Entscheidung (SPEC §7.2, M7).
 *
 * Reproduziert die Messwerte aus docs/decisions/0002-shacl-library.md:
 *   bun run bench:shacl                  # gewählte Library (rdf-validate-shacl)
 *   bun add shacl-engine && bun run bench:shacl   # inkl. Vergleichskandidat
 *
 * Validiert werden die REALEN Kern-Shapes (ontology/shapes/core.ttl)
 * gegen einen generierten Workspace-Bestand mit eingestreuten Verstößen —
 * beide Kandidaten sehen identische RDF/JS-Datasets (@rdfjs/dataset).
 * Größe über BENCH_TASKS steuerbar (Default 5000; 500 ≈ realer Workspace).
 */

import { performance } from 'node:perf_hooks';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Quad } from '@rdfjs/types';
import datasetFactory from '@rdfjs/dataset';
import RdfValidateShacl from 'rdf-validate-shacl';
import { parseRdf } from '../src/lib/graph/serialize/io';
import { factory, namedNode, literal, typedLiteral } from '../src/lib/graph/rdf';
import { OW, RDF, SCHEMA } from '../src/lib/graph/vocab';

const TASKS = Number.parseInt(process.env.BENCH_TASKS ?? '5000', 10);
const VIOLATION_RATE = 0.05;
const RUNS = 5;

function fmt(ms: number): string {
    return `${ms.toFixed(1)} ms`;
}

function median(values: number[]): number {
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
}

// --- Testdaten: Aufgaben mit Titel/Priorität/Status/Fälligkeit/BlockedBy ---

const PRIORITIES = ['low', 'medium', 'high', 'urgent'];
const STATUSES = ['backlog', 'todo', 'in-progress', 'review', 'done', 'on-hold'];

const dataQuads: Quad[] = [];
for (let i = 0; i < TASKS; i++) {
    const s = namedNode(`urn:ow:bench:u/default/task/task-${i}`);
    const violate = i % Math.round(1 / VIOLATION_RATE) === 0;
    dataQuads.push(factory.quad(s, namedNode(RDF.type), namedNode(OW.Task)));
    if (!violate) {
        // konform
        dataQuads.push(factory.quad(s, namedNode(SCHEMA.name), literal(`Aufgabe ${i}`)));
        dataQuads.push(factory.quad(s, namedNode(OW.priority), literal(PRIORITIES[i % PRIORITIES.length])));
        dataQuads.push(factory.quad(s, namedNode(OW.workflowStatus), literal(STATUSES[i % STATUSES.length])));
        dataQuads.push(factory.quad(s, namedNode(SCHEMA.endTime), typedLiteral.dateTime('2026-08-09T12:00:00.000Z')));
        if (i > 0) {
            dataQuads.push(factory.quad(s, namedNode(OW.blockedBy), namedNode(`urn:ow:bench:u/default/task/task-${i - 1}`)));
        }
    } else {
        // Verstoß-Mix: fehlender Titel, kaputte Priorität, Literal-BlockedBy
        dataQuads.push(factory.quad(s, namedNode(OW.priority), literal('sofort')));
        dataQuads.push(factory.quad(s, namedNode(OW.blockedBy), literal('task-42')));
    }
}

const shapesTtl = readFileSync(join(process.cwd(), 'ontology', 'shapes', 'core.ttl'), 'utf-8');
const shapesQuads = parseRdf(shapesTtl, { format: 'text/turtle' });

const shapesDataset = datasetFactory.dataset(shapesQuads);
const dataDataset = datasetFactory.dataset(dataQuads);

console.log(`SHACL-Benchmark (${TASKS.toLocaleString('de-DE')} Aufgaben, ${dataQuads.length.toLocaleString('de-DE')} Quads, ~${Math.round(VIOLATION_RATE * 100)} % Verstöße, Kern-Shapes aus ontology/shapes/core.ttl):`);

// --- Gewählt: rdf-validate-shacl (mitgelieferte Default-Environment) ----

{
    const initStart = performance.now();
    const validator = new RdfValidateShacl(shapesDataset);
    const initMs = performance.now() - initStart;

    const times: number[] = [];
    let resultCount = 0;
    for (let run = 0; run < RUNS; run++) {
        const start = performance.now();
        const report = await validator.validate(dataDataset);
        times.push(performance.now() - start);
        resultCount = report.results.length;
    }
    console.log('\nrdf-validate-shacl (gewählt):');
    console.log(`  Shapes kompilieren:  ${fmt(initMs)}`);
    console.log(`  Validierung (kalt):  ${fmt(times[0])}`);
    console.log(`  Validierung (Median aus ${RUNS}): ${fmt(median(times))}`);
    console.log(`  Ergebnisse:          ${resultCount}`);
}

// --- Vergleichskandidat: shacl-engine (nur wenn installiert) ------------

try {
    const { Validator } = await import('shacl-engine' as string) as {
        Validator: new (dataset: unknown, opts: { factory: unknown }) => {
            validate(data: { dataset: unknown }): Promise<{ results: unknown[] }>;
        };
    };
    const reportFactory = {
        namedNode,
        literal,
        blankNode: factory.blankNode.bind(factory),
        quad: factory.quad.bind(factory),
        defaultGraph: factory.defaultGraph.bind(factory),
    };
    const initStart = performance.now();
    const validator = new Validator(shapesDataset, { factory: reportFactory });
    const initMs = performance.now() - initStart;

    const times: number[] = [];
    let resultCount = 0;
    for (let run = 0; run < RUNS; run++) {
        const start = performance.now();
        const report = await validator.validate({ dataset: dataDataset });
        times.push(performance.now() - start);
        resultCount = report.results.length;
    }
    console.log('\nshacl-engine (Vergleichskandidat):');
    console.log(`  Shapes kompilieren:  ${fmt(initMs)}`);
    console.log(`  Validierung (kalt):  ${fmt(times[0])}`);
    console.log(`  Validierung (Median aus ${RUNS}): ${fmt(median(times))}`);
    console.log(`  Ergebnisse:          ${resultCount}`);
} catch {
    console.log('\nshacl-engine: nicht installiert — Vergleichslauf übersprungen (bun add shacl-engine).');
}

console.log(`\nRSS: ${(process.memoryUsage().rss / 1e6).toFixed(0)} MB`);
