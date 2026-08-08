/**
 * Skills: reusable instruction packages for the assistant, modeled after
 * the SKILL.md convention (YAML frontmatter with name/description, body
 * with the actual instructions).
 *
 * Progressive disclosure keeps prompts lean: enabled skills are listed
 * with name + description only; the model pulls the full content on
 * demand via the built-in `use_skill` tool. Small, critical skills can
 * be marked `alwaysInject` to be embedded verbatim.
 */

export type SkillSourceType = 'manual' | 'url' | 'repo' | 'mcp-prompt';

export interface SkillSource {
    type: SkillSourceType;
    /** URL, owner/repo/path, or mcp server id + prompt name. */
    ref?: string;
}

export interface Skill {
    id: string;
    name: string;
    description: string;
    /** Markdown body (instructions). */
    content: string;
    source: SkillSource;
    enabled: boolean;
    /** Embed full content into every system prompt instead of on-demand loading. */
    alwaysInject: boolean;
    createdAt: string;
    updatedAt: string;
}

export interface SkillMeta {
    id: string;
    name: string;
    description: string;
    alwaysInject: boolean;
    /** Present only for alwaysInject skills (kept out of listings otherwise). */
    content?: string;
}

export function toSkillMeta(skill: Skill): SkillMeta {
    return {
        id: skill.id,
        name: skill.name,
        description: skill.description,
        alwaysInject: skill.alwaysInject,
        content: skill.alwaysInject ? skill.content : undefined,
    };
}

export interface CreateSkillInput {
    name: string;
    description: string;
    content: string;
    source: SkillSource;
    enabled?: boolean;
    alwaysInject?: boolean;
}
