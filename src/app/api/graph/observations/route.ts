/**
 * Beobachtungsgrößen (CAUSAL_LAYER_SPEC §5/§6).
 *
 * GET  /api/graph/observations   → erfasste Größen, Kandidaten, Zeitgeber
 * POST /api/graph/observations   → eine Quelle zur Erfassung aufnehmen
 */

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { persistServerGraphSnapshot } from '@/lib/graph/server/instance';
import { getRequestGraph } from '@/lib/graph/server/context';
import { createVariable, listVariables } from '@/lib/graph/observations/variables';
import { findCandidate, listCaptureCandidates } from '@/lib/graph/observations/candidates';
import { captureScheduleStatus } from '@/lib/graph/observations/schedule.server';
import { variableIdFor } from '@/lib/graph/connectors/home-assistant/structure';
import { ALLOWED_AGGREGATIONS } from '@/lib/graph/observations/types';

const createSchema = z.object({
    /** Quellschlüssel (HA entity_id) — muss im Graphen bekannt sein. */
    source: z.string().min(1).max(255),
    name: z.string().min(1).max(200).optional(),
    aggregation: z.enum(['last', 'mean', 'min', 'max', 'sum']).optional(),
    intervalSeconds: z.number().int().min(10).max(86_400).default(300),
    retentionDays: z.number().int().min(0).max(36_500).default(0),
}).strict();

/** Sinnvolle Verdichtung je Skalenniveau, wenn der Aufrufer keine nennt. */
function defaultAggregation(kind: 'numeric' | 'binary' | 'categorical'): 'last' | 'mean' {
    return kind === 'numeric' ? 'mean' : 'last';
}

export async function GET(): Promise<Response> {
    try {
        const { store, iri, grant } = await getRequestGraph();
        const handle = { store, iri };
        const variables = await listVariables(handle);
        const captured = new Map(variables.map(variable => [variable.source, variable.id]));
        const candidates = (await listCaptureCandidates(store, iri, { allowedGraphs: grant.readableGraphs }))
            .map(candidate => ({
                ...candidate,
                ...(captured.has(candidate.source) ? { variableId: captured.get(candidate.source) } : {}),
            }));
        return NextResponse.json({
            variables,
            candidates,
            schedule: captureScheduleStatus(),
            allowedAggregations: ALLOWED_AGGREGATIONS,
        });
    } catch (error) {
        console.error('Observations Error:', error);
        return NextResponse.json({ error: 'Beobachtungsgrößen konnten nicht gelesen werden.' }, { status: 500 });
    }
}

export async function POST(request: Request): Promise<Response> {
    let parsed: z.infer<typeof createSchema>;
    try {
        parsed = createSchema.parse(await request.json());
    } catch (error) {
        const message = error instanceof z.ZodError
            ? error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; ')
            : 'Ungültiger Request-Body.';
        return NextResponse.json({ error: message }, { status: 400 });
    }

    try {
        const { store, iri, grant } = await getRequestGraph();
        const handle = { store, iri };
        // Die Quelle muss im Graphen stehen. Sonst entstünde eine Variable
        // ohne Skalenniveau und ohne Ort — und damit eine Reihe, deren
        // Verdichtung niemand prüfen kann.
        const candidate = await findCandidate(store, iri, parsed.source, { allowedGraphs: grant.readableGraphs });
        if (!candidate) {
            return NextResponse.json(
                {
                    error: `Die Quelle "${parsed.source}" ist im Graphen nicht bekannt.`,
                    details: 'Synchronisiere zuerst den Home-Assistant-Connector unter Graph → Quellen.',
                },
                { status: 404 },
            );
        }
        const variable = await createVariable(handle, {
            id: variableIdFor(parsed.source),
            name: parsed.name ?? candidate.name,
            sourceKind: 'home-assistant',
            source: candidate.source,
            kind: candidate.kind,
            aggregation: parsed.aggregation ?? defaultAggregation(candidate.kind),
            intervalSeconds: parsed.intervalSeconds,
            ...(candidate.unit ? { unit: candidate.unit } : {}),
            ...(candidate.placeIri ? { placeIri: candidate.placeIri } : {}),
            sensorIri: candidate.iri,
            retentionDays: parsed.retentionDays,
        });
        await persistServerGraphSnapshot();
        return NextResponse.json({ variable }, { status: 201 });
    } catch (error) {
        const message = error instanceof Error ? error.message : 'Beobachtungsgröße konnte nicht angelegt werden.';
        const status = message.includes('existiert bereits') ? 409
            : message.includes('nicht zulässig') || message.includes('Ungültige') ? 400
            : 500;
        if (status === 500) console.error('Observation Create Error:', error);
        return NextResponse.json({ error: message }, { status });
    }
}
