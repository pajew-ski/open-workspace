/**
 * Obsidian-Projektion (SPEC §10, Export-Richtung): Dokument-Knoten →
 * Markdown-Dateien. Verlustbehaftet und explizit als solche benannt.
 *
 * Quelltreue: Frontmatter wird ausschließlich aus den fm:-Properties
 * (OW_FRONTMATTER_BASE) rekonstruiert — Strings wörtlich, rdf:JSON-Werte
 * strukturerhaltend —, der Body kommt byte-genau aus `schema:text`.
 * Es wird NICHTS synthetisiert: ein Dokument ohne fm:-Properties ergibt
 * eine Datei ohne Frontmatter-Block. Damit ist Vault → Store → Vault
 * markdown-identisch bis auf die normalisierte Frontmatter-Reihenfolge
 * (M4-Abnahme).
 *
 * Verlustpositionen (dokumentiert in docs/obsidian-kompatibilitaet.md):
 *  - Typisierte Kanten zwischen Dokumenten (prov:wasDerivedFrom u. ä.)
 *    werden auf generische Wikilinks abgeflacht — der Kantentyp geht im
 *    Markdown verloren; die Links landen als angehängte Zeile im Body.
 *  - Kanten-Annotationen (Alias, ow:embedded) leben im Body-Text selbst;
 *    Kanten, die nur im Graphen annotiert wurden, verlieren die
 *    Annotation beim Abflachen.
 */

import type { Quad } from '@rdfjs/types';
import { DCTERMS, OW, OW_FRONTMATTER_BASE, RDF, SCHEMA } from '../vocab';
import {
    extractWikilinks,
    noteIdFromPath,
    serializeNote,
    type FrontmatterValue,
} from '../connectors/obsidian/markdown';

export interface ObsidianExportFile {
    /** Vault-relativer Pfad, `/`-getrennt, inklusive `.md`. */
    path: string;
    content: string;
}

export interface ObsidianExportResult {
    files: ObsidianExportFile[];
    /** Anzahl der auf Wikilinks abgeflachten typisierten Kanten. */
    flattenedLinks: number;
}

/** Prädikate, die beim Abflachen NIE zu Wikilinks werden (Strukturdaten). */
const STRUCTURAL_PREDICATES: ReadonlySet<string> = new Set([
    RDF.type,
    RDF.reifies,
    SCHEMA.text,
    SCHEMA.name,
    SCHEMA.alternateName,
    SCHEMA.about,
    SCHEMA.author,
    SCHEMA.inLanguage,
    DCTERMS.identifier,
    DCTERMS.created,
    DCTERMS.modified,
    OW.inFolder,
]);

interface DocView {
    iri: string;
    identifier: string;
    folder?: string;
    body: string;
    frontmatter: Record<string, FrontmatterValue>;
    /** Ausgehende Kanten auf andere Dokumente: Prädikat → Ziel-IRIs. */
    outgoing: Array<{ predicate: string; target: string }>;
}

function firstLiteral(quads: Quad[], predicate: string): string | undefined {
    const values = quads
        .filter(q => q.predicate.value === predicate && q.object.termType === 'Literal')
        .map(q => q.object.value)
        .sort();
    return values[0];
}

/**
 * Baut die Markdown-Dateien aller Dokument-Knoten (`ow:Document` mit
 * `dcterms:identifier`) aus einem Quad-Bestand — typischerweise dem Dump
 * genau eines Named Graphen.
 */
