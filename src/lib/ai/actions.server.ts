/**
 * Aktionen der AI-Plattform (ACTIONS_SPEC, A4): Provider, Voreinstellung,
 * MCP-Server-Konfiguration, Gesundheit. Instanzweite Konfiguration —
 * Geheimnisse (Keys, Auth-Header) verlassen die Aktionen nie
 * (`toClientProvider`, `toClientMcpServer`). Nach jeder Änderung wird der
 * AI-Spiegel erneuert (M9), damit das Selbstmodell die Konfiguration
 * beschreibt, die gilt.
 */

import { z } from 'zod';
import { defineAction, notFound } from '@/lib/actions/contract';
import { registerActions } from '@/lib/actions/registry';
import {
    aiDefaultsSchema,
    createMcpServerSchema,
    createProviderSchema,
    updateMcpServerSchema,
    updateProviderSchema,
} from '@/lib/api/validation';
import { OW } from '@/lib/graph/vocab';
import { effectiveModel, probeProvider } from './client';
import {
    createMcpServer,
    createProvider,
    deleteMcpServer,
    deleteProvider,
    loadAIConfig,
    resolveDefaultServerProvider,
    resolveServerProvider,
    setDefaults,
    toClientMcpServer,
    toClientProvider,
    updateMcpServer,
    updateProvider,
} from './store.server';

const idSchema = z.string().min(1).max(200);

export const aiConfig = defineAction({
    name: 'ai_config',
    title: 'AI-Konfiguration lesen',
    description: 'Liest Inferenz-Provider, MCP-Server und Voreinstellung — ohne Geheimnisse (nur Hat-Key-Flaggen).',
    input: z.object({}),
    effect: 'read',
    target: { kind: 'instance' },
    async run() {
        const config = await loadAIConfig();
        return {
            defaults: config.defaults,
            providers: config.providers.map(toClientProvider),
            mcpServers: config.mcpServers.map(toClientMcpServer),
        };
    },
});

export const aiSetDefaults = defineAction({
    name: 'ai_set_defaults',
    title: 'Voreinstellung setzen',
    description: 'Setzt Provider und Modell, mit denen der Assistent per Default antwortet.',
    input: aiDefaultsSchema,
    effect: 'constructive',
    target: { kind: 'instance' },
    changes: [OW.InferenceProvider],
    async run(input, ctx) {
        await setDefaults(input.providerId, input.model);
        await ctx.persist?.aiMirror('AI-Voreinstellung geändert');
        return { success: true as const };
    },
});

export const aiCreateProvider = defineAction({
    name: 'ai_create_provider',
    title: 'Provider anlegen',
    description: 'Legt einen Inferenz-Provider an (lokale Engine, Cloud-API oder WebLLM).',
    input: createProviderSchema,
    effect: 'constructive',
    target: { kind: 'instance' },
    changes: [OW.InferenceProvider],
    async run(input, ctx) {
        const provider = await createProvider(input);
        await ctx.persist?.aiMirror('Inference-Provider angelegt');
        return { provider };
    },
});

export const aiUpdateProvider = defineAction({
    name: 'ai_update_provider',
    title: 'Provider ändern',
    description: 'Ändert einen Inferenz-Provider.',
    input: updateProviderSchema.extend({ id: idSchema }),
    effect: 'constructive',
    target: { kind: 'instance' },
    changes: [OW.InferenceProvider],
    async run(input, ctx) {
        const { id, ...updates } = input;
        const provider = await updateProvider(id, updates);
        if (!provider) throw notFound('Provider nicht gefunden');
        await ctx.persist?.aiMirror('Inference-Provider aktualisiert');
        return { provider };
    },
});

export const aiDeleteProvider = defineAction({
    name: 'ai_delete_provider',
    title: 'Provider löschen',
    description: 'Entfernt einen Inferenz-Provider samt gespeichertem Key.',
    input: z.object({ id: idSchema }),
    effect: 'destructive',
    target: { kind: 'instance' },
    changes: [OW.InferenceProvider],
    async run(input, ctx) {
        await deleteProvider(input.id);
        await ctx.persist?.aiMirror('Inference-Provider gelöscht');
        return { success: true as const };
    },
});

