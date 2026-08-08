import type { AdapterEvent, AdapterRequest, ProtocolAdapter } from '../types';

/**
 * WebLLM adapter: inference inside the browser via WebGPU (@mlc-ai/web-llm).
 *
 * This is the "zero backend" extreme of the provider spectrum: model
 * weights are downloaded once (Cache API) and generation runs on the
 * user's GPU — the workspace needs neither its own backend nor any
 * external endpoint, and works offline after the first download.
 *
 * The heavy library is imported lazily and only in the browser; the
 * engine is a singleton that reloads when a different model is requested.
 */

// Curated, tested subset shown first in the UI (id → human label + size).
export interface WebLLMModelInfo {
    id: string;
    label: string;
    sizeHint: string;
    vramMB?: number;
    lowResource?: boolean;
}

export const CURATED_WEBLLM_MODELS: WebLLMModelInfo[] = [
    { id: 'Llama-3.2-1B-Instruct-q4f16_1-MLC', label: 'Llama 3.2 1B', sizeHint: '~0,9 GB' },
    { id: 'Llama-3.2-3B-Instruct-q4f16_1-MLC', label: 'Llama 3.2 3B', sizeHint: '~1,9 GB' },
    { id: 'Qwen2.5-1.5B-Instruct-q4f16_1-MLC', label: 'Qwen 2.5 1.5B', sizeHint: '~1,0 GB' },
    { id: 'Qwen2.5-3B-Instruct-q4f16_1-MLC', label: 'Qwen 2.5 3B', sizeHint: '~1,9 GB' },
    { id: 'Phi-3.5-mini-instruct-q4f16_1-MLC', label: 'Phi 3.5 Mini', sizeHint: '~2,2 GB' },
    { id: 'gemma-2-2b-it-q4f16_1-MLC', label: 'Gemma 2 2B', sizeHint: '~1,4 GB' },
    { id: 'SmolLM2-1.7B-Instruct-q4f16_1-MLC', label: 'SmolLM2 1.7B', sizeHint: '~1,1 GB' },
];

export const DEFAULT_WEBLLM_MODEL = CURATED_WEBLLM_MODELS[0].id;

type WebLLMModule = typeof import('@mlc-ai/web-llm');
type MLCEngine = import('@mlc-ai/web-llm').MLCEngineInterface;

let modulePromise: Promise<WebLLMModule> | null = null;
let engineState: { engine: MLCEngine; model: string } | null = null;
let loadingPromise: Promise<MLCEngine> | null = null;

export function isBrowser(): boolean {
    return typeof window !== 'undefined';
}

/** WebGPU capability check (the hard requirement for WebLLM). */
export async function checkWebGPU(): Promise<{ supported: boolean; detail: string }> {
    if (!isBrowser()) return { supported: false, detail: 'Nur im Browser verfügbar.' };
    const gpu = (navigator as Navigator & { gpu?: { requestAdapter(): Promise<unknown> } }).gpu;
    if (!gpu) {
        return { supported: false, detail: 'Dieser Browser unterstützt kein WebGPU. Aktuelle Chrome-, Edge- oder Firefox-Versionen verwenden.' };
    }
    try {
        const adapter = await gpu.requestAdapter();
        if (!adapter) return { supported: false, detail: 'WebGPU vorhanden, aber kein Grafik-Adapter verfügbar.' };
        return { supported: true, detail: 'WebGPU verfügbar.' };
    } catch (error) {
        return { supported: false, detail: `WebGPU-Fehler: ${error instanceof Error ? error.message : 'unbekannt'}` };
    }
}

async function loadModule(): Promise<WebLLMModule> {
    if (!isBrowser()) throw new Error('WebLLM läuft nur im Browser (WebGPU).');
    if (!modulePromise) modulePromise = import('@mlc-ai/web-llm');
    return modulePromise;
}

/** All model ids the bundled WebLLM build ships configs for. */
export async function listAllWebLLMModels(): Promise<WebLLMModelInfo[]> {
    const mod = await loadModule();
    return mod.prebuiltAppConfig.model_list.map(m => ({
        id: m.model_id,
        label: m.model_id.replace(/-MLC$/, ''),
        sizeHint: m.vram_required_MB ? `~${(m.vram_required_MB / 1024).toFixed(1).replace('.', ',')} GB VRAM` : '',
        vramMB: m.vram_required_MB,
        lowResource: m.low_resource_required,
    }));
}

