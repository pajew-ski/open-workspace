/**
 * OWL-RL-Reasoning (GRAPH_CORE_SPEC §7.3, M7).
 *
 * GET  /api/graph/reasoning — Zustand der scope-partitionierten
 *      Inferenz-Graphen (Anzahl, Zeitstempel) plus die abgeleiteten
 *      Tripel des workspace-Scopes (gekappt) für die Explorer-Überlagerung.
 * POST /api/graph/reasoning — löst einen Lauf aus („auf Anforderung"):
 *      vollständiger Replace von graph/<u>/inferred/<scope> pro Scope.
 *      Nichts davon wird persistiert (SPEC §8.1) — der Snapshot bleibt
 *      unberührt.
 */

import { NextResponse } from 'next/server';
import { getUserGraph } from '@/lib/graph/server/context';
import { inferredTriples, reasoningStatus, runReasoning } from '@/lib/graph/reasoning/run';

export async function GET() {
    try {
        const handle = await getUserGraph();
        const status = await reasoningStatus(handle);
        const triples = await inferredTriples(handle, 'workspace');
        return NextResponse.json({ status, triples });
    } catch (error) {
        return NextResponse.json(
            { error: 'Reasoning-Zustand nicht ladbar', details: error instanceof Error ? error.message : 'unknown' },
            { status: 500 },
        );
    }
}

export async function POST() {
    try {
        const handle = await getUserGraph();
        const runs = await runReasoning(handle);
        const triples = await inferredTriples(handle, 'workspace');
        return NextResponse.json({ runs, triples });
    } catch (error) {
        return NextResponse.json(
            { error: 'Reasoning-Lauf nicht ausführbar', details: error instanceof Error ? error.message : 'unknown' },
            { status: 500 },
        );
    }
}
