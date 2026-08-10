/**
 * Einführungsstrecke (GRAPH_CORE_SPEC §18, M14).
 *
 * `GET`    — Zustand: die vier Schritte, ihr aufgezeichneter Fortschritt
 *            (`ow:OnboardingStep` in `graph/meta`) und die Live-Daten, um
 *            die es in den Schritten geht (Selbstmodell, Herkunfts-Zählung).
 * `POST`   — führt einen Schritt aus. Was dabei entsteht, entsteht auf den
 *            regulären Pfaden: Store-first-CRUD, Connector-Vertrag.
 * `DELETE` — nimmt einen Schritt zurück: erst das Erzeugte, dann die
 *            Aufzeichnung.
 *
 * Die Route hält nichts selbst: Sie baut den Abhängigkeits-Satz aus dem
 * Anfrage-Kontext (Identität → nutzerskalierte Fabrik → Grant) und reicht
 * ihn an `graph/onboarding/run.ts` weiter.
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { parseBody } from '@/lib/api/validation';
import { getRequestGraph } from '@/lib/graph/server/context';
import {
    getWorkspaceContext,
    persistServerGraphSnapshot,
    runServerReasoning,
} from '@/lib/graph/server/instance';
import {
    onboardingState,
    performOnboardingStep,
    undoOnboardingStep,
    OnboardingError,
    type OnboardingDeps,
} from '@/lib/graph/onboarding/run';
import { ONBOARDING_STEP_IDS, type OnboardingStepId } from '@/lib/graph/onboarding/steps';
import { createNodeFileSystem } from '@/lib/platform/runtime/node-fs';
import { createNodeRuntimeAdapter } from '@/lib/platform/runtime/server';

export const dynamic = 'force-dynamic';

const stepSchema = z.object({ step: z.enum(ONBOARDING_STEP_IDS) });

async function buildDeps(): Promise<OnboardingDeps> {
    const { store, iri, grant } = await getRequestGraph();
    return {
        handle: { store, iri },
        workspace: await getWorkspaceContext(),
        authz: { allowedGraphs: grant.readableGraphs },
        sync: {
            files: createNodeFileSystem(),
            runtime: createNodeRuntimeAdapter(),
        },
        persist: async () => { await persistServerGraphSnapshot(); },
        reason: async () => { await runServerReasoning(); },
    };
}

function failure(error: unknown): Response {
    if (error instanceof OnboardingError) {
        return NextResponse.json({ error: error.message }, { status: 422 });
    }
    return NextResponse.json(
        { error: 'Schritt nicht ausführbar', details: error instanceof Error ? error.message : 'unknown' },
        { status: 500 },
    );
}

export async function GET(): Promise<Response> {
    try {
        return NextResponse.json(await onboardingState(await buildDeps()));
    } catch (error) {
        return failure(error);
    }
}

export async function POST(request: NextRequest): Promise<Response> {
    const parsed = await parseBody(stepSchema, request);
    if (!parsed.ok) return parsed.response;
    try {
        const state = await performOnboardingStep(await buildDeps(), parsed.data.step as OnboardingStepId);
        return NextResponse.json(state);
    } catch (error) {
        return failure(error);
    }
}

export async function DELETE(request: NextRequest): Promise<Response> {
    const step = new URL(request.url).searchParams.get('step') ?? '';
    if (!ONBOARDING_STEP_IDS.includes(step as OnboardingStepId)) {
        return NextResponse.json({ error: `Unbekannter Schritt "${step}"` }, { status: 400 });
    }
    try {
        const state = await undoOnboardingStep(await buildDeps(), step as OnboardingStepId);
        return NextResponse.json(state);
    } catch (error) {
        return failure(error);
    }
}
