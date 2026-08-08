import { NextResponse } from 'next/server';
import { loadAIConfig, resolveDefaultServerProvider } from '@/lib/ai/store.server';
import { probeProvider, effectiveModel } from '@/lib/ai/client';

/**
 * Health of the DEFAULT provider from the server's perspective, plus the
 * provider inventory. The browser combines this with its own direct
 * probes — a provider only reachable from the browser (local Ollama with
 * a cloud-hosted app) is still fully usable via the browser route.
 */
export async function GET() {
    try {
        const config = await loadAIConfig();
        const def = await resolveDefaultServerProvider();

        if (!def) {
            return NextResponse.json({
                status: 'unconfigured',
                providerCount: config.providers.length,
                models: [],
            });
        }

        const { resolved, model } = def;
        if (resolved.protocol === 'webllm') {
            // Browser-only engine: the server cannot probe it, but that is
            // not an outage — the browser route handles it.
            return NextResponse.json({
                status: 'browser-only',
                provider: { id: resolved.provider.id, label: resolved.provider.label, kind: resolved.provider.kind },
                model: effectiveModel(resolved.provider, model),
                models: [],
                providerCount: config.providers.length,
            });
        }

        const probe = await probeProvider(resolved);
        return NextResponse.json({
            status: probe.status === 'online' ? 'online' : 'offline',
            detail: probe.detail,
            provider: { id: resolved.provider.id, label: resolved.provider.label, kind: resolved.provider.kind },
            endpoint: resolved.provider.baseUrl,
            model: effectiveModel(resolved.provider, model),
            models: probe.models ?? [],
            latencyMs: probe.latencyMs,
            providerCount: config.providers.length,
        });
    } catch (error) {
        return NextResponse.json({
            status: 'error',
            error: error instanceof Error ? error.message : 'Unknown error',
            models: [],
        });
    }
}
