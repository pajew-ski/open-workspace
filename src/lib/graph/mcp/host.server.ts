/**
 * Serverbindung des MCP-Hosts (SPEC §7.6, M10).
 *
 * Ein Host pro Prozess (Dev-Hot-Reload-sicher wie die Store-Instanz), damit
 * Sitzungen zwischen Anfragen bestehen bleiben und die Status-Ansicht
 * dieselbe Instanz sieht wie der Endpoint. Alles Injizierte kommt von hier:
 * Store, Token-Konfiguration aus der Umgebung, der M8-Index-Cache und die
 * Nachbereitung von Schreibvorgängen (Snapshot).
 */

import { getServerGraph, persistServerGraphSnapshot } from '@/lib/graph/server/instance';
import { createNodeRuntimeAdapter } from '@/lib/platform/runtime/server';
import { actionContextForIdentity, serverRetrievalDeps } from '@/lib/actions/context.server';
import { McpHost } from './http';
import { mcpTokensFromEnv } from './tokens';

const globalHost = globalThis as unknown as { __owMcpHost?: McpHost };

export function getMcpHost(): McpHost {
    if (!globalHost.__owMcpHost) {
        globalHost.__owMcpHost = new McpHost({
            graph: () => getServerGraph(),
            tokens: () => mcpTokensFromEnv(),
            capable: createNodeRuntimeAdapter().capabilities.mcpServer,
            retrievalDeps: (handle, dataset, options) => serverRetrievalDeps(handle, dataset, options),
            afterWrite: async () => {
                await persistServerGraphSnapshot();
            },
            // Der Aktionskontext eines Tokens hat dieselben Bausteine wie
            // eine Anfrage der Oberfläche — nur die Identität kommt aus dem
            // Token (Nutzer, dessen Rechte gelten; Token-ID als Bezeichnung).
            actionContext: (handle, grant, token) => actionContextForIdentity(handle, grant, {
                userId: token.user,
                authenticated: true,
                label: token.id,
            }),
        });
    }
    return globalHost.__owMcpHost;
}
