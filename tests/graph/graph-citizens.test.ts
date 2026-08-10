// @vitest-environment node
/**
 * Abnahme M15 („Kalender, Chats und die AI-Konfiguration werden
 * Graph-Bürger"):
 *
 *  1. Kalender und Chats laufen Store-first (SPEC §12.4): Mutationen
 *     landen im Store, `data/calendar/*.json` und
 *     `data/chat/conversations.json` sind Projektion — ein externer
 *     Datei-Edit ändert die Wahrheit NICHT.
 *  2. Sie sind per SPARQL beantwortbar: welcher Termin kommt aus welchem
 *     abonnierten Kalender, welche Nachrichten hat eine Unterhaltung.
 *  3. Invariante 2 gilt unverändert: Kalenderfarbe, die generative
 *     Oberfläche einer Antwort und die zuletzt geöffnete Unterhaltung
 *     stehen ausschließlich in `graph/<u>/presentation`.
 *  4. Das Selbstmodell weist die neuen Entitätstypen an ihren Modulen aus
 *     — die Frage „wo bearbeite ich diesen Knotentyp" ist beantwortbar.
 */
import { describe, it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as crud from '@/lib/graph/workspace/crud';
import { defaultWorkspaceFilePaths, readWorkspaceFiles } from '@/lib/graph/workspace/files';
import { createIriFactory, urnInstanceBase } from '@/lib/graph/iri';
import { OxigraphStore } from '@/lib/graph/store/oxigraph';
import { namedNode } from '@/lib/graph/rdf';
import { OW, SCHEMA, SPARQL_PREFIXES } from '@/lib/graph/vocab';
import { APP_MODULES } from '@/lib/app/modules';

const INSTANCE_BASE = urnInstanceBase('00000000-0000-4000-8000-00000000ca15');

async function createContext(): Promise<crud.WorkspaceContext & { baseDir: string }> {
    const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ow-citizens-'));
    let chain: Promise<unknown> = Promise.resolve();
    return {
        baseDir,
        store: new OxigraphStore(),
        iri: createIriFactory(INSTANCE_BASE),
        paths: defaultWorkspaceFilePaths(baseDir),
        runExclusive: fn => {
            const run = chain.then(fn);
            chain = run.catch(() => undefined);
            return run;
        },
        persistSnapshot: async () => undefined,
    };
}

async function selectAll(
    ctx: crud.WorkspaceContext,
    sparql: string,
): Promise<Array<Record<string, string>>> {
    const result = await ctx.store.query(`${SPARQL_PREFIXES}\n${sparql}`);
    if (result.type !== 'bindings') throw new Error('SELECT erwartet');
    const rows: Array<Record<string, string>> = [];
    for await (const binding of result.bindings) {
        const row: Record<string, string> = {};
        for (const [key, term] of Object.entries(binding)) row[key] = term.value;
        rows.push(row);
    }
    return rows;
}

async function graphValues(ctx: crud.WorkspaceContext, graph: string): Promise<string[]> {
    const values: string[] = [];
    for await (const q of ctx.store.dump(namedNode(graph))) {
        values.push(`${q.predicate.value}=${q.object.value}`);
    }
    return values;
}

const EVENTS = (calendarId: string) => [
    {
        id: 'evt-1', providerId: calendarId, title: 'Milonga del Sol',
        location: 'Alte Mälzerei', description: 'Mit Live-Musik.',
        startDate: '2026-03-07T19:30:00.000Z', endDate: '2026-03-07T23:30:00.000Z', allDay: false,
    },
    {
        id: 'evt-2', providerId: calendarId, title: 'Workshop',
        startDate: '2026-04-01T00:00:00.000Z', endDate: '2026-04-02T00:00:00.000Z', allDay: true,
    },
];

describe('Kalender als Graph-Bürger (M15)', () => {
    it('Abruf-Ergebnis landet im Store; die Datei ist Projektion', async () => {
        const ctx = await createContext();
        const calendar = await crud.createCalendar(ctx, {
            name: 'Tango Regensburg', url: 'https://example.org/tango.ics', color: '#be185d',
        });
        const count = await crud.replaceCalendarEvents(ctx, calendar.id, EVENTS(calendar.id), '2026-03-01T08:00:00.000Z');
        expect(count).toBe(2);

        // Wahrheit ist der Store …
        const stored = await crud.listEvents(ctx);
        expect(stored.map(e => e.title)).toEqual(['Milonga del Sol', 'Workshop']);
        expect((await crud.listCalendars(ctx))[0].lastSync).toBe('2026-03-01T08:00:00.000Z');

        // … die Datei ist die Projektion davon.
        const projected: { events: Array<{ id: string }> } = JSON.parse(
            await fs.readFile(ctx.paths.calendarEventsFile, 'utf-8'));
        expect(projected.events.map(e => e.id)).toEqual(['evt-1', 'evt-2']);

        // Ein externer Datei-Edit ändert die Wahrheit NICHT.
        await fs.writeFile(ctx.paths.calendarEventsFile, JSON.stringify({ events: [] }), 'utf-8');
        expect((await crud.listEvents(ctx)).length).toBe(2);
    });

    it('nur aktive Kalender liefern Termine; das Zeitfenster filtert', async () => {
        const ctx = await createContext();
        const calendar = await crud.createCalendar(ctx, {
            name: 'Tango', url: 'https://example.org/tango.ics', color: '#be185d',
        });
        await crud.replaceCalendarEvents(ctx, calendar.id, EVENTS(calendar.id), '2026-03-01T08:00:00.000Z');

        const märz = await crud.listEvents(ctx, { start: '2026-03-01T00:00:00.000Z', end: '2026-03-31T00:00:00.000Z' });
        expect(märz.map(e => e.id)).toEqual(['evt-1']);

        await crud.updateCalendar(ctx, calendar.id, { enabled: false });
        expect(await crud.listEvents(ctx)).toEqual([]);
        // Abgeschaltet heißt nicht gelöscht — die Termine bleiben im Graphen.
        expect((await crud.readWorkspace(ctx)).events.length).toBe(2);
    });

    it('gelöschter Kalender nimmt seine Termine mit (keine Waisen)', async () => {
        const ctx = await createContext();
        const calendar = await crud.createCalendar(ctx, {
            name: 'Tango', url: 'https://example.org/tango.ics', color: '#be185d',
        });
        await crud.replaceCalendarEvents(ctx, calendar.id, EVENTS(calendar.id), '2026-03-01T08:00:00.000Z');
        expect(await crud.deleteCalendar(ctx, calendar.id)).toBe(true);
        const after = await crud.readWorkspace(ctx);
        expect(after.calendars).toEqual([]);
        expect(after.events).toEqual([]);
    });

    it('SPARQL beantwortet: welcher Termin kommt aus welchem abonnierten Kalender', async () => {
        const ctx = await createContext();
        const calendar = await crud.createCalendar(ctx, {
            name: 'Tango Regensburg', url: 'https://example.org/tango.ics', color: '#be185d',
        });
        await crud.replaceCalendarEvents(ctx, calendar.id, EVENTS(calendar.id), '2026-03-01T08:00:00.000Z');

        const rows = await selectAll(ctx, `
            SELECT ?titel ?kalender WHERE {
                GRAPH <${ctx.iri.graph('workspace')}> {
                    ?termin a schema:Event ; schema:name ?titel ; schema:isPartOf ?feed .
                    ?feed a schema:DataFeed ; schema:name ?kalender ; ow:enabled true .
                    FILTER(?termin != ?feed)
                }
            } ORDER BY ?titel
        `);
        expect(rows).toEqual([
            { titel: 'Milonga del Sol', kalender: 'Tango Regensburg' },
            { titel: 'Workshop', kalender: 'Tango Regensburg' },
        ]);
    });

    it('Invariante 2: die Kalenderfarbe steht nur im Präsentationsgraphen', async () => {
        const ctx = await createContext();
        await crud.createCalendar(ctx, { name: 'Tango', url: 'https://example.org/t.ics', color: '#be185d' });
        expect(await graphValues(ctx, ctx.iri.graph('workspace'))).not.toContain(`${SCHEMA.color}=#be185d`);
        expect(await graphValues(ctx, ctx.iri.graph('presentation'))).toContain(`${SCHEMA.color}=#be185d`);
    });
});

describe('Chats als Graph-Bürger (M15)', () => {
    it('Unterhaltungen und Nachrichten liegen im Store; die Datei ist Projektion', async () => {
        const ctx = await createContext();
        const conversation = await crud.createConversation(ctx, 'Erste Frage');
        await crud.addMessage(ctx, conversation.id, 'user', 'Welche Aufgaben stehen an?');
        await crud.addMessage(ctx, conversation.id, 'assistant', 'Zwei offene.', [{ type: 'TaskList' }]);

        const stored = await crud.getConversation(ctx, conversation.id);
        expect(stored?.messages.map(m => m.role)).toEqual(['user', 'assistant']);
        expect(stored?.messages[1].uiComponents).toEqual([{ type: 'TaskList' }]);
        // Titel aus der ersten Nutzer-Nachricht (Verhalten der Altfassung).
        expect(stored?.title).toBe('Welche Aufgaben stehen an?');

        const projected: { conversations: Array<{ id: string }>; activeId: string | null } = JSON.parse(
            await fs.readFile(ctx.paths.conversationsFile, 'utf-8'));
        expect(projected.conversations.map(c => c.id)).toEqual([conversation.id]);
        expect(projected.activeId).toBe(conversation.id);

        await fs.writeFile(ctx.paths.conversationsFile, JSON.stringify({ conversations: [], activeId: null }), 'utf-8');
        expect((await crud.listConversations(ctx)).length).toBe(1);
    });

    it('SPARQL beantwortet: welche Nachrichten hat eine Unterhaltung, in welcher Rolle', async () => {
        const ctx = await createContext();
        const conversation = await crud.createConversation(ctx, 'Dialog');
        await crud.addMessage(ctx, conversation.id, 'user', 'Frage');
        await crud.addMessage(ctx, conversation.id, 'assistant', 'Antwort');

        const rows = await selectAll(ctx, `
            SELECT ?rolle ?text WHERE {
                GRAPH <${ctx.iri.graph('workspace')}> {
                    ?dialog a schema:Conversation ; schema:hasPart ?nachricht .
                    ?nachricht a schema:Message ; ow:messageRole ?rolle ; schema:text ?text .
                }
            } ORDER BY ?text
        `);
        expect(rows).toEqual([
            { rolle: 'assistant', text: 'Antwort' },
            { rolle: 'user', text: 'Frage' },
        ]);
    });

    it('Invariante 2: A2UI-Oberfläche und die offene Unterhaltung stehen nur im Präsentationsgraphen', async () => {
        const ctx = await createContext();
        const conversation = await crud.createConversation(ctx, 'Dialog');
        await crud.addMessage(ctx, conversation.id, 'assistant', 'Antwort', [{ type: 'TaskList' }]);

        const workspace = await graphValues(ctx, ctx.iri.graph('workspace'));
        expect(workspace.some(v => v.startsWith(`${OW.generativeSurface}=`))).toBe(false);
        expect(workspace.some(v => v.startsWith(`${OW.selected}=`))).toBe(false);

        const presentation = await graphValues(ctx, ctx.iri.graph('presentation'));
        expect(presentation).toContain(`${OW.generativeSurface}=[{"type":"TaskList"}]`);
        expect(presentation).toContain(`${OW.selected}=true`);
    });

    it('Löschen der offenen Unterhaltung rückt die nächste nach', async () => {
        const ctx = await createContext();
        const erste = await crud.createConversation(ctx, 'Erste');
        const zweite = await crud.createConversation(ctx, 'Zweite');
        expect(await crud.getActiveConversationId(ctx)).toBe(zweite.id);
        expect(await crud.deleteConversation(ctx, zweite.id)).toBe(true);
        expect(await crud.getActiveConversationId(ctx)).toBe(erste.id);

        await crud.clearConversations(ctx);
        expect(await crud.listConversations(ctx)).toEqual([]);
        expect(await crud.getActiveConversationId(ctx)).toBeNull();
    });
});

describe('Bootstrap: der Altbestand aus data/ wird einmalig übernommen', () => {
    it('liest Kalender, Termine und Chats aus den Dateien — Termine ohne Kalender fallen weg', async () => {
        const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ow-citizens-boot-'));
        const paths = defaultWorkspaceFilePaths(baseDir);
        await fs.mkdir(path.dirname(paths.calendarProvidersFile), { recursive: true });
        await fs.mkdir(path.dirname(paths.conversationsFile), { recursive: true });
        await fs.writeFile(paths.calendarProvidersFile, JSON.stringify({
            providers: [{ id: 'cal-1', name: 'Tango', url: 'https://example.org/t.ics', color: '#be185d', enabled: true, lastSync: null }],
        }));
        await fs.writeFile(paths.calendarEventsFile, JSON.stringify({
            events: [
                ...EVENTS('cal-1'),
                { id: 'evt-waise', providerId: 'cal-weg', title: 'Ohne Quelle', startDate: '2026-01-01T00:00:00.000Z', endDate: '2026-01-01T01:00:00.000Z', allDay: false },
            ],
        }));
        await fs.writeFile(paths.conversationsFile, JSON.stringify({
            conversations: [{
                id: 'conv-1', title: 'Alt', messages: [
                    { id: 'msg-1', role: 'user', content: 'hi', timestamp: '2026-01-01T00:00:00.000Z' },
                ],
                createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:01.000Z',
            }],
            activeId: 'conv-1',
        }));

        const input = await readWorkspaceFiles(paths);
        expect(input.calendars.map(c => c.id)).toEqual(['cal-1']);
        expect(input.events.map(e => e.id)).toEqual(['evt-1', 'evt-2']);
        expect(input.conversations[0].messages.length).toBe(1);
        expect(input.activeConversationId).toBe('conv-1');
    });
});

describe('Selbstmodell: die neuen Entitätstypen hängen an ihren Modulen', () => {
    it('Kalender, Assistent und AI-Hub weisen aus, was sie verwalten', () => {
        const typesOf = (id: string) => APP_MODULES.find(module => module.id === id)?.entityTypes ?? [];
        expect(typesOf('calendar')).toEqual([SCHEMA.Event, SCHEMA.DataFeed]);
        expect(typesOf('assistant')).toEqual([SCHEMA.Conversation, SCHEMA.Message]);
        expect(typesOf('ai')).toEqual([OW.InferenceProvider, OW.Model]);
    });
});
