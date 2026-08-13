/**
 * RuntimeAdapter der Runtimes `server` und `ha-addon` (SPEC §5.2) —
 * Node-Bindungen: node:fs, Prozess-git, Secrets aus der Prozess-Umgebung,
 * Identität aus der Anfrage (auth/identity.ts).
 *
 * Beide Runtimes teilen dieselbe Implementierung, weil sie dasselbe
 * Container-Image sind (M12): Unterschied ist ausschließlich das Packaging
 * — Supervisor + Ingress-Proxy (`ha-addon`) gegen Compose + TLS/OIDC
 * (`server`). Deshalb gibt es hier eine Fabrik und keine zwei Dateien; die
 * Runtime-Kennung kommt aus der Umgebung (`OW_RUNTIME`, gesetzt von
 * scripts/start.mjs).
 *
 * Capabilities sind ehrlich: nur was existiert, steht auf true — der
 * MCP-Server existiert seit M10 (`/api/mcp`), die Föderation in beide
 * Richtungen seit M11, der Mehrbenutzerbetrieb mit ACL-Durchsetzung pro
 * Named Graph seit M13 (§17). `multiUser` heißt dabei: getrennte
 * Nutzergraphen und Rechte aus `graph/acl` — das Anmeldeverfahren führt
 * weiterhin die Identitäts-Schicht (`OW_AUTH_MODE`).
 */

import type { GraphStore } from '@/lib/graph/store/types';
import { resolveIdentity } from '../auth/identity';
import type { RuntimeAdapter, RuntimeId } from './types';
import { createNodeFileSystem } from './node-fs';
import { createProcessGitProvider } from './process-git';

export interface NodeRuntimeOptions {
    /** Store-Zugang; ohne Angabe der Server-Store dieser Instanz. */
    store?: () => Promise<GraphStore>;
    /** Header der laufenden Anfrage — Quelle der Identität. */
    headers?: Headers;
}

/** Runtime-Kennung dieses Prozesses. `ha-addon` setzt scripts/start.mjs. */
export function nodeRuntimeId(env: NodeJS.ProcessEnv = process.env): RuntimeId {
    if (env.OW_RUNTIME === 'ha-addon') return 'ha-addon';
    if (env.OW_RUNTIME === 'server') return 'server';
    return env.SUPERVISOR_TOKEN ? 'ha-addon' : 'server';
}

export function createNodeRuntimeAdapter(options: NodeRuntimeOptions = {}): RuntimeAdapter {
    const id = nodeRuntimeId();
    return {
        id,
        store: options.store ?? (async () => {
            const { getServerGraph } = await import('@/lib/graph/server/instance');
            return (await getServerGraph()).store;
        }),
        files: () => createNodeFileSystem(),
        git: () => createProcessGitProvider(),
        auth: () => ({
            identity: async context => resolveIdentity(context?.headers ?? options.headers),
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
            // Mehrbenutzerbetrieb (M13, §17): Nutzergraphen, ACL in
            // graph/acl, geteilte Räume, Durchsetzung im Dataset-Resolver.
            multiUser: true,
            reasoningTier: 'rl',
            // Tier 1 (C1): Identifikation läuft nativ in TypeScript und
            // braucht weder Netz noch Sidecar. Tier 2 (`full`) gäbe es
            // erst mit C8 — der ist nicht gebaut und wird nicht behauptet.
            causalTier: 'graph',
        },
    };
}
