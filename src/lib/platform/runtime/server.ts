/**
 * RuntimeAdapter der Runtime `server` (SPEC §5.2) — Node-Bindungen:
 * node:fs, Prozess-git, Single-User-Identität (Multi-User kommt mit
 * M13/OIDC), Secrets aus der Prozess-Umgebung. `ha-addon` teilt exakt
 * diese Bindungen und unterscheidet sich nur in Packaging und
 * Auth-Bindung (M12, dasselbe Container-Image — SPEC §5.2).
 *
 * Capabilities sind ehrlich: nur was existiert, steht auf true —
 * MCP-Server (M10) und Föderation (M11) sind noch keine Fähigkeiten.
 */

import type { GraphStore } from '@/lib/graph/store/types';
import { DEFAULT_USER_ID } from '@/lib/graph/iri';
import type { RuntimeAdapter } from './types';
import { createNodeFileSystem } from './node-fs';
import { createProcessGitProvider } from './process-git';

export function createServerRuntimeAdapter(store?: () => Promise<GraphStore>): RuntimeAdapter {
    return {
        id: 'server',
        store: store ?? (async () => {
            const { getServerGraph } = await import('@/lib/graph/server/instance');
            return (await getServerGraph()).store;
        }),
        files: () => createNodeFileSystem(),
        git: () => createProcessGitProvider(),
        auth: () => ({
            identity: async () => ({ userId: DEFAULT_USER_ID, groups: [] }),
        }),
        secrets: () => ({
            get: async key => process.env[key] ?? null,
            set: async key => {
                throw new Error(`Secrets sind in dieser Ausbaustufe nur lesbar (Umgebung) — "${key}" kann nicht gespeichert werden.`);
            },
        }),
        capabilities: {
            sparqlEndpoint: true,
            mcpServer: false,
            federationOutbound: false,
            federationInbound: false,
            multiUser: false,
            reasoningTier: 'rl',
        },
    };
}
