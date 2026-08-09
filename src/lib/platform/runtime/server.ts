/**
 * RuntimeAdapter der Runtime `server` (SPEC §5.2) — Node-Bindungen:
 * node:fs, Prozess-git, Single-User-Identität (Multi-User kommt mit
 * M13/OIDC), Secrets aus der Prozess-Umgebung. `ha-addon` teilt exakt
 * diese Bindungen und unterscheidet sich nur in Packaging und
 * Auth-Bindung (M12, dasselbe Container-Image — SPEC §5.2).
 *
 * Capabilities sind ehrlich: nur was existiert, steht auf true —
 * der MCP-Server existiert seit M10 (`/api/mcp`), die Föderation in
 * beide Richtungen seit M11 (`SERVICE` gegen die Endpoint-Registry,
 * `/api/graph/federation/sparql`).
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
            // MCP-Server (M10): HTTP-Endpoint /api/mcp. Ob er jemanden
            // hereinlässt, entscheidet die Token-Konfiguration — die
            // Fähigkeit selbst existiert in dieser Runtime.
            mcpServer: true,
            // Föderation (M11): ausgehend `SERVICE` gegen registrierte
            // Endpoints, eingehend `/api/graph/federation/sparql` mit
            // Authz-Rewriting. Ob jemand etwas sieht, entscheidet auch
            // hier die Token-Konfiguration — die Fähigkeit existiert.
            federationOutbound: true,
            federationInbound: true,
            multiUser: false,
            reasoningTier: 'rl',
        },
    };
}
