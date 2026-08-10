/**
 * SPARQL 1.1 Protocol (SPEC §7.1) — transportunabhängiger Executor.
 *
 * Die HTTP-Route (`/api/graph/sparql`) und der spätere In-Process-Pfad der
 * Runtime `local` rufen dieselbe Funktion mit identischer Signatur —
 * `capabilities.sparqlEndpoint` entscheidet nur, ob es die HTTP-Route gibt.
 *
 * Sicherheitsmodell (Dataset-Resolver, SPEC §17.3; seit M13 mit
 * ACL-Verengung über `allowedGraphs`/`writableGraphs`):
 *  - Das Dataset wird IMMER als default_graph/named_graphs in die Query
 *    injiziert und überschreibt `FROM`/`FROM NAMED` im Query-Text.
 *  - `allowedGraphs` und `writableGraphs` können ausschließlich wegnehmen.
 *    Sie kommen aus `authz/resolve.ts#grantForIdentity` — es gibt keinen
 *    zweiten Weg, ein Dataset zu bestimmen.
 *  - `graph/acl` ist über keinen Pfad erreichbar; `presentation` und
 *    `inferred/*` sind aus dem Default-Dataset ausgeschlossen und nur über
 *    explizite Protocol-Parameter erreichbar (SPEC §3.3).
 *  - Nicht erlaubte Graph-Anforderungen werden still verworfen — leeres
 *    Ergebnis statt Existenzbestätigung.
 *  - Ein GET führt nie ein UPDATE aus.
 *  - Updates laufen in einer Transaktion mit Schutz-Hash über
 *    systemverwaltete Graphen (vocab, meta, shapes, acl, import/*,
 *    inferred/*): jede Veränderung dort wird zurückgerollt.
 */

import type { NamedNode, Quad, Term } from '@rdfjs/types';
import type { GraphStore, QueryResult } from '../store/types';
import { GraphStoreError } from '../store/types';
import type { IriFactory } from '../iri';
import { namedNode } from '../rdf';
import { serializeRdf } from '../serialize/io';
import { quadToNQuadsLine } from '../serialize/nquads';

export interface SparqlProtocolRequest {
    method: 'GET' | 'POST';
    /** Content-Type des Request-Bodys (nur POST). */
    contentType?: string | null;
    accept?: string | null;
    /** Query aus URL-Parameter oder Formular. */
    query?: string | null;
    /** Update aus Formular (nur POST). */
    update?: string | null;
    /** Roh-Body für application/sparql-query bzw. application/sparql-update. */
    body?: string | null;
    defaultGraphUris?: string[];
    namedGraphUris?: string[];
}

export interface SparqlProtocolResponse {
    status: number;
    contentType: string;
    body: string;
}

const RESULT_JSON = 'application/sparql-results+json';
const CSV = 'text/csv';
const TSV = 'text/tab-separated-values';
const BINDINGS_TYPES = [RESULT_JSON, 'application/json', CSV, TSV];
const BOOLEAN_TYPES = [RESULT_JSON, 'application/json'];
const QUADS_TYPES = ['text/turtle', 'application/ld+json', 'application/json', 'application/n-quads', 'application/n-triples', 'text/trig'];

/** Einfache Accept-Verhandlung mit q-Werten und Wildcards. */
export function negotiate(accept: string | null | undefined, supported: string[], fallback: string): string {
    if (!accept || accept.trim() === '') return fallback;
    const candidates = accept
        .split(',')
        .map(part => {
            const [type, ...params] = part.trim().split(';');
            const qParam = params.map(p => p.trim()).find(p => p.startsWith('q='));
            const q = qParam ? Number.parseFloat(qParam.slice(2)) : 1;
            return { type: type.trim().toLowerCase(), q: Number.isFinite(q) ? q : 0 };
        })
        .filter(c => c.q > 0)
        .sort((a, b) => b.q - a.q);
    for (const candidate of candidates) {
        if (candidate.type === '*/*') return fallback;
        for (const type of supported) {
            if (candidate.type === type) return type;
            const [major] = type.split('/');
            if (candidate.type === `${major}/*`) return type;
        }
    }
    return '';
}

