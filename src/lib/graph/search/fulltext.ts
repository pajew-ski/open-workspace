/**
 * Volltext-Index über alle Literale (SPEC §7.7, M8).
 *
 * Invertierter Index als leichte, eigene JS-Lösung — bewusst OHNE
 * Elasticsearch-/Lucene-Dependency, identisch in Browser und Server
 * (pures Modul: bekommt Quads, kennt weder Store noch Runtime).
 *
 * Die Kopplung an den Graphen läuft über IRIs als gemeinsamen Schlüssel:
 * jeder Index-Eintrag trägt Subjekt-IRI, Prädikat und Named Graph. Damit
 * ist der Index nach Graphen filterbar (§17.4: Volltext-Index pro Scope
 * partitioniert bzw. vor der Score-Rückgabe gefiltert — der Aufrufer baut
 * den Index über sein erlaubtes Dataset, nie darüber hinaus).
 *
 * Fuzzy-Suche (Levenshtein über das Token-Vokabular, begrenzt) erhält das
 * Verhalten des bestehenden Global Finders — der Finder wird auf den
 * Graphen UMGESTELLT, nicht ersetzt (§7.7).
 *
 * Grenze dieser Ausbaustufe, ehrlich benannt: Die Oxigraph-JS-Bindung
 * bietet keine benutzerdefinierten SPARQL-Funktionen; die in §7.7 skizzierte
 * Custom-Function im Query-Layer ist deshalb eine erstklassige Funktion
 * DIESER Schicht (Seeding der Retrieval-Pipeline, /api/graph/search,
 * Finder) statt einer in SPARQL aufrufbaren. Sobald oxigraph-js Custom
 * Functions exponiert, ist `FulltextIndex.search` der eine Einhängepunkt.
 */

import type { Quad } from '@rdfjs/types';
import { PREFIXES, SCHEMA, SKOS } from '../vocab';

/** Prädikate, deren Literale als Titel/Label zählen (höheres Gewicht). */
export const LABEL_PREDICATES: ReadonlySet<string> = new Set([
    SCHEMA.name,
    SKOS.prefLabel,
    `${PREFIXES.rdfs}label`,
    `${PREFIXES.dcterms}title`,
    SCHEMA.alternateName,
]);

/** Ein Literal-Vorkommen im Index. */
export interface FulltextEntry {
    iri: string;
    predicate: string;
    graph: string;
    /** Originaltext (für Snippets und Präfix-Erkennung). */
    text: string;
}

export interface FulltextMatch {
    predicate: string;
    graph: string;
    /** Kurzer Ausschnitt um die Fundstelle. */
    snippet: string;
}

export interface FulltextHit {
    iri: string;
    /** Deterministischer Relevanz-Score (> 0). */
    score: number;
    /** Bestes Label-Verhältnis zum Suchtext (für Finder-Ranking). */
    labelMatch: 'prefix' | 'contains' | 'token' | 'fuzzy' | 'none';
    /** Erstes gefundenes Label des Subjekts (falls vorhanden). */
    label?: string;
    /** Fundstellen (dedupliziert nach Prädikat). */
    matches: FulltextMatch[];
    /** Graphen, in denen Treffer liegen (sortiert). */
    graphs: string[];
}

export interface FulltextSearchOptions {
    limit?: number;
    /** Nur Treffer aus diesen Graphen (Post-Resolver-Filter, §17.4). */
    graphs?: readonly string[];
}

/**
 * Tokenisierung: NFKC-normalisiert, kleingeschrieben, Unicode-Buchstaben/
 * Ziffern (Umlaute und ß bleiben erhalten), Mindestlänge 2. Deterministisch.
 */
export function tokenize(text: string): string[] {
    const normalized = text.normalize('NFKC').toLowerCase();
    const tokens = normalized.match(/[\p{L}\p{N}]+/gu) ?? [];
    return tokens.filter(t => t.length >= 2);
}

/** Klassische Levenshtein-Distanz mit frühem Abbruch über `max`. */
export function levenshtein(a: string, b: string, max: number): number {
    if (Math.abs(a.length - b.length) > max) return max + 1;
    let previous = Array.from({ length: a.length + 1 }, (_, i) => i);
    for (let j = 1; j <= b.length; j++) {
        const current = [j];
        let rowMin = j;
        for (let i = 1; i <= a.length; i++) {
            const cost = a[i - 1] === b[j - 1] ? 0 : 1;
            current[i] = Math.min(current[i - 1] + 1, previous[i] + 1, previous[i - 1] + cost);
            rowMin = Math.min(rowMin, current[i]);
        }
        if (rowMin > max) return max + 1;
        previous = current;
    }
    return previous[a.length];
}

/** Erlaubte Editierdistanz je Query-Token (Finder-Verhalten: Tippfehler-tolerant). */
function fuzzyBudget(token: string): number {
    if (token.length >= 7) return 2;
    if (token.length >= 4) return 1;
    return 0;
}

