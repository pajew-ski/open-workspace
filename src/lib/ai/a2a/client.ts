/**
 * Minimal A2A (Agent2Agent) protocol client: agent card discovery and
 * JSON-RPC message exchange. Isomorphic — runs in the browser (CORS
 * permitting) and on the server (relay path).
 *
 * Implements the happy path of the spec (message/send with text parts,
 * task polling via tasks/get) plus fallbacks for older card locations
 * and the legacy tasks/send method.
 */

export interface A2AAgentCard {
    name: string;
    description: string;
    /** JSON-RPC endpoint URL. */
    url: string;
    version?: string;
    capabilities?: Record<string, unknown>;
    skills?: Array<{ id?: string; name?: string; description?: string }>;
    /** Where the card was found (debug/UI). */
    cardUrl: string;
}

/** Well-known card locations, newest spec first (shared with the graph connector). */
export const CARD_PATHS = ['/.well-known/agent-card.json', '/.well-known/agent.json'];

/**
 * Candidate card URLs for an input that may be an origin, a full card URL
 * (".../*.json") or the JSON-RPC endpoint. Single source of the discovery
 * order for `fetchAgentCard` and the `a2a-agent-card` graph connector.
 */
export function agentCardCandidates(input: string): string[] {
    const trimmed = input.trim().replace(/\/+$/, '');
    if (trimmed.endsWith('.json')) return [trimmed];
    const candidates = CARD_PATHS.map(path => `${trimmed}${path}`);
    candidates.push(trimmed); // some agents serve the card at their root
    return candidates;
}
const FETCH_TIMEOUT_MS = 10_000;
const POLL_INTERVAL_MS = 1_500;
const MAX_POLLS = 20;

interface JsonRpcResponse {
    result?: unknown;
    error?: { code?: number; message?: string };
}

function normalizeCard(data: Record<string, unknown>, cardUrl: string, origin: string): A2AAgentCard {
    return {
        name: typeof data.name === 'string' ? data.name : 'Unbenannter Agent',
        description: typeof data.description === 'string' ? data.description : '',
        url: typeof data.url === 'string' ? data.url : origin,
        version: typeof data.version === 'string' ? data.version : undefined,
        capabilities: (data.capabilities as Record<string, unknown>) ?? undefined,
        skills: Array.isArray(data.skills) ? (data.skills as A2AAgentCard['skills']) : undefined,
        cardUrl,
    };
}

/**
 * Discover an agent card. Accepts an origin ("https://agent.example"),
 * a full card URL (".../agent-card.json") or the JSON-RPC endpoint.
 */
export async function fetchAgentCard(input: string, headers?: Record<string, string>): Promise<A2AAgentCard> {
    const candidates = agentCardCandidates(input);

    let lastError = '';
    for (const candidate of candidates) {
        try {
            const response = await fetch(candidate, {
                headers: { Accept: 'application/json', ...headers },
                signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
            });
            if (!response.ok) {
                lastError = `HTTP ${response.status} bei ${candidate}`;
                continue;
            }
            const data = await response.json();
            if (data && typeof data === 'object' && ('name' in data || 'url' in data)) {
                const origin = new URL(candidate).origin;
                return normalizeCard(data as Record<string, unknown>, candidate, origin);
            }
            lastError = `Keine Agent Card unter ${candidate}`;
        } catch (error) {
            lastError = error instanceof Error ? error.message : 'Netzwerkfehler';
        }
    }
    throw new Error(`Agent Card nicht gefunden: ${lastError}`);
}

function extractTextFromParts(parts: unknown): string[] {
    if (!Array.isArray(parts)) return [];
    const texts: string[] = [];
    for (const part of parts) {
        if (part && typeof part === 'object') {
            const p = part as { kind?: string; type?: string; text?: string };
            if ((p.kind === 'text' || p.type === 'text') && typeof p.text === 'string') {
                texts.push(p.text);
            }
        }
    }
    return texts;
}

/** Pull all text out of a Message | Task result object. */
function extractText(result: unknown): { text: string; taskId?: string; state?: string } {
    if (!result || typeof result !== 'object') return { text: '' };
    const obj = result as Record<string, unknown>;

    // Direct Message reply
    if (obj.kind === 'message' || obj.role === 'agent' || (obj.parts && !obj.status)) {
        return { text: extractTextFromParts(obj.parts).join('\n') };
    }

    // Task object
    const taskId = typeof obj.id === 'string' ? obj.id : undefined;
    const status = obj.status as Record<string, unknown> | undefined;
    const state = status && typeof status.state === 'string' ? status.state : undefined;
    const texts: string[] = [];

    const statusMessage = status?.message as Record<string, unknown> | undefined;
    if (statusMessage?.parts) texts.push(...extractTextFromParts(statusMessage.parts));

    if (Array.isArray(obj.artifacts)) {
        for (const artifact of obj.artifacts) {
            const a = artifact as { parts?: unknown };
            texts.push(...extractTextFromParts(a.parts));
        }
    }
    return { text: texts.join('\n'), taskId, state };
}

async function rpc(
    endpointUrl: string,
    method: string,
    params: Record<string, unknown>,
    headers?: Record<string, string>
): Promise<JsonRpcResponse> {
    const response = await fetch(endpointUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...headers },
        body: JSON.stringify({ jsonrpc: '2.0', id: crypto.randomUUID(), method, params }),
        signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok) {
        throw new Error(`Agent antwortet mit HTTP ${response.status}`);
    }
    return response.json();
}

const TERMINAL_STATES = new Set(['completed', 'failed', 'canceled', 'rejected', 'input-required']);

/**
 * Send a text message to an A2A agent and return the agent's text reply.
 * Handles both direct Message replies and Task lifecycles (polling).
 */
export async function sendA2AMessage(
    endpointUrl: string,
    text: string,
    headers?: Record<string, string>
): Promise<string> {
    const message = {
        role: 'user',
        parts: [{ kind: 'text', text }],
        messageId: crypto.randomUUID(),
        kind: 'message',
    };

    let response = await rpc(endpointUrl, 'message/send', { message }, headers);
    if (response.error && (response.error.code === -32601 || /method/i.test(response.error.message ?? ''))) {
        // Legacy agents (pre message/send): tasks/send
        response = await rpc(endpointUrl, 'tasks/send', {
            id: crypto.randomUUID(),
            message: { role: 'user', parts: [{ type: 'text', text }] },
        }, headers);
    }
    if (response.error) {
        throw new Error(`Agent-Fehler: ${response.error.message ?? 'unbekannt'} (${response.error.code ?? '—'})`);
    }

    const initial = extractText(response.result);
    const taskId = initial.taskId;
    let resultText = initial.text;
    let state = initial.state;

    // Poll unfinished tasks until they reach a terminal state.
    let polls = 0;
    while (taskId && state && !TERMINAL_STATES.has(state) && polls < MAX_POLLS) {
        await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));
        const poll = await rpc(endpointUrl, 'tasks/get', { id: taskId }, headers);
        if (poll.error) break;
        const extracted = extractText(poll.result);
        resultText = extracted.text || resultText;
        state = extracted.state;
        polls += 1;
    }

    if (state === 'failed') {
        throw new Error(resultText || 'Der Agent hat die Aufgabe als fehlgeschlagen gemeldet.');
    }
    return resultText || '(Der Agent hat keine Textantwort geliefert.)';
}
