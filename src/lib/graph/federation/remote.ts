/**
 * Ausgehender SPARQL-Protokoll-Client für `SERVICE` (SPEC §7.4, M11).
 *
 * Ein föderierter Aufruf ist nichts anderes als eine SPARQL-1.1-Protocol-
 * Anfrage an einen fremden Endpoint. Verbindlich für jeden solchen
 * Aufruf (§7.4):
 *
 *  - **SSRF-Absicherung**: derselbe geschützte fetch wie bei Connector-
 *    Pulls (`connectors/http.ts` — nur http(s), keine privaten Ziele ohne
 *    `ALLOW_LOCAL_TOOL_URLS=1`, jeder Redirect-Hop wird erneut geprüft).
 *  - **Timeout** und **Ergebnis-Limit** sind Pflicht, nicht optional. Ein
 *    überschrittenes Limit ist ein Fehler, keine stille Kürzung — ein
 *    abgeschnittenes Ergebnis wäre ein falsches Ergebnis.
 *
 * Geantwortet wird in SPARQL-Results-JSON; die Bindungen kommen als
 * RDF/JS-Terme zurück, damit der Planer sie unverändert als `VALUES`
 * einsetzen kann.
 */

import type { Term } from '@rdfjs/types';
import { literal, namedNode } from '../rdf';
import { createGuardedFetch, ConnectorFetchError } from '../connectors/http';

export const FEDERATION_DEFAULTS = {
    /** Zeitbudget je entferntem Aufruf. */
    timeoutMs: 15_000,
    /** Höchstzahl Zeilen je entferntem Aufruf. */
    maxRows: 5_000,
    /** Antwort-Größenlimit je entferntem Aufruf. */
    maxBytes: 8 * 1024 * 1024,
    /** Join-Schlüssel pro Bound-Join-Anfrage. */
    bindChunkSize: 50,
    /** Mehr Join-Schlüssel als das → eigenständige Auswertung. */
    maxBindings: 500,
} as const;

export class FederationError extends Error {
    constructor(message: string, readonly code: 'BLOCKED' | 'TIMEOUT' | 'HTTP' | 'FORMAT' | 'LIMIT' | 'NETWORK') {
        super(message);
        this.name = 'FederationError';
    }
}

interface JsonTerm {
    type: string;
    value: unknown;
    'xml:lang'?: string;
    datatype?: string;
}

/** Ein Ergebnis-Term des fremden Endpoints als RDF/JS-Term. */
function termFromJson(raw: unknown): Term | null {
    if (typeof raw !== 'object' || raw === null) return null;
    const json = raw as JsonTerm;
    if (typeof json.value !== 'string') return null;
    switch (json.type) {
        case 'uri':
            return namedNode(json.value);
        case 'literal':
        case 'typed-literal':
            if (json['xml:lang']) return literal(json.value, json['xml:lang']);
            if (json.datatype) return literal(json.value, namedNode(json.datatype));
            return literal(json.value);
        case 'bnode':
            // Blank Nodes des Endpoints haben außerhalb seines Ergebnisses
            // keine Identität. Der Aufrufer entscheidet, was damit
            // geschieht (siehe service.ts: Zeile wird verworfen + gemeldet).
            return null;
        default:
            return null;
    }
}

export interface RemoteBindingsResult {
    variables: string[];
    rows: Array<Record<string, Term>>;
    /** Zeilen, die einen Blank Node trugen und deshalb entfielen. */
    droppedRows: number;
    durationMs: number;
}

export interface RemoteQueryOptions {
    timeoutMs?: number;
    maxRows?: number;
    maxBytes?: number;
    /** Basis-fetch (Tests injizieren hier einen Stub). */
    fetchImpl?: typeof fetch;
    /** Uhr für die Dauer-Messung (Tests: stellbar). */
    clock?: () => number;
    /** User-Agent des ausgehenden Aufrufs. */
    userAgent?: string;
}

const DEFAULT_USER_AGENT = 'open-workspace-graph/1.0 (SPARQL federation; +https://github.com/pajew-ski/open-workspace)';

