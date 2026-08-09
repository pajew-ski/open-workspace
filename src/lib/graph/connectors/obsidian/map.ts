/**
 * Abbildung Obsidian-Vault → RDF (SPEC §10), Import-Richtung.
 *
 * Zwei Schichten pro Notiz, bewusst getrennt:
 *
 *  1. QUELLTREUE — der Round-Trip-Träger: `schema:text` hält den Body
 *     byte-genau, jeder Frontmatter-Key liegt zusätzlich als
 *     fm:-Property (OW_FRONTMATTER_BASE) auf der Notiz — Strings als
 *     einfache Literale, alles Strukturierte (Listen, Maps, Zahlen,
 *     Booleans) als rdf:JSON-Literal, damit Reihenfolge und Typ den
 *     Round-Trip überleben. Typisierte RDF-Literale (xsd:dateTime …)
 *     scheiden als Träger aus: Oxigraph normalisiert ihre Lexik.
 *  2. WISSEN — die Extraktion: bekannte Frontmatter-Keys werden auf
 *     Standard-Terme gemappt (schema:name, dcterms:created, …), Wikilinks
 *     werden ow:linksTo-Kanten (Alias/Einbettung als RDF-1.2-Annotation
 *     über einen benannten Reifier), Tags werden skos:Concepts mit
 *     skos:broader-Hierarchie.
 *
 * Backlinks werden NICHT gespeichert (SPEC §10): sie sind eine
 * SPARQL-Query über eingehende Kanten.
 */

import type { Quad } from '@rdfjs/types';
import type { IriFactory } from '../../iri';
import { factory, namedNode, literal, typedLiteral } from '../../rdf';
import { DCTERMS, OW, OW_FRONTMATTER_BASE, RDF, SCHEMA, SKOS, XSD } from '../../vocab';
import {
    extractInlineTags,
    extractWikilinks,
    folderFromPath,
    frontmatterTags,
    isAttachmentTarget,
    isCanvasTarget,
    noteIdFromPath,
    noteNameFromPath,
    parseFrontmatter,
    splitFrontmatter,
    type FrontmatterValue,
} from './markdown';
import type { VaultFile } from './vault';

/** Frontmatter-Keys, die zusätzlich semantisch gemappt werden. */
const KNOWN_KEYS = {
    title: ['title', 'titel'],
    aliases: ['aliases', 'alias'],
    created: ['created', 'createdat', 'erstellt'],
    modified: ['updated', 'updatedat', 'modified', 'aktualisiert'],
    language: ['lang', 'language', 'inlanguage'],
    author: ['author', 'autor'],
    type: ['typ', 'type'],
} as const;

/** `typ:`-Werte → zusätzliche rdf:type-Aussagen (SPEC §10: `typ: begriff`). */
const TYPE_VALUES: Record<string, string[]> = {
    begriff: [SKOS.Concept, SCHEMA.DefinedTerm],
    term: [SKOS.Concept, SCHEMA.DefinedTerm],
    definedterm: [SKOS.Concept, SCHEMA.DefinedTerm],
    howto: [SCHEMA.HowTo],
    anleitung: [SCHEMA.HowTo],
    artikel: [SCHEMA.TechArticle],
    article: [SCHEMA.TechArticle],
    techarticle: [SCHEMA.TechArticle],
    blog: [SCHEMA.BlogPosting],
    blogposting: [SCHEMA.BlogPosting],
};

export interface VaultQuadsResult {
    quads: Quad[];
    /** Quarantäne-Meldungen (kaputtes Frontmatter u. ä.). */
    quarantined: Array<{ source: string; reason: string }>;
    notes: number;
    links: number;
    tags: number;
}

/** IRI-Property eines Frontmatter-Keys im Quelltreue-Namespace. */
export function frontmatterPropertyIri(key: string): string {
    return `${OW_FRONTMATTER_BASE}${encodeURIComponent(key)}`;
}

function frontmatterLiteral(value: FrontmatterValue): Quad['object'] {
    if (typeof value === 'string') return literal(value);
    return literal(JSON.stringify(value), namedNode(RDF.JSON));
}