/** Is the model already in the browser cache (offline-ready)? */
export async function isModelCached(modelId: string): Promise<boolean> {
    try {
        const mod = await loadModule();
        return await mod.hasModelInCache(modelId, mod.prebuiltAppConfig);
    } catch {
        return false;
    }
}

/** Remove a model's weights from the browser cache. */
export async function deleteModelFromCache(modelId: string): Promise<void> {
    const mod = await loadModule();
    await mod.deleteModelAllInfoInCache(modelId, mod.prebuiltAppConfig);
}

export type WebLLMProgress = (label: string, value?: number) => void;

/** Get (or load/switch to) the singleton engine for a model. */
export async function getEngine(modelId: string, onProgress?: WebLLMProgress): Promise<MLCEngine> {
    if (engineState && engineState.model === modelId) return engineState.engine;
    if (loadingPromise) await loadingPromise.catch(() => undefined);
    if (engineState && engineState.model === modelId) return engineState.engine;

    const mod = await loadModule();
    const doLoad = async (): Promise<MLCEngine> => {
        const progressCallback = (report: { text: string; progress: number }) => {
            onProgress?.(report.text, report.progress);
        };
        if (engineState) {
            await engineState.engine.reload(modelId);
            engineState = { engine: engineState.engine, model: modelId };
            return engineState.engine;
        }
        const engine = await mod.CreateMLCEngine(modelId, { initProgressCallback: progressCallback });
        engineState = { engine, model: modelId };
        return engine;
    };
    loadingPromise = doLoad();
    try {
        return await loadingPromise;
    } finally {
        loadingPromise = null;
    }
}

/** Simple push→pull bridge so callback progress can be yielded mid-stream. */
class EventQueue {
    private queue: AdapterEvent[] = [];
    private wakeup: (() => void) | null = null;

    push(event: AdapterEvent): void {
        this.queue.push(event);
        this.wakeup?.();
        this.wakeup = null;
    }

    async next(): Promise<AdapterEvent | null> {
        if (this.queue.length > 0) return this.queue.shift()!;
        return null;
    }

    drain(): AdapterEvent[] {
        const items = this.queue;
        this.queue = [];
        return items;
    }
}

export const webllmAdapter: ProtocolAdapter = {
    protocol: 'webllm',
    // Native tool calling in WebLLM is model-dependent and fragile —
    // the engine uses the universal text syntax instead.
    supportsNativeTools: false,

    async *streamChat(req: AdapterRequest): AsyncGenerator<AdapterEvent, void, unknown> {
        const progressEvents = new EventQueue();
        const enginePromise = getEngine(req.model, (label, value) => {
            progressEvents.push({ type: 'progress', label, value });
        });

        // Surface load progress while the engine initializes.
        let engine: MLCEngine | null = null;
        let engineError: unknown = null;
        const settled = enginePromise.then(
            e => { engine = e; },
            err => { engineError = err; }
        );
        while (engine === null && engineError === null) {
            for (const event of progressEvents.drain()) yield event;
            await Promise.race([settled, new Promise(resolve => setTimeout(resolve, 120))]);
        }
        for (const event of progressEvents.drain()) yield event;
        if (engineError) throw engineError instanceof Error ? engineError : new Error(String(engineError));

        const messages = req.messages.map(m => ({
            role: (m.role === 'tool' ? 'user' : m.role) as 'system' | 'user' | 'assistant',
            content: m.role === 'tool' ? `[TOOL_RESULT ${m.toolName ?? ''}]: ${m.content}` : m.content,
        }));

        const chunks = await engine!.chat.completions.create({
            messages,
            stream: true,
            temperature: req.options?.temperature,
            top_p: req.options?.top_p,
            max_tokens: req.options?.max_tokens,
        });

        for await (const chunk of chunks) {
            if (req.signal?.aborted) {
                await engine!.interruptGenerate();
                break;
            }
            const delta = chunk.choices?.[0]?.delta?.content;
            if (delta) yield { type: 'text', text: delta };
        }
        yield { type: 'done', model: req.model };
    },

    async listModels(): Promise<string[]> {
        if (!isBrowser()) return CURATED_WEBLLM_MODELS.map(m => m.id);
        try {
            const all = await listAllWebLLMModels();
            return all.map(m => m.id);
        } catch {
            return CURATED_WEBLLM_MODELS.map(m => m.id);
        }
    },
};
