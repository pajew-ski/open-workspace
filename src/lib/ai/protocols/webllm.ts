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
    /**
     * The bundled WebLLM build enables native `tools` for this model
     * (its `functionCallingModelIds`). A hard fact from the library, not
     * an assessment — `webllmNativeToolModels()` reads it back at
     * runtime, and a test keeps this flag in sync with it.
     *
     * Note that the workspace itself still drives tool calls through the
     * universal text syntax; see `webllmAdapter.supportsNativeTools`.
     */
    nativeTools?: boolean;
    /** One-line German note shown next to the model in the manager. */
    note?: string;
}

/**
 * Curated list, newest first. The bundled build ships ~165 model
 * configs — everything here is one of them, and everything else is one
 * toggle away in the manager ("Alle Modelle"), so nothing is hidden.
 * VRAM figures come from the build's own `vram_required_MB`.
 */
export const CURATED_WEBLLM_MODELS: WebLLMModelInfo[] = [
    // --- Werkzeug-Aufrufe: die einzigen Modelle, für die dieser Build
    //     natives Tool-Calling freischaltet (Hermes-Prompt-Format).
    {
        id: 'Hermes-3-Llama-3.1-8B-q4f16_1-MLC', label: 'Hermes 3 · Llama 3.1 8B',
        sizeHint: '~4,8 GB', vramMB: 4876.13, nativeTools: true,
        note: 'Auf Funktionsaufrufe trainiert — die stärkste Wahl für Werkzeuge im Browser.',
    },
    {
        id: 'Hermes-2-Pro-Mistral-7B-q4f16_1-MLC', label: 'Hermes 2 Pro · Mistral 7B',
        sizeHint: '~3,9 GB', vramMB: 4033.28, nativeTools: true,
        note: 'Kleiner als die 8B-Modelle, ebenfalls für Funktionsaufrufe trainiert.',
    },
    {
        id: 'Hermes-2-Pro-Llama-3-8B-q4f16_1-MLC', label: 'Hermes 2 Pro · Llama 3 8B',
        sizeHint: '~4,9 GB', vramMB: 4976.13, nativeTools: true,
        note: 'Vorgänger von Hermes 3, gleiches Tool-Format.',
    },
    {
        id: 'Hermes-3-Llama-3.2-3B-q4f16_1-MLC', label: 'Hermes 3 · Llama 3.2 3B',
        sizeHint: '~2,2 GB', vramMB: 2263.69, lowResource: true,
        note: 'Hermes-Familie für kleine Grafikspeicher; Tool-Aufrufe über die Text-Syntax.',
    },
    // --- Neueste allgemeine Modelle des Builds.
    {
        id: 'Qwen3-8B-q4f16_1-MLC', label: 'Qwen 3 · 8B',
        sizeHint: '~5,6 GB', vramMB: 5695.78,
        note: 'Größtes Qwen 3 im Build — braucht eine Karte mit reichlich Speicher.',
    },
    {
        id: 'Qwen3-4B-q4f16_1-MLC', label: 'Qwen 3 · 4B',
        sizeHint: '~3,4 GB', vramMB: 3431.59, lowResource: true,
        note: 'Guter Mittelweg aus Qualität und Downloadgröße.',
    },
    {
        id: 'Qwen3-1.7B-q4f16_1-MLC', label: 'Qwen 3 · 1.7B',
        sizeHint: '~2,0 GB', vramMB: 2036.66, lowResource: true,
    },
    {
        id: 'Qwen3-0.6B-q4f16_1-MLC', label: 'Qwen 3 · 0.6B',
        sizeHint: '~1,4 GB', vramMB: 1403.34, lowResource: true,
        note: 'Kleinstes Qwen 3 — schnell geladen, für einfache Aufgaben.',
    },
    {
        id: 'Phi-4-mini-instruct-q4f16_1-MLC', label: 'Phi 4 Mini',
        sizeHint: '~3,4 GB', vramMB: 3437.58,
        note: 'Microsofts kompaktes Modell der vierten Generation.',
    },
    {
        id: 'Llama-3.1-8B-Instruct-q4f16_1-MLC', label: 'Llama 3.1 8B',
        sizeHint: '~4,9 GB', vramMB: 5001,
    },
    {
        id: 'Llama-3.2-3B-Instruct-q4f16_1-MLC', label: 'Llama 3.2 3B',
        sizeHint: '~2,2 GB', vramMB: 2263.69, lowResource: true,
    },
    {
        id: 'Llama-3.2-1B-Instruct-q4f16_1-MLC', label: 'Llama 3.2 1B',
        sizeHint: '~0,9 GB', vramMB: 879.04, lowResource: true,
        note: 'Kleinster Download — die Voreinstellung für den ersten Versuch.',
    },
    {
        id: 'gemma3-1b-it-q4f16_1-MLC', label: 'Gemma 3 · 1B',
        sizeHint: '~0,7 GB', vramMB: 711.07, lowResource: true,
    },
    {
        id: 'SmolLM2-1.7B-Instruct-q4f16_1-MLC', label: 'SmolLM2 1.7B',
        sizeHint: '~1,7 GB', vramMB: 1774.19, lowResource: true,
    },
];

