import type {
    AdapterEvent,
    AdapterRequest,
    AIProvider,
    ChatRequestOptions,
    EngineMessage,
    ProbeResult,
    ProtocolAdapter,
    ProviderProtocol,
    ResolvedProvider,
    ToolSpec,
} from './types';
import { protocolForKind } from './presets';
import { openaiAdapter } from './protocols/openai';
import { anthropicAdapter } from './protocols/anthropic';
import { ollamaAdapter } from './protocols/ollama';
import { webllmAdapter } from './protocols/webllm';
import { AdapterHttpError } from './protocols/shared';
import { isMixedContentBlocked } from '@/lib/net/private';

/**
 * Unified inference client: one call surface over every protocol adapter.
 * Runs identically in the browser (direct connection) and on the server
 * (relay for server-side keys / CORS-blocked endpoints).
 */

const ADAPTERS: Record<ProviderProtocol, ProtocolAdapter> = {
    openai: openaiAdapter,
    anthropic: anthropicAdapter,
    ollama: ollamaAdapter,
    webllm: webllmAdapter,
};

export function getAdapter(protocol: ProviderProtocol): ProtocolAdapter {
    return ADAPTERS[protocol];
}

export function resolveProtocol(provider: AIProvider): ProviderProtocol {
    return protocolForKind(provider.kind);
}

/** The model a request will use: explicit > provider default > pinned. */
export function effectiveModel(provider: AIProvider, explicit?: string): string | undefined {
    return explicit || provider.defaultModel || provider.pinnedModels?.[0];
}

export interface StreamParams {
    model?: string;
    messages: EngineMessage[];
    tools?: ToolSpec[];
    options?: ChatRequestOptions;
    signal?: AbortSignal;
}

export function streamProviderChat(
    resolved: ResolvedProvider,
    params: StreamParams
): AsyncGenerator<AdapterEvent, void, unknown> {
    const adapter = getAdapter(resolved.protocol);
    const model = effectiveModel(resolved.provider, params.model);
    if (!model) {
        throw new Error(`Für Provider "${resolved.provider.label}" ist kein Modell konfiguriert.`);
    }
    const request: AdapterRequest = {
        baseUrl: resolved.provider.baseUrl,
        apiKey: resolved.apiKey,
        model,
        messages: params.messages,
        tools: params.tools,
        options: params.options,
        signal: params.signal,
        inBrowser: resolved.context === 'browser',
    };
    return adapter.streamChat(request);
}

export async function listProviderModels(resolved: ResolvedProvider): Promise<string[]> {
    const adapter = getAdapter(resolved.protocol);
    const models = await adapter.listModels({
        baseUrl: resolved.provider.baseUrl,
        apiKey: resolved.apiKey,
        inBrowser: resolved.context === 'browser',
    });
    if (models.length > 0) return models;
    return resolved.provider.pinnedModels ?? [];
}

/**
 * Probe a provider and translate failures into actionable diagnostics.
 * The interesting cases are browser-specific: mixed content (HTTPS page →
 * http://LAN-IP) is detected before fetching; a TypeError from fetch in
 * the browser is reported as "CORS or offline" with endpoint-side hints.
 */
export async function probeProvider(resolved: ResolvedProvider): Promise<ProbeResult> {
    const { provider } = resolved;

    if (resolved.protocol === 'webllm') {
        if (resolved.context !== 'browser') {
            return { status: 'error', detail: 'WebLLM läuft nur im Browser (WebGPU).' };
        }
        const { checkWebGPU } = await import('./protocols/webllm');
        const gpu = await checkWebGPU();
        return gpu.supported
            ? { status: 'online', detail: 'WebGPU verfügbar — Inference läuft in diesem Browser.', models: await webllmAdapter.listModels({ baseUrl: '' }) }
            : { status: 'error', detail: gpu.detail };
    }

    if (!provider.baseUrl) {
        return { status: 'error', detail: 'Keine Endpunkt-URL konfiguriert.' };
    }

    if (resolved.context === 'browser' && typeof window !== 'undefined') {
        if (isMixedContentBlocked(provider.baseUrl, window.location.protocol)) {
            return {
                status: 'mixed-content',
                detail:
                    'Diese App läuft über HTTPS, der Endpunkt über unverschlüsseltes HTTP auf einer Nicht-Localhost-Adresse — der Browser blockiert das (Mixed Content). ' +
                    'Lösungen: Endpunkt über HTTPS bereitstellen, die Adresse auf http://localhost ummappen (z. B. SSH-Tunnel: `ssh -L 11434:ziel:11434 …`) oder die Server-Route verwenden.',
            };
        }
    }

    const started = Date.now();
    try {
        const models = await listProviderModels(resolved);
        return {
            status: 'online',
            detail: `Erreichbar (${models.length} Modelle).`,
            models,
            latencyMs: Date.now() - started,
        };
    } catch (error) {
        if (error instanceof AdapterHttpError) {
            if (error.status === 401 || error.status === 403) {
                return { status: 'auth', detail: 'Endpunkt erreichbar, aber der API-Schlüssel wurde abgelehnt (401/403).', latencyMs: Date.now() - started };
            }
            return { status: 'error', detail: `Endpunkt antwortet mit HTTP ${error.status}.`, latencyMs: Date.now() - started };
        }
        if (error instanceof Error && error.name === 'TimeoutError') {
            return { status: 'offline', detail: 'Zeitüberschreitung — Endpunkt antwortet nicht.' };
        }
        if (resolved.context === 'browser' && error instanceof TypeError) {
            return {
                status: 'cors-or-offline',
                detail:
                    'Der Browser konnte den Endpunkt nicht erreichen. Entweder läuft er nicht — oder er erlaubt diese Herkunft nicht (CORS). ' +
                    'Für Ollama: `OLLAMA_ORIGINS` setzen; für LM Studio: CORS aktivieren. Alternativ die Server-Route nutzen, falls ein Backend verbunden ist.',
            };
        }
        return {
            status: 'offline',
            detail: `Nicht erreichbar: ${error instanceof Error ? error.message : 'unbekannter Fehler'}`,
        };
    }
}
