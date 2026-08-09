/**
 * Ausgehende Föderation: `SERVICE` gegen registrierte Endpoints
 * (SPEC §7.4, M11).
 *
 * Warum ein eigener Planer? Die Oxigraph-Bindung für JavaScript hat
 * keinen Service-Handler — `SERVICE <…>` endet dort mit „the service is
 * not supported". Die Föderation lebt deshalb eine Schicht darüber, in
 * genau der Semantik, die SPARQL 1.1 Federated Query vorschreibt: das
 * entfernte Muster wird beim Endpoint ausgewertet, die Lösungsmenge kommt
 * zurück und wird lokal gejoint. Umgesetzt wird der Join, indem der
 * `SERVICE`-Block im Query-Text durch die entfernte Lösungsmenge als
 * `VALUES` ersetzt wird — der Store rechnet danach ganz normal weiter.
 *
 * Pflichten aus §7.4, alle nicht abschaltbar:
 *  - Nur **registrierte** Endpoints (`ow:FederatedEndpoint` in `graph/meta`).
 *  - Ausgehende Aufrufe laufen durch den SSRF-Guard (`remote.ts`).
 *  - Timeout und Ergebnis-Limit pro Aufruf; ein überschrittenes Limit ist
 *    ein Fehler, keine stille Kürzung.
 *  - Die Vertrauensstufe entscheidet, ob **lokale Werte** den Rechner
 *    verlassen dürfen:
 *      unknown → gesperrt,
 *      known   → eigenständige Auswertung, keine lokale Bindung geht raus,
 *      trusted → Bound-Join (lokale Join-Schlüssel als `VALUES` mitgeschickt).
 *
 * `SERVICE SILENT` verhält sich wie in der Spezifikation: ein Fehler wird
 * zur leeren Lösung statt zum Abbruch — aber er steht im Bericht, damit
 * die UI ihn zeigen kann.
 */

import type { Term } from '@rdfjs/types';
import type { GraphStore } from '../store/types';
import type { ResolvedDataset } from '../sparql/protocol';
import { termToNQuads } from '../serialize/nquads';
import { findServiceClauses, prologOf, spliceAll, variablesIn, maskSparql, type ServiceClause } from './parse';
import { FEDERATION_DEFAULTS, FederationError, remoteSelect, type RemoteBindingsResult } from './remote';
import type { FederatedEndpointRecord, TrustLevel } from './registry';

export interface FederationCallReport {
    endpointId: string | null;
    endpointUrl: string;
    trustLevel: TrustLevel | null;
    silent: boolean;
    mode: 'standalone' | 'bound-join' | 'refused';
    /** Zeilen, die vom Endpoint übernommen wurden. */
    rows: number;
    /** Lokale Join-Schlüssel, die mitgeschickt wurden (nur bound-join). */
    pushedBindings: number;
    /** Anzahl entfernter Anfragen (Bound-Join chunkt). */
    requests: number;
    /** Zeilen mit nicht einsetzbaren Termen (Blank Nodes, Triple Terms). */
    droppedRows: number;
    durationMs: number;
    error?: string;
}

export interface FederationReport {
    calls: FederationCallReport[];
}

/** Fehler mit HTTP-Status für den Protokoll-Layer. */
export class FederationRefusedError extends Error {
    constructor(message: string, readonly status: number) {
        super(message);
        this.name = 'FederationRefusedError';
    }
}

export interface FederationDeps {
    /** Registrierte Endpoints (Registry aus `graph/meta`). */
    endpoints: readonly FederatedEndpointRecord[];
    /** Lokaler Store — für die Bound-Join-Sonde. */
    store: GraphStore;
    /** Entfernter Aufruf (Tests injizieren hier einen Stub). */
    remote?: typeof remoteSelect;
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
    maxRows?: number;
    bindChunkSize?: number;
    maxBindings?: number;
    clock?: () => number;
}

function normalizeUrl(raw: string): string {
    try {
        return new URL(raw).toString();
    } catch {
        return raw;
    }
}

