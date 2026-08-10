/**
 * `DESCRIBE` einer Entität für die Dereferenzierung (SPEC §4.4/§17.5).
 *
 * Zwei Ausgaben, eine Quelle: RDF (Turtle/JSON-LD über `serializeRdf`)
 * und eine schlichte HTML-Seite mit eingebettetem JSON-LD — dieselbe
 * pragmatische Linie wie bei der Ontologie-Auslieferung (§4.4).
 *
 * Das Dataset ist ein Parameter, kein Fund: Die Funktion liest
 * ausschließlich aus den übergebenen Graphen. Wer sie ohne Grant aufruft,
 * bekommt nichts — es gibt hier keinen Weg an §17.3 vorbei.
 */

import type { Quad } from '@rdfjs/types';
import type { GraphStore } from '../store/types';
import { namedNode } from '../rdf';
import { serializeRdf } from '../serialize/io';

/**
 * Alle Aussagen ÜBER die Entität plus die eingehenden Kanten — das ist
 * die übliche „concise bounded description" in ihrer einfachen Form.
 * Bewusst über `dump` statt SPARQL DESCRIBE: dieselbe Ausgabe für
 * Oxigraph und das In-Memory-Double, und keine Abhängigkeit davon, wie
 * eine Store-Bindung DESCRIBE auslegt.
 */
export async function describeEntity(
    store: GraphStore,
    entityIri: string,
    graphs: readonly string[],
): Promise<Quad[]> {
    const out: Quad[] = [];
    for (const graph of [...graphs].sort()) {
        for await (const quad of store.dump(namedNode(graph))) {
            if (quad.subject.value === entityIri || quad.object.value === entityIri) out.push(quad);
        }
    }
    return out;
}

function escapeHtml(value: string): string {
    return value
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;');
}

/**
 * Menschenlesbare Fassung: eine Tabelle der Aussagen plus
 * `<link rel="alternate">` auf die RDF-Repräsentationen und das
 * eingebettete JSON-LD (§4.4).
 */
export function entityHtml(entityIri: string, quads: readonly Quad[]): string {
    const jsonld = serializeRdf([...quads], 'application/ld+json');
    const rows = quads
        .filter(quad => quad.subject.value === entityIri)
        .map(quad => `<tr><td>${escapeHtml(quad.predicate.value)}</td><td>${escapeHtml(quad.object.value)}</td></tr>`)
        .join('\n');
    const incoming = quads.filter(quad => quad.object.value === entityIri).length;
    return `<!doctype html>
<html lang="de">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(entityIri)}</title>
<link rel="alternate" type="text/turtle" href="${escapeHtml(entityIri)}">
<link rel="alternate" type="application/ld+json" href="${escapeHtml(entityIri)}">
<script type="application/ld+json">${jsonld.replaceAll('</', '<\\/')}</script>
<style>
body { font-family: system-ui, sans-serif; margin: 0 auto; max-width: 60rem; padding: 1.5rem; line-height: 1.5; }
table { border-collapse: collapse; width: 100%; }
td { border-bottom: 1px solid #ccc; padding: 0.4rem 0.6rem; vertical-align: top; word-break: break-word; }
td:first-child { width: 35%; color: #555; }
</style>
</head>
<body>
<h1>${escapeHtml(entityIri)}</h1>
${rows === '' ? '<p>Keine Aussagen über diese Entität sichtbar.</p>' : `<table>${rows}</table>`}
<p>Eingehende Kanten: ${incoming}</p>
</body>
</html>
`;
}
