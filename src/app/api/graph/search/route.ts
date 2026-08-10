/**
 * Volltext-/Vektorsuche über den Graphen (SPEC §7.7, M8) — die „eigene
 * API" der Suche. Liefert Kandidaten-IRIs mit Score, Label und Provenienz-
 * Graphen; das Seeding der Retrieval-Pipeline nutzt denselben Index.
 *
 * GET /api/graph/search?q=…&limit=…&vector=1
 *
 * Der Index wird über das erlaubte Wissens-Dataset gebaut (workspace,
 * public, import/*, meta — §17.4: scope-partitioniert). Embeddings sind
 * optional: ohne konfigurierten Provider meldet die Antwort das ehrlich
 * unter `embeddings.reason`, statt leere Vektor-Treffer vorzutäuschen.
 */

import { NextResponse } from 'next/server';
import { getRequestGraph } from '@/lib/graph/server/context';
import { retrievalDataset } from '@/lib/graph/search/retrieval';
import { getFulltextIndex, getVectorIndex } from '@/lib/graph/search/cache';
import { resolveEmbeddingProvider } from '@/lib/ai/embeddings.server';

export async function GET(request: Request): Promise<Response> {
    const { searchParams } = new URL(request.url);
    const query = searchParams.get('q')?.trim() ?? '';
    const limitRaw = Number.parseInt(searchParams.get('limit') ?? '20', 10);
    const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 100) : 20;
    const wantVector = searchParams.get('vector') === '1';

    if (query === '') {
        return NextResponse.json({ error: 'Parameter "q" (Suchtext) fehlt.' }, { status: 400 });
    }

    try {
        const { store, iri, grant } = await getRequestGraph();
        const handle = { store, iri };
        // §17.4: Der Index wird über GENAU das erlaubte Dataset gebaut —
        // ein globaler Index mit gefilterter Trefferliste verriete über
        // Scores und Nachbarschaft trotzdem Inhalte.
        const dataset = await retrievalDataset(handle, {
            includeInferred: false,
            allowedGraphs: grant.readableGraphs,
        });
        const index = await getFulltextIndex(handle, dataset);
        const hits = index.search(query, { limit, graphs: dataset });

        const embedding = await resolveEmbeddingProvider();
        let vectorHits: Array<{ iri: string; similarity: number; graph: string }> = [];
        if (wantVector && embedding.provider) {
            const vectorIndex = await getVectorIndex(handle, dataset, embedding.provider);
            const [queryVector] = await embedding.provider.embed([query]);
            vectorHits = vectorIndex.search(queryVector, { limit, graphs: dataset });
        }

        return NextResponse.json({
            query,
            hits: hits.map(hit => ({
                iri: hit.iri,
                score: hit.score,
                label: hit.label ?? null,
                labelMatch: hit.labelMatch,
                graphs: hit.graphs,
                matches: hit.matches,
            })),
            vectorHits,
            embeddings: embedding.availability,
            indexedLiterals: index.size,
        });
    } catch (error) {
        console.error('Graph Search Error:', error);
        return NextResponse.json({ error: 'Suche fehlgeschlagen.' }, { status: 500 });
    }
}
