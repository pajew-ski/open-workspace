/**
 * Serverbindungen der Föderation (SPEC §7.4, M11).
 *
 * Zwei Richtungen, eine Datei:
 *  - **ausgehend**: `createFederationResolver()` liest die Endpoint-
 *    Registry aus `graph/meta` und löst `SERVICE`-Blöcke auf, bevor der
 *    Store die Query sieht. Der Bericht des letzten Laufs bleibt am
 *    Resolver hängen, damit die Route ihn als Header mitgeben kann.
 *  - **eingehend**: ein `FederationEndpointHost` pro Prozess (wie der
 *    MCP-Host), damit das Rate-Limit über Anfragen hinweg zählt.
 */

import { getServerGraph } from '@/lib/graph/server/instance';
import { createServerRuntimeAdapter } from '@/lib/platform/runtime/server';
import { mcpTokensFromEnv } from '@/lib/graph/mcp/tokens';
import type { ResolvedDataset } from '@/lib/graph/sparql/protocol';
import { FederationEndpointHost } from './inbound';
import { listFederatedEndpoints } from './registry';
import { planFederatedQuery, type FederationReport } from './service';

const globalHost = globalThis as unknown as { __owFederationHost?: FederationEndpointHost };

export function getFederationHost(): FederationEndpointHost {
    if (!globalHost.__owFederationHost) {
        globalHost.__owFederationHost = new FederationEndpointHost({
            graph: () => getServerGraph(),
            tokens: () => mcpTokensFromEnv(),
            capable: createServerRuntimeAdapter().capabilities.federationInbound,
        });
    }
    return globalHost.__owFederationHost;
}

export interface ServerFederationResolver {
    resolve(query: string, dataset: ResolvedDataset): Promise<string>;
    /** Bericht des letzten Aufrufs (leer, solange keine SERVICE-Klausel kam). */
    report(): FederationReport;
}

/**
 * Resolver für die serverseitigen SPARQL-Pfade. Die Registry wird pro
 * Query frisch gelesen: eine gerade herabgestufte Vertrauensstufe wirkt
 * sofort, nicht erst nach einem Neustart.
 */
export function createFederationResolver(): ServerFederationResolver {
    let report: FederationReport = { calls: [] };
    const capabilities = createServerRuntimeAdapter().capabilities;
    return {
        report: () => report,
        resolve: async (query, dataset) => {
            if (!capabilities.federationOutbound) return query;
            const handle = await getServerGraph();
            const endpoints = await listFederatedEndpoints(handle);
            const plan = await planFederatedQuery(query, dataset, { endpoints, store: handle.store });
            report = plan.report;
            return plan.query;
        },
    };
}
