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
import { getFulltextIndex, getVectorIndex } from '@/lib/graph/search/cache';
import { resolveEmbeddingProvider } from '@/lib/ai/embeddings.server';
import { createServerRuntimeAdapter } from '@/lib/platform/runtime/server';
import type { GraphHandle, RetrievalDeps } from '@/lib/graph/search/retrieval';
import { McpHost } from './http';
import { mcpTokensFromEnv } from './tokens';

const globalHost = globalThis as unknown as { __owMcpHost?: McpHost };

export function getMcpHost(): McpHost {
    if (!globalHost.__owMcpHost) {
        globalHost.__owMcpHost = new McpHost({
            graph: () => getServerGraph(),
            tokens: () => mcpTokensFromEnv(),
            capable: createServerRuntimeAdapter().capabilities.mcpServer,
            retrievalDeps: async (handle: GraphHandle, dataset: readonly string[]) => {
                const deps: RetrievalDeps = { fulltext: await getFulltextIndex(handle, dataset) };
                const embedding = await resolveEmbeddingProvider();
                if (embedding.provider) {
                    const provider = embedding.provider;
                    deps.vector = await getVectorIndex(handle, dataset, provider);
                    deps.embedQuery = async text => (await provider.embed([text]))[0];
                }
                return deps;
            },
            afterWrite: async () => {
                await persistServerGraphSnapshot();
            },
        });
    }
    return globalHost.__owMcpHost;
}
