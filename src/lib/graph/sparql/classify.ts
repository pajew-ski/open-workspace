/**
 * Klassifikation von SPARQL-Query-Texten (SPEC §7.1, M2-Editor).
 *
 * Pur und isomorph (Server-Routen UND Editor-UI): bestimmt die
 * Operationsform nach Abtragen von Kommentaren und Prolog (PREFIX/BASE).
 * Keine vollständige Grammatik — die verbindliche Prüfung bleibt beim
 * Store-Parser; hier geht es um Weichenstellung (Tabelle vs. Graph vs.
 * Update-Pfad) und ehrliche Fehlermeldungen VOR dem Ausführen.
 */

export type SparqlOperation = 'select' | 'ask' | 'construct' | 'describe' | 'update' | 'unknown';

const UPDATE_KEYWORDS: ReadonlySet<string> = new Set([
    'insert', 'delete', 'load', 'clear', 'drop', 'create', 'with', 'move', 'copy', 'add',
]);

/**
 * Entfernt Kommentare (# bis Zeilenende), ohne `#` in IRIs (<…ns/v1#>)
 * oder String-Literalen anzutasten — Vokabular-IRIs enden regulär auf #.
 */
function stripComments(text: string): string {
    let out = '';
    let inIri = false;
    let inString: '"' | "'" | null = null;
    for (let i = 0; i < text.length; i += 1) {
        const char = text[i];
        if (inString) {
            out += char;
            if (char === inString && text[i - 1] !== '\\') inString = null;
            continue;
        }
        if (inIri) {
            out += char;
            if (char === '>') inIri = false;
            continue;
        }
        if (char === '<') {
            inIri = true;
        } else if (char === '"' || char === "'") {
            inString = char;
        } else if (char === '#') {
            while (i < text.length && text[i] !== '\n') i += 1;
            out += '\n';
            continue;
        }
        out += char;
    }
    return out;
}

export function classifySparql(queryText: string): SparqlOperation {
    let rest = stripComments(queryText);
    const prolog = /^\s*(?:PREFIX\s+[A-Za-z][\w-]*\s*:\s*<[^>]*>|PREFIX\s*:\s*<[^>]*>|BASE\s*<[^>]*>)\s*/i;
    for (;;) {
        const match = rest.match(prolog);
        if (!match || match[0].length === 0) break;
        rest = rest.slice(match[0].length);
    }
    const word = rest.match(/^\s*([A-Za-z]+)/)?.[1]?.toLowerCase();
    if (word === 'select' || word === 'ask' || word === 'construct' || word === 'describe') return word;
    if (word !== undefined && UPDATE_KEYWORDS.has(word)) return 'update';
    return 'unknown';
}

/** Graph-förmige Queries (CONSTRUCT/DESCRIBE) sind als View auflösbar. */
export function isGraphQuery(queryText: string): boolean {
    const op = classifySparql(queryText);
    return op === 'construct' || op === 'describe';
}

/** Lesende Queries dürfen als ow:QueryView gespeichert werden (SPEC §7.1). */
export function isReadQuery(queryText: string): boolean {
    const op = classifySparql(queryText);
    return op === 'select' || op === 'ask' || op === 'construct' || op === 'describe';
}
