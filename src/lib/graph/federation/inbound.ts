/**
 * Eingehende Föderation (SPEC §7.4, M11) — der eigene Endpoint als
 * föderierbare Quelle für fremde Workspaces und SPARQL-Clients.
 *
 * „Ein roher SPARQL-Endpoint kennt keine Berechtigungen: jede eingehende
 * Query sieht, was der Store sieht." Genau deshalb ist dieser Pfad kein
 * zweiter Sicherheitsmechanismus, sondern dieselbe Verengung wie beim
 * MCP-Server (M10):
 *
 *  - Das erlaubte Dataset wird aus der **authentifizierten Identität**
 *    abgeleitet (`AccessGrant`) und über `resolveDataset` in die Query
 *    **injiziert** — `FROM`/`FROM NAMED` des Aufrufers werden dabei
 *    überschrieben. Es gibt keinen Nachfilter auf dem Ergebnis.
 *  - **Default ohne gültiges Token: das leere Dataset.** Die Query läuft,
 *    sieht aber nichts. Kein 401, keine Existenzbestätigung — ein
 *    fremder Client erfährt nicht einmal, welche Graphen es gibt.
 *  - Nur lesend: UPDATE ist gesperrt (`readOnly`).
 *  - **Kein ausgehendes `SERVICE`**: der Endpoint ist keine Relaisstation.
 *    Sonst könnte ein fremder Client über uns Adressen erreichen, die
 *    ihm selbst verschlossen sind (Confused Deputy).
 *  - Zeitbudget, Ergebnis-Limit und Rate-Limit pro Identität sind Pflicht.
 *
 * Tokens kommen bis M13 aus derselben Konfiguration wie beim MCP-Server
 * (`OW_MCP_TOKENS`, Recht `sparql`) — eine Rechte-Welt, nicht zwei.
 *
 * MIGRATION: Mit M13 kommt das erlaubte Dataset aus `graph/acl` statt aus
 * der Token-Liste. Diese Datei ändert sich dadurch nicht — sie kennt nur
 * `AccessGrant`; getauscht wird ausschließlich die Herkunft des Grants.
 */

import type { GraphStore } from '../store/types';
import type { IriFactory } from '../iri';
import { executeSparqlProtocol, type SparqlProtocolRequest } from '../sparql/protocol';
import { sparqlHttpResponse, sparqlRequestFromHttp, SparqlBodyTooLargeError } from '../sparql/http';
import { bearerFromHeaders, findMcpToken, grantForToken, MCP_TOKENS_ENV, type McpTokenParseResult } from '../mcp/tokens';
import { RateLimiter } from '../mcp/limits';
import { hasServiceClause } from './service';

export interface InboundGraphHandle {
    store: GraphStore;
    iri: IriFactory;
}

export interface FederationEndpointDeps {
    graph: () => Promise<InboundGraphHandle>;
    tokens: () => McpTokenParseResult;
    /** `capabilities.federationInbound` der Runtime (SPEC §5.2). */
    capable: boolean;
    /** Zeitbudget einer eingehenden Query. */
    timeoutMs?: number;
    /** Ergebnis-Limit einer eingehenden Query. */
    maxRows?: number;
    /** Anfragen pro Minute ohne Token. */
    anonymousRateLimit?: number;
    clock?: () => number;
}

const DEFAULTS = {
    timeoutMs: 10_000,
    maxRows: 10_000,
    anonymousRateLimit: 30,
} as const;

/**
 * CORS: Föderation aus einem Browser heraus ist ohne diese Header
 * unmöglich (SPEC §7.4 nennt die CORS-Abhängigkeit ausdrücklich).
 * `*` ist hier unbedenklich, weil die Authentifizierung über ein
 * Bearer-Token läuft — es gibt keine Cookie-Identität, die eine fremde
 * Seite mitschicken könnte, und ohne Token ist das Dataset leer.
 */
const CORS_HEADERS: Record<string, string> = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type, Accept',
    'Access-Control-Max-Age': '600',
    Vary: 'Origin, Authorization',
};

function textResponse(status: number, message: string, extraHeaders: Record<string, string> = {}): Response {
    return new Response(`${message}\n`, {
        status,
        headers: { 'Content-Type': 'text/plain; charset=utf-8', ...CORS_HEADERS, ...extraHeaders },
    });
}

