/**
 * Fragen an ein Kausalmodell (`ow:Estimand`, CAUSAL_LAYER_SPEC §5.2, C4).
 *
 * GET  /api/graph/causal/estimands → alle Fragen
 * POST /api/graph/causal/estimands → eine Frage anlegen
 *
 * Die Frage ist eine Setzung des Menschen und liegt deshalb in
 * `graph/meta` — dasselbe Muster wie Retrieval-Profile. Die ANTWORTEN
 * entstehen im Lauf (`/api/graph/causal/studies`) und leben im
 * Inferenz-Graphen, wo sie bei jedem Lauf ersetzt werden (Invariante C4).
 */

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getRequestGraph } from '@/lib/graph/server/context';
import { persistServerGraphSnapshot } from '@/lib/graph/server/instance';
import { createEstimand, listEstimands } from '@/lib/graph/causal/estimand';
import { readCausalModel } from '@/lib/graph/causal/model';
import { ESTIMATOR_CHOICES } from '@/lib/graph/causal/study';

const createSchema = z.object({
    id: z.string().min(1).max(64),
    name: z.string().min(1).max(200),
    modelId: z.string().min(1).max(64),
    treatment: z.string().min(1).max(500),
    outcome: z.string().min(1).max(500),
    estimator: z.enum(ESTIMATOR_CHOICES).default('auto'),
    seed: z.number().int().min(0).max(2 ** 31).default(42),
    description: z.string().max(2000).optional(),
    controlOutcome: z.string().min(1).max(500).optional(),
    interventionAt: z.string().max(40).optional(),
    windowFrom: z.string().max(40).optional(),
    windowThrough: z.string().max(40).optional(),
    // Rechenraster in Sekunden. Die Obergrenze ist ein Jahr; die
    // inhaltliche Grenze (nie feiner als die gröbste beteiligte Reihe)
    // kennt erst das Panel, weil sie an den Daten hängt und nicht an der
    // Frage — sie wird dort begründet abgelehnt, nicht hier geraten.
    intervalSeconds: z.number().int().min(1).max(366 * 86400).optional(),
}).strict();

export async function GET(): Promise<Response> {
    try {
        const { store, iri } = await getRequestGraph();
        return NextResponse.json({ estimands: await listEstimands({ store, iri }) });
    } catch (error) {
        console.error('Causal Estimands Error:', error);
        return NextResponse.json({ error: 'Fragen konnten nicht gelesen werden.' }, { status: 500 });
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
        // Eine Frage ohne Modell wäre eine Frage ohne Annahme. Und lesen
        // muss der Fragende das Modell dürfen — sonst verriete schon die
        // Existenz der Frage, dass es das Modell gibt (§17.3).
        const modelGraph = iri.causalGraph(parsed.modelId);
        if (!grant.readableGraphs.includes(modelGraph)) {
            return NextResponse.json({ error: 'Kausalmodell nicht gefunden.' }, { status: 404 });
        }
        const model = await readCausalModel(handle, { modelId: parsed.modelId, graph: modelGraph });
        if (!model) {
            return NextResponse.json({ error: 'Kausalmodell nicht gefunden.' }, { status: 404 });
        }
        const known = new Set(model.variables.map(variable => variable.iri));
        for (const [label, value] of [
            ['Die Behandlung', parsed.treatment],
            ['Die Wirkung', parsed.outcome],
            ['Die Kontroll-Wirkung', parsed.controlOutcome],
        ] as const) {
            if (value !== undefined && !known.has(value)) {
                return NextResponse.json(
                    { error: `${label} steht nicht im Modell „${model.name}".` },
                    { status: 400 },
                );
            }
        }
        const estimand = await createEstimand(handle, parsed);
        await persistServerGraphSnapshot();
        return NextResponse.json({ estimand }, { status: 201 });
    } catch (error) {
        const message = error instanceof Error ? error.message : 'Frage konnte nicht angelegt werden.';
        const status = message.includes('existiert bereits') ? 409
            : /Ungültige|braucht|dieselbe Größe|Zeitpunkt|Fenster|Startwert|Unbekanntes|Rechenraster/
                .test(message) ? 400
            : 500;
        if (status === 500) console.error('Causal Estimand Create Error:', error);
        return NextResponse.json({ error: message }, { status });
    }
}
