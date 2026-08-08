/**
 * Migration Bestand → Graph (SPEC §12.2).
 *
 * Pure Quad-Builder: nehmen die bestehenden Datei-Entitäten (Docs, Tasks,
 * Projekte, Canvases) und erzeugen den Workspace-Graphen. Idempotent und
 * deterministisch — bewusst ohne Zeitstempel des Migrationslaufs, damit
 * wiederholte Läufe byte-identische Snapshots erzeugen.
 *
 * Wissen/Präsentation-Trennung (Invariante 2): Layout-Werte (x/y/Breite/
 * Höhe/Farbe/Viewport) werden NICHT migriert. Sie bleiben bis zur
 * Präsentationsschicht (M5) in den Canvas-/Projekt-Dateien; der
 * semantische Graph enthält sie zu keinem Zeitpunkt.
 */

import type { Quad } from '@rdfjs/types';
import type { Doc } from '@/types/doc';
import type { Task } from '@/lib/storage/tasks';
import type { Project } from '@/lib/storage/projects';
import type { CanvasData } from '@/lib/storage/canvas';
import { factory, namedNode, typedLiteral, literal } from '../rdf';
import { DCTERMS, OW, RDF, SCHEMA, SKOS } from '../vocab';
import type { IriFactory } from '../iri';

export interface WorkspaceSnapshotInput {
    docs: Doc[];
    tasks: Task[];
    projects: Project[];
    canvases: CanvasData[];
}

export interface MigrationCounts {
    docs: number;
    tasks: number;
    projects: number;
    canvases: number;
    cards: number;
    tags: number;
    links: number;
    quads: number;
}

const WIKILINK = /\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g;

/** Slug-Logik identisch zu storage/docs.generateSlug — hier dupliziert
 *  gehalten, damit dieses Modul frei von fs-Importen bleibt; ein Test
 *  stellt die Übereinstimmung sicher. */
export function slugifyTitle(title: string): string {
    return title
        .toLowerCase()
        .replace(/[äÄ]/g, 'ae')
        .replace(/[öÖ]/g, 'oe')
        .replace(/[üÜ]/g, 'ue')
        .replace(/ß/g, 'ss')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '')
        .slice(0, 50);
}

function docSchemaType(doc: Doc): string {
    switch (doc.type) {
        case 'TechArticle': return SCHEMA.TechArticle;
        case 'BlogPosting': return SCHEMA.BlogPosting;
        case 'HowTo': return SCHEMA.HowTo;
        case 'DefinedTerm': return SCHEMA.DefinedTerm;
        default: return SCHEMA.TechArticle;
    }
}

function taskStatusIri(status: Task['status']): string {
    if (status === 'done') return SCHEMA.CompletedActionStatus;
    if (status === 'in-progress' || status === 'review') return SCHEMA.ActiveActionStatus;
    return SCHEMA.PotentialActionStatus;
}

/**
 * Baut den Workspace-Graphen aus dem Dateibestand. Die Rückgabe trägt
 * keine Graph-Komponente — `GraphStore.load()` erzwingt den Ziel-Graphen.
 */
