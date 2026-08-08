/**
 * SEO-Projektion: JSON-LD-Snippets für die Seiten (Docs, Aufgaben,
 * Canvas). Nachfolger von src/lib/ontology/generator*.ts (SPEC §12.5) —
 * dieselbe Ausgabeform, aber ohne die hartkodierte
 * `https://exocortex.local`-Base: `@id`/`url` sind dokumentrelativ und
 * lösen gegen den tatsächlichen Host auf.
 *
 * Diese Snippets sind eine Ansicht der über /api/graph ausgelieferten
 * Store-Daten für Suchmaschinen — keine zweite Wahrheit.
 */

import type { Thing, WithContext, Person } from 'schema-dts';
import type { Doc } from '@/types/doc';

const OWNER: Person = {
    '@type': 'Person',
    name: 'Michael Pajewski',
    url: 'https://github.com/pajew-ski',
};

const DEFAULT_LANGUAGE = 'de';

/** Markdown → Klartext-Beschreibung (max. 160 Zeichen). */
function stripMarkdown(text: string): string {
    const plain = text
        .replace(/!\[.*?\]\(.*?\)/g, '')
        .replace(/\[([^\]]+)\]\(.*?\)/g, '$1')
        .replace(/(\*\*|__)(.*?)\1/g, '$2')
        .replace(/(\*|_)(.*?)\1/g, '$2')
        .replace(/^#+\s+/gm, '')
        .replace(/<[^>]*>/g, '')
        .replace(/\s+/g, ' ')
        .trim();
    return plain.length > 160 ? `${plain.slice(0, 160)}…` : plain;
}

interface MentionRef {
    '@type': 'Thing';
    name: string;
    '@id': string;
}

function extractMentions(content: string): MentionRef[] {
    const mentions: MentionRef[] = [];
    for (const match of content.matchAll(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g)) {
        const title = match[1];
        const targetSlug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-');
        mentions.push({ '@type': 'Thing', name: title, '@id': `/docs/${targetSlug}` });
    }
    return mentions;
}

export function generateDocJsonLd(doc: Doc): WithContext<Thing> {
    const url = `/docs/${doc.slug}`;
    const description = stripMarkdown(doc.content);
    const mentions = extractMentions(doc.content);

    if (doc.type === 'DefinedTerm') {
        return {
            '@context': 'https://schema.org',
            '@type': 'DefinedTerm',
            '@id': url,
            name: doc.title,
            description,
            inDefinedTermSet: {
                '@type': 'DefinedTermSet',
                '@id': '/glossary',
                name: 'Open Workspace Glossar',
            },
        };
    }

    const base = {
        '@context': 'https://schema.org' as const,
        '@id': url,
        url,
        headline: doc.title,
        description,
        author: OWNER,
        inLanguage: doc.inLanguage || DEFAULT_LANGUAGE,
        dateCreated: doc.createdAt,
        dateModified: doc.updatedAt,
        keywords: doc.tags.join(', '),
        mentions: mentions.length > 0 ? mentions : undefined,
    };

    switch (doc.type) {
        case 'BlogPosting':
            return { ...base, '@type': 'BlogPosting' };
        case 'HowTo':
            return { ...base, '@type': 'HowTo', step: [] };
        case 'TechArticle':
            return { ...base, '@type': 'TechArticle', proficiencyLevel: 'Expert' };
        default:
            return { ...base, '@type': 'CreativeWork' };
    }
}

export interface SeoTask {
    id: string;
    title: string;
    status: string;
    projectId?: string;
    description?: string;
}

export interface SeoProject {
    id: string;
    title: string;
    description?: string;
}

function mapStatus(status: string): string {
    switch (status) {
        case 'done': return 'https://schema.org/CompletedActionStatus';
        case 'in-progress':
        case 'review': return 'https://schema.org/ActiveActionStatus';
        default: return 'https://schema.org/PotentialActionStatus';
    }
}

export function generateProjectJsonLd(project: SeoProject, tasks: SeoTask[]): WithContext<Thing> {
    const url = `/tasks?projectId=${project.id}`;
    const projectTasks = tasks.filter(t => t.projectId === project.id);
    // schema-dts erlaubt hasPart nicht auf Project (Organization) — die
    // Ausgabeform bleibt aber zum Alt-Contract kompatibel, daher der Cast.
    const node = {
        '@context': 'https://schema.org',
        '@type': 'Project',
        '@id': url,
        url,
        name: project.title,
        description: project.description || `Projekt: ${project.title}`,
        member: OWNER,
        hasPart: projectTasks.map(task => ({
            '@type': 'Action' as const,
            name: task.title,
            description: task.description,
            actionStatus: mapStatus(task.status),
            agent: OWNER,
        })),
    };
    return node as unknown as WithContext<Thing>;
}

export function generateTaskListJsonLd(projects: SeoProject[], tasks: SeoTask[]): WithContext<Thing> {
    return {
        '@context': 'https://schema.org',
        '@type': 'ItemList',
        name: 'Open Workspace Projekte',
        url: '/tasks',
        itemListElement: projects.map((project, index) => ({
            '@type': 'ListItem' as const,
            position: index + 1,
            item: generateProjectJsonLd(project, tasks),
        })),
    } as WithContext<Thing>;
}

export interface SeoCanvas {
    id: string;
    name: string;
    description?: string;
    createdAt: string;
    updatedAt: string;
}

export function generateCanvasJsonLd(canvas: SeoCanvas): WithContext<Thing> {
    const url = `/canvas/${canvas.id}`;
    return {
        '@context': 'https://schema.org',
        '@type': 'CreativeWork',
        '@id': url,
        url,
        name: canvas.name,
        description: canvas.description,
        author: OWNER,
        dateCreated: canvas.createdAt,
        dateModified: canvas.updatedAt,
        learningResourceType: 'Diagram',
        interactivityType: 'active',
    };
}

export function generateCanvasListJsonLd(canvases: SeoCanvas[]): WithContext<Thing> {
    return {
        '@context': 'https://schema.org',
        '@type': 'ItemList',
        name: 'Canvas Visualisierungen',
        url: '/canvas',
        itemListElement: canvases.map((canvas, index) => ({
            '@type': 'ListItem' as const,
            position: index + 1,
            item: generateCanvasJsonLd(canvas),
        })),
    } as WithContext<Thing>;
}
