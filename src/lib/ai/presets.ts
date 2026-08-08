import type { ProviderKind, ProviderProtocol } from './types';

/**
 * Provider catalog: every inference source the workspace can talk to,
 * local and cloud, plus the in-browser WebLLM engine. A preset carries
 * everything the UI needs to offer a one-click setup and everything the
 * client needs to speak the right protocol.
 */

export type PresetCategory = 'local' | 'browser' | 'cloud';

export interface ProviderPreset {
    kind: ProviderKind;
    label: string;
    category: PresetCategory;
    protocol: ProviderProtocol;
    defaultBaseUrl: string;
    /** Does this endpoint require an API key? */
    requiresKey: boolean;
    /** Can the browser call it directly (CORS supported / configurable)? */
    browserCapable: boolean;
    /** Short German description for the preset gallery. */
    description: string;
    /** Hint shown when direct browser access needs endpoint-side setup. */
    corsHint?: string;
    docsUrl?: string;
    /** Suggested models to prefill when the endpoint cannot list any. */
    exampleModels?: string[];
}

export const PROVIDER_PRESETS: ProviderPreset[] = [
    // ---------------- Local engines ----------------
    {
        kind: 'ollama',
        label: 'Ollama',
        category: 'local',
        protocol: 'ollama',
        defaultBaseUrl: 'http://localhost:11434',
        requiresKey: false,
        browserCapable: true,
        description: 'Lokale Modelle auf deinem Rechner. Der Browser verbindet sich direkt — funktioniert auch, wenn die App in der Cloud gehostet ist.',
        corsHint: 'Für den Direktzugriff aus einer gehosteten App: OLLAMA_ORIGINS setzen, z. B. `OLLAMA_ORIGINS=https://deine-app.example` (oder `*`), dann Ollama neu starten.',
        docsUrl: 'https://ollama.com',
    },
    {
        kind: 'lmstudio',
        label: 'LM Studio',
        category: 'local',
        protocol: 'openai',
        defaultBaseUrl: 'http://localhost:1234/v1',
        requiresKey: false,
        browserCapable: true,
        description: 'Lokaler OpenAI-kompatibler Server aus LM Studio.',
        corsHint: 'In LM Studio unter Developer → „Enable CORS" aktivieren, damit der Browser direkt zugreifen darf.',
        docsUrl: 'https://lmstudio.ai',
    },
    {
        kind: 'llamacpp',
        label: 'llama.cpp',
        category: 'local',
        protocol: 'openai',
        defaultBaseUrl: 'http://localhost:8080/v1',
        requiresKey: false,
        browserCapable: true,
        description: 'llama-server (llama.cpp) mit OpenAI-kompatibler API.',
        docsUrl: 'https://github.com/ggml-org/llama.cpp',
    },
    {
        kind: 'vllm',
        label: 'vLLM',
        category: 'local',
        protocol: 'openai',
        defaultBaseUrl: 'http://localhost:8000/v1',
        requiresKey: false,
        browserCapable: true,
        description: 'vLLM-Server (eigene GPU-Maschine oder LAN).',
        corsHint: 'vLLM mit `--allowed-origins` für Browser-Direktzugriff starten.',
        docsUrl: 'https://docs.vllm.ai',
    },
    {
        kind: 'jan',
        label: 'Jan',
        category: 'local',
        protocol: 'openai',
        defaultBaseUrl: 'http://localhost:1337/v1',
        requiresKey: false,
        browserCapable: true,
        description: 'Jan Desktop-App mit lokalem API-Server.',
        docsUrl: 'https://jan.ai',
    },
    // ---------------- In-browser ----------------
    {
        kind: 'webllm',
        label: 'WebLLM (im Browser)',
        category: 'browser',
        protocol: 'webllm',
        defaultBaseUrl: '',
        requiresKey: false,
        browserCapable: true,
        description: 'Inference direkt in diesem Browser via WebGPU — komplett ohne Server. Nach dem Modell-Download auch offline nutzbar.',
        docsUrl: 'https://github.com/mlc-ai/web-llm',
    },
    // ---------------- Cloud ----------------
    {
        kind: 'openai',
        label: 'OpenAI',
        category: 'cloud',
        protocol: 'openai',
        defaultBaseUrl: 'https://api.openai.com/v1',
        requiresKey: true,
        browserCapable: true,
        description: 'GPT-Modelle über die OpenAI-API.',
        docsUrl: 'https://platform.openai.com',
        exampleModels: ['gpt-5.1', 'gpt-5-mini', 'gpt-4.1'],
    },
    {
        kind: 'anthropic',
        label: 'Anthropic',
        category: 'cloud',
        protocol: 'anthropic',
        defaultBaseUrl: 'https://api.anthropic.com',
        requiresKey: true,
        browserCapable: true,
        description: 'Claude-Modelle. Browser-Direktzugriff wird über einen offiziellen CORS-Header unterstützt.',
        docsUrl: 'https://docs.claude.com',
        exampleModels: ['claude-sonnet-5', 'claude-haiku-4-5-20251001', 'claude-opus-5'],
    },
    {
        kind: 'google',
        label: 'Google Gemini',
        category: 'cloud',
        protocol: 'openai',
        defaultBaseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
        requiresKey: true,
        browserCapable: true,
        description: 'Gemini über den OpenAI-kompatiblen Endpunkt.',
        docsUrl: 'https://ai.google.dev',
        exampleModels: ['gemini-2.5-flash', 'gemini-2.5-pro'],
    },
    {
        kind: 'mistral',
        label: 'Mistral AI',
        category: 'cloud',
        protocol: 'openai',
        defaultBaseUrl: 'https://api.mistral.ai/v1',
        requiresKey: true,
        browserCapable: true,
        description: 'Mistral-Modelle (EU-Anbieter).',
        docsUrl: 'https://docs.mistral.ai',
        exampleModels: ['mistral-large-latest', 'mistral-small-latest'],
    },
    {
        kind: 'groq',
        label: 'Groq',
        category: 'cloud',
        protocol: 'openai',
        defaultBaseUrl: 'https://api.groq.com/openai/v1',
        requiresKey: true,
        browserCapable: true,
        description: 'Sehr schnelle Inference für offene Modelle (LPU).',
        docsUrl: 'https://console.groq.com',
        exampleModels: ['llama-3.3-70b-versatile', 'openai/gpt-oss-120b'],
    },
    {
        kind: 'openrouter',
        label: 'OpenRouter',
        category: 'cloud',
        protocol: 'openai',
        defaultBaseUrl: 'https://openrouter.ai/api/v1',
        requiresKey: true,
        browserCapable: true,
        description: 'Ein Schlüssel, hunderte Modelle vieler Anbieter.',
        docsUrl: 'https://openrouter.ai',
        exampleModels: ['anthropic/claude-sonnet-4.5', 'openai/gpt-5.1', 'qwen/qwen3-235b-a22b'],
    },
    {
        kind: 'together',
        label: 'Together AI',
        category: 'cloud',
        protocol: 'openai',
        defaultBaseUrl: 'https://api.together.xyz/v1',
        requiresKey: true,
        browserCapable: true,
        description: 'Offene Modelle als gehostete API.',
        docsUrl: 'https://docs.together.ai',
    },
    {
        kind: 'deepseek',
        label: 'DeepSeek',
        category: 'cloud',
        protocol: 'openai',
        defaultBaseUrl: 'https://api.deepseek.com/v1',
        requiresKey: true,
        browserCapable: true,
        description: 'DeepSeek-Modelle (V3/R1).',
        docsUrl: 'https://platform.deepseek.com',
        exampleModels: ['deepseek-chat', 'deepseek-reasoner'],
    },
    {
        kind: 'xai',
        label: 'xAI Grok',
        category: 'cloud',
        protocol: 'openai',
        defaultBaseUrl: 'https://api.x.ai/v1',
        requiresKey: true,
        browserCapable: true,
        description: 'Grok-Modelle über die xAI-API.',
        docsUrl: 'https://docs.x.ai',
        exampleModels: ['grok-4', 'grok-4-fast'],
    },
    {
        kind: 'custom',
        label: 'Eigener Endpunkt',
        category: 'cloud',
        protocol: 'openai',
        defaultBaseUrl: '',
        requiresKey: false,
        browserCapable: true,
        description: 'Beliebiger OpenAI-kompatibler Endpunkt (Proxy, Gateway, Self-Hosted).',
    },
];

export function getPreset(kind: ProviderKind): ProviderPreset {
    const preset = PROVIDER_PRESETS.find(p => p.kind === kind);
    // 'custom' is the safe fallback for unknown kinds from older configs.
    return preset ?? PROVIDER_PRESETS[PROVIDER_PRESETS.length - 1];
}

export function protocolForKind(kind: ProviderKind): ProviderProtocol {
    return getPreset(kind).protocol;
}
