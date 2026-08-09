/**
 * Rück-Abbildung Workspace-Graph → Domänenmodell (Abschluss SPEC §12.4).
 *
 * Der Store ist die eine Wahrheit; diese Funktionen rekonstruieren daraus
 * die Domänen-Objekte (Doc, Task, Project, CanvasData) für UI, API und
 * Datei-Projektion. Gegenstück zur Vorwärts-Abbildung in
 * `migrate/from-files.ts` (Wissen) und `presentation/layout.ts` (Layout);
 * der Round-Trip ist als Test verankert
 * (`tests/graph/workspace-roundtrip.test.ts`).
 *
 * Normalisierungen (dokumentiert, deterministisch — analog zur
 * Frontmatter-Normalisierung des Obsidian-Round-Trips, M4):
 *  - Leere Strings optionaler Felder werden zu „nicht gesetzt".
 *  - Tags und Abhängigkeiten sind sortiert (RDF kennt keine Reihenfolge).
 *  - Entitäten sind nach (createdAt, id) sortiert.
 *  - Zeitstempel: Oxigraph entfernt „.000" aus xsd:dateTime-Lexik; die
 *    Rekonstruktion stellt genau diese JS-ISO-Form wieder her und lässt
 *    alle anderen Formen (z. B. reine Datumsangaben) unangetastet.
 */

import type { Quad } from '@rdfjs/types';
import type { Doc } from '@/types/doc';
import type { Task, TaskDependency, TaskPriority, TaskStatus, TaskType } from '@/lib/storage/tasks';
import type { Project, ProjectStatus } from '@/lib/storage/projects';
import type { CanvasCard, CanvasConnection, CanvasData } from '@/lib/storage/canvas';
import type { GraphStore } from '../store/types';
import type { IriFactory } from '../iri';
import { namedNode } from '../rdf';
import { DCTERMS, OW, PROV, RDF, SCHEMA, SKOS } from '../vocab';
import { docTypeFromSchemaTypes, type WorkspaceSnapshotInput } from '../migrate/from-files';

const TASK_STATUSES: ReadonlySet<string> = new Set(['backlog', 'todo', 'in-progress', 'review', 'done', 'on-hold']);
const TASK_PRIORITIES: ReadonlySet<string> = new Set(['low', 'medium', 'high', 'urgent']);
const TASK_TYPES: ReadonlySet<string> = new Set(['task', 'bug', 'feature', 'milestone']);
const PROJECT_STATUSES: ReadonlySet<string> = new Set(['planning', 'active', 'completed', 'archived']);
const DEPENDENCY_KINDS: ReadonlySet<string> = new Set(['FS', 'SS', 'FF', 'SF']);

/** Default-Farbe neuer Projekte (storage/projects.ts) — Fallback ohne Presentation-Wert. */
const DEFAULT_PROJECT_COLOR = '#00674F';

/**
 * Stellt die JS-ISO-Form eines Zeitstempels wieder her, wenn Oxigraph
 * lediglich die Endnullen der Sekundenbruchteile entfernt hat — die
 * kanonische xsd:dateTime-Lexik kürzt „.000" ganz weg, „.090" zu „.09"
 * und „.100" zu „.1". Alles andere (reine Datumsangaben, fremde
 * Zeitzonen-Offsets, echte Sub-Millisekunden) bleibt wörtlich erhalten.
 */
export function isoFromStoreValue(value: string): string {
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) return value;
    const iso = parsed.toISOString();
    if (iso === value) return value;
    const canonical = iso.replace(/(\.\d*?)0+Z$/, (_, keep: string) => (keep === '.' ? 'Z' : `${keep}Z`));
    if (canonical === value) return iso;
    return value;
}

interface SubjectIndex {
    types: Set<string>;
    byPredicate: Map<string, Quad[]>;
}

function indexBySubject(quads: Iterable<Quad>): Map<string, SubjectIndex> {
    const index = new Map<string, SubjectIndex>();
    for (const q of quads) {
        if (q.subject.termType !== 'NamedNode') continue;
        let entry = index.get(q.subject.value);
        if (!entry) {
            entry = { types: new Set(), byPredicate: new Map() };
            index.set(q.subject.value, entry);
        }
        if (q.predicate.value === RDF.type && q.object.termType === 'NamedNode') {
            entry.types.add(q.object.value);
        }
        const list = entry.byPredicate.get(q.predicate.value) ?? [];
        list.push(q);
        entry.byPredicate.set(q.predicate.value, list);
    }
    return index;
}

