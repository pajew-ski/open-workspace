/**
 * Vorwärts-Abbildung Domänenmodell → Workspace-Graph.
 *
 * Historisch der Migrator (SPEC §12.2); seit dem Abschluss von §12.4 ist
 * dies DIE Abbildung des Schreibpfads: jede Mutation baut hierüber den
 * Workspace-Graphen, die Dateien unter data/ sind Projektion. Die
 * Rück-Abbildung (Store → Domänenmodell) liegt in `workspace/read.ts`;
 * der Round-Trip ist als Test verankert
 * (`tests/graph/workspace-roundtrip.test.ts`).
 *
 * Pure Quad-Builder: idempotent und deterministisch — bewusst ohne
 * Zeitstempel des Laufs, damit wiederholte Läufe byte-identische
 * Snapshots erzeugen.
 *
 * Wissen/Präsentation-Trennung (Invariante 2): Layout-Werte (x/y/Breite/
 * Höhe/Farbe/Viewport, Projekt-Farben) werden hier NICHT abgebildet — der
 * semantische Graph enthält sie zu keinem Zeitpunkt. Das übernimmt
 * `presentation/layout.ts` nach `graph/<u>/presentation`.
 */

import type { Quad } from '@rdfjs/types';
import type { Doc } from '@/types/doc';
import type { Task } from '@/lib/storage/tasks';
import type { Project } from '@/lib/storage/projects';
import type { CanvasData } from '@/lib/storage/canvas';
import type { CalendarEvent, CalendarProvider } from '@/lib/storage/calendar';
import type { Conversation } from '@/lib/storage/chat';
import { factory, namedNode, typedLiteral, literal } from '../rdf';
import { DCTERMS, OW, PROV, RDF, SCHEMA, SKOS } from '../vocab';
import type { IriFactory } from '../iri';

export interface WorkspaceSnapshotInput {
    docs: Doc[];
    tasks: Task[];
    projects: Project[];
    canvases: CanvasData[];
    /** Abonnierte Kalender (M15) — schema:DataFeed. */
    calendars: CalendarProvider[];
    /** Termine dieser Kalender (M15) — schema:Event. */
    events: CalendarEvent[];
    /** Chat-Verlauf des Assistenten (M15) — schema:Conversation. */
    conversations: Conversation[];
    /** Zuletzt geöffnete Unterhaltung — Auswahl der Ansicht, graph/presentation. */
    activeConversationId?: string | null;
}