/** Ein Term als SPARQL-Literal/IRI für `VALUES`; null = nicht einsetzbar. */
function termToSparql(term: Term): string | null {
    if (term.termType === 'BlankNode' || term.termType === 'Quad' || term.termType === 'Variable') return null;
    if (term.termType === 'DefaultGraph') return null;
    return termToNQuads(term);
}

/**
 * Baut den `VALUES`-Block, der den `SERVICE`-Block ersetzt.
 * Ohne Variablen ist die Lösungsmenge entweder die leere Bindung (join-
 * neutral) oder leer (`FILTER(false)`).
 */
export function bindingsToValuesBlock(variables: string[], rows: Array<Record<string, Term>>): string {
    const used = variables.filter(name => rows.some(row => row[name] !== undefined));
    if (used.length === 0) {
        return rows.length > 0 ? '{ }' : '{ FILTER(false) }';
    }
    const lines = rows.map(row => {
        const cells = used.map(name => {
            const term = row[name];
            if (!term) return 'UNDEF';
            return termToSparql(term) ?? 'UNDEF';
        });
        return `    (${cells.join(' ')})`;
    });
    const head = used.map(name => `?${name}`).join(' ');
    return `{ VALUES (${head}) {\n${lines.join('\n')}\n  } }`;
}

/** Grenzen der Gruppe, in der die Klausel steht (inklusive Klammern). */
function enclosingGroup(query: string, clause: ServiceClause): { start: number; end: number } | null {
    const masked = maskSparql(query);
    let level = 0;
    const openStack: number[] = [];
    for (let i = 0; i < masked.length; i += 1) {
        if (masked[i] === '{') {
            openStack.push(i);
            level += 1;
        } else if (masked[i] === '}') {
            const open = openStack.pop();
            level -= 1;
            if (open !== undefined && open < clause.start && i > clause.end && level === 0) {
                return { start: open, end: i + 1 };
            }
        }
    }
    return null;
}

/**
 * Lokale Sonde für den Bound-Join: Welche Werte kann der lokale Teil der
 * Query für die gemeinsamen Variablen liefern?
 *
 * Die Sonde ist bewusst eine **Lockerung** der echten Query (alle
 * SERVICE-Blöcke der Gruppe entfallen, Solution Modifier ebenfalls) —
 * ihre Lösungsmenge ist damit eine Obermenge der echten Join-Schlüssel.
 * Eine Obermenge ist für den Bound-Join zulässig: sie schickt höchstens
 * zu viele Schlüssel, nie zu wenige. Liefert die Sonde nichts, wird
 * NICHT auf „leeres Ergebnis" geschlossen, sondern eigenständig
 * ausgewertet — Filter über den entfernten Variablen könnten die Sonde
 * fälschlich leeren.
 */
async function probeJoinKeys(
    query: string,
    clause: ServiceClause,
    clauses: readonly ServiceClause[],
    sharedVars: string[],
    deps: FederationDeps,
    dataset: ResolvedDataset,
    limit: number,
): Promise<Array<Record<string, Term>> | null> {
    const group = enclosingGroup(query, clause);
    if (!group) return null;
    const inside = clauses.filter(c => c.start >= group.start && c.end <= group.end);
    const remainder = spliceAll(
        query.slice(group.start, group.end),
        inside.map(c => ({ start: c.start - group.start, end: c.end - group.start, replacement: '' })),
    );
    const projection = sharedVars.map(name => `?${name}`).join(' ');
    const probe = `${prologOf(query)}\nSELECT DISTINCT ${projection} WHERE ${remainder} LIMIT ${limit}`;
    try {
        const result = await deps.store.query(probe, {
            defaultGraphs: dataset.defaultGraphs,
            namedGraphs: dataset.namedGraphs,
            timeoutMs: deps.timeoutMs ?? FEDERATION_DEFAULTS.timeoutMs,
        });
        if (result.type !== 'bindings') return null;
        const rows: Array<Record<string, Term>> = [];
        for await (const row of result.bindings) rows.push(row);
        return rows;
    } catch {
        // Die Sonde ist eine Optimierung. Scheitert sie, wird eigenständig
        // ausgewertet — nie falsch, höchstens langsamer.
        return null;
    }
}

function chunk<T>(items: readonly T[], size: number): T[][] {
    const out: T[][] = [];
    for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
    return out;
}

