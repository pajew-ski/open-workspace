import { describe, it, expect } from 'vitest';
import { parseSkillMarkdown, serializeSkillMarkdown } from './parse';

describe('parseSkillMarkdown', () => {
    it('parses YAML frontmatter with name and description', () => {
        const raw = `---\nname: Release Notes\ndescription: "Nutze diesen Skill: für Release Notes"\nlicense: MIT\n---\n\n# Anleitung\nSchritt 1.`;
        const parsed = parseSkillMarkdown(raw);
        expect(parsed.name).toBe('Release Notes');
        expect(parsed.description).toBe('Nutze diesen Skill: für Release Notes');
        expect(parsed.content).toBe('# Anleitung\nSchritt 1.');
    });

    it('falls back to the first heading without frontmatter', () => {
        const parsed = parseSkillMarkdown('# Mein Skill\n\nInhalt.');
        expect(parsed.name).toBe('Mein Skill');
        expect(parsed.description).toBe('');
        expect(parsed.content).toBe('# Mein Skill\n\nInhalt.');
    });

    it('uses the fallback name when nothing else is available', () => {
        const parsed = parseSkillMarkdown('Nur Text ohne Überschrift.', 'skill-datei');
        expect(parsed.name).toBe('skill-datei');
    });

    it('survives broken frontmatter', () => {
        const parsed = parseSkillMarkdown('---\n: : :kaputt\n---\n\n# Titel\nText', 'Fallback');
        expect(parsed.name).toBe('Titel');
        expect(parsed.content).toContain('Text');
    });

    it('round-trips through serializeSkillMarkdown', () => {
        const md = serializeSkillMarkdown('Name: mit Doppelpunkt', 'Beschreibung', '# Inhalt');
        const parsed = parseSkillMarkdown(md);
        expect(parsed.name).toBe('Name: mit Doppelpunkt');
        expect(parsed.description).toBe('Beschreibung');
        expect(parsed.content).toBe('# Inhalt');
    });
});