export interface InboundIdentity {
    /** Token-ID oder `null` für unauthentifizierte Zugriffe. */
    identity: string | null;
    /** Erlaubte Named Graphs — leer heißt: leeres Dataset. */
    allowedGraphs: readonly string[];
    rateLimitPerMinute: number;
}

export class FederationEndpointHost {
    private readonly limiter: RateLimiter;

    constructor(private readonly deps: FederationEndpointDeps) {
        this.limiter = new RateLimiter(deps.clock ?? Date.now);
    }

    /** Preflight für browserseitige Föderation. */
    options(): Response {
        return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    /**
     * Leitet Identität und erlaubtes Dataset aus dem Bearer-Token ab.
     * Unbekanntes oder fehlendes Token → leeres Dataset (kein Fehler).
     */
    async identify(
        request: Request,
        iri: IriFactory,
        existingGraphs: readonly string[],
    ): Promise<InboundIdentity | { refused: Response }> {
        const config = this.deps.tokens();
        const presented = bearerFromHeaders(request.headers);
        if (!presented) {
            return { identity: null, allowedGraphs: [], rateLimitPerMinute: this.deps.anonymousRateLimit ?? DEFAULTS.anonymousRateLimit };
        }
        const token = await findMcpToken(config.tokens, presented);
        if (!token) {
            // Kein 401: ein fremder Client soll nicht unterscheiden können,
            // ob ein Token existiert. Er sieht schlicht nichts.
            return { identity: null, allowedGraphs: [], rateLimitPerMinute: this.deps.anonymousRateLimit ?? DEFAULTS.anonymousRateLimit };
        }
        if (!token.sparql) {
            return {
                refused: textResponse(403,
                    `Token "${token.id}" hat kein SPARQL-Recht. Setze "sparql": true in ${MCP_TOKENS_ENV}, ` +
                    'wenn dieser Zugang föderieren soll.'),
            };
        }
        const { grant } = grantForToken(token, iri, existingGraphs);
        return {
            identity: grant.identity,
            allowedGraphs: grant.readableGraphs,
            rateLimitPerMinute: token.rateLimitPerMinute,
        };
    }

    async handle(request: Request, method: 'GET' | 'POST'): Promise<Response> {
        if (!this.deps.capable) {
            return textResponse(503,
                'Eingehende Föderation ist in dieser Runtime nicht verfügbar (capabilities.federationInbound = false).');
        }
        const config = this.deps.tokens();
        if (config.errors.length > 0) {
            // Fehlerhafte Konfiguration kippt nie nach „offen": solange die
            // Tokenliste nicht lesbar ist, kann niemand authentifiziert
            // werden — und dann wird auch niemand bedient.
            return textResponse(503, `Zugangs-Konfiguration fehlerhaft: ${config.errors.join(' | ')}`);
        }

        let protocolRequest: SparqlProtocolRequest;
        try {
            protocolRequest = await sparqlRequestFromHttp(request, method);
        } catch (error) {
            if (error instanceof SparqlBodyTooLargeError) return textResponse(413, error.message);
            throw error;
        }

        const queryText = protocolRequest.query ?? protocolRequest.body ?? '';
        if (queryText && hasServiceClause(queryText)) {
            return textResponse(400,
                'SERVICE ist auf dem eingehenden Föderations-Endpoint gesperrt — dieser Endpoint ist Quelle, ' +
                'kein Relais. Föderiere von deiner Seite aus.');
        }

        const handle = await this.deps.graph();
        const existing = (await handle.store.graphs()).map(g => g.value);
        const identified = await this.identify(request, handle.iri, existing);
        if ('refused' in identified) return identified.refused;

        const decision = this.limiter.check(identified.identity ?? 'anonym', identified.rateLimitPerMinute);
        if (!decision.allowed) {
            return textResponse(429,
                `Rate-Limit erreicht (${identified.rateLimitPerMinute}/min). Erneut versuchen in ${decision.retryAfterSeconds} s.`,
                { 'Retry-After': String(decision.retryAfterSeconds) });
        }

        const result = await executeSparqlProtocol(handle.store, handle.iri, protocolRequest, {
            readOnly: true,
            allowedGraphs: identified.allowedGraphs,
            timeoutMs: this.deps.timeoutMs ?? DEFAULTS.timeoutMs,
            maxRows: this.deps.maxRows ?? DEFAULTS.maxRows,
        });
        return sparqlHttpResponse(result, {
            ...CORS_HEADERS,
            'X-OW-Federation-Identity': identified.identity ?? 'anonym',
        });
    }
}