/**
 * Prefilled when a WebLLM provider is created: the smallest download in
 * the list, so the first attempt succeeds on modest hardware. Bewusst
 * eine eigene Konstante statt `CURATED_WEBLLM_MODELS[0]` — die
 * Reihenfolge der Liste ist eine Empfehlung, keine Voreinstellung.
 */
export const DEFAULT_WEBLLM_MODEL = 'Llama-3.2-1B-Instruct-q4f16_1-MLC';

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

/**
 * All model ids the bundled WebLLM build ships configs for — the full
 * catalogue behind the curated list. `nativeTools` comes straight from
 * the build's `functionCallingModelIds`, so the flag can never drift
 * from what the library actually accepts.
 */
export async function listAllWebLLMModels(): Promise<WebLLMModelInfo[]> {
    const mod = await loadModule();
    const nativeTools = new Set(mod.functionCallingModelIds);
    return mod.prebuiltAppConfig.model_list.map(m => ({
        id: m.model_id,
        label: m.model_id.replace(/-MLC$/, ''),
        sizeHint: m.vram_required_MB ? `~${(m.vram_required_MB / 1024).toFixed(1).replace('.', ',')} GB VRAM` : '',
        vramMB: m.vram_required_MB,
        lowResource: m.low_resource_required,
        ...(nativeTools.has(m.model_id) ? { nativeTools: true } : {}),
    }));
}

/**
 * Model ids for which THIS WebLLM build enables the native `tools`
 * parameter. Read from the library, never hard-coded — a version bump
 * changes the answer, and `tests/ai/webllm-models.test.ts` checks the
 * curated flags against it.
 */
export async function webllmNativeToolModels(): Promise<string[]> {
    const mod = await loadModule();
    return [...mod.functionCallingModelIds];
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
    /**
     * The engine drives tool calls through the universal text syntax
     * here, not through WebLLM's `tools` parameter. Three properties of
     * the bundled build (0.2.84) make that the right call, and all three
     * are checked, not assumed (`tests/ai/webllm-models.test.ts`):
     *
     *  1. `tools` is accepted for a handful of Hermes models only
     *     (`functionCallingModelIds`) — every other model throws.
     *  2. Passing `tools` forbids a system message. This workspace always
     *     sends one (module context from the self-model), so the two are
     *     mutually exclusive.
     *  3. With `tools` set, the response is constrained to a tool-call
     *     array — the model can no longer answer in prose, which breaks
     *     ordinary turns of a conversation.
     *
     * `WebLLMModelInfo.nativeTools` still surfaces (1) in the UI: those
     * models are trained on function calling and follow the text syntax
     * most reliably.
     */
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