// --- Dataset-Auflösung ---------------------------------------------------

function graphScope(iriValue: string, base: string): string | null {
    if (!iriValue.startsWith(`${base}graph/`)) return null;
    return iriValue.slice(`${base}graph/`.length);
}

function isAclGraph(iriValue: string, base: string): boolean {
    return graphScope(iriValue, base) === 'acl';
}

function isRestrictedByDefault(iriValue: string, base: string): boolean {
    const scope = graphScope(iriValue, base);
    if (!scope) return true;
    if (scope.endsWith('/presentation')) return true;
    if (scope.includes('/inferred/')) return true;
    return false;
}

/**
 * Systemverwaltete Graphen — für SPARQL-Updates unantastbar.
 *
 * `writableGraphs` (M13, SPEC §17.3) verengt zusätzlich: Ist die Liste
 * gesetzt, ist ALLES geschützt, was nicht darin steht — auch ein Graph,
 * den es noch gar nicht gibt. Ein Update kann damit weder fremde
 * Nutzergraphen ändern noch neue Graphen außerhalb des eigenen Rechts
 * anlegen. Die Liste kann nie erweitern: die systemverwalteten Graphen
 * bleiben geschützt, selbst wenn jemand sie hineinschreibt.
 */
function isProtectedForUpdate(iriValue: string, base: string, writableGraphs?: readonly string[]): boolean {
    const scope = graphScope(iriValue, base);
    if (!scope) return true;
    if (scope === 'vocab' || scope === 'meta' || scope === 'shapes' || scope === 'acl') return true;
    if (scope.includes('/import/')) return true; // Connector-eigen (SPEC §6.2)
    if (scope.includes('/inferred/')) return true; // Reasoner-eigen (SPEC §7.3)
    if (writableGraphs && !writableGraphs.includes(iriValue)) return true;
    return false;
}

export interface ResolvedDataset {
    defaultGraphs: NamedNode[];
    namedGraphs: NamedNode[];
}

/**
 * Verengung des Datasets auf das Recht des Aufrufers (SPEC §7.6): Der
 * MCP-Server läuft über genau diese Funktion, statt einen zweiten
 * Authz-Pfad zu bauen. `allowedGraphs` kann nur wegnehmen — die Klammern
 * dieser Funktion (acl nie, presentation/inferred nicht im Default) gelten
 * unverändert. Ohne Angabe verhält sich alles wie bisher.
 */
export interface DatasetAuthz {
    allowedGraphs?: readonly string[];
    /**
     * Graphen mit Schreibrecht (M13, SPEC §17.3). Gesetzt heißt: ein
     * UPDATE darf ausschließlich diese Graphen verändern. Nicht gesetzt
     * heißt Einzelnutzer-Betrieb — dort schützt die Liste der
     * systemverwalteten Graphen wie bisher.
     */
    writableGraphs?: readonly string[];
}

/**
 * Vorstufe des Dataset-Resolvers (SPEC §17.3): leitet das erlaubte Dataset
 * aus dem Store-Bestand ab und filtert explizit angeforderte Graphen.
 */
export async function resolveDataset(
    store: GraphStore,
    iri: IriFactory,
    requested?: { defaultGraphUris?: string[]; namedGraphUris?: string[] },
    authz?: DatasetAuthz,
): Promise<ResolvedDataset> {
    const base = iri.instanceBase;
    const existing = (await store.graphs()).map(g => g.value);
    const grantedGraphs = authz?.allowedGraphs ? new Set(authz.allowedGraphs) : null;
    const readable = existing.filter(g =>
        graphScope(g, base) !== null &&
        !isAclGraph(g, base) &&
        (!grantedGraphs || grantedGraphs.has(g)));
    const defaultReadable = readable.filter(g => !isRestrictedByDefault(g, base));

    const filterRequested = (uris: string[] | undefined): string[] | null => {
        if (!uris || uris.length === 0) return null;
        // Still verworfen statt 403: keine Existenzbestätigung.
        return uris.filter(uri => readable.includes(uri));
    };

    const requestedDefault = filterRequested(requested?.defaultGraphUris);
    const requestedNamed = filterRequested(requested?.namedGraphUris);

    const defaultGraphs = (requestedDefault ?? defaultReadable).map(namedNode);
    const namedGraphs = (requestedNamed ?? defaultReadable).map(namedNode);
    return { defaultGraphs, namedGraphs };
}