function firstValue(entry: SubjectIndex | undefined, predicate: string): string | undefined {
    return entry?.byPredicate.get(predicate)?.[0]?.object.value;
}

function firstIri(entry: SubjectIndex | undefined, predicate: string): string | undefined {
    const quad = entry?.byPredicate.get(predicate)?.find(q => q.object.termType === 'NamedNode');
    return quad?.object.value;
}

function allIris(entry: SubjectIndex | undefined, predicate: string): string[] {
    return (entry?.byPredicate.get(predicate) ?? [])
        .filter(q => q.object.termType === 'NamedNode')
        .map(q => q.object.value);
}

function timeValue(entry: SubjectIndex | undefined, predicate: string): string | undefined {
    const raw = firstValue(entry, predicate);
    return raw === undefined ? undefined : isoFromStoreValue(raw);
}

function numberValue(entry: SubjectIndex | undefined, predicate: string): number | undefined {
    const raw = firstValue(entry, predicate);
    if (raw === undefined) return undefined;
    const parsed = Number.parseFloat(raw);
    return Number.isFinite(parsed) ? parsed : undefined;
}

/** `<base>u/<userId>/<type>/<rest>` → dekodierte stabile ID, sonst null. */
function idFromEntityIri(iri: IriFactory, type: string, entityIri: string): string | null {
    const prefix = `${iri.instanceBase}u/${encodeURIComponent(iri.userId)}/${type}/`;
    if (!entityIri.startsWith(prefix)) return null;
    const rest = entityIri.slice(prefix.length);
    try {
        return rest.split('/').map(decodeURIComponent).join('/');
    } catch {
        return null;
    }
}

function enumValue<T extends string>(raw: string | undefined, allowed: ReadonlySet<string>, fallback: T): T {
    return raw !== undefined && allowed.has(raw) ? (raw as T) : fallback;
}

async function dumpGraph(store: GraphStore, graphIri: string): Promise<Quad[]> {
    const quads: Quad[] = [];
    for await (const q of store.dump(namedNode(graphIri))) {
        quads.push(q);
    }
    return quads;
}

