/**
 * Deterministische Serialisierung mit RDF Dataset Canonicalization
 * (RDFC-1.0, SPEC §8.1).
 *
 * Zweimaliges Dumpen desselben Zustands muss byte-identische Dateien
 * erzeugen, sonst ist Git-Sync unbrauchbar. Zwei Bausteine:
 *
 *  1. Blank-Node-Labels werden über RDFC-1.0 (rdf-canonize) stabilisiert —
 *     isomorphe Datasets erhalten identische Labels, unabhängig von den
 *     Eingangs-Labels.
 *  2. Alle Zeilen werden kanonisch sortiert.
 *
 * RDFC-1.0 betrachtet für die Label-Vergabe ausschließlich Quads, die den
 * jeweiligen Blank Node enthalten. Quads ohne Blank Nodes können deshalb
 * getrennt serialisiert werden, ohne das Ergebnis zu verändern — das
 * erlaubt Triple Terms (RDF 1.2) außerhalb des RDFC-Pfads, den die
 * Spezifikation (noch) nicht abdeckt.
 *
 * Bekannte Grenze: Ein Blank Node INNERHALB eines Triple Terms ist nicht
 * kanonisierbar und wird mit einem klaren Fehler abgelehnt. Der eigene
 * Schreibpfad erzeugt solche Quads nie (Reifier sind benannte Knoten).
 */

import { canonize } from 'rdf-canonize';
import type { Quad } from '@rdfjs/types';
import {
    quadContainsBlankNode,
    quadContainsTripleTerm,
    quadToNQuadsLine,
} from './nquads';

export class CanonicalizationError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'CanonicalizationError';
    }
}

/**
 * Kanonische N-Quads-Serialisierung eines Datasets: RDFC-1.0-stabile
 * Blank-Node-Labels, Zeilen sortiert, abschließender Zeilenumbruch.
 */
export async function canonicalNQuads(quads: Iterable<Quad>): Promise<string> {
    const withBlank: Quad[] = [];
    const plainLines: string[] = [];

    for (const q of quads) {
        if (quadContainsBlankNode(q)) {
            if (quadContainsTripleTerm(q)) {
                throw new CanonicalizationError(
                    'Blank Nodes innerhalb von Triple Terms sind nicht kanonisierbar (RDFC-1.0 deckt RDF-star nicht ab). ' +
                    `Betroffenes Quad: ${quadToNQuadsLine(q)}`,
                );
            }
            withBlank.push(q);
        } else {
            plainLines.push(quadToNQuadsLine(q));
        }
    }

    let canonizedLines: string[] = [];
    if (withBlank.length > 0) {
        const input = withBlank.map(q => `${quadToNQuadsLine(q)}\n`).join('');
        const output = await canonize(input, {
            algorithm: 'RDFC-1.0',
            inputFormat: 'application/n-quads',
            format: 'application/n-quads',
        });
        canonizedLines = output.split('\n').filter(line => line.length > 0);
    }

    // Duplikate können entstehen, wenn der Aufrufer Quads doppelt liefert —
    // ein Set macht den Dump davon unabhängig.
    const lines = [...new Set([...plainLines, ...canonizedLines])];
    lines.sort();
    return lines.length === 0 ? '' : `${lines.join('\n')}\n`;
}

/** SHA-256 (hex) über die kanonische Form — für manifest.json. */
export async function hashCanonical(canonical: string): Promise<string> {
    const data = new TextEncoder().encode(canonical);
    const digest = await globalThis.crypto.subtle.digest('SHA-256', data);
    return Array.from(new Uint8Array(digest))
        .map(b => b.toString(16).padStart(2, '0'))
        .join('');
}

/**
 * RDF-Dataset-Isomorphie über Kanonisierung: Zwei Datasets sind isomorph
 * genau dann, wenn ihre kanonischen Serialisierungen identisch sind.
 */
export async function isIsomorphic(a: Iterable<Quad>, b: Iterable<Quad>): Promise<boolean> {
    const [ca, cb] = await Promise.all([canonicalNQuads(a), canonicalNQuads(b)]);
    return ca === cb;
}
