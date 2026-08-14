/**
 * Benennung im Beobachtungs-Layer — IRI-sichere Slugs und die
 * Vorschlags-ID einer Größe.
 *
 * Warum das seit C5 hier liegt und nicht mehr beim Home-Assistant-
 * Connector: Es gilt für jede Quelle. Ein Quellschlüssel wird zum
 * Verzeichnisnamen im Beobachtungs-Speicher und zum IRI-Segment, und die
 * Regel dafür darf nicht davon abhängen, wer die Reihe liefert.
 */

/** IRI- und dateisystemsicherer Slug aus einem Namen oder Schlüssel. */
export function slugify(value: string): string {
    const slug = value
        .toLowerCase()
        .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
    return slug === '' ? 'unbenannt' : slug;
}

/** Vorschlags-ID einer Variablen aus einem Quellschlüssel (stabil, kollisionsarm). */
export function variableIdFor(source: string): string {
    return slugify(source);
}
