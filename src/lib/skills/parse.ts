import { parse as parseYaml } from 'yaml';

/**
 * SKILL.md parsing: YAML frontmatter (name, description, license, …)
 * followed by a markdown body. Tolerant against missing frontmatter —
 * then the first heading becomes the name.
 */

export interface ParsedSkillFile {
    name: string;
    description: string;
    content: string;
}

const FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

export function parseSkillMarkdown(raw: string, fallbackName = 'Unbenannter Skill'): ParsedSkillFile {
    const match = raw.match(FRONTMATTER_PATTERN);

    if (match) {
        let meta: Record<string, unknown> = {};
        try {
            const parsed = parseYaml(match[1]);
            if (parsed && typeof parsed === 'object') meta = parsed as Record<string, unknown>;
        } catch {
            // Broken frontmatter → treat whole file as body
        }
        const body = raw.slice(match[0].length).trim();
        const name = typeof meta.name === 'string' && meta.name.trim() ? meta.name.trim() : firstHeading(body) ?? fallbackName;
        const description = typeof meta.description === 'string' ? meta.description.trim() : '';
        return { name, description, content: body };
    }

    const body = raw.trim();
    return {
        name: firstHeading(body) ?? fallbackName,
        description: '',
        content: body,
    };
}

function firstHeading(markdown: string): string | null {
    const match = markdown.match(/^#{1,3}\s+(.+)$/m);
    return match ? match[1].trim() : null;
}

/** Serialize a skill back to SKILL.md format (export / repo round-trip). */
export function serializeSkillMarkdown(name: string, description: string, content: string): string {
    const escapedName = name.includes(':') || name.includes('"') ? JSON.stringify(name) : name;
    const escapedDescription = description.includes(':') || description.includes('"')
        ? JSON.stringify(description)
        : description;
    return `---\nname: ${escapedName}\ndescription: ${escapedDescription}\n---\n\n${content}\n`;
}