export function projectDocsToMarkdown(quads: Iterable<Quad>): ObsidianExportResult {
    const bySubject = new Map<string, Quad[]>();
    for (const q of quads) {
        if (q.subject.termType !== 'NamedNode') continue;
        const list = bySubject.get(q.subject.value) ?? [];
        list.push(q);
        bySubject.set(q.subject.value, list);
    }

    // Dokument-Knoten einsammeln.
    const docs = new Map<string, DocView>();
    for (const [subject, subjectQuads] of bySubject) {
        const isDoc = subjectQuads.some(q => q.predicate.value === RDF.type && q.object.value === OW.Document);
        if (!isDoc) continue;
        const identifier = firstLiteral(subjectQuads, DCTERMS.identifier);
        if (identifier === undefined) continue;

        const frontmatter: Record<string, FrontmatterValue> = {};
        const outgoing: DocView['outgoing'] = [];
        for (const q of subjectQuads) {
            if (q.predicate.value.startsWith(OW_FRONTMATTER_BASE) && q.object.termType === 'Literal') {
                const key = decodeURIComponent(q.predicate.value.slice(OW_FRONTMATTER_BASE.length));
                frontmatter[key] = q.object.datatype.value === RDF.JSON
                    ? (JSON.parse(q.object.value) as FrontmatterValue)
                    : q.object.value;
            }
            if (q.object.termType === 'NamedNode') {
                outgoing.push({ predicate: q.predicate.value, target: q.object.value });
            }
        }

        docs.set(subject, {
            iri: subject,
            identifier,
            folder: firstLiteral(subjectQuads, OW.inFolder),
            body: firstLiteral(subjectQuads, SCHEMA.text) ?? '',
            frontmatter,
            outgoing,
        });
    }

    // Wikilink-Namen: Basename, wenn er im Export-Set eindeutig ist,
    // sonst der volle vault-relative Pfad (Obsidians Auflösungsregel).
    const nameCounts = new Map<string, number>();
    for (const doc of docs.values()) {
        const name = noteIdFromPath(doc.identifier).split('/').pop() ?? doc.identifier;
        nameCounts.set(name.toLowerCase(), (nameCounts.get(name.toLowerCase()) ?? 0) + 1);
    }
    const wikilinkText = (doc: DocView): string => {
        const name = noteIdFromPath(doc.identifier).split('/').pop() ?? doc.identifier;
        return (nameCounts.get(name.toLowerCase()) ?? 0) > 1 ? doc.identifier : name;
    };

    // Ziel-Auflösung für „ist der Link schon im Body?": wie beim Import.
    const byPath = new Map<string, string>();
    const byName = new Map<string, string[]>();
    for (const doc of docs.values()) {
        const id = doc.identifier;
        byPath.set(id.toLowerCase(), doc.iri);
        const name = (id.split('/').pop() ?? id).toLowerCase();
        const list = byName.get(name) ?? [];
        list.push(id);
        byName.set(name, list);
    }
    for (const list of byName.values()) list.sort();
    const iriByIdentifier = new Map<string, string>();
    for (const doc of docs.values()) iriByIdentifier.set(doc.identifier, doc.iri);

    const resolveBodyTarget = (rawTarget: string): string | null => {
        const target = noteIdFromPath(rawTarget.replace(/\\/g, '/').replace(/^\/+/, ''));
        const exact = byPath.get(target.toLowerCase());
        if (exact) return exact;
        if (!target.includes('/')) {
            const candidates = byName.get(target.toLowerCase());
            if (candidates && candidates.length > 0) return iriByIdentifier.get(candidates[0]) ?? null;
        }
        return null;
    };

    const files: ObsidianExportFile[] = [];
    let flattenedLinks = 0;

    for (const doc of [...docs.values()].sort((a, b) => a.identifier.localeCompare(b.identifier, 'de'))) {
        // Bereits im Body verlinkte Ziele (aufgelöst) überspringen.
        const linkedInBody = new Set<string>();
        for (const link of extractWikilinks(doc.body)) {
            const resolved = resolveBodyTarget(link.target);
            if (resolved) linkedInBody.add(resolved);
        }

        // Abzuflachende Kanten: ow:linksTo und alle nicht-strukturellen
        // Prädikate, deren Ziel ein Dokument des Export-Sets ist.
        const flattenTargets = new Set<string>();
        for (const edge of doc.outgoing) {
            if (edge.target === doc.iri) continue;
            const targetDoc = docs.get(edge.target);
            if (!targetDoc) continue;
            if (edge.predicate !== OW.linksTo && (
                STRUCTURAL_PREDICATES.has(edge.predicate) || edge.predicate.startsWith(OW_FRONTMATTER_BASE)
            )) continue;
            if (linkedInBody.has(edge.target)) continue;
            flattenTargets.add(edge.target);
        }

        let body = doc.body;
        if (flattenTargets.size > 0) {
            const links = [...flattenTargets]
                .map(target => docs.get(target))
                .filter((target): target is DocView => target !== undefined)
                .sort((a, b) => a.identifier.localeCompare(b.identifier, 'de'))
                .map(target => `[[${wikilinkText(target)}]]`);
            flattenedLinks += links.length;
            body = body === ''
                ? `${links.join(' ')}\n`
                : `${body}${body.endsWith('\n') ? '' : '\n'}\n${links.join(' ')}\n`;
        }

        const path = doc.folder && !doc.identifier.startsWith(`${doc.folder}/`)
            ? `${doc.folder}/${doc.identifier}.md`
            : `${doc.identifier}.md`;
        files.push({ path, content: serializeNote(doc.frontmatter, body) });
    }

    return { files, flattenedLinks };
}
