/**
 * Embedding-Anbindung der Graph-Suche (SPEC §7.7, M8) — serverseitig.
 *
 * Der Vektorindex (`src/lib/graph/search/vector.ts`) kennt nur das
 * `EmbeddingProvider`-Interface; DIESES Modul bindet es an die bestehende
 * AI-Schicht: ein konfigurierter Provider aus `data/ai/config.json` wird
 * per Umgebungsvariablen als Embedding-Quelle benannt:
 *
 *   OW_EMBEDDING_PROVIDER = Provider-ID oder -Label aus dem AI-Hub (/ai)
 *   OW_EMBEDDING_MODEL    = Embedding-Modell (z. B. "nomic-embed-text",
 *                           "text-embedding-3-small")
 *
 * Unterstützt sind die Protokolle `openai` (POST {base}/embeddings) und
 * `ollama` (POST {base}/api/embed). Ohne diese Konfiguration gibt es
 * KEINEN Vektorindex — die Suche meldet das ehrlich als nicht verfügbar
 * (Invariante 10), statt Embeddings vorzutäuschen.
 */

import type { EmbeddingProvider } from '@/lib/graph/search/vector';
import { loadAIConfig, resolveServerProvider } from './store.server';

export interface EmbeddingAvailability {
    available: boolean;
    /** Begründung, wenn nicht verfügbar (für UI/API-Diagnose). */
    reason?: string;
    providerLabel?: string;
    model?: string;
}

interface ResolvedEmbedding {
    provider: EmbeddingProvider;
    availability: EmbeddingAvailability;
}

const EMBED_TIMEOUT_MS = 60_000;

async function postJson(url: string, body: unknown, apiKey?: string): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), EMBED_TIMEOUT_MS);
    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
            },
            body: JSON.stringify(body),
            signal: controller.signal,
        });
        if (!response.ok) {
            const detail = (await response.text()).slice(0, 300);
            throw new Error(`Embedding-Endpunkt antwortete ${response.status}: ${detail}`);
        }
        return await response.json();
    } finally {
        clearTimeout(timer);
    }
}

function asVectorArray(value: unknown, count: number, source: string): number[][] {
    if (!Array.isArray(value) || value.length !== count || !value.every(v => Array.isArray(v))) {
        throw new Error(`Embedding-Antwort von ${source} hat nicht die erwartete Form (Vektor pro Text).`);
    }
    return (value as number[][]).map(vector => vector.map(Number));
}

function openAiEmbedding(baseUrl: string, model: string, id: string, apiKey?: string): EmbeddingProvider {
    const url = `${baseUrl.replace(/\/+$/, '')}/embeddings`;
    return {
        id,
        model,
        async embed(texts: string[]): Promise<number[][]> {
            if (texts.length === 0) return [];
            const raw = await postJson(url, { model, input: texts }, apiKey) as {
                data?: Array<{ index?: number; embedding?: unknown }>;
            };
            if (!Array.isArray(raw.data)) {
                throw new Error(`Embedding-Antwort von ${id} enthält kein data-Array.`);
            }
            const sorted = [...raw.data].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
            return asVectorArray(sorted.map(item => item.embedding), texts.length, id);
        },
    };
}

function ollamaEmbedding(baseUrl: string, model: string, id: string): EmbeddingProvider {
    const url = `${baseUrl.replace(/\/+$/, '')}/api/embed`;
    return {
        id,
        model,
        async embed(texts: string[]): Promise<number[][]> {
            if (texts.length === 0) return [];
            const raw = await postJson(url, { model, input: texts }) as { embeddings?: unknown };
            return asVectorArray(raw.embeddings, texts.length, id);
        },
    };
}

/**
 * Löst die konfigurierte Embedding-Quelle auf. `null`-Provider mit
 * Begründung, wenn keine (vollständige) Konfiguration existiert.
 */
export async function resolveEmbeddingProvider(): Promise<ResolvedEmbedding | { provider: null; availability: EmbeddingAvailability }> {
    const wanted = process.env.OW_EMBEDDING_PROVIDER?.trim();
    const model = process.env.OW_EMBEDDING_MODEL?.trim();
    if (!wanted || !model) {
        return {
            provider: null,
            availability: {
                available: false,
                reason: 'Keine Embedding-Quelle konfiguriert (OW_EMBEDDING_PROVIDER + OW_EMBEDDING_MODEL setzen; Provider im AI-Hub /ai anlegen).',
            },
        };
    }
    const config = await loadAIConfig();
    const provider = config.providers.find(p => p.id === wanted || p.label === wanted);
    if (!provider || !provider.enabled) {
        return {
            provider: null,
            availability: {
                available: false,
                reason: `Embedding-Provider "${wanted}" ist nicht konfiguriert oder deaktiviert (AI-Hub /ai).`,
            },
        };
    }
    const resolved = await resolveServerProvider(provider.id);
    if (!resolved) {
        return {
            provider: null,
            availability: { available: false, reason: `Provider "${provider.label}" ließ sich nicht auflösen.` },
        };
    }
    const id = `${provider.label} (${model})`;
    if (resolved.protocol === 'openai') {
        return {
            provider: openAiEmbedding(provider.baseUrl, model, id, resolved.apiKey),
            availability: { available: true, providerLabel: provider.label, model },
        };
    }
    if (resolved.protocol === 'ollama') {
        return {
            provider: ollamaEmbedding(provider.baseUrl, model, id),
            availability: { available: true, providerLabel: provider.label, model },
        };
    }
    return {
        provider: null,
        availability: {
            available: false,
            reason: `Protokoll "${resolved.protocol}" bietet keine Embeddings — nutze einen openai-kompatiblen oder Ollama-Provider.`,
        },
    };
}
