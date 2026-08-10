// @vitest-environment node
/**
 * M7-Abnahme SHACL (GRAPH_CORE_SPEC §7.2): Validierung an DREI Stellen.
 *
 *  Stelle 1 — vor jedem Schreibvorgang aus UI/API (workspace/crud.ts):
 *    blockierend NUR bei sh:Violation, und nur wenn die Mutation den
 *    Verstoß NEU einführt; Altbestand bleibt bearbeitbar.
 *  Stelle 2 — nach jedem Connector-Pull (Sync-Runner): berichtend, NIE
 *    blockierend; der Bericht liegt als sh:ValidationReport-Graph in
 *    graph/meta und die Kurzfassung im Connector-Lesemodell.
 *  Stelle 3 — on demand (validateStoreGraphs, /api/graph/validate):
 *    geschützte Graphen (acl, presentation, inferred) sind nie Ziel.
 *
 * Dazu: die Kern-Shapes selbst (ontology/shapes/core.ttl) erkennen die
 * definierten Verstoßklassen, inkl. der Layout-Blacklist (Invariante 2).
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Quad } from '@rdfjs/types';
import { OxigraphStore } from '@/lib/graph/store/oxigraph';
import { createIriFactory } from '@/lib/graph/iri';
import { factory, literal, namedNode, typedLiteral } from '@/lib/graph/rdf';
import { OW, PREFIXES, RDF, SCHEMA } from '@/lib/graph/vocab';
import { newViolations, ShaclViolationError, validateQuads } from '@/lib/graph/reasoning/shacl';
import { connectorValidationIri, validateStoreGraphs } from '@/lib/graph/reasoning/run';
import { parseRdf } from '@/lib/graph/serialize/io';
import * as crud from '@/lib/graph/workspace/crud';
import { writeWorkspaceToStore } from '@/lib/graph/workspace/crud';
import { defaultWorkspaceFilePaths } from '@/lib/graph/workspace/files';
import { createConnector, deleteConnector, getConnector, type GraphHandle } from '@/lib/graph/connectors/registry';
import { syncConnector } from '@/lib/graph/connectors/sync';

const INSTANCE_BASE = 'urn:ow:11111111-2222-4333-8444-555555555555:';
const SH = PREFIXES.sh;

const nn = namedNode;

function shapesQuads(): Quad[] {
    const ttl = readFileSync(path.join(process.cwd(), 'ontology', 'shapes', 'core.ttl'), 'utf-8');
    return parseRdf(ttl, { format: 'text/turtle' });
}

async function makeHandle(): Promise<GraphHandle> {
    const iri = createIriFactory(INSTANCE_BASE);
    const store = new OxigraphStore();
    await store.load(shapesQuads(), nn(iri.sharedGraph('shapes')), { replace: true });
    return { store, iri };
}

async function dump(handle: GraphHandle, graphIri: string): Promise<Quad[]> {
    const quads: Quad[] = [];
    for await (const q of handle.store.dump(nn(graphIri))) {
        quads.push(q);
    }
    return quads;
}

describe('Kern-Shapes (ontology/shapes/core.ttl)', () => {
    const task = (id: string) => nn(`urn:test:task/${id}`);

    it('konforme Aufgabe: kein Befund', async () => {
        const report = await validateQuads(shapesQuads(), [
            factory.quad(task('ok'), nn(RDF.type), nn(OW.Task)),
            factory.quad(task('ok'), nn(SCHEMA.name), literal('Alles gut')),
            factory.quad(task('ok'), nn(OW.priority), literal('high')),
            factory.quad(task('ok'), nn(OW.workflowStatus), literal('todo')),
            factory.quad(task('ok'), nn(SCHEMA.endTime), typedLiteral.dateTime('2026-09-01T00:00:00.000Z')),
        ]);
        expect(report.conforms).toBe(true);
        expect(report.results).toEqual([]);
    });

    it('erkennt fehlenden Titel, kaputte Priorität und Literal-blockedBy als sh:Violation', async () => {
        const report = await validateQuads(shapesQuads(), [
            factory.quad(task('kaputt'), nn(RDF.type), nn(OW.Task)),
            factory.quad(task('kaputt'), nn(OW.priority), literal('sofort')),
            factory.quad(task('kaputt'), nn(OW.blockedBy), literal('task-42')),
        ]);
        expect(report.conforms).toBe(false);
        expect(report.counts.violations).toBe(3);
        const messages = report.results.map(r => r.message).join(' | ');
        expect(messages).toContain('nicht-leeren Titel');
        expect(messages).toContain('Priorität');
        expect(messages).toContain('IRI');
    });

    it('hängende Abhängigkeit ist eine Warnung, kein Blocker', async () => {
        const report = await validateQuads(shapesQuads(), [
            factory.quad(task('haengt'), nn(RDF.type), nn(OW.Task)),
            factory.quad(task('haengt'), nn(SCHEMA.name), literal('Mit Leiche')),
            factory.quad(task('haengt'), nn(OW.blockedBy), nn('urn:test:task/geloescht')),
        ]);
        expect(report.counts.violations).toBe(0);
        expect(report.counts.warnings).toBeGreaterThanOrEqual(1);
        expect(report.results.some(r => r.severity === 'Warning' && r.message.includes('hängende Abhängigkeit'))).toBe(true);
    });

    it('Layout-Prädikat im Wissens-Graphen ist eine sh:Violation (Invariante 2 als Shape)', async () => {
        const report = await validateQuads(shapesQuads(), [
            factory.quad(nn('urn:test:node/1'), nn(OW.xPosition), typedLiteral.decimal(42)),
        ]);
        expect(report.conforms).toBe(false);
        expect(report.results.some(r => r.severity === 'Violation' && r.message.includes('graph/<u>/presentation'))).toBe(true);
    });

    it('newViolations: nur NEUE Verstöße blockieren', async () => {
        const dirty = [
            factory.quad(task('alt'), nn(RDF.type), nn(OW.Task)),
        ];
        const before = await validateQuads(shapesQuads(), dirty);
        const unchanged = await validateQuads(shapesQuads(), [
            ...dirty,
            factory.quad(nn('urn:test:doc/neu'), nn(RDF.type), nn(OW.Document)),
            factory.quad(nn('urn:test:doc/neu'), nn(SCHEMA.name), literal('Sauber')),
        ]);
        expect(newViolations(before, unchanged)).toEqual([]);
        const worse = await validateQuads(shapesQuads(), [
            ...dirty,
            factory.quad(task('neu'), nn(RDF.type), nn(OW.Task)),
        ]);
        expect(newViolations(before, worse).map(v => v.focusNode)).toEqual([task('neu').value]);
    });
});

describe('Stelle 1: Validierung vor jedem UI-Schreibvorgang (Store-first-CRUD)', () => {
    async function createTestContext(): Promise<crud.WorkspaceContext> {
        const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ow-shacl-'));
        const iri = createIriFactory(INSTANCE_BASE);
        const store = new OxigraphStore();
        await store.load(shapesQuads(), nn(iri.sharedGraph('shapes')), { replace: true });
        let chain: Promise<unknown> = Promise.resolve();
        return {
            store,
            iri,
            paths: defaultWorkspaceFilePaths(baseDir),
            runExclusive: fn => {
                const run = chain.then(fn);
                chain = run.catch(() => undefined);
                return run;
            },
            persistSnapshot: async () => undefined,
        };
    }

    it('gültige Mutationen laufen durch, leerer Titel wird abgelehnt und der Store bleibt unverändert', async () => {
        const ctx = await createTestContext();
        const task = await crud.createTask(ctx, { title: 'Ordentliche Aufgabe' });
        await expect(crud.updateTask(ctx, task.id, { title: '' })).rejects.toThrow(ShaclViolationError);
        const after = await crud.getTask(ctx, task.id);
        expect(after?.title).toBe('Ordentliche Aufgabe');
    });

    it('lehnt auch leere Dokument- und Pinnwand-Titel ab (422-Pfad der API)', async () => {
        const ctx = await createTestContext();
        const doc = await crud.createDoc(ctx, { title: 'Notiz', content: 'Inhalt' });
        await expect(crud.updateDoc(ctx, doc.id, { title: '' })).rejects.toThrow(ShaclViolationError);
        const canvas = await crud.createCanvas(ctx, 'Pinnwand');
        await expect(crud.updateCanvasMeta(ctx, canvas.id, { name: '' })).rejects.toThrow(ShaclViolationError);
    });

    it('M15: die Shapes der neuen Graph-Bürger greifen (Kalender, Unterhaltung)', async () => {
        const ctx = await createTestContext();
        const calendar = await crud.createCalendar(ctx, {
            name: 'Tango', url: 'https://example.org/t.ics', color: '#be185d',
        });
        await expect(crud.updateCalendar(ctx, calendar.id, { name: '' })).rejects.toThrow(ShaclViolationError);
        expect((await crud.listCalendars(ctx))[0].name).toBe('Tango');

        const conversation = await crud.createConversation(ctx, 'Dialog');
        await expect(crud.renameConversation(ctx, conversation.id, '')).rejects.toThrow(ShaclViolationError);
        expect((await crud.getConversation(ctx, conversation.id))?.title).toBe('Dialog');
    });

    it('Altbestand mit Verstößen blockiert unabhängige Mutationen nicht — nur eine Verschlechterung', async () => {
        const ctx = await createTestContext();
        // Altbestand MIT Verstoß über den Bootstrap-Pfad einspielen
        // (writeWorkspaceToStore validiert nicht — genau wie die
        // (Re-)Migration bestehender Datenbestände).
        const now = '2026-01-01T00:00:00.000Z';
        await writeWorkspaceToStore(ctx.store, ctx.iri, {
            docs: [],
            tasks: [{
                id: 'task-alt', title: '', status: 'todo', priority: 'medium', type: 'task',
                tags: [], dependencies: [], createdAt: now, updatedAt: now,
            }],
            projects: [],
            canvases: [],
            calendars: [], events: [], conversations: [],
        });
        // Unabhängige Mutation: erlaubt, obwohl der Altbestand verletzt.
        const created = await crud.createTask(ctx, { title: 'Neue saubere Aufgabe' });
        expect(created.id).toBeTruthy();
        // Verschlechterung: ein WEITERER leerer Titel wird abgelehnt.
        await expect(crud.updateTask(ctx, created.id, { title: '' })).rejects.toThrow(ShaclViolationError);
    });
});

describe('Stelle 2: Validierung nach jedem Connector-Pull (berichtend, nie blockierend)', () => {
    const LOCATOR = 'https://example.org/quelle.ttl';

    function stubFor(ttl: string): typeof fetch {
        return (async () => new Response(ttl, {
            status: 200,
            headers: { 'content-type': 'text/turtle' },
        })) as typeof fetch;
    }

    async function syncWith(handle: GraphHandle, ttl: string) {
        return syncConnector(handle, 'quelle', { fetchImpl: stubFor(ttl) });
    }

    it('ein Import mit Verstößen läuft durch, erzeugt den Bericht als Graph und die Kurzfassung im Lesemodell', async () => {
        const handle = await makeHandle();
        await createConnector(handle, { id: 'quelle', name: 'Quelle', kind: 'rdf-file', locator: LOCATOR });
        const result = await syncWith(handle, `@prefix ow: <${PREFIXES.ow}> .\n<urn:ext:t1> a ow:Task .\n`);

        // NIE blockierend: der Lauf ist ein regulärer Import.
        expect(result.status).toBe('imported');
        expect(result.validation?.conforms).toBe(false);
        expect(result.validation?.counts.violations).toBeGreaterThanOrEqual(1);
        expect(result.message).toContain('SHACL');

        // Bericht als Graph in graph/meta (sh:ValidationReport).
        const reportIri = connectorValidationIri(handle.iri, 'quelle');
        const meta = await dump(handle, handle.iri.sharedGraph('meta'));
        const reportNode = meta.filter(q => q.subject.value === reportIri);
        expect(reportNode.some(q => q.predicate.value === RDF.type && q.object.value === `${SH}ValidationReport`)).toBe(true);
        expect(reportNode.some(q => q.predicate.value === `${SH}conforms` && q.object.value === 'false')).toBe(true);
        const resultNodes = meta.filter(q => q.subject.value.startsWith(`${reportIri}/result-`));
        expect(resultNodes.some(q => q.predicate.value === `${SH}resultSeverity` && q.object.value === `${SH}Violation`)).toBe(true);

        // Kurzfassung im Connector-Lesemodell (eine Quelle: der Bericht).
        const view = await getConnector(handle, 'quelle');
        expect(view?.lastRun?.validation?.conforms).toBe(false);
        expect(view?.lastRun?.validation?.violations).toBe(result.validation?.counts.violations);
    });

    it('ein reparierter Import ersetzt den Bericht (konform, keine Alt-Ergebnisse)', async () => {
        const handle = await makeHandle();
        await createConnector(handle, { id: 'quelle', name: 'Quelle', kind: 'rdf-file', locator: LOCATOR });
        await syncWith(handle, `@prefix ow: <${PREFIXES.ow}> .\n<urn:ext:t1> a ow:Task .\n`);
        const fixed = await syncWith(handle, [
            `@prefix ow: <${PREFIXES.ow}> .`,
            `@prefix schema: <https://schema.org/> .`,
            `<urn:ext:t1> a ow:Task ; schema:name "Repariert" .`,
            '',
        ].join('\n'));
        expect(fixed.status).toBe('imported');
        expect(fixed.validation?.conforms).toBe(true);

        const reportIri = connectorValidationIri(handle.iri, 'quelle');
        const meta = await dump(handle, handle.iri.sharedGraph('meta'));
        expect(meta.some(q => q.subject.value === reportIri && q.predicate.value === `${SH}conforms` && q.object.value === 'true')).toBe(true);
        expect(meta.filter(q => q.subject.value.startsWith(`${reportIri}/result-`))).toEqual([]);
        const view = await getConnector(handle, 'quelle');
        expect(view?.lastRun?.validation).toEqual({ conforms: true, violations: 0, warnings: 0, infos: 0 });
    });

    it('das Löschen des Connectors räumt den Bericht mit aus', async () => {
        const handle = await makeHandle();
        await createConnector(handle, { id: 'quelle', name: 'Quelle', kind: 'rdf-file', locator: LOCATOR });
        await syncWith(handle, `@prefix ow: <${PREFIXES.ow}> .\n<urn:ext:t1> a ow:Task .\n`);
        await deleteConnector(handle, 'quelle');
        const reportIri = connectorValidationIri(handle.iri, 'quelle');
        const meta = await dump(handle, handle.iri.sharedGraph('meta'));
        expect(meta.filter(q => q.subject.value.startsWith(reportIri))).toEqual([]);
    });
});

describe('Stelle 3: On-demand-Validierung (Explorer, /api/graph/validate)', () => {
    it('validiert die Wissens-Graphen und meldet Fundstellen mit Fokus-Knoten', async () => {
        const handle = await makeHandle();
        const ws = nn(handle.iri.graph('workspace'));
        const taskIri = handle.iri.entity('task', 'task-1');
        await handle.store.load([
            factory.quad(nn(taskIri), nn(RDF.type), nn(OW.Task), ws),
            factory.quad(nn(taskIri), nn(OW.priority), literal('sofort'), ws),
        ], ws, { replace: true });

        const report = await validateStoreGraphs(handle);
        expect(report.graphs).toContain(ws.value);
        expect(report.conforms).toBe(false);
        expect(report.results.some(r => r.focusNode === taskIri && r.severity === 'Violation')).toBe(true);
    });

    it('geschützte und präsentationsnahe Graphen sind still ausgeschlossen', async () => {
        const handle = await makeHandle();
        const report = await validateStoreGraphs(handle, [
            handle.iri.sharedGraph('acl'),
            handle.iri.graph('presentation'),
            handle.iri.inferredGraph('workspace'),
            handle.iri.sharedGraph('shapes'),
        ]);
        expect(report.graphs).toEqual([]);
        expect(report.conforms).toBe(true);
    });
});
