import path from 'path';
import { randomUUID } from 'crypto';
import { readJsonSafe, withFileLock, writeJsonAtomic } from '@/lib/storage/atomic';
import type { CreateSkillInput, Skill } from './types';

const SKILLS_FILE = path.join(process.cwd(), 'data', 'ai', 'skills.json');

export async function loadSkills(): Promise<Skill[]> {
    return readJsonSafe<Skill[]>(SKILLS_FILE, []);
}

export async function saveSkills(skills: Skill[]): Promise<void> {
    await writeJsonAtomic(SKILLS_FILE, skills);
}

export async function createSkill(input: CreateSkillInput): Promise<Skill> {
    return withFileLock(SKILLS_FILE, async () => {
        const skills = await loadSkills();
        const now = new Date().toISOString();
        const skill: Skill = {
            id: randomUUID(),
            name: input.name,
            description: input.description,
            content: input.content,
            source: input.source,
            enabled: input.enabled ?? true,
            alwaysInject: input.alwaysInject ?? false,
            createdAt: now,
            updatedAt: now,
        };
        skills.push(skill);
        await saveSkills(skills);
        return skill;
    });
}

export async function updateSkill(id: string, updates: Partial<CreateSkillInput>): Promise<Skill | null> {
    return withFileLock(SKILLS_FILE, async () => {
        const skills = await loadSkills();
        const index = skills.findIndex(s => s.id === id);
        if (index === -1) return null;
        skills[index] = {
            ...skills[index],
            ...(updates.name !== undefined ? { name: updates.name } : {}),
            ...(updates.description !== undefined ? { description: updates.description } : {}),
            ...(updates.content !== undefined ? { content: updates.content } : {}),
            ...(updates.source !== undefined ? { source: updates.source } : {}),
            ...(updates.enabled !== undefined ? { enabled: updates.enabled } : {}),
            ...(updates.alwaysInject !== undefined ? { alwaysInject: updates.alwaysInject } : {}),
            updatedAt: new Date().toISOString(),
        };
        await saveSkills(skills);
        return skills[index];
    });
}

export async function deleteSkill(id: string): Promise<void> {
    return withFileLock(SKILLS_FILE, async () => {
        const skills = await loadSkills();
        await saveSkills(skills.filter(s => s.id !== id));
    });
}
