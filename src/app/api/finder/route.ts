/**
 * Global Finder (`workspace_finder`) — seit M8 auf den Graphen umgestellt
 * (SPEC §7.7): Dokumente, Aufgaben und Projekte kommen aus dem
 * Volltext-Index über alle Literale des Wissens-Datasets (Fuzzy-Verhalten
 * inklusive — Tippfehler-Toleranz lebt im Index, nicht mehr in einer
 * eigenen Titel-Schleife). Chats und Termine sind noch keine Graph-Bürger
 * (M9+) und kommen ehrlich weiter aus ihren Storages.
 */

import { NextResponse } from 'next/server';
import { listConversations } from '@/lib/storage/chat';
import { getEvents } from '@/lib/storage/calendar';
import { getRequestGraph } from '@/lib/graph/server/context';
import { workspaceFromStore } from '@/lib/graph/workspace/read';
import { retrievalDataset } from '@/lib/graph/search/retrieval';
import { getFulltextIndex } from '@/lib/graph/search/cache';
import { searchWorkspaceGraph } from '@/lib/graph/search/finder';

interface FinderResult {
    type: string;
    id: string;
    title: string;
    subtitle: string;
    url: string;
    matchScore: number;
}

/** Titel-Vergleich der Nicht-Graph-Quellen (Chats/Termine, wie bisher). */
function titleMatches(text: string | undefined, query: string): boolean {
    return !!text && text.toLowerCase().includes(query);
}

export async function GET(request: Request) {
    const { searchParams } = new URL(request.url);
    const rawQuery = searchParams.get('q') ?? '';
    const query = rawQuery.toLowerCase().trim();
    const typeFilter = searchParams.get('type');

    if (!query) {
        return NextResponse.json({ results: [] });
    }

    try {
        const { store, iri, grant } = await getRequestGraph();
        const handle = { store, iri };
        const results: FinderResult[] = [];

        // Graph-Bürger über den Volltext-Index (Dataset = Wissens-Graphen).
        if (!typeFilter || ['doc', 'note', 'task', 'project'].includes(typeFilter)) {
            const dataset = await retrievalDataset(handle, {
                includeInferred: false,
                allowedGraphs: grant.readableGraphs,
            });
            const index = await getFulltextIndex(handle, dataset);
            const workspace = await workspaceFromStore(handle.store, handle.iri);
            for (const hit of searchWorkspaceGraph(index, handle.iri, workspace, rawQuery, typeFilter)) {
                results.push({
                    type: hit.type,
                    id: hit.id,
                    title: hit.title,
                    subtitle: hit.subtitle,
                    url: hit.url,
                    matchScore: hit.matchScore,
                });
            }
        }

        if (!typeFilter || typeFilter === 'chat') {
            const conversations = await listConversations().catch(() => []);
            for (const chat of conversations) {
                if (titleMatches(chat.title, query)) {
                    results.push({
                        type: 'chat',
                        id: chat.id,
                        title: chat.title,
                        subtitle: 'Konversation',
                        url: `/communication?id=${chat.id}`,
                        matchScore: 2,
                    });
                }
            }
        }

        if (!typeFilter || typeFilter === 'calendar') {
            const events = await getEvents().catch(() => []);
            for (const event of events) {
                if (titleMatches(event.title, query) || titleMatches(event.description, query)) {
                    results.push({
                        type: 'calendar',
                        id: event.id,
                        title: event.title,
                        subtitle: `Termin • ${new Date(event.startDate).toLocaleDateString('de-DE')}`,
                        url: `/calendar?date=${event.startDate.split('T')[0]}`,
                        matchScore: event.title.toLowerCase().startsWith(query) ? 3 : 2,
                    });
                }
            }
        }

        results.sort((a, b) => b.matchScore - a.matchScore);
        return NextResponse.json({ results: results.slice(0, 50) });
    } catch (error) {
        console.error('Finder Error:', error);
        return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
    }
}
