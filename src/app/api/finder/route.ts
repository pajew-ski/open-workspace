/**
 * Global Finder (`workspace_finder`) — seit M8 auf den Graphen umgestellt
 * (SPEC §7.7): Ergebnisse kommen aus dem Volltext-Index über alle
 * Literale des Wissens-Datasets (Fuzzy-Verhalten inklusive —
 * Tippfehler-Toleranz lebt im Index, nicht mehr in einer eigenen
 * Titel-Schleife). Seit M15 gilt das auch für Termine und Chats: sie
 * sind Graph-Bürger und brauchen keinen Sonderweg an ihren Storages
 * vorbei mehr — die Zugriffsgrenzen (§17.4) gelten damit auch für sie.
 */

import { NextResponse } from 'next/server';
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

        // Alle Graph-Bürger über den Volltext-Index (Dataset = Wissens-Graphen).
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

        results.sort((a, b) => b.matchScore - a.matchScore);
        return NextResponse.json({ results: results.slice(0, 50) });
    } catch (error) {
        console.error('Finder Error:', error);
        return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
    }
}