export const aiProbeProvider = defineAction({
    name: 'ai_probe_provider',
    title: 'Provider prüfen',
    description: 'Prüft vom Server aus, ob ein Provider erreichbar ist und welche Modelle er nennt.',
    input: z.object({ id: idSchema }),
    effect: 'read',
    target: { kind: 'instance' },
    async run(input) {
        const resolved = await resolveServerProvider(input.id);
        if (!resolved) throw notFound('Provider nicht gefunden');
        if (resolved.protocol === 'webllm') {
            return { status: 'error' as const, detail: 'WebLLM läuft ausschließlich im Browser — es gibt keine Server-Route.' };
        }
        return probeProvider(resolved);
    },
});

/**
 * Gesundheit des Standard-Providers aus Sicht des Servers plus das
 * Provider-Inventar. Der Browser kombiniert das mit seinen eigenen
 * Proben — ein nur vom Browser erreichbarer Provider (lokales Ollama bei
 * gehosteter App) ist über die Browser-Route trotzdem voll nutzbar.
 */
export const aiHealth = defineAction({
    name: 'ai_health',
    title: 'Inferenz-Status',
    description: 'Sagt, ob der Standard-Provider vom Server aus antwortet, mit Modell und Latenz.',
    input: z.object({}),
    effect: 'read',
    target: { kind: 'instance' },
    async run() {
        const config = await loadAIConfig();
        const def = await resolveDefaultServerProvider();
        if (!def) {
            return { status: 'unconfigured' as const, providerCount: config.providers.length, models: [] as string[] };
        }
        const { resolved, model } = def;
        if (resolved.protocol === 'webllm') {
            // Browser-only engine: the server cannot probe it, but that is
            // not an outage — the browser route handles it.
            return {
                status: 'browser-only' as const,
                provider: { id: resolved.provider.id, label: resolved.provider.label, kind: resolved.provider.kind },
                model: effectiveModel(resolved.provider, model),
                models: [] as string[],
                providerCount: config.providers.length,
            };
        }
        const probe = await probeProvider(resolved);
        return {
            status: probe.status === 'online' ? ('online' as const) : ('offline' as const),
            detail: probe.detail,
            provider: { id: resolved.provider.id, label: resolved.provider.label, kind: resolved.provider.kind },
            endpoint: resolved.provider.baseUrl,
            model: effectiveModel(resolved.provider, model),
            models: probe.models ?? [],
            latencyMs: probe.latencyMs,
            providerCount: config.providers.length,
        };
    },
});

export const aiCreateMcpServer = defineAction({
    name: 'ai_create_mcp_server',
    title: 'MCP-Server anlegen',
    description: 'Registriert einen externen MCP-Server, dessen Werkzeuge im Tool-Loop erscheinen.',
    input: createMcpServerSchema,
    effect: 'constructive',
    target: { kind: 'instance' },
    changes: [OW.ToolProvider],
    async run(input, ctx) {
        const server = await createMcpServer(input);
        await ctx.persist?.aiMirror('MCP-Server angelegt');
        return { server };
    },
});

export const aiUpdateMcpServer = defineAction({
    name: 'ai_update_mcp_server',
    title: 'MCP-Server ändern',
    description: 'Ändert einen registrierten MCP-Server.',
    input: updateMcpServerSchema.extend({ id: idSchema }),
    effect: 'constructive',
    target: { kind: 'instance' },
    changes: [OW.ToolProvider],
    async run(input, ctx) {
        const { id, ...updates } = input;
        const server = await updateMcpServer(id, updates);
        if (!server) throw notFound('MCP-Server nicht gefunden');
        await ctx.persist?.aiMirror('MCP-Server aktualisiert');
        return { server };
    },
});

export const aiDeleteMcpServer = defineAction({
    name: 'ai_delete_mcp_server',
    title: 'MCP-Server entfernen',
    description: 'Entfernt einen registrierten MCP-Server.',
    input: z.object({ id: idSchema }),
    effect: 'destructive',
    target: { kind: 'instance' },
    changes: [OW.ToolProvider],
    async run(input, ctx) {
        await deleteMcpServer(input.id);
        await ctx.persist?.aiMirror('MCP-Server gelöscht');
        return { success: true as const };
    },
});

registerActions('ai', [
    aiConfig, aiSetDefaults, aiCreateProvider, aiUpdateProvider, aiDeleteProvider, aiProbeProvider, aiHealth,
    aiCreateMcpServer, aiUpdateMcpServer, aiDeleteMcpServer,
]);
