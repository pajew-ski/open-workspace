/**
 * Multi-Hop-Retrieval (SPEC §7.5, M8) — erstklassige API.
 *
 * POST /api/graph/retrieve
 * Body: RetrievalRequest (partiell, Defaults nach §7.5) plus optional
 * `profile` (ID eines gespeicherten ow:RetrievalProfile — dessen
 * Parameter bilden die Basis, der Body überschreibt feldweise).
 *
 * Antwort: RetrievalResult mit Pflicht-`explain` und -`provenance`.
 * Das Dataset ist IMMER das erlaubte (§17-Vorstufe) — die Klammer greift
 * vor der Expansion, nicht als Nachfilter.
 */

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getRequestGraph } from '@/lib/graph/server/context';
import { retrievalDataset, retrieve, type RetrievalRequestInput } from '@/lib/graph/search/retrieval';
import { getFulltextIndex, getVectorIndex } from '@/lib/graph/search/cache';
import { getRetrievalProfile } from '@/lib/graph/search/profiles';
import { resolveEmbeddingProvider } from '@/lib/ai/embeddings.server';
import type { RetrievalDeps } from '@/lib/graph/search/retrieval';

const typeFilterSchema = z.object({
    include: z.array(z.string()).optional(),
    exclude: z.array(z.string()).optional(),
}).strict();

/**
 * Kausale Erdung (CAUSAL_LAYER_SPEC §9, C2). `paths` braucht beide Enden —
 * das wird hier abgewiesen statt später still zu einem leeren Ergebnis zu
 * führen; alle anderen Modi brauchen mindestens eines von beiden.
 */
const causalSchema = z.object({
    mode: z.enum(['ancestors', 'descendants', 'paths', 'markov-blanket']),
    treatment: z.string().max(2000).optional(),
    outcome: z.string().max(2000).optional(),
    model: z.string().max(2000).optional(),
    blockedBy: z.array(z.string().max(2000)).max(50).optional(),
    minEvidence: z.enum(['hypothesis', 'estimated', 'refuted-clean']).optional(),
}).strict().refine(
    value => value.mode !== 'paths' || (Boolean(value.treatment) && Boolean(value.outcome)),
    { message: 'Modus „paths" braucht treatment UND outcome.' },
).refine(
    value => Boolean(value.treatment) || Boolean(value.outcome),
    { message: 'Ohne treatment oder outcome gibt es keinen Bezugspunkt im Kausalmodell.' },
);

const requestSchema = z.object({
    profile: z.string().optional(),
    causal: causalSchema.optional(),
    seeds: z.object({
        iri: z.array(z.string()).max(100).optional(),
        text: z.string().max(2000).optional(),
        vector: z.array(z.number()).max(8192).optional(),
    }).strict().optional(),
    maxHops: z.number().int().min(1).max(4).optional(),
    maxNodes: z.number().int().min(1).max(500).optional(),
    edgeTypes: typeFilterSchema.optional(),
    nodeTypes: typeFilterSchema.optional(),
    direction: z.enum(['out', 'in', 'both']).optional(),
    graphs: z.array(z.string()).max(50).optional(),
    decay: z.number().min(0).max(1).optional(),
    maxDegree: z.number().int().min(1).max(10_000).optional(),
    includeInferred: z.boolean().optional(),
    format: z.enum(['subgraph', 'context', 'both']).optional(),
    tokenBudget: z.number().int().min(50).max(100_000).optional(),
    seedLimit: z.number().int().min(1).max(100).optional(),
}).strict();

export async function POST(request: Request): Promise<Response> {
    let parsed: z.infer<typeof requestSchema>;
    try {
        parsed = requestSchema.parse(await request.json());
    } catch (error) {
        const message = error instanceof z.ZodError
            ? error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; ')
            : 'Ungültiger Request-Body.';
        return NextResponse.json({ error: message }, { status: 400 });
    }

    try {
        const { store, iri, grant } = await getRequestGraph();
        const handle = { store, iri };

        const { profile: profileId, ...overrides } = parsed;
        let input: RetrievalRequestInput = overrides;
        if (profileId) {
            const profile = await getRetrievalProfile(handle, profileId);
            if (!profile) {
                return NextResponse.json({ error: `Retrieval-Profil "${profileId}" existiert nicht.` }, { status: 404 });
            }
            input = { ...profile.config, ...overrides };
        }

        const dataset = await retrievalDataset(handle, {
            graphs: input.graphs,
            includeInferred: input.includeInferred ?? false,
            allowedGraphs: grant.readableGraphs,
        });
        const deps: RetrievalDeps = {
            fulltext: await getFulltextIndex(handle, dataset),
        };
        const needsVector = Boolean(input.seeds?.vector?.length) || Boolean(input.seeds?.text);
        if (needsVector) {
            const embedding = await resolveEmbeddingProvider();
            if (embedding.provider) {
                const provider = embedding.provider;
                deps.vector = await getVectorIndex(handle, dataset, provider);
                deps.embedQuery = async text => (await provider.embed([text]))[0];
            } else if (input.seeds?.vector?.length) {
                // Roh-Vektor ohne Index: ehrlicher Fehler statt leerem Ergebnis.
                return NextResponse.json(
                    { error: `Vektor-Seeding nicht verfügbar: ${embedding.availability.reason}` },
                    { status: 400 },
                );
            }
        }

        const result = await retrieve(handle, input, deps, { allowedGraphs: grant.readableGraphs });
        return NextResponse.json(result);
    } catch (error) {
        console.error('Graph Retrieve Error:', error);
        return NextResponse.json({ error: 'Retrieval fehlgeschlagen.' }, { status: 500 });
    }
}