function parseResults(payload: string, maxRows: number): Omit<RemoteBindingsResult, 'durationMs'> {
    let parsed: unknown;
    try {
        parsed = JSON.parse(payload);
    } catch {
        throw new FederationError('Antwort ist kein SPARQL-Results-JSON.', 'FORMAT');
    }
    if (typeof parsed !== 'object' || parsed === null) {
        throw new FederationError('Antwort ist kein SPARQL-Results-JSON.', 'FORMAT');
    }
    const body = parsed as { head?: { vars?: unknown }; results?: { bindings?: unknown }; boolean?: unknown };
    if (typeof body.boolean === 'boolean') {
        // ASK: eine Lösung ohne Variablen (true) bzw. keine (false).
        return { variables: [], rows: body.boolean ? [{}] : [], droppedRows: 0 };
    }
    const rawRows = body.results?.bindings;
    if (!Array.isArray(rawRows)) {
        throw new FederationError('Antwort enthält keine results.bindings.', 'FORMAT');
    }
    if (rawRows.length > maxRows) {
        throw new FederationError(
            `Ergebnis-Limit überschritten: ${rawRows.length} Zeilen, erlaubt sind ${maxRows}. ` +
            'Schränke das SERVICE-Muster ein (LIMIT, Filter) — abgeschnitten wird nichts.',
            'LIMIT',
        );
    }
    const variables = Array.isArray(body.head?.vars)
        ? (body.head!.vars as unknown[]).filter((v): v is string => typeof v === 'string')
        : [];
    const rows: Array<Record<string, Term>> = [];
    let droppedRows = 0;
    for (const rawRow of rawRows) {
        if (typeof rawRow !== 'object' || rawRow === null) continue;
        const row: Record<string, Term> = {};
        let dropped = false;
        for (const [name, value] of Object.entries(rawRow as Record<string, unknown>)) {
            const term = termFromJson(value);
            if (!term) { dropped = true; break; }
            row[name] = term;
        }
        if (dropped) { droppedRows += 1; continue; }
        rows.push(row);
    }
    const seen = new Set(variables);
    for (const row of rows) {
        for (const name of Object.keys(row)) {
            if (!seen.has(name)) { seen.add(name); variables.push(name); }
        }
    }
    return { variables, rows, droppedRows };
}

/**
 * Führt eine SELECT/ASK-Query gegen einen fremden Endpoint aus.
 * POST mit `application/sparql-query` (GET-URLs sprengen bei
 * Bound-Joins die Längenbegrenzung von Servern und Proxys).
 */
export async function remoteSelect(
    endpointUrl: string,
    query: string,
    options: RemoteQueryOptions = {},
): Promise<RemoteBindingsResult> {
    const timeoutMs = options.timeoutMs ?? FEDERATION_DEFAULTS.timeoutMs;
    const maxRows = options.maxRows ?? FEDERATION_DEFAULTS.maxRows;
    const maxBytes = options.maxBytes ?? FEDERATION_DEFAULTS.maxBytes;
    const clock = options.clock ?? Date.now;
    const guardedFetch = createGuardedFetch({
        timeoutMs,
        maxBytes,
        ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    });

    const started = clock();
    let response: Response;
    try {
        response = await guardedFetch(endpointUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/sparql-query',
                Accept: 'application/sparql-results+json',
                'User-Agent': options.userAgent ?? DEFAULT_USER_AGENT,
            },
            body: query,
        });
    } catch (error) {
        if (error instanceof ConnectorFetchError) {
            const code = error.code === 'TIMEOUT' ? 'TIMEOUT' : error.code === 'BLOCKED_URL' ? 'BLOCKED' : 'NETWORK';
            throw new FederationError(error.message, code);
        }
        throw new FederationError(
            `Netzwerkfehler beim Aufruf von ${endpointUrl}: ${error instanceof Error ? error.message : String(error)}`,
            'NETWORK',
        );
    }
    if (!response.ok) {
        const detail = (await response.text().catch(() => '')).slice(0, 300).trim();
        throw new FederationError(
            `Endpoint antwortete mit HTTP ${response.status}${detail ? `: ${detail}` : ''}.`,
            'HTTP',
        );
    }
    const payload = await response.text();
    if (payload.length > maxBytes) {
        throw new FederationError(`Antwort zu groß (> ${maxBytes} Bytes).`, 'LIMIT');
    }
    const parsed = parseResults(payload, maxRows);
    return { ...parsed, durationMs: clock() - started };
}

export interface ProbeResult {
    reachable: boolean;
    /** Deutsche Begründung — auch im Erfolgsfall gefüllt. */
    message: string;
    durationMs: number;
    checkedAt: string;
}

/**
 * Erreichbarkeits-Probe eines Endpoints (§7.4: „probe pro Endpoint und
 * markiere nicht erreichbare in der UI ehrlich als solche"). Bewusst die
 * billigste sinnvolle Query — `ASK { ?s ?p ?o }` — mit kurzem Zeitbudget.
 */
export async function probeEndpoint(
    endpointUrl: string,
    options: RemoteQueryOptions & { now?: () => Date } = {},
): Promise<ProbeResult> {
    const checkedAt = (options.now ? options.now() : new Date()).toISOString();
    try {
        const result = await remoteSelect(endpointUrl, 'ASK { ?s ?p ?o }', {
            ...options,
            timeoutMs: options.timeoutMs ?? 8_000,
            maxRows: 1,
        });
        return {
            reachable: true,
            message: `Erreichbar (${result.durationMs} ms).`,
            durationMs: result.durationMs,
            checkedAt,
        };
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { reachable: false, message, durationMs: 0, checkedAt };
    }
}
