/**
 * Die Messreihe einer Beobachtungsgröße.
 *
 * GET /api/graph/observations/<id>/series?from=<ISO>&to=<ISO>&limit=<n>
 *
 * Das ist der Lesepfad, den später jeder Schätzer benutzt: Zeitstempel und
 * Werte, aufsteigend, mit ausgewiesenen Lücken. Bewusst KEIN SPARQL — die
 * Werte stehen nicht im Store (Invariante C3), und eine Reihe mit
 * Zehntausenden Punkten will spaltenweise gelesen werden, nicht als
 * Bindings.
 */

import { NextResponse } from 'next/server';
import { getUserGraph } from '@/lib/graph/server/context';
import { getVariable } from '@/lib/graph/observations/variables';
import { ObservationStore } from '@/lib/graph/observations/store';
import { dataRoot } from '@/lib/graph/observations/schedule.server';
import { createNodeFileSystem } from '@/lib/platform/runtime/node-fs';

/** Harte Obergrenze je Anfrage — wie überall im Graph-Kern (SPEC §7.5). */
const MAX_POINTS = 50_000;
const DEFAULT_POINTS = 5_000;

function parseTimestamp(raw: string | null): number | undefined {
    if (!raw) return undefined;
    const parsed = Date.parse(raw);
    return Number.isFinite(parsed) ? parsed : undefined;
}

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(request: Request, context: RouteContext): Promise<Response> {
    const { id } = await context.params;
    const params = new URL(request.url).searchParams;
    const from = parseTimestamp(params.get('from'));
    const to = parseTimestamp(params.get('to'));
    const requestedLimit = Number(params.get('limit') ?? DEFAULT_POINTS);
    const limit = Number.isFinite(requestedLimit)
        ? Math.min(Math.max(Math.floor(requestedLimit), 1), MAX_POINTS)
        : DEFAULT_POINTS;

    try {
        const handle = await getUserGraph();
        const variable = await getVariable(handle, id);
        if (!variable) {
            return NextResponse.json({ error: 'Beobachtungsgröße nicht gefunden.' }, { status: 404 });
        }
        const observations = new ObservationStore({
            files: createNodeFileSystem(),
            root: dataRoot(),
            userId: handle.iri.userId,
        });
        const result = await observations.read(id, {
            // `after` ist exklusiv; `from` meint inklusiv — deshalb der Schritt.
            ...(from !== undefined ? { after: from - 1 } : {}),
            ...(to !== undefined ? { through: to } : {}),
            limit,
        });
        return NextResponse.json({
            variable: {
                id: variable.id,
                name: variable.name,
                kind: variable.kind,
                aggregation: variable.aggregation,
                intervalSeconds: variable.intervalSeconds,
                unit: variable.unit,
            },
            points: result.observations.map(point => ({
                t: new Date(point.t).toISOString(),
                v: point.v,
                ...(point.q ? { q: point.q } : {}),
            })),
            count: result.observations.length,
            truncated: result.truncated,
            // Ehrlich gemeldet statt still übersprungen: eine defekte Zeile
            // ist ein Hinweis auf einen abgebrochenen Schreibvorgang.
            corruptLines: result.corruptLines,
        });
    } catch (error) {
        console.error('Observation Series Error:', error);
        return NextResponse.json({ error: 'Messreihe konnte nicht gelesen werden.' }, { status: 500 });
    }
}