export function buildWorkspaceQuads(
    input: WorkspaceSnapshotInput,
    iri: IriFactory,
): { quads: Quad[]; counts: MigrationCounts } {
    const quads: Quad[] = [];
    const counts: MigrationCounts = {
        docs: 0, tasks: 0, projects: 0, canvases: 0, cards: 0, tags: 0, links: 0, quads: 0,
    };

    const add = (subject: string, predicate: string, object: Quad['object']) => {
        quads.push(factory.quad(namedNode(subject), namedNode(predicate), object));
    };
    const addIri = (subject: string, predicate: string, objectIri: string) =>
        add(subject, predicate, namedNode(objectIri));

    // --- Tags (skos:Concept, verschachtelt über '/') -------------------
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

    // --- Personen ------------------------------------------------------
    const personIris = new Map<string, string>();
    const ensurePerson = (authorId: string): string => {
        const existing = personIris.get(authorId);
        if (existing) return existing;
        const personIri = iri.entity('person', authorId);
        personIris.set(authorId, personIri);
        addIri(personIri, RDF.type, SCHEMA.Person);
        add(personIri, DCTERMS.identifier, literal(authorId));
        return personIri;
    };

    // --- Dokumente -----------------------------------------------------
    const slugToDocIri = new Map<string, string>();
    for (const doc of input.docs) {
        slugToDocIri.set(doc.slug, iri.entity('doc', doc.id));
    }

    for (const doc of input.docs) {
        const docIri = iri.entity('doc', doc.id);
        counts.docs += 1;
        addIri(docIri, RDF.type, SCHEMA.DigitalDocument);
        addIri(docIri, RDF.type, OW.Document);
        addIri(docIri, RDF.type, docSchemaType(doc));
        const lang = doc.inLanguage || 'de';
        add(docIri, SCHEMA.name, literal(doc.title, lang));
        add(docIri, SCHEMA.text, literal(doc.content, lang));
        add(docIri, SCHEMA.inLanguage, literal(lang));
        add(docIri, DCTERMS.identifier, literal(doc.slug));
        add(docIri, DCTERMS.created, typedLiteral.dateTime(doc.createdAt));
        add(docIri, DCTERMS.modified, typedLiteral.dateTime(doc.updatedAt));
        if (doc.category) {
            add(docIri, OW.inFolder, literal(doc.category));
        }
        if (doc.author) {
            addIri(docIri, SCHEMA.author, ensurePerson(doc.author));
        }
        for (const tag of doc.tags) {
            addIri(docIri, SCHEMA.about, ensureTag(tag));
            counts.tags = tagIris.size;
        }
        // Wikilinks: alle Behauptungen werden übernommen; nicht auflösbare
        // Ziele bekommen eine stabile Slug-IRI (die Projektion filtert
        // Kanten auf existierende Knoten — Wissen vs. Ansicht).
        for (const match of doc.content.matchAll(WIKILINK)) {
            const targetSlug = slugifyTitle(match[1]);
            if (!targetSlug) continue;
            const target = slugToDocIri.get(targetSlug) ?? iri.entity('doc', targetSlug);
            addIri(docIri, OW.linksTo, target);
            counts.links += 1;
        }
    }

    // --- Projekte ------------------------------------------------------
    for (const project of input.projects) {
        const projectIri = iri.entity('project', project.id);
        counts.projects += 1;
        addIri(projectIri, RDF.type, SCHEMA.Project);
        addIri(projectIri, RDF.type, OW.Project);
        add(projectIri, SCHEMA.name, literal(project.title));
        if (project.description) add(projectIri, SCHEMA.description, literal(project.description));
        add(projectIri, DCTERMS.identifier, literal(project.prefix));
        add(projectIri, DCTERMS.created, typedLiteral.dateTime(project.createdAt));
        add(projectIri, DCTERMS.modified, typedLiteral.dateTime(project.updatedAt));
        // project.color ist Präsentation und bleibt in der Datei (M5).
    }

    // --- Aufgaben ------------------------------------------------------
    for (const task of input.tasks) {
        const taskIri = iri.entity('task', task.id);
        counts.tasks += 1;
        addIri(taskIri, RDF.type, SCHEMA.Action);
        addIri(taskIri, RDF.type, OW.Task);
        add(taskIri, SCHEMA.name, literal(task.title));
        if (task.description) add(taskIri, SCHEMA.description, literal(task.description));
        addIri(taskIri, SCHEMA.actionStatus, taskStatusIri(task.status));
        if (task.projectId) addIri(taskIri, OW.inProject, iri.entity('project', task.projectId));
        if (task.startDate) add(taskIri, SCHEMA.startTime, typedLiteral.dateTime(task.startDate));
        if (task.dueDate) add(taskIri, SCHEMA.endTime, typedLiteral.dateTime(task.dueDate));
        add(taskIri, DCTERMS.created, typedLiteral.dateTime(task.createdAt));
        add(taskIri, DCTERMS.modified, typedLiteral.dateTime(task.updatedAt));
        for (const tag of task.tags) {
            addIri(taskIri, SCHEMA.about, ensureTag(tag));
        }
        // Alle Abhängigkeitstypen (FS/SS/FF/SF) werden als ow:blockedBy
        // angenähert; die Feintypisierung folgt mit RDF-star-Annotationen,
        // sobald der Schreibpfad auf den Store umgestellt ist.
        for (const dep of task.dependencies) {
            addIri(taskIri, OW.blockedBy, iri.entity('task', dep.id));
            counts.links += 1;
        }
    }

    // --- Canvases ------------------------------------------------------
    for (const canvas of input.canvases) {
        const canvasIri = iri.entity('canvas', canvas.id);
        counts.canvases += 1;
        addIri(canvasIri, RDF.type, OW.Canvas);
        addIri(canvasIri, RDF.type, SCHEMA.CreativeWork);
        add(canvasIri, SCHEMA.name, literal(canvas.name));
        if (canvas.description) add(canvasIri, SCHEMA.description, literal(canvas.description));
        add(canvasIri, DCTERMS.created, typedLiteral.dateTime(canvas.createdAt));
        add(canvasIri, DCTERMS.modified, typedLiteral.dateTime(canvas.updatedAt));

        const cardIri = (cardId: string) => iri.entity('card', `${canvas.id}/${cardId}`);
        for (const card of canvas.cards) {
            counts.cards += 1;
            const cIri = cardIri(card.id);
            addIri(cIri, RDF.type, SCHEMA.CreativeWork);
            add(cIri, SCHEMA.name, literal(card.title));
            if (card.content) add(cIri, SCHEMA.text, literal(card.content));
            add(cIri, DCTERMS.created, typedLiteral.dateTime(card.createdAt));
            add(cIri, DCTERMS.modified, typedLiteral.dateTime(card.updatedAt));
            addIri(canvasIri, SCHEMA.hasPart, cIri);
            // card.x/y/width/height/color: Präsentation, nicht migriert (M5).
        }
        // JSON-Canvas-Regel (SPEC §9): untypisierte Kanten → ow:linksTo.
        for (const connection of canvas.connections) {
            addIri(cardIri(connection.fromId), OW.linksTo, cardIri(connection.toId));
            counts.links += 1;
        }
    }

    counts.tags = tagIris.size;
    counts.quads = quads.length;
    return { quads, counts };
}
