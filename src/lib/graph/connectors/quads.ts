/**
 * Quad-Werkzeuge für Connectors: fehlertolerantes Parsen und
 * Blank-Node-Umbenennung.
 *
 * Fehlertoleranz (M3-Abnahme): fremde Graphen sind im Normalfall unreif.
 * Was parst, wird importiert; was nicht parst, wird quarantäniert —
 * bei zeilenbasierten Formaten (N-Triples/N-Quads) zeilengenau, sonst
 * pro Quelle. Es gibt bewusst KEINE Vokabular- oder Typ-Schranke:
 * unbekannte Prädikate und fehlende rdf:type-Aussagen sind gültiges RDF.
 */

import type { Quad, Quad_Graph, Quad_Object, Quad_Predicate, Quad_Subject, Term } from '@rdfjs/types';
import { parseRdf, normalizeRdfFormat, type RdfFormat } from '../serialize/io';
import { factory } from '../rdf';
import type { QuarantineEntry } from './types';

/** Datei-Endung → RDF-Format (Quelle: SPEC §6.3, „Ordner mit .ttl/.jsonld"). */
const EXTENSION_FORMATS: Record<string, RdfFormat> = {
    ttl: 'text/turtle',
    turtle: 'text/turtle',
    nt: 'application/n-triples',
    ntriples: 'application/n-triples',
    nq: 'application/n-quads',
    nquads: 'application/n-quads',
    trig: 'text/trig',
    jsonld: 'application/ld+json',
    rdf: 'application/rdf+xml',
    owl: 'application/rdf+xml',
};

export function rdfFormatForPath(path: string): RdfFormat | null {
    const match = path.toLowerCase().match(/\.([a-z0-9]+)$/);
    return match ? EXTENSION_FORMATS[match[1]] ?? null : null;
}

export function isRdfPath(path: string): boolean {
    return rdfFormatForPath(path) !== null;
}

function formatFromContentType(contentType: string | null | undefined): RdfFormat | null {
    if (!contentType) return null;
    try {
        return normalizeRdfFormat(contentType);
    } catch {
        return null;
    }
}

const LINE_BASED: ReadonlySet<RdfFormat> = new Set(['application/n-triples', 'application/n-quads']);

/** Reihenfolge der Format-Versuche, wenn nichts Verlässliches bekannt ist. */
const SNIFF_ORDER: RdfFormat[] = [
    'text/turtle',
    'text/trig',
    'application/ld+json',
    'application/n-quads',
    'application/rdf+xml',
];

export interface LenientParseResult {
    quads: Quad[];
    quarantined: QuarantineEntry[];
    /** Tatsächlich benutztes Format, falls eines funktioniert hat. */
    format?: RdfFormat;
}

/**
 * Zeilenweises Auffangnetz für N-Triples/N-Quads: importiert jede Zeile,
 * die für sich parst, und quarantäniert kaputte Zeilen mit Zeilennummer.
 */
function parseLineBased(input: string, format: RdfFormat, source: string): LenientParseResult {
    const quads: Quad[] = [];
    const quarantined: QuarantineEntry[] = [];
    const lines = input.split('\n');
    for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i].trim();
        if (line === '' || line.startsWith('#')) continue;
        try {
            quads.push(...parseRdf(line, { format }));
        } catch (error) {
            quarantined.push({
                source: `${source}:${i + 1}`,
                reason: error instanceof Error ? error.message : String(error),
            });
        }
    }
    return { quads, quarantined, format };
}

/**
 * Fehlertolerantes Parsen einer RDF-Quelle.
 *
 * Format-Bestimmung: expliziter Hinweis (Content-Type) → Datei-Endung →
 * Sniffing in fester Reihenfolge. Scheitert alles, wird die Quelle als
 * Ganzes quarantäniert — der Import läuft weiter (M3-Abnahme).
 */
export function parseRdfLenient(
    input: string,
    options: { source: string; contentType?: string | null; path?: string; baseIri?: string },
): LenientParseResult {
    const hinted = formatFromContentType(options.contentType) ?? (options.path ? rdfFormatForPath(options.path) : null);

    if (hinted) {
        try {
            return { quads: parseRdf(input, { format: hinted, baseIri: options.baseIri }), quarantined: [], format: hinted };
        } catch (error) {
            if (LINE_BASED.has(hinted)) {
                return parseLineBased(input, hinted, options.source);
            }
            return {
                quads: [],
                quarantined: [{
                    source: options.source,
                    reason: `Parst nicht als ${hinted}: ${error instanceof Error ? error.message : String(error)}`,
                }],
                format: hinted,
            };
        }
    }

    let lastError = 'kein Format-Kandidat hat funktioniert';
    for (const format of SNIFF_ORDER) {
        try {
            return { quads: parseRdf(input, { format, baseIri: options.baseIri }), quarantined: [], format };
        } catch (error) {
            lastError = error instanceof Error ? error.message : String(error);
        }
    }
    // Letzter Versuch: zeilenweises Auffangnetz für N-Quads-artige Inhalte.
    const salvaged = parseLineBased(input, 'application/n-quads', options.source);
    if (salvaged.quads.length > 0) return salvaged;
    return {
        quads: [],
        quarantined: [{
            source: options.source,
            reason: `Kein unterstütztes RDF-Format erkannt (versucht: ${SNIFF_ORDER.join(', ')}). Letzter Fehler: ${lastError}`,
        }],
    };
}

/**
 * Benennt Blank Nodes deterministisch pro Quelle um, damit `_:b0` aus
 * zwei Dateien beim Zusammenführen im Import-Graphen nicht kollidiert.
 * Steigt rekursiv in RDF-star-Triple-Terme hinein.
 */
export function relabelBlankNodes(quads: Quad[], prefix: string): Quad[] {
    const mapping = new Map<string, string>();
    const relabelled = (value: string): string => {
        let next = mapping.get(value);
        if (!next) {
            next = `${prefix}_${value}`;
            mapping.set(value, next);
        }
        return next;
    };

    const relabelTerm = (term: Term): Term => {
        if (term.termType === 'BlankNode') {
            return factory.blankNode(relabelled(term.value));
        }
        if (term.termType === 'Quad') {
            const q = term as Quad;
            return factory.quad(
                relabelTerm(q.subject) as Quad_Subject,
                q.predicate,
                relabelTerm(q.object) as Quad_Object,
                q.graph,
            );
        }
        return term;
    };

    return quads.map(q => factory.quad(
        relabelTerm(q.subject) as Quad_Subject,
        relabelTerm(q.predicate) as Quad_Predicate,
        relabelTerm(q.object) as Quad_Object,
        relabelTerm(q.graph) as Quad_Graph,
    ));
}

/** SHA-256 als Hex — Web Crypto, läuft in Node und Browser (Invariante 7). */
export async function sha256Hex(input: string): Promise<string> {
    const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
    return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}