/** ISO-Datum/Zeit → typisiertes Literal fürs Wissens-Mapping, sonst plain. */
function temporalLiteral(value: FrontmatterValue): Quad['object'] {
    const text = String(value);
    if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return literal(text, namedNode(XSD.date));
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(text)) return typedLiteral.dateTime(text);
    return literal(text);
}

function findKnown(frontmatter: Record<string, FrontmatterValue>, names: readonly string[]): FrontmatterValue | undefined {
    for (const key of Object.keys(frontmatter)) {
        if (names.includes(key.toLowerCase())) return frontmatter[key];
    }
    return undefined;
}

/**
 * Baut die Import-Quads eines kompletten Vault-Standes. Die Rückgabe
 * trägt keine Graph-Komponente — `GraphStore.load()` erzwingt den
 * Import-Graphen (Invariante 4).
 */
export function buildVaultQuads(
    vaultFiles: VaultFile[],
    iri: IriFactory,
    connectorId: string,
): VaultQuadsResult {
    const quads: Quad[] = [];
    const quarantined: Array<{ source: string; reason: string }> = [];
    let linkCount = 0;

    const add = (subject: string, predicate: string, object: Quad['object']) => {
        quads.push(factory.quad(namedNode(subject), namedNode(predicate), object));
    };
    const addIri = (subject: string, predicate: string, objectIri: string) =>
        add(subject, predicate, namedNode(objectIri));

    // --- Notiz-Registry: Auflösung wie Obsidian (Basename, dann Pfad) ---
    const docIri = (noteId: string) => iri.entity('doc', `${connectorId}/${noteId}`);
    const byPath = new Map<string, string>();
    const byName = new Map<string, string[]>();
    for (const file of vaultFiles) {
        const noteId = noteIdFromPath(file.path);
        byPath.set(noteId.toLowerCase(), noteId);
        const name = noteNameFromPath(file.path).toLowerCase();
        const list = byName.get(name) ?? [];
        list.push(noteId);
        byName.set(name, list);
    }
    for (const list of byName.values()) list.sort();

    /**
     * Wikilink-Ziel → Notiz-ID. Pfad-Angaben lösen exakt auf, bloße Namen
     * über den Basename (bei Mehrdeutigkeit deterministisch der
     * lexikografisch kleinste Pfad). Unaufgelöste Ziele werden Phantom-
     * Notizen — wie in Obsidian existiert der Knoten, sobald auf ihn
     * verwiesen wird.
     */
    const resolveTarget = (rawTarget: string): string => {
        const target = noteIdFromPath(rawTarget.replace(/\\/g, '/').replace(/^\/+/, ''));
        const exact = byPath.get(target.toLowerCase());
        if (exact) return exact;
        if (!target.includes('/')) {
            const candidates = byName.get(target.toLowerCase());
            if (candidates && candidates.length > 0) return candidates[0];
        }
        return target;
    };

    // --- Tags (skos:Concept, verschachtelt über '/') — vault-weit dedupliziert
    const tagIris = new Map<string, string>();
    const ensureTag = (tag: string): string => {
        const existing = tagIris.get(tag);
        if (existing) return existing;
        const tagIri = iri.entity('tag', tag);
        tagIris.set(tag, tagIri);
        addIri(tagIri, RDF.type, SKOS.Concept);
        add(tagIri, SKOS.prefLabel, literal(tag));
        const parent = tag.includes('/') ? tag.slice(0, tag.lastIndexOf('/')) : null;
        if (parent) {
            addIri(tagIri, SKOS.broader, ensureTag(parent));
        }
        return tagIri;
    };

    for (const file of vaultFiles) {
        const noteId = noteIdFromPath(file.path);
        const subject = docIri(noteId);
        const { frontmatterSource, body } = splitFrontmatter(file.content);

        let frontmatter: Record<string, FrontmatterValue> = {};
        if (frontmatterSource !== null) {
            try {
                frontmatter = parseFrontmatter(frontmatterSource);
            } catch (error) {
                quarantined.push({
                    source: file.path,
                    reason: `Frontmatter nicht lesbar (Body wurde importiert, der Frontmatter-Block geht beim Export verloren): ${error instanceof Error ? error.message : String(error)}`,
                });
                frontmatter = {};
            }
        }

        // Grundgerüst
        addIri(subject, RDF.type, OW.Document);
        addIri(subject, RDF.type, SCHEMA.DigitalDocument);
        add(subject, DCTERMS.identifier, literal(noteId));
        add(subject, SCHEMA.text, literal(body));
        const folder = folderFromPath(file.path);
        if (folder !== '') {
            add(subject, OW.inFolder, literal(folder));
        }

        // Quelltreue-Schicht: jeder Frontmatter-Key als fm:-Property.
        for (const [key, value] of Object.entries(frontmatter)) {
            add(subject, frontmatterPropertyIri(key), frontmatterLiteral(value));
        }

        // Wissens-Schicht: bekannte Keys auf Standard-Terme.
        const title = findKnown(frontmatter, KNOWN_KEYS.title);
        add(subject, SCHEMA.name, literal(title !== undefined ? String(title) : noteNameFromPath(file.path)));

        const aliases = findKnown(frontmatter, KNOWN_KEYS.aliases);
        if (aliases !== undefined && aliases !== null) {
            for (const alias of Array.isArray(aliases) ? aliases : [aliases]) {
                const text = String(alias).trim();
                if (text !== '') add(subject, SCHEMA.alternateName, literal(text));
            }
        }
        const created = findKnown(frontmatter, KNOWN_KEYS.created);
        if (created !== undefined && created !== null) add(subject, DCTERMS.created, temporalLiteral(created));
        const modified = findKnown(frontmatter, KNOWN_KEYS.modified);
        if (modified !== undefined && modified !== null) add(subject, DCTERMS.modified, temporalLiteral(modified));
        const language = findKnown(frontmatter, KNOWN_KEYS.language);
        if (language !== undefined && language !== null) add(subject, SCHEMA.inLanguage, literal(String(language)));
        const author = findKnown(frontmatter, KNOWN_KEYS.author);
        if (author !== undefined && author !== null) add(subject, SCHEMA.author, literal(String(author)));
        const type = findKnown(frontmatter, KNOWN_KEYS.type);
        if (typeof type === 'string') {
            for (const typeIri of TYPE_VALUES[type.trim().toLowerCase()] ?? []) {
                addIri(subject, RDF.type, typeIri);
            }
        }

        // Tags: Frontmatter + Inline, gemeinsame skos-Konzepte.
        for (const tag of new Set([...frontmatterTags(frontmatter), ...extractInlineTags(body)])) {
            addIri(subject, SCHEMA.about, ensureTag(tag));
        }

        // Wikilinks → ow:linksTo; Alias/Einbettung als Annotation am
        // benannten Reifier (RDF 1.2: <reifier> rdf:reifies <<( s p o )>>).
        const seenTargets = new Set<string>();
        for (const link of extractWikilinks(body)) {
            if (isAttachmentTarget(link.target) || isCanvasTarget(link.target)) continue;
            const targetId = resolveTarget(link.target);
            const targetIri = docIri(targetId);
            if (!seenTargets.has(targetIri)) {
                seenTargets.add(targetIri);
                addIri(subject, OW.linksTo, targetIri);
                linkCount += 1;
            }
            if (link.alias !== undefined || link.embed) {
                const reifier = iri.entity('link', `${connectorId}/${noteId}/${link.index}`);
                const linkTriple = factory.quad(
                    namedNode(subject),
                    namedNode(OW.linksTo),
                    namedNode(targetIri),
                );
                quads.push(factory.quad(namedNode(reifier), namedNode(RDF.reifies), linkTriple));
                if (link.alias !== undefined) {
                    add(reifier, SCHEMA.alternateName, literal(link.alias));
                }
                if (link.embed) {
                    add(reifier, OW.embedded, typedLiteral.boolean(true));
                }
            }
        }
    }

    return {
        quads,
        quarantined,
        notes: vaultFiles.length,
        links: linkCount,
        tags: tagIris.size,
    };
}