interface Posting {
    /** Index in `entries`. */
    entry: number;
    /** Vorkommen des Tokens im Eintrag. */
    count: number;
}

const MATCH_QUALITY = { exact: 1, prefix: 0.75, fuzzy: 0.5 } as const;
type MatchKind = keyof typeof MATCH_QUALITY;

/**
 * Invertierter Index über die Literale eines Quad-Bestands. Aufbau und
 * Suche sind deterministisch: gleiche Quads (in beliebiger Reihenfolge)
 * ergeben identische Treffer in identischer Reihenfolge.
 */
export class FulltextIndex {
    private readonly entries: FulltextEntry[] = [];
    /** Token → Postings (Eintrag + Häufigkeit). */
    private readonly postings = new Map<string, Posting[]>();
    /** Sortiertes Token-Vokabular für Präfix-/Fuzzy-Suche. */
    private vocabulary: string[] = [];
    /** Erstes Label pro Subjekt-IRI. */
    private readonly labels = new Map<string, string>();
    private readonly documentCount = new Map<string, number>();

    /** Anzahl indexierter Literal-Vorkommen (Diagnostik/Tests). */
    get size(): number {
        return this.entries.length;
    }

    static fromQuads(quads: Iterable<Quad>): FulltextIndex {
        // Deterministische Eintragsreihenfolge unabhängig von der
        // Reihenfolge der Quads: nach (iri, predicate, graph, text) sortiert.
        const collected: FulltextEntry[] = [];
        for (const q of quads) {
            if (q.subject.termType !== 'NamedNode') continue;
            if (q.object.termType !== 'Literal') continue;
            const text = q.object.value;
            if (text.trim() === '') continue;
            collected.push({
                iri: q.subject.value,
                predicate: q.predicate.value,
                graph: q.graph.termType === 'NamedNode' ? q.graph.value : '',
                text,
            });
        }
        collected.sort((a, b) =>
            a.iri.localeCompare(b.iri) ||
            a.predicate.localeCompare(b.predicate) ||
            a.graph.localeCompare(b.graph) ||
            a.text.localeCompare(b.text));
        const index = new FulltextIndex();
        for (const entry of collected) index.add(entry);
        index.finalize();
        return index;
    }

    private add(entry: FulltextEntry): void {
        const entryIndex = this.entries.length;
        this.entries.push(entry);
        const counts = new Map<string, number>();
        for (const token of tokenize(entry.text)) {
            counts.set(token, (counts.get(token) ?? 0) + 1);
        }
        for (const [token, count] of counts) {
            const list = this.postings.get(token) ?? [];
            list.push({ entry: entryIndex, count });
            this.postings.set(token, list);
        }
        if (LABEL_PREDICATES.has(entry.predicate) && !this.labels.has(entry.iri)) {
            this.labels.set(entry.iri, entry.text);
        }
        this.documentCount.set(entry.iri, (this.documentCount.get(entry.iri) ?? 0) + 1);
    }

    private finalize(): void {
        this.vocabulary = [...this.postings.keys()].sort();
    }

    /** Subjekte im Index (sortiert) — Basis für den Embedding-Index. */
    subjects(): string[] {
        return [...this.documentCount.keys()].sort();
    }

    label(iri: string): string | undefined {
        return this.labels.get(iri);
    }