interface ClauseOutcome {
    replacement: string;
    report: FederationCallReport;
}

async function runClause(
    query: string,
    clause: ServiceClause,
    clauses: readonly ServiceClause[],
    deps: FederationDeps,
    dataset: ResolvedDataset,
): Promise<ClauseOutcome> {
    const remote = deps.remote ?? remoteSelect;
    const clock = deps.clock ?? Date.now;
    const maxBindings = deps.maxBindings ?? FEDERATION_DEFAULTS.maxBindings;
    const chunkSize = deps.bindChunkSize ?? FEDERATION_DEFAULTS.bindChunkSize;
    const base: FederationCallReport = {
        endpointId: null,
        endpointUrl: clause.endpointIri ?? `?${clause.endpointVariable ?? ''}`,
        trustLevel: null,
        silent: clause.silent,
        mode: 'refused',
        rows: 0,
        pushedBindings: 0,
        requests: 0,
        droppedRows: 0,
        durationMs: 0,
    };

    const refuse = (message: string, status: number): ClauseOutcome => {
        if (clause.silent) {
            return { replacement: '{ FILTER(false) }', report: { ...base, error: message } };
        }
        throw new FederationRefusedError(message, status);
    };

    if (!clause.endpointIri) {
        return refuse(
            `SERVICE ?${clause.endpointVariable} wird nicht unterstützt — der Endpoint muss als IRI dastehen ` +
            'und in der Registry stehen (Graph → Föderation).',
            400,
        );
    }
    const target = normalizeUrl(clause.endpointIri);
    const endpoint = deps.endpoints.find(e => normalizeUrl(e.url) === target);
    if (!endpoint) {
        return refuse(
            `Endpoint <${clause.endpointIri}> ist nicht registriert. Föderierte Abfragen laufen nur gegen ` +
            'Endpoints aus der Registry (Graph → Föderation).',
            403,
        );
    }
    base.endpointId = endpoint.id;
    base.endpointUrl = endpoint.url;
    base.trustLevel = endpoint.trustLevel;
    if (endpoint.trustLevel === 'unknown') {
        return refuse(
            `Endpoint "${endpoint.name}" hat die Vertrauensstufe "unknown" und ist für SERVICE gesperrt. ` +
            'Stufe ihn auf "known" (ohne lokale Bindungen) oder "trusted" (mit Bound-Join) hoch.',
            403,
        );
    }

    const remoteOptions = {
        ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
        timeoutMs: deps.timeoutMs ?? FEDERATION_DEFAULTS.timeoutMs,
        maxRows: deps.maxRows ?? FEDERATION_DEFAULTS.maxRows,
        clock,
    };

    // --- Bound-Join nur bei "trusted" und nur als reiner Join ----------
    let pushRows: Array<Record<string, Term>> | null = null;
    let pushVars: string[] = [];
    if (endpoint.trustLevel === 'trusted' && clause.depth === 1) {
        const patternVars = variablesIn(clause.pattern);
        const outsideText = spliceAll(query, [{ start: clause.start, end: clause.end, replacement: ' ' }]);
        const outsideVars = new Set(variablesIn(outsideText));
        const shared = patternVars.filter(name => outsideVars.has(name));
        if (shared.length > 0) {
            const probed = await probeJoinKeys(query, clause, clauses, shared, deps, dataset, maxBindings + 1);
            if (probed && probed.length > 0 && probed.length <= maxBindings) {
                pushVars = shared.filter(name => probed.some(row => row[name] !== undefined));
                if (pushVars.length > 0) pushRows = probed;
            }
        }
    }

    // Der Prolog der Ausgangs-Query geht mit: das entfernte Muster darf
    // die dort deklarierten Präfixe benutzen (und `BASE` gilt auch für
    // relative IRIs im Muster).
    const prolog = prologOf(query).trim();
    const remoteText = (body: string) => (prolog ? `${prolog}\n${body}` : body);

    const started = clock();
    const merged: RemoteBindingsResult = { variables: [], rows: [], droppedRows: 0, durationMs: 0 };
    try {
        if (pushRows && pushVars.length > 0) {
            base.mode = 'bound-join';
            base.pushedBindings = pushRows.length;
            for (const batch of chunk(pushRows, chunkSize)) {
                const values = bindingsToValuesBlock(pushVars, batch);
                const remoteQuery = remoteText(`SELECT * WHERE {\n  ${values}\n  {${clause.pattern}}\n}`);
                const result = await remote(endpoint.url, remoteQuery, remoteOptions);
                base.requests += 1;
                merged.rows.push(...result.rows);
                merged.droppedRows += result.droppedRows;
                for (const name of result.variables) {
                    if (!merged.variables.includes(name)) merged.variables.push(name);
                }
            }
        } else {
            base.mode = 'standalone';
            const remoteQuery = remoteText(`SELECT * WHERE {${clause.pattern}}`);
            const result = await remote(endpoint.url, remoteQuery, remoteOptions);
            base.requests = 1;
            merged.rows = result.rows;
            merged.droppedRows = result.droppedRows;
            merged.variables = result.variables;
        }
    } catch (error) {
        const message = error instanceof FederationError || error instanceof Error
            ? error.message
            : String(error);
        base.durationMs = clock() - started;
        if (clause.silent) {
            return { replacement: '{ FILTER(false) }', report: { ...base, error: message } };
        }
        throw new FederationRefusedError(
            `SERVICE <${endpoint.url}> fehlgeschlagen: ${message}`,
            error instanceof FederationError && (error.code === 'BLOCKED' || error.code === 'FORMAT') ? 400 : 502,
        );
    }

    base.durationMs = clock() - started;
    base.rows = merged.rows.length;
    base.droppedRows = merged.droppedRows;
    // Nur Variablen des Musters einsetzen — der Endpoint könnte in `head`
    // Variablen melden, die lokal nichts zu suchen haben.
    const patternVars = new Set(variablesIn(clause.pattern));
    const variables = merged.variables.filter(name => patternVars.has(name));
    return { replacement: bindingsToValuesBlock(variables, merged.rows), report: base };
}

