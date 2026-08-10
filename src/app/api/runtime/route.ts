/**
 * Laufzeitumgebung (SPEC §5.2, M12) — Lesemodell für die UI.
 *
 * `GET /api/runtime` beantwortet, was man über die laufende Installation
 * wissen muss, bevor man ihr etwas zutraut: Welche Runtime ist das? Was
 * kann sie (und was ausdrücklich nicht)? Unter welchem Pfad liegt sie —
 * also läuft sie hinter Home-Assistant-Ingress? Wer ist angemeldet, und
 * über welches Verfahren?
 *
 * Ausdrücklich NICHT hier: Geheimnisse, Token, Header-Rohwerte.
 */

import { NextResponse } from 'next/server';
import { headers } from 'next/headers';
import { createNodeRuntimeAdapter } from '@/lib/platform/runtime/server';
import { resolveIdentity } from '@/lib/platform/auth/identity';
import { getBasePath } from '@/lib/platform/base-path';

export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
    const requestHeaders = await headers();
    const adapter = createNodeRuntimeAdapter({ headers: requestHeaders });
    const identity = await resolveIdentity(requestHeaders);
    const basePath = getBasePath();
    const ingressPath = requestHeaders.get('x-ingress-path');

    return NextResponse.json({
        runtime: adapter.id,
        capabilities: adapter.capabilities,
        basePath,
        ingress: {
            // Nur wahr, wenn wirklich eine Ingress-Anfrage ankommt — die
            // bloße Konfiguration eines Base-Path heißt gar nichts.
            active: Boolean(ingressPath),
            basePath: ingressPath ?? null,
        },
        identity: {
            mode: identity.mode,
            authenticated: identity.authenticated,
            userId: identity.userId,
            displayName: identity.displayName ?? null,
            groups: identity.groups,
            reason: identity.reason ?? null,
        },
    });
}
