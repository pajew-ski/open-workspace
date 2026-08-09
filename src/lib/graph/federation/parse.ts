/**
 * Erkennung von `SERVICE`-Blöcken in einem Query-Text (SPEC §7.4, M11).
 *
 * Bewusst kein zweiter SPARQL-Parser: der verbindliche Parser bleibt der
 * des Stores. Hier geht es um genau eine Frage — wo im Text steht ein
 * `SERVICE`-Block, gegen welchen Endpoint, und was ist sein Muster —
 * damit der Planer ihn durch das entfernte Ergebnis ersetzen kann.
 *
 * Damit `SERVICE`, `{`, `}` in Kommentaren, String-Literalen und IRIs
 * nicht mitzählen, läuft alles über eine **Maske**: eine zeichengleich
 * lange Kopie des Textes, in der Kommentar-, String- und IRI-Inhalte
 * durch Leerzeichen ersetzt sind. Positionen bleiben gültig, gefunden
 * wird also im Original.
 */

/** Maskiert Kommentare, String-Literale und IRIs positionstreu. */
export function maskSparql(text: string): string {
    const out = new Array<string>(text.length);
    const blank = (from: number, to: number) => {
        for (let i = from; i < to; i += 1) out[i] = text[i] === '\n' ? '\n' : ' ';
    };
    let i = 0;
    while (i < text.length) {
        const char = text[i];
        if (char === '#') {
            const end = text.indexOf('\n', i);
            const stop = end === -1 ? text.length : end;
            blank(i, stop);
            i = stop;
            continue;
        }
        if (char === '"' || char === "'") {
            const triple = text.startsWith(char.repeat(3), i);
            const delimiter = triple ? char.repeat(3) : char;
            let j = i + delimiter.length;
            while (j < text.length) {
                if (text[j] === '\\') { j += 2; continue; }
                if (text.startsWith(delimiter, j)) break;
                j += 1;
            }
            const stop = Math.min(text.length, j + delimiter.length);
            // Nur der Inhalt wird geleert; die Anführungszeichen bleiben
            // stehen, damit sichtbar bleibt, wo ein Literal steht.
            blank(i, stop);
            for (let k = 0; k < delimiter.length && i + k < stop; k += 1) out[i + k] = text[i + k];
            for (let k = 1; k <= delimiter.length; k += 1) {
                const tail = stop - k;
                if (tail >= i + delimiter.length) out[tail] = text[tail];
            }
            i = stop;
            continue;
        }
        if (char === '<') {
            // `<` ist auch der Kleiner-als-Operator. Als IRI zählt nur,
            // was vor dem nächsten Leerraum/`<`/`{` geschlossen wird.
            let j = i + 1;
            let isIri = false;
            while (j < text.length) {
                const c = text[j];
                if (c === '>') { isIri = true; break; }
                if (/\s/.test(c) || c === '<' || c === '{' || c === '}' || c === '"' || c === '|') break;
                j += 1;
            }
            if (isIri) {
                // Spitze Klammern bleiben stehen: der Planer erkennt an
                // ihnen, dass hinter `SERVICE` eine IRI steht, und liest
                // sie dann aus dem Original.
                blank(i, j + 1);
                out[i] = '<';
                out[j] = '>';
                i = j + 1;
                continue;
            }
        }
        out[i] = char;
        i += 1;
    }
    return out.join('');
}

export interface ServiceClause {
    /** Index des Schlüsselworts `SERVICE` im Original-Text. */
    start: number;
    /** Index hinter der schließenden `}` des Blocks. */
    end: number;
    silent: boolean;
    /** Endpoint-IRI, falls literal angegeben (`SERVICE <…>`). */
    endpointIri: string | null;
    /** Variablenname bei `SERVICE ?var` (nicht unterstützt, aber erkannt). */
    endpointVariable: string | null;
    /** Muster zwischen den geschweiften Klammern, ohne die Klammern. */
    pattern: string;
    /**
     * Verschachtelungstiefe der Gruppe, in der der Block steht.
     * 1 = direkt in der äußeren WHERE-Gruppe (dort ist der Block ein
     * reiner Join und damit für den Bound-Join geeignet); alles darüber
     * steht in OPTIONAL/UNION/MINUS/Subselect.
     */
    depth: number;
}

export class FederationParseError extends Error {
    /** Für den Protokoll-Layer: eine unlesbare SERVICE-Klausel ist ein Client-Fehler. */
    readonly status = 400;

    constructor(message: string) {
        super(message);
        this.name = 'FederationParseError';
    }
}

