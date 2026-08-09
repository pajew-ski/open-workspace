/**
 * HTTP-Hülle des MCP-Servers (SPEC §7.6, M10) — transportfrei testbar.
 *
 * Streamable HTTP über die Web-Standard-Bindung der offiziellen SDK
 * (`WebStandardStreamableHTTPServerTransport`): POST für JSON-RPC (Antwort
 * als SSE-Strom oder JSON), GET für den serverinitiierten SSE-Strom,
 * DELETE zum Beenden der Sitzung. Damit sprechen wir dieselbe
 * Protokollimplementierung, die auch unser MCP-Client benutzt — kein
 * nachgebautes Protokoll.
 *
 * Sicherheitsmodell (§7.6):
 *  - **Jede** Anfrage trägt ein Bearer-Token aus `OW_MCP_TOKENS`. Ohne
 *    konfigurierte Tokens ist der Endpoint aus (503), nicht offen.
 *  - Sitzungen sind an die Token-Identität gebunden: eine Session-ID aus
 *    einem anderen Token ist unbekannt (404), nicht übernehmbar.
 *  - Das erlaubte Dataset wird PRO ANFRAGE neu aus dem Grant abgeleitet —
 *    ein Graph, den das Token nicht lesen darf, ist auch über Hops nicht
 *    erreichbar (die Klammer sitzt in retrievalDataset/resolveDataset).
 *  - Rate-Limit pro Token (gleitendes Minutenfenster) und Zeitbudget pro
 *    Werkzeug sind Pflicht.
 */

import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { GraphHandle, RetrievalDeps } from '../search/retrieval';
import { grantForToken, bearerFromHeaders, findMcpToken, type McpTokenConfig, type McpTokenParseResult, MCP_TOKENS_ENV } from './tokens';
import { createGraphMcpServer, registerRetrievalPrompts } from './server';
import type { McpGraphContext } from './tools';
import { RateLimiter } from './limits';

export interface McpHostDeps {
    /** Store + IRI-Fabrik (lazy, damit der Prozess ohne MCP nichts lädt). */
    graph: () => Promise<GraphHandle>;
    /** Token-Konfiguration inklusive Konfigurationsfehler. */
    tokens: () => McpTokenParseResult;
    /** `capabilities.mcpServer` der Runtime (SPEC §5.2). */
    capable: boolean;
    /** Seed-Quellen für ein Dataset (M8-Index-Cache bzw. Test-Index). */
    retrievalDeps?: (handle: GraphHandle, dataset: readonly string[]) => Promise<RetrievalDeps>;
    /** Nachbereitung nach graph_write (Snapshot + Index-Invalidierung). */
    afterWrite?: () => Promise<void>;
    now?: () => Date;
    /** Monotone Uhr des Rate-Limiters (Tests: stellbar). */
    clock?: () => number;
    /** Session-ID-Erzeugung (Tests: deterministisch). */
    sessionId?: () => string;
}

interface Session {
    id: string;
    tokenId: string;
    transport: WebStandardStreamableHTTPServerTransport;
    server: McpServer;
    ctx: McpGraphContext;
    lastSeen: number;
}

const SESSION_IDLE_MS = 30 * 60_000;

function jsonRpcError(status: number, code: number, message: string, extraHeaders: Record<string, string> = {}): Response {
    return new Response(
        JSON.stringify({ jsonrpc: '2.0', error: { code, message }, id: null }),
        { status, headers: { 'Content-Type': 'application/json', ...extraHeaders } },
    );
}

function isInitializeRequest(body: unknown): boolean {
    const check = (value: unknown): boolean =>
        typeof value === 'object' && value !== null && (value as { method?: unknown }).method === 'initialize';
    return Array.isArray(body) ? body.some(check) : check(body);
}

/**
 * Hält die offenen MCP-Sitzungen eines Prozesses. Die Route erzeugt genau
 * einen Host (Dev-Hot-Reload-sicher über globalThis).
 */
export class McpHost {
    private readonly sessions = new Map<string, Session>();
    private readonly limiter: RateLimiter;

    constructor(private readonly deps: McpHostDeps) {
        this.limiter = new RateLimiter(deps.clock ?? Date.now);
    }

    /** Offene Sitzungen (Status-API). */
    get sessionCount(): number {
        this.sweep();
        return this.sessions.size;
    }

    private now(): number {
        return (this.deps.clock ?? Date.now)();
    }

    private sweep(): void {
        const cutoff = this.now() - SESSION_IDLE_MS;
        for (const [id, session] of this.sessions) {
            if (session.lastSeen < cutoff) {
                this.sessions.delete(id);
                void session.transport.close().catch(() => undefined);
            }
        }
        this.limiter.prune();
    }