export interface FederationPlan {
    /** Lokal ausführbare Query (SERVICE-Blöcke ersetzt). */
    query: string;
    report: FederationReport;
}

/**
 * Enthält der Query-Text einen `SERVICE`-Block? Eine Klausel, die sich
 * nicht lesen lässt, zählt als vorhanden — wer damit einen Torwächter
 * umgehen will, kommt nicht durch, weil die Frage im Zweifel „ja" ist.
 */
export function hasServiceClause(query: string): boolean {
    try {
        return findServiceClauses(query).length > 0;
    } catch {
        return true;
    }
}

/**
 * Löst alle `SERVICE`-Blöcke auf. Ohne SERVICE bleibt die Query
 * unverändert und es gibt keinen Netzverkehr.
 */
export async function planFederatedQuery(
    query: string,
    dataset: ResolvedDataset,
    deps: FederationDeps,
): Promise<FederationPlan> {
    const clauses = findServiceClauses(query);
    if (clauses.length === 0) return { query, report: { calls: [] } };
    const edits: Array<{ start: number; end: number; replacement: string }> = [];
    const calls: FederationCallReport[] = [];
    for (const clause of clauses) {
        const outcome = await runClause(query, clause, clauses, deps, dataset);
        edits.push({ start: clause.start, end: clause.end, replacement: outcome.replacement });
        calls.push(outcome.report);
    }
    return { query: spliceAll(query, edits), report: { calls } };
}

/**
 * Fasst einen Bericht für Header/UI zusammen — kurz genug für einen
 * HTTP-Header, vollständig genug, um zu erklären, was passiert ist.
 */
export function summarizeFederation(report: FederationReport): string {
    return report.calls
        .map(call => {
            const parts = [`${call.endpointId ?? call.endpointUrl}: ${call.mode}`, `${call.rows} Zeilen`];
            if (call.pushedBindings > 0) parts.push(`${call.pushedBindings} Bindungen gesendet`);
            if (call.droppedRows > 0) parts.push(`${call.droppedRows} Zeilen ohne einsetzbaren Term verworfen`);
            parts.push(`${call.durationMs} ms`);
            if (call.error) parts.push(`Fehler: ${call.error}`);
            return parts.join(', ');
        })
        .join(' | ');
}
