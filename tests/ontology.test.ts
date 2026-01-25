
import { describe, it, expect } from 'bun:test';
import { generateDocJsonLd } from '../src/lib/ontology/generator';
import { Doc } from '../src/types/doc';

// Mock Config if necessary, but generator imports it. We assume valid default config.

describe('JSON-LD Ontology', () => {

    it('should generate valid BlogPosting for Daily Notes', () => {
        const doc: Doc = {
            id: '1',
            slug: '2025-01-25-daily-log',
            title: 'Daily Log 2025-01-25',
            content: 'Today I worked on JSON-LD.',
            tags: ['daily'],
            createdAt: '2025-01-25T10:00:00Z',
            updatedAt: '2025-01-25T10:00:00Z',
            type: 'BlogPosting',
            author: 'michael-pajewski'
        };

        const jsonLd = generateDocJsonLd(doc);

        expect(jsonLd['@context']).toBe('https://schema.org');
        expect(jsonLd['@type']).toBe('BlogPosting');
        expect(jsonLd['@id']).toContain('/docs/2025-01-25-daily-log');
        expect(jsonLd.headline).toBe(doc.title);
        // Check strictness via compiled TS, but runtime check fields
        expect(jsonLd.inLanguage).toBe('de'); // Default from config
    });

    it('should strip markdown from description', () => {
        const doc: Doc = {
            id: '2',
            slug: 'tech-setup',
            title: 'Tech Setup',
            content: '# Heading\n\nThis is **bold** text and [link](url).',
            tags: [],
            createdAt: '2025-01-25T10:00:00Z',
            updatedAt: '2025-01-25T10:00:00Z',
            type: 'TechArticle'
        };

        const jsonLd = generateDocJsonLd(doc);
        expect(jsonLd.description).toBe('Heading This is bold text and link.');
    });

    it('should generate mentions from internal links', () => {
        const doc: Doc = {
            id: '3',
            slug: 'ai-agents',
            title: 'AI Agents',
            content: 'This refers to [[LLMs]] and [[Neural Networks]].',
            tags: [],
            createdAt: '2025-01-25T10:00:00Z',
            updatedAt: '2025-01-25T10:00:00Z',
            type: 'TechArticle'
        };

        const jsonLd = generateDocJsonLd(doc);

        // mentions is correctly typed as Thing[] or undefined in our generator logic (though schema-dts allows more)
        const mentions = jsonLd.mentions as any[];
        expect(mentions).toBeDefined();
        expect(mentions.length).toBe(2);
        expect(mentions[0].name).toBe('LLMs');
        expect(mentions[0]['@id']).toContain('/docs/llms');
    });

    it('should generate DefinedTerm correctly', () => {
        const doc: Doc = {
            id: '4',
            slug: 'json-ld',
            title: 'JSON-LD',
            content: 'JSON for Linking Data',
            tags: ['definition'],
            createdAt: '2025-01-25T10:00:00Z',
            updatedAt: '2025-01-25T10:00:00Z',
            type: 'DefinedTerm'
        };

        const jsonLd = generateDocJsonLd(doc);
        expect(jsonLd['@type']).toBe('DefinedTerm');
        // DefinedTerm uses specific structure
        const term = jsonLd as any;
        expect(term.inDefinedTermSet).toBeDefined();
        expect(term.inDefinedTermSet.name).toBe('Exocortex Glossary');
    });

});