// --- Ergebnis-Serialisierung --------------------------------------------

interface JsonTerm {
    type: 'uri' | 'literal' | 'bnode' | 'triple';
    value?: string | { subject: JsonTerm; predicate: JsonTerm; object: JsonTerm };
    'xml:lang'?: string;
    datatype?: string;
}

function termToJson(term: Term): JsonTerm {
    switch (term.termType) {
        case 'NamedNode':
            return { type: 'uri', value: term.value };
        case 'BlankNode':
            return { type: 'bnode', value: term.value };
        case 'Literal': {
            const json: JsonTerm = { type: 'literal', value: term.value };
            if (term.language) {
                json['xml:lang'] = term.language;
            } else if (term.datatype.value !== 'http://www.w3.org/2001/XMLSchema#string') {
                json.datatype = term.datatype.value;
            }
            return json;
        }
        case 'Quad': {
            const q = term as Quad;
            return {
                type: 'triple',
                value: {
                    subject: termToJson(q.subject),
                    predicate: termToJson(q.predicate),
                    object: termToJson(q.object),
                },
            };
        }
        default:
            return { type: 'literal', value: term.value };
    }
}

async function collectBindings(result: Extract<QueryResult, { type: 'bindings' }>): Promise<Array<Record<string, Term>>> {
    const rows: Array<Record<string, Term>> = [];
    for await (const row of result.bindings) rows.push(row);
    return rows;
}

function bindingsToJson(variables: string[], rows: Array<Record<string, Term>>): string {
    return JSON.stringify({
        head: { vars: variables },
        results: {
            bindings: rows.map(row => {
                const out: Record<string, JsonTerm> = {};
                for (const [name, term] of Object.entries(row)) {
                    out[name] = termToJson(term);
                }
                return out;
            }),
        },
    });
}

