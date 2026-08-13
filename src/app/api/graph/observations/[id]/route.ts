/**
 * Eine Beobachtungsgröße.
 *
 * GET    /api/graph/observations/<id>          → Definition + Erfassungszustand
 * PATCH  /api/graph/observations/<id>          → Name, Ein/Aus, Aufbewahrung, Verdichtung
 * DELETE /api/graph/observations/<id>          → Definition entfernen
 *        ?purge=1                              → zusätzlich den erfassten Bestand löschen
 *
 * Warum Löschen zweistufig ist: Der erfasste Bestand ist genau das, was
 * die Quelle nicht mehr hat. Ihn zusammen mit der Definition wegzuwerfen,
 * wäre für einen Fehlklick eine unwiederbringliche Strafe — deshalb bleibt
 * er liegen, bis jemand ausdrücklich `purge` verlangt.
 */

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { persistServerGraphSnapshot } from '@/lib/graph/server/instance';
import { getUserGraph } from '@/lib/graph/server/context';
import { deleteVariable, getVariable, updateVariable } from '@/lib/graph/observations/variables';
import { ObservationStore } from '@/lib/graph/observations/store';
import { dataRoot } from '@/lib/graph/observations/schedule.server';
import { createNodeFileSystem } from '@/lib/platform/runtime/node-fs';

const patchSchema = z.object({
    name: z.string().min(1).max(200).optional(),
    enabled: z.boolean().optional(),
    retentionDays: z.number().int().min(0).max(36_500).optional(),
    aggregation: z.enum(['last', 'mean', 'min', 'max', 'sum']).optional(),
}).strict();

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(_request: Request, context: RouteContext): Promise<Response> {
    const { id } = await context.params;
    try {
        const handle = await getUserGraph();
        const variable = await getVariable(handle, id);
        if (!variable) {
            return NextResponse.json({ error: 'Beobachtungsgröße nicht gefunden.' }, { status: 404 });
        }
        return NextResponse.json({ variable });
    } catch (error) {
        console.error('Observation Read Error:', error);
        return NextResponse.json({ error: 'Beobachtungsgröße konnte nicht gelesen werden.' }, { status: 500 });
    }
}

export async function PATCH(request: Request, context: RouteContext): Promise<Response> {
    const { id } = await context.params;
    let parsed: z.infer<typeof patchSchema>;
    try {
        parsed = patchSchema.parse(await request.json());
    } catch (error) {
        const message = error instanceof z.ZodError
            ? error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; ')
            : 'Ungültiger Request-Body.';
        return NextResponse.json({ error: message }, { status: 400 });
    }
    try {
        const handle = await getUserGraph();
        const variable = await updateVariable(handle, id, parsed);
        if (!variable) {
            return NextResponse.json({ error: 'Beobachtungsgröße nicht gefunden.' }, { status: 404 });
        }
        await persistServerGraphSnapshot();
        return NextResponse.json({ variable });
    } catch (error) {
        const message = error instanceof Error ? error.message : 'Änderung fehlgeschlagen.';
        const status = message.includes('nicht zulässig') ? 400 : 500;
        if (status === 500) console.error('Observation Patch Error:', error);
        return NextResponse.json({ error: message }, { status });
    }
}

export async function DELETE(request: Request, context: RouteContext): Promise<Response> {
    const { id } = await context.params;
    const purge = new URL(request.url).searchParams.get('purge') === '1';
    try {
        const handle = await getUserGraph();
        const removed = await deleteVariable(handle, id);
        if (!removed) {
            return NextResponse.json({ error: 'Beobachtungsgröße nicht gefunden.' }, { status: 404 });
        }
        let purgedSegments = 0;
        if (purge) {
            const observations = new ObservationStore({
                files: createNodeFileSystem(),
                root: dataRoot(),
                userId: handle.iri.userId,
            });
            purgedSegments = await observations.drop(id);
        }
        await persistServerGraphSnapshot();
        return NextResponse.json({
            deleted: true,
            purgedSegments,
            message: purge
                ? `Größe entfernt, ${purgedSegments} Tagesdatei(en) gelöscht.`
                : 'Größe entfernt. Der erfasste Bestand bleibt erhalten.',
        });
    } catch (error) {
        console.error('Observation Delete Error:', error);
        return NextResponse.json({ error: 'Beobachtungsgröße konnte nicht entfernt werden.' }, { status: 500 });
    }
}
