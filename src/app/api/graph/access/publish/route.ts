/**
 * Freigabehandlung (SPEC §17.1, M13).
 *
 * `POST /api/graph/access/publish` kopiert oder verschiebt einen Knoten
 * aus einem Graphen in einen anderen — typisch aus dem eigenen Workspace
 * in den eigenen öffentlichen Graphen. Protokolliert als `prov:Activity`.
 *
 * Zwei Rechte, beide nötig: Lesen auf der Quelle, Schreiben auf dem Ziel.
 * Fehlt eines, ist die Antwort dieselbe wie für einen Graphen, den es
 * nicht gibt (§17.3).
 */

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getRequestGraph } from '@/lib/graph/server/context';
import { persistServerGraphSnapshot } from '@/lib/graph/server/instance';
import { publishEntity } from '@/lib/graph/authz/publish';

const bodySchema = z.object({
    iri: z.string().min(1),
    mode: z.enum(['copy', 'move']).default('copy'),
    from: z.string().optional(),
    to: z.string().optional(),
}).strict();

export async function POST(request: Request): Promise<Response> {
    let body: z.infer<typeof bodySchema>;
    try {
        body = bodySchema.parse(await request.json());
    } catch (error) {
        const message = error instanceof z.ZodError
            ? error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; ')
            : 'Ungültiger Request-Body.';
        return NextResponse.json({ error: message }, { status: 400 });
    }

    try {
        const { store, iri, grant } = await getRequestGraph();
        if (!grant.userId) {
            return NextResponse.json({ error: 'Freigeben kann nur eine angemeldete Identität.' }, { status: 403 });
        }
        const from = body.from ?? iri.graph('workspace');
        const to = body.to ?? iri.graph('public');
        const mayRead = grant.readableGraphs.includes(from);
        const mayWriteTarget = (grant.writableGraphs ?? []).includes(to);
        // Verschieben nimmt aus der Quelle weg — dafür reicht Lesen nicht.
        const mayWriteSource = body.mode === 'copy' || (grant.writableGraphs ?? []).includes(from);
        if (!mayRead || !mayWriteTarget || !mayWriteSource) {
            return NextResponse.json({ error: 'Graph nicht gefunden.' }, { status: 404 });
        }

        const report = await publishEntity({ store, iri }, {
            entityIri: body.iri,
            from,
            to,
            mode: body.mode,
            actor: grant.userId,
        });
        await persistServerGraphSnapshot();
        return NextResponse.json({ report });
    } catch (error) {
        return NextResponse.json(
            { error: 'Freigabe nicht ausgeführt', details: error instanceof Error ? error.message : 'unknown' },
            { status: 400 },
        );
    }
}