export interface MigrationCounts {
    docs: number;
    tasks: number;
    projects: number;
    canvases: number;
    /** Semantische Karten — Gruppen zählen nicht (reine Darstellung, SPEC §9). */
    cards: number;
    tags: number;
    links: number;
    calendars: number;
    events: number;
    conversations: number;
    messages: number;
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

/**
 * Polymorpher Doc-Typ ↔ schema.org-Klasse. Bijektiv, damit der Round-Trip
 * Store → Doc den exakten Frontmatter-Typ zurückliefert (Abschluss §12.4):
 * auch 'CreativeWork' wird materialisiert, ein fehlender Typ gar nicht.
 */
const DOC_TYPE_TO_SCHEMA: ReadonlyArray<readonly [Doc['type'] & string, string]> = [
    ['TechArticle', SCHEMA.TechArticle],
    ['BlogPosting', SCHEMA.BlogPosting],
    ['HowTo', SCHEMA.HowTo],
    ['DefinedTerm', SCHEMA.DefinedTerm],
    ['CreativeWork', SCHEMA.CreativeWork],
];

function docSchemaType(doc: Doc): string | null {
    if (!doc.type) return null;
    const entry = DOC_TYPE_TO_SCHEMA.find(([docType]) => docType === doc.type);
    return entry ? entry[1] : null;
}

export function docTypeFromSchemaTypes(schemaTypes: ReadonlySet<string>): Doc['type'] | undefined {
    const entry = DOC_TYPE_TO_SCHEMA.find(([, schemaType]) => schemaTypes.has(schemaType));
    return entry ? entry[0] : undefined;
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
        docs: 0, tasks: 0, projects: 0, canvases: 0, cards: 0, tags: 0, links: 0,
        calendars: 0, events: 0, conversations: 0, messages: 0, quads: 0,
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
    // Auflösungsindex für Wikilinks. Ein `[[…]]` nennt in der Praxis den
    // TITEL des Ziels, die kanonische Kennung eines Dokuments ist aber
    // sein Slug — und beide fallen auseinander, sobald ein Dokument nach
    // dem Anlegen umbenannt wurde (`module-tasks` vs. „Modul: Aufgaben &
    // Projekte"). Wer nur gegen Slugs auflöst, erklärt jede Titel-
    // Referenz für unauflösbar; die Kante entsteht dann auf eine IRI, die
    // es nicht gibt, und verschwindet in jeder Ansicht.
    const docIriByKey = new Map<string, string>();
    for (const doc of input.docs) {
        const titleKey = slugifyTitle(doc.title);
        if (titleKey && !docIriByKey.has(titleKey)) docIriByKey.set(titleKey, iri.entity('doc', doc.id));
    }
    // Slugs zuletzt: die kanonische Kennung sticht einen gleichlautenden
    // Titel eines anderen Dokuments.
    for (const doc of input.docs) {
        docIriByKey.set(doc.slug, iri.entity('doc', doc.id));
    }

    for (const doc of input.docs) {
        const docIri = iri.entity('doc', doc.id);
        counts.docs += 1;
        addIri(docIri, RDF.type, SCHEMA.DigitalDocument);
        addIri(docIri, RDF.type, OW.Document);
        const polymorphType = docSchemaType(doc);
        if (polymorphType) addIri(docIri, RDF.type, polymorphType);
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
            const targetKey = slugifyTitle(match[1]);
            if (!targetKey) continue;
            const target = docIriByKey.get(targetKey) ?? iri.entity('doc', targetKey);
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
        add(projectIri, OW.workflowStatus, literal(project.status));
        add(projectIri, DCTERMS.created, typedLiteral.dateTime(project.createdAt));
        add(projectIri, DCTERMS.modified, typedLiteral.dateTime(project.updatedAt));
        // project.color ist Präsentation: graph/<u>/presentation
        // (presentation/layout.ts#buildProjectPresentation), nie hier.
    }

    // --- Aufgaben ------------------------------------------------------
    for (const task of input.tasks) {
        const taskIri = iri.entity('task', task.id);
        counts.tasks += 1;
        addIri(taskIri, RDF.type, SCHEMA.Action);
        addIri(taskIri, RDF.type, OW.Task);
        add(taskIri, SCHEMA.name, literal(task.title));
        if (task.description) add(taskIri, SCHEMA.description, literal(task.description));
        // Doppel-Muster (Abschluss §12.4): grobe Standard-Projektion für
        // Interop PLUS exakter nativer Zustand als Quelltreue-Träger.
        addIri(taskIri, SCHEMA.actionStatus, taskStatusIri(task.status));
        add(taskIri, OW.workflowStatus, literal(task.status));
        add(taskIri, OW.priority, literal(task.priority));
        add(taskIri, OW.taskKind, literal(task.type));
        if (task.projectId) addIri(taskIri, OW.inProject, iri.entity('project', task.projectId));
        if (task.startDate) add(taskIri, SCHEMA.startTime, typedLiteral.dateTime(task.startDate));
        if (task.dueDate) add(taskIri, SCHEMA.endTime, typedLiteral.dateTime(task.dueDate));
        if (task.deferredUntil) add(taskIri, OW.deferredUntil, typedLiteral.dateTime(task.deferredUntil));
        if (task.estimatedEffort !== undefined) add(taskIri, OW.estimatedEffort, typedLiteral.decimal(task.estimatedEffort));
        if (task.actualEffort !== undefined) add(taskIri, OW.actualEffort, typedLiteral.decimal(task.actualEffort));
        if (task.completedAt) add(taskIri, PROV.endedAtTime, typedLiteral.dateTime(task.completedAt));
        add(taskIri, DCTERMS.created, typedLiteral.dateTime(task.createdAt));
        add(taskIri, DCTERMS.modified, typedLiteral.dateTime(task.updatedAt));
        for (const tag of task.tags) {
            addIri(taskIri, SCHEMA.about, ensureTag(tag));
        }
        // Abhängigkeiten als ow:blockedBy; Nicht-Default-Typen (SS/FF/SF)
        // als RDF-1.2-Annotation am benannten Reifier der Kante — dasselbe
        // Muster wie Alias/Einbettung beim Obsidian-Connector (M4).
        for (const dep of task.dependencies) {
            const target = iri.entity('task', dep.id);
            addIri(taskIri, OW.blockedBy, target);
            counts.links += 1;
            if (dep.type !== 'FS') {
                const reifier = iri.entity('link', `dep/${task.id}/${dep.id}`);
                const depTriple = factory.quad(namedNode(taskIri), namedNode(OW.blockedBy), namedNode(target));
                quads.push(factory.quad(namedNode(reifier), namedNode(RDF.reifies), depTriple));
                add(reifier, OW.dependencyKind, literal(dep.type));
            }
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

        // Gruppen sind reine Darstellung (SPEC §9): implizit über Position
        // definiert, keine Hierarchie-Behauptung — sie bekommen KEIN
        // semantisches Gegenstück; ihr Layout lebt in graph/presentation.
        const groupIds = new Set(canvas.cards.filter(card => card.type === 'group').map(card => card.id));

        const cardIri = (cardId: string) => iri.entity('card', `${canvas.id}/${cardId}`);
        for (const card of canvas.cards) {
            if (card.type === 'group') continue;
            counts.cards += 1;
            const cIri = cardIri(card.id);
            if (card.type === 'link') {
                addIri(cIri, RDF.type, SCHEMA.WebPage);
                if (card.content) add(cIri, SCHEMA.url, typedLiteral.anyUri(card.content));
            } else if (card.type === 'file' || card.type === 'image') {
                addIri(cIri, RDF.type, SCHEMA.DigitalDocument);
            } else {
                addIri(cIri, RDF.type, SCHEMA.CreativeWork);
                if (card.content) add(cIri, SCHEMA.text, literal(card.content));
            }
            add(cIri, SCHEMA.name, literal(card.title));
            add(cIri, DCTERMS.created, typedLiteral.dateTime(card.createdAt));
            add(cIri, DCTERMS.modified, typedLiteral.dateTime(card.updatedAt));
            addIri(canvasIri, SCHEMA.hasPart, cIri);
            // card.x/y/width/height/color: Präsentation — gespiegelt nach
            // graph/<u>/presentation (presentation/layout.ts), nie hierher.
        }
        // JSON-Canvas-Regel (SPEC §9): untypisierte Kanten → ow:linksTo.
        // Kanten an Gruppen sind reine Zeichnung ohne Wissens-Behauptung.
        for (const connection of canvas.connections) {
            if (groupIds.has(connection.fromId) || groupIds.has(connection.toId)) continue;
            addIri(cardIri(connection.fromId), OW.linksTo, cardIri(connection.toId));
            counts.links += 1;
        }
    }

    // --- Kalender (M15) ------------------------------------------------
    // Ein abonnierter Kalender ist ein schema:DataFeed, seine Termine sind
    // schema:Event mit schema:isPartOf auf den Feed — Standardklassen vor
    // eigenen (Invariante 8). Die Farbe des Kalenders ist Darstellung und
    // steht in graph/<u>/presentation, nie hier.
    for (const calendar of input.calendars) {
        const calendarIri = iri.entity('calendar', calendar.id);
        counts.calendars += 1;
        addIri(calendarIri, RDF.type, SCHEMA.DataFeed);
        add(calendarIri, SCHEMA.name, literal(calendar.name));
        add(calendarIri, DCTERMS.identifier, literal(calendar.id));
        add(calendarIri, SCHEMA.url, typedLiteral.anyUri(calendar.url));
        add(calendarIri, OW.enabled, typedLiteral.boolean(calendar.enabled));
        // Zeitpunkt des letzten erfolgreichen Abrufs — die Termine sind aus
        // ihm abgeleitet, deshalb prov:generatedAtTime statt dcterms:modified.
        if (calendar.lastSync) {
            add(calendarIri, PROV.generatedAtTime, typedLiteral.dateTime(calendar.lastSync));
        }
    }

    for (const event of input.events) {
        const eventIri = iri.entity('event', event.id);
        counts.events += 1;
        addIri(eventIri, RDF.type, SCHEMA.Event);
        add(eventIri, SCHEMA.name, literal(event.title));
        add(eventIri, DCTERMS.identifier, literal(event.id));
        add(eventIri, SCHEMA.startDate, typedLiteral.dateTime(event.startDate));
        add(eventIri, SCHEMA.endDate, typedLiteral.dateTime(event.endDate));
        if (event.allDay) add(eventIri, OW.allDay, typedLiteral.boolean(true));
        if (event.description) add(eventIri, SCHEMA.description, literal(event.description));
        if (event.location) add(eventIri, SCHEMA.location, literal(event.location));
        addIri(eventIri, SCHEMA.isPartOf, iri.entity('calendar', event.providerId));
    }

    // --- Chats (M15) ---------------------------------------------------
    // schema:Conversation mit schema:hasPart → schema:Message, wie Canvas
    // und Karten. Die generative Oberfläche einer Antwort (uiComponents)
    // ist Darstellung und steht in graph/<u>/presentation.
    for (const conversation of input.conversations) {
        const conversationIri = iri.entity('conversation', conversation.id);
        counts.conversations += 1;
        addIri(conversationIri, RDF.type, SCHEMA.Conversation);
        add(conversationIri, SCHEMA.name, literal(conversation.title));
        add(conversationIri, DCTERMS.identifier, literal(conversation.id));
        add(conversationIri, DCTERMS.created, typedLiteral.dateTime(conversation.createdAt));
        add(conversationIri, DCTERMS.modified, typedLiteral.dateTime(conversation.updatedAt));
        for (const message of conversation.messages) {
            const messageIri = iri.entity('message', `${conversation.id}/${message.id}`);
            counts.messages += 1;
            addIri(messageIri, RDF.type, SCHEMA.Message);
            add(messageIri, DCTERMS.identifier, literal(message.id));
            add(messageIri, SCHEMA.text, literal(message.content));
            add(messageIri, OW.messageRole, literal(message.role));
            add(messageIri, SCHEMA.dateSent, typedLiteral.dateTime(message.timestamp));
            addIri(conversationIri, SCHEMA.hasPart, messageIri);
        }
    }

    counts.tags = tagIris.size;
    counts.quads = quads.length;
    return { quads, counts };
}
