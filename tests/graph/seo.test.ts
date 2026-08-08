// @vitest-environment node
/**
 * SEO-Projektion (Nachfolger von tests/ontology.test.ts): dieselben
 * Erwartungen an die JSON-LD-Snippets, jetzt gegen
 * src/lib/graph/projection/seo.ts — ohne exocortex.local.
 */
import { describe, it, expect } from 'vitest';
import { generateDocJsonLd, generateTaskListJsonLd, generateCanvasListJsonLd } from '../../src/lib/graph/projection/seo';
import type { Doc } from '../../src/types/doc';

const asRecord = (value: unknown) => value as Record<string, unknown>;

describe('SEO-JSON-LD-Projektion', () => {
    it('erzeugt BlogPosting für Daily Notes', () => {
        const doc: Doc = {
            id: '1', slug: '2025-01-25-daily-log', title: 'Daily Log 2025-01-25',
            content: 'Today I worked on JSON-LD.', tags: ['daily'],
            createdAt: '2025-01-25T10:00:00Z', updatedAt: '2025-01-25T10:00:00Z',
            type: 'BlogPosting', author: 'michael-pajewski',
        };
        const jsonLd = asRecord(generateDocJsonLd(doc));
        expect(jsonLd['@context']).toBe('https://schema.org');
        expect(jsonLd['@type']).toBe('BlogPosting');
        expect(jsonLd['@id']).toContain('/docs/2025-01-25-daily-log');
        expect(jsonLd['@id']).not.toContain('exocortex.local');
        expect(jsonLd.headline).toBe(doc.title);
        expect(jsonLd.inLanguage).toBe('de');
    });

    it('entfernt Markdown aus der Beschreibung', () => {
        const doc: Doc = {
            id: '2', slug: 'tech-setup', title: 'Tech Setup',
            content: '# Heading\n\nThis is **bold** text and [link](url).', tags: [],
            createdAt: '2025-01-25T10:00:00Z', updatedAt: '2025-01-25T10:00:00Z',
            type: 'TechArticle',
        };
        const jsonLd = asRecord(generateDocJsonLd(doc));
        expect(jsonLd.description).toBe('Heading This is bold text and link.');
    });

    it('erzeugt mentions aus internen Links (inkl. Alias-Syntax)', () => {
        const doc: Doc = {
            id: '3', slug: 'ai-agents', title: 'AI Agents',
            content: 'This refers to [[LLMs]] and [[Neural Networks|NN]].', tags: [],
            createdAt: '2025-01-25T10:00:00Z', updatedAt: '2025-01-25T10:00:00Z',
            type: 'TechArticle',
        };
        const jsonLd = asRecord(generateDocJsonLd(doc));
        const mentions = jsonLd.mentions as Array<Record<string, string>>;
        expect(mentions).toHaveLength(2);
        expect(mentions[0].name).toBe('LLMs');
        expect(mentions[0]['@id']).toContain('/docs/llms');
        expect(mentions[1].name).toBe('Neural Networks');
    });

    it('erzeugt DefinedTerm mit Glossar', () => {
        const doc: Doc = {
            id: '4', slug: 'json-ld', title: 'JSON-LD', content: 'JSON for Linking Data',
            tags: ['definition'],
            createdAt: '2025-01-25T10:00:00Z', updatedAt: '2025-01-25T10:00:00Z',
            type: 'DefinedTerm',
        };
        const jsonLd = asRecord(generateDocJsonLd(doc));
        expect(jsonLd['@type']).toBe('DefinedTerm');
        const termSet = jsonLd.inDefinedTermSet as Record<string, string>;
        expect(termSet).toBeDefined();
        expect(termSet.name).toBe('Open Workspace Glossar');
    });

    it('erzeugt Projektlisten und Canvas-Listen ohne any-Casts', () => {
        const list = asRecord(generateTaskListJsonLd(
            [{ id: 'p1', title: 'Projekt' }],
            [{ id: 't1', title: 'Aufgabe', status: 'done', projectId: 'p1' }],
        ));
        expect(list['@type']).toBe('ItemList');
        const items = list.itemListElement as Array<Record<string, unknown>>;
        expect(items).toHaveLength(1);

        const canvases = asRecord(generateCanvasListJsonLd([
            { id: 'c1', name: 'Canvas', createdAt: '2025-01-01T00:00:00Z', updatedAt: '2025-01-01T00:00:00Z' },
        ]));
        expect(canvases['@type']).toBe('ItemList');
    });
});