function csvEscape(value: string): string {
    return /[",\n\r]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

function bindingsToCsv(variables: string[], rows: Array<Record<string, Term>>): string {
    const lines = [variables.join(',')];
    for (const row of rows) {
        lines.push(variables.map(v => csvEscape(row[v]?.value ?? '')).join(','));
    }
    return `${lines.join('\r\n')}\r\n`;
}

function bindingsToTsv(variables: string[], rows: Array<Record<string, Term>>): string {
    const lines = [variables.map(v => `?${v}`).join('\t')];
    for (const row of rows) {
        lines.push(variables.map(v => {
            const term = row[v];
            if (!term) return '';
            if (term.termType === 'Quad') return quadToNQuadsLine(term as Quad).replace(/ \.$/, '');
            if (term.termType === 'NamedNode') return `<${term.value}>`;
            if (term.termType === 'BlankNode') return `_:${term.value}`;
            if (term.termType === 'Literal') {
                if (term.language) return `"${term.value}"@${term.language}`;
                if (term.datatype.value !== 'http://www.w3.org/2001/XMLSchema#string') {
                    return `"${term.value}"^^<${term.datatype.value}>`;
                }
                return `"${term.value}"`;
            }
            return term.value;
        }).join('\t'));
    }
    return `${lines.join('\n')}\n`;
}

async function collectQuads(result: Extract<QueryResult, { type: 'quads' }>): Promise<Quad[]> {
    const quads: Quad[] = [];
    for await (const q of result.quads) quads.push(q);
    return quads;
}

// --- Update-Schutz -------------------------------------------------------

/**
 * Ein Marker statt einer Textprobe: der HTTP-Status hängt nicht daran,
 * wie eine Fehlermeldung formuliert ist. Die Meldung unterscheidet
 * bewusst NICHT zwischen „systemverwaltet", „fremd" und „existiert
 * nicht" — sonst wäre die Ablehnung ein Existenz-Orakel (§17.3).
 */
const UPDATE_DENIED = 'Update abgelehnt:';

async function graphFingerprint(store: GraphStore, graph: NamedNode): Promise<string> {
    const lines: string[] = [];
    for await (const q of store.dump(graph)) {
        lines.push(quadToNQuadsLine(q));
    }
    lines.sort();
    return lines.join('\n');
}

async function executeGuardedUpdate(
    store: GraphStore,
    iri: IriFactory,
    update: string,
    writableGraphs?: readonly string[],
): Promise<void> {
    const base = iri.instanceBase;
    await store.transaction(async tx => {
        const protectedGraphs = (await tx.graphs()).filter(g => isProtectedForUpdate(g.value, base, writableGraphs));
        const before = new Map<string, string>();
        for (const graph of protectedGraphs) {
            before.set(graph.value, await graphFingerprint(tx, graph));
        }
        await tx.update(update);
        const after = await tx.graphs();
        for (const graph of after) {
            if (!isProtectedForUpdate(graph.value, base, writableGraphs)) continue;
            const previous = before.get(graph.value) ?? '';
            if ((await graphFingerprint(tx, graph)) !== previous) {
                throw new GraphStoreError(
                    `${UPDATE_DENIED} Der Graph <${graph.value}> wird verändert, ist aber nicht freigegeben — zurückgerollt.`,
                    'UPDATE_FAILED',
                );
            }
        }
        // Entfernte Schutz-Graphen erkennen (DROP GRAPH o. ä.).
        const afterValues = new Set(after.map(g => g.value));
        for (const graph of protectedGraphs) {
            if (!afterValues.has(graph.value)) {
                throw new GraphStoreError(
                    `${UPDATE_DENIED} Der Graph <${graph.value}> wird gelöscht, ist aber nicht freigegeben — zurückgerollt.`,
                    'UPDATE_FAILED',
                );
            }
        }
    });
}

// --- Executor ------------------------------------------------------------

function textResponse(status: number, message: string): SparqlProtocolResponse {
    return { status, contentType: 'text/plain; charset=utf-8', body: `${message}\n` };
}

/**
 * Auflösung föderierter `SERVICE`-Blöcke VOR der lokalen Ausführung
 * (SPEC §7.4, M11). Der Protokoll-Layer kennt die Föderation nur als
 * diese eine Funktion: rein geht die Query des Aufrufers, raus die lokal
 * ausführbare Fassung. Wirft der Resolver einen Fehler mit numerischem
 * `status`, wird genau der zum HTTP-Status der Antwort.
 */
export type SparqlFederationResolver = (query: string, dataset: ResolvedDataset) => Promise<string>;

export interface SparqlProtocolOptions extends DatasetAuthz {
    /**
     * Verbietet UPDATE unabhängig von Methode und Content-Type (SPEC §7.6:
     * `graph_sparql` ist read-only). Der Aufrufer bekommt 405 statt eines
     * stillen Erfolgs.
     */
    readOnly?: boolean;
    /** Zeitbudget der lokalen Query (Default 30 s). */
    timeoutMs?: number;
    /**
     * Ergebnis-Limit (SPEC §7.4: Pflicht für die eingehende Föderation).
     * Überschreitung ist ein Fehler (413), keine stille Kürzung.
     */
    maxRows?: number;
    /** SERVICE-Auflösung (SPEC §7.4). Ohne Resolver: keine Föderation. */
    federation?: SparqlFederationResolver;
}

function errorStatus(error: unknown, fallback: number): number {
    const status = (error as { status?: unknown } | null)?.status;
    return typeof status === 'number' ? status : fallback;
}

export async function executeSparqlProtocol(
    store: GraphStore,
    iri: IriFactory,
    request: SparqlProtocolRequest,
    options: SparqlProtocolOptions = {},
): Promise<SparqlProtocolResponse> {
    const contentType = request.contentType?.split(';')[0].trim().toLowerCase() ?? '';

    let query = request.query ?? null;
    let update = request.update ?? null;
    if (request.method === 'POST') {
        if (contentType === 'application/sparql-query') query = request.body ?? null;
        if (contentType === 'application/sparql-update') update = request.body ?? null;
    }

    // Ein GET darf nie ein UPDATE ausführen (SPEC §7.1).
    if (request.method === 'GET' && (update || contentType === 'application/sparql-update')) {
        return textResponse(405, 'UPDATE über GET ist nicht erlaubt — benutze POST.');
    }
    if (query && update) {
        return textResponse(400, 'Entweder query oder update, nicht beides.');
    }
    if (options.readOnly && (update || contentType === 'application/sparql-update')) {
        return textResponse(405, 'Nur lesende Queries erlaubt — UPDATE ist auf diesem Pfad gesperrt.');
    }

    if (update) {
        try {
            await executeGuardedUpdate(store, iri, update, options.writableGraphs);
            return { status: 204, contentType: 'text/plain; charset=utf-8', body: '' };
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            const status = message.startsWith(UPDATE_DENIED) ? 403 : 400;
            return textResponse(status, message);
        }
    }

    if (!query) {
        return textResponse(400, 'Parameter "query" fehlt (SPARQL 1.1 Protocol).');
    }

    const dataset = await resolveDataset(store, iri, {
        defaultGraphUris: request.defaultGraphUris,
        namedGraphUris: request.namedGraphUris,
    }, { allowedGraphs: options.allowedGraphs });

    let localQuery = query;
    if (options.federation) {
        try {
            localQuery = await options.federation(query, dataset);
        } catch (error) {
            return textResponse(
                errorStatus(error, 502),
                error instanceof Error ? error.message : String(error),
            );
        }
    }

    let result: QueryResult;
    try {
        result = await store.query(localQuery, {
            defaultGraphs: dataset.defaultGraphs,
            namedGraphs: dataset.namedGraphs,
            timeoutMs: options.timeoutMs ?? 30_000,
        });
    } catch (error) {
        return textResponse(400, error instanceof Error ? error.message : String(error));
    }

    switch (result.type) {
        case 'boolean': {
            if (!negotiate(request.accept, BOOLEAN_TYPES, RESULT_JSON)) {
                return textResponse(406, `Nicht verhandelbar. Unterstützt: ${BOOLEAN_TYPES.join(', ')}`);
            }
            return {
                status: 200,
                contentType: `${RESULT_JSON}; charset=utf-8`,
                body: JSON.stringify({ head: {}, boolean: result.value }),
            };
        }
        case 'bindings': {
            const media = negotiate(request.accept, BINDINGS_TYPES, RESULT_JSON);
            if (!media) return textResponse(406, `Nicht verhandelbar. Unterstützt: ${BINDINGS_TYPES.join(', ')}`);
            const rows = await collectBindings(result);
            if (options.maxRows !== undefined && rows.length > options.maxRows) {
                return textResponse(413, `Ergebnis-Limit überschritten: ${rows.length} Zeilen, erlaubt sind ${options.maxRows}. Nutze LIMIT.`);
            }
            const variables = result.variables.length > 0
                ? result.variables
                : [...new Set(rows.flatMap(row => Object.keys(row)))];
            if (media === CSV) {
                return { status: 200, contentType: `${CSV}; charset=utf-8`, body: bindingsToCsv(variables, rows) };
            }
            if (media === TSV) {
                return { status: 200, contentType: `${TSV}; charset=utf-8`, body: bindingsToTsv(variables, rows) };
            }
            return { status: 200, contentType: `${RESULT_JSON}; charset=utf-8`, body: bindingsToJson(variables, rows) };
        }
        case 'quads': {
            const media = negotiate(request.accept, QUADS_TYPES, 'text/turtle');
            if (!media) return textResponse(406, `Nicht verhandelbar. Unterstützt: ${QUADS_TYPES.join(', ')}`);
            const quads = await collectQuads(result);
            if (options.maxRows !== undefined && quads.length > options.maxRows) {
                return textResponse(413, `Ergebnis-Limit überschritten: ${quads.length} Tripel, erlaubt sind ${options.maxRows}. Nutze LIMIT.`);
            }
            const format = media === 'application/json' ? 'application/ld+json' : media;
            return {
                status: 200,
                contentType: `${format}; charset=utf-8`,
                body: serializeRdf(quads, format),
            };
        }
    }
}
