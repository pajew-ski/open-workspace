/**
 * Rückgriff auf die Long-Term-Statistics für EINE Größe.
 *
 * POST /api/graph/observations/<id>/backfill            → ein Jahr zurück
 * POST /api/graph/observations/<id>/backfill {days:730} → zwei Jahre
 *
 * Bewusst kein Zeitgeber und bewusst nicht im regulären Erfassungslauf:
 * Der Rückgriff holt einmalig, was vor dem Bestand liegt — danach gibt es
 * dort nichts Neues mehr. Ein wiederholter Lauf ist ein No-Op, aber er
 * kostet eine WebSocket-Verbindung und einen Abruf über Monate; das ist
 * nichts, was alle zehn Minuten von selbst passieren sollte.
 *
 * Statuscodes: 404 unbekannte Größe, 409 wenn die Quelle diese Größe
 * grundsätzlich nicht liefern kann (Schalter, Summen — eine Auskunft,
 * kein Serverfehler), 502 bei gescheitertem Abruf.
 */

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { persistServerGraphSnapshot } from '@/lib/graph/server/instance';
import { getUserGraph } from '@/lib/graph/server/context';
import { createNodeFileSystem } from '@/lib/platform/runtime/node-fs';
import { dataRoot } from '@/lib/graph/observations/schedule.server';
import {
    backfillFromStatistics,
    DEFAULT_STATISTICS_DAYS,
    MAX_STATISTICS_DAYS,
} from '@/lib/graph/observations/backfill';

const bodySchema = z.object({
    days: z.number().int().min(1).max(MAX_STATISTICS_DAYS).optional(),
}).strict();

type RouteContext = { params: Promise<{ id: string }> };

export async function POST(request: Request, context: RouteContext): Promise<Response> {
    const { id } = await context.params;

    let parsed: z.infer<typeof bodySchema> = {};
    if (request.headers.get('content-type')?.includes('application/json')) {
        try {
            parsed = bodySchema.parse(await request.json());
        } catch (error) {
            const message = error instanceof z.ZodError
                ? error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; ')
                : 'Ungültiger Request-Body.';
            return NextResponse.json({ error: message }, { status: 400 });
        }
    }

    try {
        const handle = await getUserGraph();
        const result = await backfillFromStatistics(handle, id, {
            files: createNodeFileSystem(),
            root: dataRoot(),
            days: parsed.days ?? DEFAULT_STATISTICS_DAYS,
        });
        if (result.status === 'filled') await persistServerGraphSnapshot();
        const status = result.status === 'refused' ? 409 : result.status === 'failed' ? 502 : 200;
        return NextResponse.json(result, { status });
    } catch (error) {
        const message = error instanceof Error ? error.message : 'Rückgriff fehlgeschlagen.';
        if (message.includes('gibt es nicht')) {
            return NextResponse.json({ error: message }, { status: 404 });
        }
        console.error('Observation Backfill Error:', error);
        return NextResponse.json({ error: message }, { status: 500 });
    }
}