    async handle(request: Request): Promise<Response> {
        if (!this.deps.capable) {
            return jsonRpcError(503, -32000,
                'Der MCP-Server ist in dieser Runtime nicht verfügbar (capabilities.mcpServer = false).');
        }
        const config = this.deps.tokens();
        if (config.errors.length > 0) {
            return jsonRpcError(503, -32000, `MCP-Konfiguration fehlerhaft: ${config.errors.join(' | ')}`);
        }
        if (config.tokens.length === 0) {
            return jsonRpcError(503, -32000,
                `Kein MCP-Zugang konfiguriert. Setze ${MCP_TOKENS_ENV} (JSON-Liste mit id, token, scopes), ` +
                'dann ist /api/mcp erreichbar.');
        }

        const presented = bearerFromHeaders(request.headers);
        if (!presented) {
            return jsonRpcError(401, -32001, 'Bearer-Token fehlt (Authorization: Bearer <token>).', {
                'WWW-Authenticate': 'Bearer realm="open-workspace-graph"',
            });
        }
        const token = await findMcpToken(config.tokens, presented);
        if (!token) {
            return jsonRpcError(401, -32001, 'Unbekanntes MCP-Token.', {
                'WWW-Authenticate': 'Bearer realm="open-workspace-graph", error="invalid_token"',
            });
        }

        const decision = this.limiter.check(token.id, token.rateLimitPerMinute);
        if (!decision.allowed) {
            return jsonRpcError(429, -32002,
                `Rate-Limit erreicht (${token.rateLimitPerMinute}/min). Erneut versuchen in ${decision.retryAfterSeconds} s.`,
                { 'Retry-After': String(decision.retryAfterSeconds) });
        }

        this.sweep();

        let parsedBody: unknown;
        if (request.method === 'POST') {
            const raw = await request.text();
            try {
                parsedBody = JSON.parse(raw);
            } catch {
                return jsonRpcError(400, -32700, 'Ungültiges JSON im Request-Body.');
            }
        }

        const sessionId = request.headers.get('mcp-session-id');
        if (sessionId) {
            const session = this.sessions.get(sessionId);
            // Fremde oder unbekannte Sitzung sieht identisch aus: eine
            // Session-ID ist nicht über Tokengrenzen hinweg übernehmbar.
            if (!session || session.tokenId !== token.id) {
                return jsonRpcError(404, -32003, 'Unbekannte MCP-Sitzung.');
            }
            session.lastSeen = this.now();
            session.ctx.grant = await this.grantFor(token, session.ctx.handle);
            return session.transport.handleRequest(request, parsedBody === undefined ? undefined : { parsedBody });
        }

        if (request.method !== 'POST' || !isInitializeRequest(parsedBody)) {
            return jsonRpcError(400, -32000,
                'Ohne Sitzung ist nur ein initialize-POST erlaubt (Header mcp-session-id fehlt).');
        }

        const session = await this.createSession(token);
        return session.transport.handleRequest(request, { parsedBody });
    }

    private async grantFor(token: McpTokenConfig, handle: GraphHandle) {
        const existing = (await handle.store.graphs()).map(g => g.value);
        return grantForToken(token, handle.iri, existing).grant;
    }

    private async createSession(token: McpTokenConfig): Promise<Session> {
        const handle = await this.deps.graph();
        const grant = await this.grantFor(token, handle);
        const ctx: McpGraphContext = {
            handle,
            grant,
            ...(this.deps.retrievalDeps
                ? { retrievalDeps: (dataset: readonly string[]) => this.deps.retrievalDeps!(handle, dataset) }
                : {}),
            ...(this.deps.afterWrite ? { afterWrite: this.deps.afterWrite } : {}),
            ...(this.deps.now ? { now: this.deps.now } : {}),
        };
        const server = createGraphMcpServer(ctx);
        await registerRetrievalPrompts(server, ctx);

        // Die Session-ID wird hier erzeugt (nicht erst im Transport),
        // damit die Bindung an die Token-Identität VOR der ersten Antwort
        // in der Tabelle steht — es gibt kein Fenster, in dem eine Sitzung
        // ohne Eigentümer existiert.
        const id = (this.deps.sessionId ?? (() => globalThis.crypto.randomUUID()))();
        const transport = new WebStandardStreamableHTTPServerTransport({
            sessionIdGenerator: () => id,
            onsessionclosed: closed => {
                this.sessions.delete(closed);
            },
        });
        transport.onclose = () => {
            this.sessions.delete(id);
        };
        await server.connect(transport);
        const session: Session = { id, tokenId: token.id, transport, server, ctx, lastSeen: this.now() };
        this.sessions.set(id, session);
        return session;
    }

    /** Beendet alle Sitzungen (Tests, Shutdown). */
    async closeAll(): Promise<void> {
        const sessions = [...this.sessions.values()];
        this.sessions.clear();
        await Promise.all(sessions.map(s => s.transport.close().catch(() => undefined)));
    }
}
