/**
 * Ein Kausalmodell (CAUSAL_LAYER_SPEC §5, C0/C1).
 *
 * GET    /api/graph/causal/<id> → Modell samt Variablen und Kanten
 * PATCH  /api/graph/causal/<id> → genau eine Strukturänderung (C1) —
 *                                 derselbe Schreibweg für DAG-Editor und
 *                                 API, mit Revision und Azyklizitäts-Prüfung
 * DELETE /api/graph/causal/<id> → Modell entfernen (der Named Graph IST
 *                                 die Modellgrenze, also fällt alles
 *                                 zusammen mit ihm)
 *
 * Der Bestand an Beobachtungen bleibt unberührt: Messreihen gehören
 * keinem Modell, sondern der Installation (Invariante C3). Ein gelöschtes
 * Modell ist eine verworfene Annahme, kein verworfener Datenbestand.
 */

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getRequestGraph, getUserGraph } from '@/lib/graph/server/context';
import { persistServerGraphSnapshot } from '@/lib/graph/server/instance';
import { deleteCausalModel, readCausalModel } from '@/lib/graph/causal/model';
import { applyStructureOperation, CausalEditError, type StructureOperation } from '@/lib/graph/causal/edit';
import { EDGE_CLASSES, EVIDENCE_LEVELS } from '@/lib/graph/causal/types';
import { ShaclViolationError } from '@/lib/graph/reasoning/shacl';

type RouteContext = { params: Promise<{ id: string }> };

const operationSchema = z.discriminatedUnion('op', [
    z.object({
        op: z.literal('add-variable'),
        iri: z.string().min(1).max(500).optional(),
        name: z.string().min(1).max(200).optional(),
    }),
    z.object({ op: z.literal('remove-variable'), iri: z.string().min(1).max(500) }),
    z.object({
        op: z.literal('add-edge'),
        from: z.string().min(1).max(500),
        to: z.string().min(1).max(500),
        edgeClass: z.enum(EDGE_CLASSES),
        evidenceLevel: z.enum(EVIDENCE_LEVELS).optional(),
        temporalLag: z.string().max(40).optional(),
    }),
    z.object({ op: z.literal('remove-edge'), from: z.string().min(1).max(500), to: z.string().min(1).max(500) }),
    z.object({
        op: z.literal('describe'),
        name: z.string().min(1).max(200).optional(),
        description: z.string().max(2000).optional(),
    }),
]);

export async function GET(_request: Request, context: RouteContext): Promise<Response> {
    const { id } = await context.params;
    try {
        const handle = await getUserGraph();
        const model = await readCausalModel(handle, { modelId: id, graph: handle.iri.causalGraph(id) });
        if (!model) {
            return NextResponse.json({ error: 'Kausalmodell nicht gefunden.' }, { status: 404 });
        }
        return NextResponse.json({ model });
    } catch (error) {
        console.error('Causal Model Read Error:', error);
        return NextResponse.json({ error: 'Kausalmodell konnte nicht gelesen werden.' }, { status: 500 });
    }
}

/**
 * Strukturänderung. Der Schreibweg ist derselbe wie der des SPARQL-Editors
 * in dem Sinn, der zählt: Ziel ist der Named Graph des Modells, und die
 * Erlaubnis kommt aus `graph/acl` bzw. — für einen Graphen, den es noch
 * nicht gibt — aus dem Scope-Muster des eigenen Kausal-Namensraums (C1).
 */
export async function PATCH(request: Request, context: RouteContext): Promise<Response> {
    const { id } = await context.params;
    let operation: StructureOperation;
    try {
        operation = operationSchema.parse(await request.json());
    } catch (error) {
        const message = error instanceof z.ZodError
            ? error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; ')
            : 'Ungültiger Request-Body.';
        return NextResponse.json({ error: message }, { status: 400 });
    }

    try {
        const { store, iri, identity, grant } = await getRequestGraph();
        const graph = iri.causalGraph(id);
        // Der Graph existiert (sonst gäbe es das Modell nicht), also
        // entscheidet allein die ACL — kein Scope-Muster macht hier etwas auf.
        if (!(grant.writableGraphs ?? []).includes(graph)) {
            return NextResponse.json({ error: 'Kausalmodell nicht gefunden.' }, { status: 404 });
        }
        const result = await applyStructureOperation({ store, iri }, id, operation, {
            ...(identity.userId ? { actor: iri.principal('user', identity.userId) } : {}),
        });
        await persistServerGraphSnapshot();
        return NextResponse.json(result);
    } catch (error) {
        if (error instanceof CausalEditError) {
            return NextResponse.json({ error: error.message }, { status: error.status });
        }
        if (error instanceof ShaclViolationError) {
            return NextResponse.json(
                { error: 'Die Änderung verletzt die Shapes des Kausal-Layers.', details: error.message },
                { status: 422 },
            );
        }
        const message = error instanceof Error ? error.message : 'Änderung fehlgeschlagen.';
        const status = message.includes('Ungültige') ? 400 : 500;
        if (status === 500) console.error('Causal Model Patch Error:', error);
        return NextResponse.json({ error: message }, { status });
    }
}

export async function DELETE(_request: Request, context: RouteContext): Promise<Response> {
    const { id } = await context.params;
    try {
        const handle = await getUserGraph();
        const removed = await deleteCausalModel(handle, id);
        if (!removed) {
            return NextResponse.json({ error: 'Kausalmodell nicht gefunden.' }, { status: 404 });
        }
        await persistServerGraphSnapshot();
        return NextResponse.json({
            deleted: true,
            message: 'Modell entfernt. Erfasste Beobachtungen bleiben erhalten.',
        });
    } catch (error) {
        const message = error instanceof Error ? error.message : 'Kausalmodell konnte nicht entfernt werden.';
        const status = message.includes('Ungültige') ? 400 : 500;
        if (status === 500) console.error('Causal Model Delete Error:', error);
        return NextResponse.json({ error: message }, { status });
    }
}