    /**
     * Suche: Query-Tokens werden gegen das Vokabular aufgelöst (exakt,
     * Präfix, Fuzzy per Levenshtein), Treffer pro Subjekt aggregiert.
     * Score: IDF-gewichtete Token-Qualität, Label-Treffer zählen doppelt.
     */
    search(query: string, options: FulltextSearchOptions = {}): FulltextHit[] {
        const queryTokens = tokenize(query);
        if (queryTokens.length === 0) return [];
        const limit = options.limit ?? 20;
        const allowedGraphs = options.graphs ? new Set(options.graphs) : null;
        const queryLower = query.normalize('NFKC').toLowerCase().trim();

        // Token → beste Match-Qualität über das Vokabular. Präfixe über
        // binäre Suche im sortierten Vokabular; Fuzzy nur mit Budget und
        // Längen-Vorfilter (Levenshtein bricht früh ab).
        const resolved = new Map<string, { token: string; kind: MatchKind }[]>();
        for (const token of [...new Set(queryTokens)]) {
            const found: { token: string; kind: MatchKind }[] = [];
            if (this.postings.has(token)) {
                found.push({ token, kind: 'exact' });
            }
            const prefixMatches = new Set<string>();
            for (let i = lowerBound(this.vocabulary, token); i < this.vocabulary.length; i++) {
                const candidate = this.vocabulary[i];
                if (!candidate.startsWith(token)) break;
                if (candidate !== token) {
                    prefixMatches.add(candidate);
                    found.push({ token: candidate, kind: 'prefix' });
                }
            }
            const budget = fuzzyBudget(token);
            if (budget > 0) {
                for (const candidate of this.vocabulary) {
                    if (candidate === token || prefixMatches.has(candidate)) continue;
                    if (Math.abs(candidate.length - token.length) > budget) continue;
                    if (levenshtein(token, candidate, budget) <= budget) {
                        found.push({ token: candidate, kind: 'fuzzy' });
                    }
                }
            }
            resolved.set(token, found);
        }

        interface Accumulator {
            score: number;
            matchedQueryTokens: Set<string>;
            matches: Map<string, FulltextMatch>;
            graphs: Set<string>;
            labelMatch: FulltextHit['labelMatch'];
        }
        const bySubject = new Map<string, Accumulator>();
        const totalEntries = Math.max(1, this.entries.length);

        for (const [queryToken, candidates] of resolved) {
            for (const { token, kind } of candidates) {
                const postings = this.postings.get(token);
                if (!postings) continue;
                // IDF: seltene Tokens wiegen mehr als allgegenwärtige.
                const idf = Math.log(1 + totalEntries / postings.length);
                for (const posting of postings) {
                    const entry = this.entries[posting.entry];
                    if (allowedGraphs && !allowedGraphs.has(entry.graph)) continue;
                    const isLabel = LABEL_PREDICATES.has(entry.predicate);
                    const weight = MATCH_QUALITY[kind] * idf * (isLabel ? 2 : 1) * Math.min(posting.count, 3);
                    let acc = bySubject.get(entry.iri);
                    if (!acc) {
                        acc = {
                            score: 0,
                            matchedQueryTokens: new Set(),
                            matches: new Map(),
                            graphs: new Set(),
                            labelMatch: 'none',
                        };
                        bySubject.set(entry.iri, acc);
                    }
                    acc.score += weight;
                    acc.matchedQueryTokens.add(queryToken);
                    acc.graphs.add(entry.graph);
                    if (!acc.matches.has(entry.predicate)) {
                        acc.matches.set(entry.predicate, {
                            predicate: entry.predicate,
                            graph: entry.graph,
                            snippet: makeSnippet(entry.text, queryToken),
                        });
                    }
                    if (isLabel) {
                        acc.labelMatch = bestLabelMatch(acc.labelMatch, labelRelation(entry.text, queryLower, kind));
                    }
                }
            }
        }

        const hits: FulltextHit[] = [];
        for (const [iri, acc] of bySubject) {
            // Mehr-Wort-Queries: alle Tokens müssen (irgendwo am Subjekt)
            // getroffen sein — Verhalten des bisherigen Finders.
            if (acc.matchedQueryTokens.size < resolved.size) continue;
            const coverage = acc.matchedQueryTokens.size / resolved.size;
            hits.push({
                iri,
                score: round6(acc.score * coverage),
                labelMatch: acc.labelMatch,
                label: this.labels.get(iri),
                matches: [...acc.matches.values()].sort((a, b) => a.predicate.localeCompare(b.predicate)),
                graphs: [...acc.graphs].sort(),
            });
        }
        hits.sort((a, b) => b.score - a.score || a.iri.localeCompare(b.iri));
        return hits.slice(0, limit);
    }
}

function round6(value: number): number {
    return Math.round(value * 1e6) / 1e6;
}

/** Erste Position in `sorted`, die nicht kleiner als `value` ist. */
function lowerBound(sorted: readonly string[], value: string): number {
    let low = 0;
    let high = sorted.length;
    while (low < high) {
        const mid = (low + high) >> 1;
        if (sorted[mid] < value) low = mid + 1;
        else high = mid;
    }
    return low;
}

const LABEL_MATCH_RANK: Record<FulltextHit['labelMatch'], number> = {
    none: 0,
    fuzzy: 1,
    token: 2,
    contains: 3,
    prefix: 4,
};

function bestLabelMatch(a: FulltextHit['labelMatch'], b: FulltextHit['labelMatch']): FulltextHit['labelMatch'] {
    return LABEL_MATCH_RANK[b] > LABEL_MATCH_RANK[a] ? b : a;
}

function labelRelation(labelText: string, queryLower: string, kind: MatchKind): FulltextHit['labelMatch'] {
    const label = labelText.normalize('NFKC').toLowerCase();
    if (queryLower !== '' && label.startsWith(queryLower)) return 'prefix';
    if (queryLower !== '' && label.includes(queryLower)) return 'contains';
    return kind === 'fuzzy' ? 'fuzzy' : 'token';
}

/** Ausschnitt um die erste Fundstelle des Tokens (max. ~120 Zeichen). */
function makeSnippet(text: string, token: string): string {
    const lower = text.normalize('NFKC').toLowerCase();
    const at = lower.indexOf(token);
    const compact = text.replace(/\s+/g, ' ').trim();
    if (at === -1) return compact.slice(0, 120);
    const start = Math.max(0, at - 40);
    const end = Math.min(text.length, at + token.length + 60);
    const slice = text.slice(start, end).replace(/\s+/g, ' ').trim();
    return `${start > 0 ? '…' : ''}${slice}${end < text.length ? '…' : ''}`;
}
