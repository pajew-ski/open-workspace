/**
 * Erfassungslauf auf Anforderung.
 *
 * POST /api/graph/observations/capture           → alle aktiven Größen
 * POST /api/graph/observations/capture {ids:[…]} → nur diese
 *
 * Der reguläre Weg ist der Zeitgeber im Serverprozess
 * (`schedule.server.ts`); diese Route ist der Knopf daneben — für den
 * ersten Lauf nach dem Einrichten, für Installationen, die von außen
 * takten (Cron, n8n), und für die Fehlersuche.
 */

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { persistServerGraphSnapshot } from '@/lib/graph/server/instance';
import { getUserGraph } from '@/lib/graph/server/context';
import { runCaptureOnce } from '@/lib/graph/observations/schedule.server';

const bodySchema = z.object({
    ids: z.array(z.string().min(1).max(200)).max(200).optional(),
}).strict();

export async function POST(request: Request): Promise<Response> {
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
        const report = await runCaptureOnce(handle, parsed.ids);
        await persistServerGraphSnapshot();
        // Ein Lauf, in dem jede Größe scheiterte, ist kein Erfolg — der
        // Statuscode sagt das, statt es in einem 200er zu verstecken.
        const allFailed = report.results.length > 0 && report.results.every(result => result.status === 'failed');
        return NextResponse.json(report, { status: allFailed ? 502 : 200 });
    } catch (error) {
        console.error('Observation Capture Error:', error);
        const message = error instanceof Error ? error.message : 'Erfassungslauf fehlgeschlagen.';
        return NextResponse.json({ error: message }, { status: 500 });
    }
}