/**
 * Findet alle `SERVICE`-Blöcke. Verschachtelte `SERVICE` innerhalb eines
 * `SERVICE`-Musters werden nicht separat gemeldet — sie gehören zum
 * entfernten Muster und werden dort ausgewertet.
 */
export function findServiceClauses(query: string): ServiceClause[] {
    const masked = maskSparql(query);
    const clauses: ServiceClause[] = [];
    const keyword = /\bSERVICE\b/gi;
    let match: RegExpExecArray | null;
    while ((match = keyword.exec(masked)) !== null) {
        const start = match.index;
        // Kein Treffer, wenn `SERVICE` Teil eines Präfix-Namens ist.
        const before = start > 0 ? masked[start - 1] : ' ';
        if (/[:?$\w-]/.test(before)) continue;
        // Innerhalb eines bereits erfassten Blocks? Dann gehört es dorthin.
        if (clauses.some(c => start > c.start && start < c.end)) continue;

        let cursor = start + 'SERVICE'.length;
        const skipSpace = () => { while (cursor < masked.length && /\s/.test(masked[cursor])) cursor += 1; };
        skipSpace();
        let silent = false;
        if (/^silent\b/i.test(masked.slice(cursor, cursor + 7))) {
            silent = true;
            cursor += 'SILENT'.length;
            skipSpace();
        }
        let endpointIri: string | null = null;
        let endpointVariable: string | null = null;
        if (query[cursor] === '<') {
            const close = query.indexOf('>', cursor);
            if (close === -1) throw new FederationParseError('SERVICE: Endpoint-IRI ist nicht geschlossen.');
            endpointIri = query.slice(cursor + 1, close);
            cursor = close + 1;
        } else if (masked[cursor] === '?' || masked[cursor] === '$') {
            const rest = masked.slice(cursor + 1);
            const name = rest.match(/^[A-Za-z0-9_]+/)?.[0];
            if (!name) throw new FederationParseError('SERVICE: Endpoint ist weder IRI noch Variable.');
            endpointVariable = name;
            cursor += 1 + name.length;
        } else {
            throw new FederationParseError(
                'SERVICE erwartet einen Endpoint als IRI (<…>) oder Variable — Präfix-Namen werden nicht unterstützt.',
            );
        }
        skipSpace();
        if (masked[cursor] !== '{') {
            throw new FederationParseError('SERVICE: Nach dem Endpoint fehlt das Muster in geschweiften Klammern.');
        }
        const open = cursor;
        let level = 0;
        let close = -1;
        for (let i = open; i < masked.length; i += 1) {
            if (masked[i] === '{') level += 1;
            else if (masked[i] === '}') {
                level -= 1;
                if (level === 0) { close = i; break; }
            }
        }
        if (close === -1) throw new FederationParseError('SERVICE: Der Musterblock ist nicht geschlossen.');

        let depth = 0;
        for (let i = 0; i < open; i += 1) {
            if (masked[i] === '{') depth += 1;
            else if (masked[i] === '}') depth -= 1;
        }

        clauses.push({
            start,
            end: close + 1,
            silent,
            endpointIri,
            endpointVariable,
            pattern: query.slice(open + 1, close),
            depth,
        });
    }
    return clauses;
}

/** Variablennamen eines Textabschnitts (ohne `?`/`$`), stabil sortiert. */
export function variablesIn(text: string): string[] {
    const masked = maskSparql(text);
    const names = new Set<string>();
    for (const m of masked.matchAll(/[?$]([A-Za-z0-9_]+)/g)) names.add(m[1]);
    return [...names].sort();
}

/** Prolog (PREFIX/BASE) eines Query-Textes — für abgeleitete Queries. */
export function prologOf(query: string): string {
    const masked = maskSparql(query);
    const prolog = /^\s*(?:PREFIX\s+[A-Za-z][\w.-]*\s*:\s*|PREFIX\s*:\s*|BASE\s*)/i;
    let cursor = 0;
    for (;;) {
        const rest = masked.slice(cursor);
        const match = rest.match(prolog);
        if (!match) break;
        // Hinter dem Schlüsselwort steht die (maskierte) IRI — ihr Ende
        // ist das nächste `>` im Original.
        const close = query.indexOf('>', cursor + match[0].length);
        if (close === -1) break;
        cursor = close + 1;
    }
    return query.slice(0, cursor);
}

/** Ersetzt Textabschnitte (rückwärts, damit Indizes gültig bleiben). */
export function spliceAll(text: string, edits: Array<{ start: number; end: number; replacement: string }>): string {
    let out = text;
    for (const edit of [...edits].sort((a, b) => b.start - a.start)) {
        out = out.slice(0, edit.start) + edit.replacement + out.slice(edit.end);
    }
    return out;
}
