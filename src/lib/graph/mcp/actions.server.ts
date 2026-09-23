/**
 * Status des MCP-Servers als Aktion (ACTIONS_SPEC, A4; SPEC §7.6, M10):
 * Ist der Endpoint in dieser Runtime verfügbar, sind Tokens konfiguriert
 * (und fehlerfrei), welche Graphen darf welches Token lesen, welche
 * Werkzeuge sieht es? Instanzweite Auskunft, deshalb `instance` — und
 * Geheimnisse verlassen sie nie: nur IDs, Scopes und Rechte.
 *
 * Serverseitig, weil sie den MCP-Host und die Token-Konfiguration aus der
 * Umgebung liest. Getrennt von `actions.ts` (die Graph-Werkzeuge), damit
 * der Browser-Loop jene weiter ohne Node-Abhängigkeiten laden kann.
 */

import { z } from 'zod';
import { defineAction } from '@/lib/actions/contract';
import { registerActions } from '@/lib/actions/registry';
import { getMcpHost } from './host.server';
import { toolsForContext } from './server';
import { grantForToken, MCP_TOKENS_ENV, mcpTokensFromEnv } from './tokens';

export const mcpStatus = defineAction({
    name: 'mcp_status',
    title: 'MCP-Status',
    description: 'Zustand des MCP-Servers: Verfügbarkeit, konfigurierte Tokens mit Leserechten und sichtbaren Werkzeugen, offene Sitzungen.',
    input: z.object({}),
    effect: 'read',
    target: { kind: 'instance' },
    async run(_input, ctx) {
        const available = ctx.platform?.runtime.capabilities.mcpServer ?? false;
        const config = mcpTokensFromEnv();
        const handle = available && config.tokens.length > 0 ? ctx.graph : null;
        const existing = handle ? (await handle.store.graphs()).map(g => g.value) : [];
        const tokens = await Promise.all(config.tokens.map(async token => {
            const resolved = handle ? await grantForToken(token, handle, existing) : null;
            return {
                id: token.id,
                label: token.label ?? null,
                user: token.user,
                scopes: token.scopes ?? null,
                sparql: token.sparql,
                write: Boolean(resolved?.grant.writableGraph),
                writeScope: token.writeScope ?? null,
                rateLimitPerMinute: token.rateLimitPerMinute,
                readableGraphs: resolved?.grant.readableGraphs ?? [],
                tools: resolved && handle
                    ? await toolsForContext(getMcpHost().actionContextFor(handle, resolved.grant, token))
                    : [],
                ...(resolved?.writeScopeError ? { warning: resolved.writeScopeError } : {}),
            };
        }));
        return {
            available,
            configured: config.tokens.length > 0,
            endpoint: '/api/mcp',
            envVar: MCP_TOKENS_ENV,
            errors: config.errors,
            sessions: available ? getMcpHost().sessionCount : 0,
            tokens,
        };
    },
});

registerActions('graph/mcp', [mcpStatus]);
