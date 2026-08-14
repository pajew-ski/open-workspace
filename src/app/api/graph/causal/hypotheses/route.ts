/**
 * Vorschläge: der Lauf der neurosymbolischen Schleife
 * (CAUSAL_LAYER_SPEC §8, Meilenstein C6).
 *
 * GET  /api/graph/causal/hypotheses → Vorschläge samt Quellenvergleich
 * POST /api/graph/causal/hypotheses → Quellen befragen und filtern
 *
 * Ein Lauf ersetzt die Vorschläge **je Quelle** (§6.2-Muster): Wer nur
 * das Sprachmodell laufen lässt, verliert die topologischen Vorschläge
 * nicht. Geschrieben wird ausschließlich nach
 * `graph/<u>/causal-hypotheses` — nie in ein Modell. Der Weg dorthin
 * führt über das Übernehmen, und das prüft die Filter noch einmal
 * (`/api/graph/causal/hypotheses/[id]`).
 */

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getRequestGraph } from '@/lib/graph/server/context';
import { persistServerGraphSnapshot } from '@/lib/graph/server/instance';
import { mayCreateGraph, WRITE_SCOPE_HINT } from '@/lib/graph/authz/grant';
import { hypothesesGraph, readHypotheses } from '@/lib/graph/causal/hypothesis';
import { runProposalSources } from '@/lib/graph/causal/propose.server';
import { PROPOSAL_SOURCES } from '@/lib/graph/causal/propose';
import { compareStructureSources } from '@/lib/graph/causal/compare';
import { readCausalModel } from '@/lib/graph/causal/model';
import { createNodeRuntimeAdapter } from '@/lib/platform/runtime/server';

/** Drei Quellen, dazu die Filterstrecke — das dauert, aber nicht ewig. */
export const maxDuration = 120;

const runSchema = z.object({
    modelId: z.string().min(1).max(64),
    sources: z.array(z.enum(PROPOSAL_SOURCES)).min(1).optional(),
}).strict();

export async function GET(): Promise<Response> {
    try {
        const { store, iri, grant } = await getRequestGraph();
        const handle = { store, iri };
        const hypotheses = await readHypotheses(handle, { allowedGraphs: grant.readableGraphs });
        return NextResponse.json({ hypotheses });
    } catch (error) {
        console.error('Causal Hypotheses Error:', error);
        return NextResponse.json({ error: 'Vorschläge konnten nicht gelesen werden.' }, { status: 500 });
    }
}

export async function POST(request: Request): Promise<Response> {
    let parsed: z.infer<typeof runSchema>;
    try {
        parsed = runSchema.parse(await request.json());
    } catch (error) {
        const message = error instanceof z.ZodError
            ? error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; ')
            : 'Ungültiger Request-Body.';
        return NextResponse.json({ error: message }, { status: 400 });
    }

    try {
        // Invariante C9: Die Filter sind Graphalgorithmik und brauchen den
        // Tier-1-Kern. Wo der nicht läuft, wird auch nicht vorgeschlagen.
        if (createNodeRuntimeAdapter().capabilities.causalTier === 'none') {
            return NextResponse.json(
                { error: 'Diese Runtime prüft keine kausalen Vorschläge.' },
                { status: 501 },
            );
        }
        const { store, iri, grant } = await getRequestGraph();
        const handle = { store, iri };

        const graph = hypothesesGraph(iri);
        const existing = (await store.graphs()).map(g => g.value);
        const permitted = existing.includes(graph)
            ? (grant.writableGraphs ?? []).includes(graph)
            : mayCreateGraph(grant, iri.instanceBase, graph);
        if (!permitted) {
            return NextResponse.json(
                { error: 'Kein Schreibrecht für Vorschläge in deinem Namensraum.', details: WRITE_SCOPE_HINT },
                { status: 403 },
            );
        }

        const summary = await runProposalSources(handle, parsed.modelId, {
            ...(parsed.sources ? { sources: parsed.sources } : {}),
            allowedGraphs: grant.readableGraphs,
        });
        // Vorschläge sind behauptet und persistiert — anders als eine
        // Studie überleben sie den Neustart. Ein Lauf, der niemanden
        // erreicht, weil er nicht gesichert wurde, wäre verlorene
        // Rechenzeit und ein verlorener Sprachmodell-Aufruf.
        await persistServerGraphSnapshot();

        const hypotheses = await readHypotheses(handle, {
            allowedGraphs: grant.readableGraphs,
            modelId: parsed.modelId,
        });
        const model = await readCausalModel(handle, {
            modelId: parsed.modelId,
            graph: iri.causalGraph(parsed.modelId),
        }, { withStudies: false });
        const names = new Map((model?.variables ?? []).map(variable => [variable.iri, variable.name]));
        for (const hypothesis of hypotheses) {
            names.set(hypothesis.from, hypothesis.fromName);
            names.set(hypothesis.to, hypothesis.toName);
        }
        return NextResponse.json({
            ...summary,
            hypotheses,
            comparison: compareStructureSources(
                hypotheses,
                model?.edges ?? [],
                node => names.get(node) ?? node,
            ),
        });
    } catch (error) {
        const message = error instanceof Error ? error.message : 'Der Vorschlagslauf ist fehlgeschlagen.';
        const status = message.includes('gibt es nicht') ? 404 : 500;
        if (status === 500) console.error('Causal Proposal Run Error:', error);
        return NextResponse.json({ error: message }, { status });
    }
}
