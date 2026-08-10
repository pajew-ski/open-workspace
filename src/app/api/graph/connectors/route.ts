/**
 * Connector-Verwaltung (GRAPH_CORE_SPEC §6, M3).
 *
 * GET  /api/graph/connectors — Instanzen (aus `graph/meta`) + Katalog der
 *      implementierten Arten. Der Katalog ist die einzige Quelle der
 *      UI-Auswahl: nicht implementierte Arten erscheinen nirgends
 *      (Invariante 10).
 * POST /api/graph/connectors — legt eine Instanz an. Die kind-spezifische
 *      Konfiguration validiert der Connector selbst (parseConfig).
 */

import { NextRequest, NextResponse } from 'next/server';
import { ZodError, z } from 'zod';
import { parseBody, createGraphConnectorSchema } from '@/lib/api/validation';
import {persistServerGraphSnapshot } from '@/lib/graph/server/instance';
import { getRequestGraph, getUserGraph } from '@/lib/graph/server/context';
import { snapshotExportRefusal } from '@/lib/graph/authz/resolve';
import { listConnectors, createConnector } from '@/lib/graph/connectors/registry';
import { getConnectorKind, listConnectorKinds } from '@/lib/graph/connectors/catalog';

export async function GET() {
    try {
        const handle = await getUserGraph();
        const connectors = await listConnectors(handle);
        const kinds = listConnectorKinds().map(kind => ({
            kind: kind.kind,
            mode: kind.mode,
            label: kind.label,
            description: kind.description,
            capabilities: kind.capabilities,
            configSchema: kind.configSchema(),
        }));
        return NextResponse.json({ connectors, kinds });
    } catch (error) {
        return NextResponse.json(
            { error: 'Connectors nicht ladbar', details: error instanceof Error ? error.message : 'unknown' },
            { status: 500 },
        );
    }
}

export async function POST(request: NextRequest) {
    const parsed = await parseBody(createGraphConnectorSchema, request);
    if (!parsed.ok) return parsed.response;

    const impl = getConnectorKind(parsed.data.kind);
    if (!impl) {
        return NextResponse.json(
            { error: `Connector-Art "${parsed.data.kind}" ist nicht implementiert.` },
            { status: 400 },
        );
    }

    let locator: string;
    try {
        locator = impl.locatorFor(impl.parseConfig(parsed.data.config));
    } catch (error) {
        const details = error instanceof ZodError
            ? z.prettifyError(error)
            : error instanceof Error ? error.message : 'unknown';
        return NextResponse.json(
            { error: 'Konfiguration ungültig', details },
            { status: 400 },
        );
    }

    try {
        const refused = await refuseSnapshotExport(impl.kind);
        if (refused) return refused;
        const handle = await getUserGraph();
        const connector = await createConnector(handle, {
            name: parsed.data.name,
            kind: impl.kind,
            locator,
        });
        await persistServerGraphSnapshot();
        return NextResponse.json({ connector }, { status: 201 });
    } catch (error) {
        return NextResponse.json(
            { error: 'Connector konnte nicht angelegt werden', details: error instanceof Error ? error.message : 'unknown' },
            { status: 500 },
        );
    }
}

/**
 * §17.4: Ein Git-Backup nimmt den ganzen Snapshot mit. Wer ihn ausliefert,
 * muss jeden enthaltenen Graphen verwalten dürfen.
 */
async function refuseSnapshotExport(kind: string): Promise<Response | null> {
    if (kind !== 'git-backup') return null;
    const { store, iri, grant } = await getRequestGraph();
    const existing = (await store.graphs()).map(g => g.value);
    const refusal = snapshotExportRefusal(grant, iri.instanceBase, existing);
    return refusal ? NextResponse.json({ error: 'Backup nicht erlaubt', details: refusal }, { status: 403 }) : null;
}