function byCreatedThenId(a: { createdAt: string; id: string }, b: { createdAt: string; id: string }): number {
    if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Tag-IRIs → sortierte prefLabels (fehlende Labels fallen ehrlich weg). */
function tagsFor(entry: SubjectIndex | undefined, index: Map<string, SubjectIndex>): string[] {
    const labels: string[] = [];
    for (const tagIri of allIris(entry, SCHEMA.about)) {
        const label = firstValue(index.get(tagIri), SKOS.prefLabel);
        if (label !== undefined) labels.push(label);
    }
    return labels.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

function nonEmpty(value: string | undefined): string | undefined {
    return value === undefined || value === '' ? undefined : value;
}

/**
 * Rekonstruiert das komplette Domänenmodell aus Workspace- und
 * Presentation-Graph. Eine Funktion für alles — die CRUD-Schicht liest
 * hierüber, mutiert im Domänenmodell und bildet vollständig zurück ab.
 */
export async function workspaceFromStore(store: GraphStore, iri: IriFactory): Promise<WorkspaceSnapshotInput> {
    const workspace = await dumpGraph(store, iri.graph('workspace'));
    const presentation = await dumpGraph(store, iri.graph('presentation'));
    const index = indexBySubject(workspace);
    const layoutIndex = indexBySubject(presentation);

    // Reifier-Annotationen (RDF 1.2): ow:dependencyKind am Reifier einer
    // ow:blockedBy-Kante, adressiert über das reifizierte Tripel.
    const dependencyKinds = new Map<string, string>();
    for (const q of workspace) {
        if (q.predicate.value !== RDF.reifies || q.object.termType !== 'Quad') continue;
        const triple = q.object;
        if (triple.predicate.value !== OW.blockedBy) continue;
        if (q.subject.termType !== 'NamedNode') continue;
        const kind = firstValue(index.get(q.subject.value), OW.dependencyKind);
        if (kind !== undefined && DEPENDENCY_KINDS.has(kind)) {
            dependencyKinds.set(`${triple.subject.value}\t${triple.object.value}`, kind);
        }
    }

    const docs: Doc[] = [];
    const tasks: Task[] = [];
    const projects: Project[] = [];
    const canvases: CanvasData[] = [];

    for (const [subject, entry] of index) {
        if (entry.types.has(OW.Document)) {
            const id = idFromEntityIri(iri, 'doc', subject);
            if (!id) continue;
            const authorIri = firstIri(entry, SCHEMA.author);
            const author = authorIri
                ? firstValue(index.get(authorIri), DCTERMS.identifier)
                : undefined;
            docs.push({
                id,
                slug: firstValue(entry, DCTERMS.identifier) ?? id,
                title: firstValue(entry, SCHEMA.name) ?? id,
                content: firstValue(entry, SCHEMA.text) ?? '',
                category: nonEmpty(firstValue(entry, OW.inFolder)),
                tags: tagsFor(entry, index),
                author: nonEmpty(author),
                type: docTypeFromSchemaTypes(entry.types),
                inLanguage: firstValue(entry, SCHEMA.inLanguage),
                createdAt: timeValue(entry, DCTERMS.created) ?? '',
                updatedAt: timeValue(entry, DCTERMS.modified) ?? '',
            });
            continue;
        }
        if (entry.types.has(OW.Task)) {
            const id = idFromEntityIri(iri, 'task', subject);
            if (!id) continue;
            const projectIri = firstIri(entry, OW.inProject);
            const dependencies: TaskDependency[] = allIris(entry, OW.blockedBy)
                .map(targetIri => {
                    const targetId = idFromEntityIri(iri, 'task', targetIri);
                    if (!targetId) return null;
                    const kind = dependencyKinds.get(`${subject}\t${targetIri}`) ?? 'FS';
                    return { id: targetId, type: kind as TaskDependency['type'] };
                })
                .filter((dep): dep is TaskDependency => dep !== null)
                .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
            tasks.push({
                id,
                projectId: projectIri ? idFromEntityIri(iri, 'project', projectIri) ?? undefined : undefined,
                title: firstValue(entry, SCHEMA.name) ?? id,
                description: nonEmpty(firstValue(entry, SCHEMA.description)),
                status: enumValue<TaskStatus>(firstValue(entry, OW.workflowStatus), TASK_STATUSES, 'todo'),
                priority: enumValue<TaskPriority>(firstValue(entry, OW.priority), TASK_PRIORITIES, 'medium'),
                type: enumValue<TaskType>(firstValue(entry, OW.taskKind), TASK_TYPES, 'task'),
                startDate: timeValue(entry, SCHEMA.startTime),
                dueDate: timeValue(entry, SCHEMA.endTime),
                deferredUntil: timeValue(entry, OW.deferredUntil),
                estimatedEffort: numberValue(entry, OW.estimatedEffort),
                actualEffort: numberValue(entry, OW.actualEffort),
                dependencies,
                tags: tagsFor(entry, index),
                createdAt: timeValue(entry, DCTERMS.created) ?? '',
                updatedAt: timeValue(entry, DCTERMS.modified) ?? '',
                completedAt: timeValue(entry, PROV.endedAtTime),
            });
            continue;
        }
        if (entry.types.has(OW.Project)) {
            const id = idFromEntityIri(iri, 'project', subject);
            if (!id) continue;
            projects.push({
                id,
                title: firstValue(entry, SCHEMA.name) ?? id,
                description: nonEmpty(firstValue(entry, SCHEMA.description)),
                prefix: firstValue(entry, DCTERMS.identifier) ?? '',
                status: enumValue<ProjectStatus>(firstValue(entry, OW.workflowStatus), PROJECT_STATUSES, 'planning'),
                color: firstValue(layoutIndex.get(subject), SCHEMA.color) ?? DEFAULT_PROJECT_COLOR,
                createdAt: timeValue(entry, DCTERMS.created) ?? '',
                updatedAt: timeValue(entry, DCTERMS.modified) ?? '',
            });
            continue;
        }
        if (entry.types.has(OW.Canvas)) {
            const id = idFromEntityIri(iri, 'canvas', subject);
            if (!id) continue;
            canvases.push(reconstructCanvas(iri, subject, id, entry, index, layoutIndex));
        }
    }

    docs.sort(byCreatedThenId);
    tasks.sort(byCreatedThenId);
    projects.sort(byCreatedThenId);
    canvases.sort(byCreatedThenId);
    return { docs, tasks, projects, canvases };
}

function cardTypeFromLayout(nodeKind: string | undefined, cardKind: string | undefined): CanvasCard['type'] {
    if (cardKind === 'task' || cardKind === 'image') return cardKind;
    if (nodeKind === 'group') return 'group';
    if (nodeKind === 'link') return 'link';
    if (nodeKind === 'file') return 'file';
    return 'note';
}

function connectionTypeFromLayout(fromEnd: string | undefined, toEnd: string | undefined): CanvasConnection['type'] {
    if (fromEnd === 'arrow') return 'bidirectional';
    if (toEnd === 'none') return 'simple';
    return 'directional';
}

function reconstructCanvas(
    iri: IriFactory,
    canvasIri: string,
    canvasId: string,
    entry: SubjectIndex,
    index: Map<string, SubjectIndex>,
    layoutIndex: Map<string, SubjectIndex>,
): CanvasData {
    const layoutRoot = layoutIndex.get(canvasIri);
    const viewport = {
        x: numberValue(layoutRoot, OW.viewportX) ?? 0,
        y: numberValue(layoutRoot, OW.viewportY) ?? 0,
        zoom: numberValue(layoutRoot, OW.viewportZoom) ?? 1,
    };

    const cards: CanvasCard[] = [];
    const connections: CanvasConnection[] = [];
    // Layout-Knoten-IRI → Karten-ID, für die Kanten-Endpunkte.
    const cardIdByLayoutIri = new Map<string, string>();

    for (const [subject, layoutEntry] of layoutIndex) {
        if (firstIri(layoutEntry, SCHEMA.isPartOf) !== canvasIri) continue;
        const identifier = firstValue(layoutEntry, DCTERMS.identifier);
        if (identifier === undefined) continue;

        if (layoutEntry.types.has(OW.CanvasNode)) {
            cardIdByLayoutIri.set(subject, identifier);
            const type = cardTypeFromLayout(firstValue(layoutEntry, OW.nodeKind), firstValue(layoutEntry, OW.cardKind));
            const semantic = type === 'group'
                ? undefined
                : index.get(iri.entity('card', `${canvasId}/${identifier}`));
            let content: string | undefined;
            if (type === 'link') {
                content = firstValue(semantic, SCHEMA.url);
            } else if (type === 'file' || type === 'image') {
                content = firstValue(layoutEntry, OW.filePath);
            } else if (type !== 'group') {
                content = firstValue(semantic, SCHEMA.text);
            }
            cards.push({
                id: identifier,
                type,
                title: (type === 'group'
                    ? firstValue(layoutEntry, SCHEMA.name)
                    : firstValue(semantic, SCHEMA.name)) ?? '',
                content: nonEmpty(content),
                x: numberValue(layoutEntry, OW.xPosition) ?? 0,
                y: numberValue(layoutEntry, OW.yPosition) ?? 0,
                width: numberValue(layoutEntry, SCHEMA.width) ?? 240,
                height: numberValue(layoutEntry, SCHEMA.height) ?? 180,
                color: nonEmpty(firstValue(layoutEntry, SCHEMA.color)),
                createdAt: (type === 'group'
                    ? timeValue(layoutEntry, DCTERMS.created)
                    : timeValue(semantic, DCTERMS.created)) ?? '',
                updatedAt: (type === 'group'
                    ? timeValue(layoutEntry, DCTERMS.modified)
                    : timeValue(semantic, DCTERMS.modified)) ?? '',
            });
        }
    }

    for (const [, layoutEntry] of layoutIndex) {
        if (firstIri(layoutEntry, SCHEMA.isPartOf) !== canvasIri) continue;
        if (!layoutEntry.types.has(OW.CanvasEdge)) continue;
        const identifier = firstValue(layoutEntry, DCTERMS.identifier);
        const fromIri = firstIri(layoutEntry, OW.edgeFrom);
        const toIri = firstIri(layoutEntry, OW.edgeTo);
        if (identifier === undefined || !fromIri || !toIri) continue;
        const fromId = cardIdByLayoutIri.get(fromIri);
        const toId = cardIdByLayoutIri.get(toIri);
        if (fromId === undefined || toId === undefined) continue;
        connections.push({
            id: identifier,
            fromId,
            toId,
            type: connectionTypeFromLayout(firstValue(layoutEntry, OW.fromEnd), firstValue(layoutEntry, OW.toEnd)),
            label: nonEmpty(firstValue(layoutEntry, SCHEMA.name)),
        });
    }

    cards.sort(byCreatedThenId);
    connections.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

    return {
        id: canvasId,
        name: firstValue(entry, SCHEMA.name) ?? canvasId,
        description: nonEmpty(firstValue(entry, SCHEMA.description)),
        cards,
        connections,
        viewport,
        createdAt: timeValue(entry, DCTERMS.created) ?? '',
        updatedAt: timeValue(entry, DCTERMS.modified) ?? '',
    };
}
