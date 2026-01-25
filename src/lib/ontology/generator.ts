
import { WithContext } from 'schema-dts';
import { OntologyConfig, GLOBAL_ASK_PERSON, SchemaOrgDoc } from './types';
import { Doc } from '@/types/doc';

// Hardcoded for now, ideally strictly typed config or .env
const CONFIG: OntologyConfig = {
    baseUrl: 'https://exocortex.local',
    defaultLanguage: 'de',
    person: GLOBAL_ASK_PERSON
};

/**
 * Remove Markdown syntax and HTML tags for plaintext description
 */
function stripMarkdown(text: string): string {
    return text
        .replace(/!\[.*?\]\(.*?\)/g, '') // Remove images
        .replace(/\[([^\]]+)\]\(.*?\)/g, '$1') // Remove links
        .replace(/(\*\*|__)(.*?)\1/g, '$2') // Remove bold
        .replace(/(\*|_)(.*?)\1/g, '$2') // Remove italic
        .replace(/^#+\s+/gm, '') // Remove header syntax (keep text)
        .replace(/<[^>]*>/g, '') // Remove HTML
        .replace(/\s+/g, ' ') // Normalize whitespace (newlines to spaces)
        .trim()
        .slice(0, 160);

    return text.length > 160 ? text + '...' : text;
}

/**
 * Extract internal links [[Example]] to build graph edges
 */
function extractMentions(content: string): { '@type': 'Thing', name: string, '@id': string }[] {
    const mentions: { '@type': 'Thing', name: string, '@id': string }[] = [];
    const wikiLinkRegex = /\[\[(.*?)\]\]/g;
    let match;

    while ((match = wikiLinkRegex.exec(content)) !== null) {
        const title = match[1];
        // Synthetic ID based on unknown target slug (best effort: sanitize title)
        // In a real system, we would lookup key by title.
        const targetSlug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-');

        mentions.push({
            '@type': 'Thing',
            name: title,
            '@id': `${CONFIG.baseUrl}/docs/${targetSlug}`
        });
    }

    return mentions;
}

export function generateDocJsonLd(doc: Doc): WithContext<SchemaOrgDoc> {
    const url = `${CONFIG.baseUrl}/docs/${doc.slug}`;
    const description = stripMarkdown(doc.content);
    const mentions = extractMentions(doc.content);

    // Common properties that apply to our CreativeWork intersection
    const base = {
        '@context': 'https://schema.org' as const,
        '@id': url,
        url: url,
        headline: doc.title,
        description: description,
        author: CONFIG.person,
        inLanguage: doc.inLanguage || CONFIG.defaultLanguage,
        dateCreated: doc.createdAt,
        dateModified: doc.updatedAt,
        keywords: doc.tags.join(', '),
        mentions: mentions.length > 0 ? mentions : undefined,
    };

    switch (doc.type) {
        case 'BlogPosting':
            return {
                ...base,
                '@type': 'BlogPosting',
            };
        case 'TechArticle':
            return {
                ...base,
                '@type': 'TechArticle',
                proficiencyLevel: 'Expert',
            };
        case 'HowTo':
            return {
                ...base,
                '@type': 'HowTo',
                step: [],
            };
        case 'DefinedTerm':
            return {
                '@context': 'https://schema.org' as const,
                '@type': 'DefinedTerm',
                '@id': url,
                name: doc.title,
                description: description,
                inDefinedTermSet: {
                    '@type': 'DefinedTermSet',
                    '@id': `${CONFIG.baseUrl}/glossary`,
                    name: 'Exocortex Glossary'
                }
            };
        default:
            return {
                ...base,
                '@type': 'CreativeWork',
            };
    }
}
