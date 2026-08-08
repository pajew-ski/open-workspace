'use client';

import { checkBackend } from '@/lib/platform/backend';
import type { CreateSkillInput, Skill } from './types';

/**
 * Client gateway for skills: server store when the backend is reachable,
 * localStorage otherwise (serverless mode). Skills loaded while
 * serverless live only in this browser and are labeled accordingly.
 */

const LOCAL_KEY = 'ow.skills.local';
const MIRROR_KEY = 'ow.skills.mirror';

export type ClientSkill = Skill & { origin: 'server' | 'local' };

function readLocal(key: string): Skill[] {
    if (typeof window === 'undefined') return [];
    try {
        const raw = window.localStorage.getItem(key);
        const parsed = raw ? JSON.parse(raw) : [];
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
}

function writeLocal(key: string, skills: Skill[]): void {
    if (typeof window === 'undefined') return;
    try {
        window.localStorage.setItem(key, JSON.stringify(skills));
    } catch {
        // best effort
    }
}

function newLocalSkillId(): string {
    return `skill-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export async function listClientSkills(): Promise<ClientSkill[]> {
    const local = readLocal(LOCAL_KEY).map(s => ({ ...s, origin: 'local' as const }));
    if ((await checkBackend()) === 'available') {
        try {
            const response = await fetch('/api/skills', { cache: 'no-store' });
            if (response.ok) {
                const data = await response.json();
                const server: Skill[] = data.skills ?? [];
                writeLocal(MIRROR_KEY, server);
                return [...server.map(s => ({ ...s, origin: 'server' as const })), ...local];
            }
        } catch { /* fall back */ }
    }
    const mirror = readLocal(MIRROR_KEY).map(s => ({ ...s, origin: 'server' as const }));
    return [...mirror, ...local];
}

export async function createClientSkill(input: CreateSkillInput): Promise<ClientSkill> {
    if ((await checkBackend()) === 'available') {
        const response = await fetch('/api/skills', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(input),
        });
        if (!response.ok) {
            const err = await response.json().catch(() => ({}));
            throw new Error(err.error || `Skill anlegen fehlgeschlagen (${response.status})`);
        }
        const data = await response.json();
        return { ...data.skill, origin: 'server' };
    }
    const now = new Date().toISOString();
    const skill: Skill = {
        id: newLocalSkillId(),
        name: input.name,
        description: input.description,
        content: input.content,
        source: input.source,
        enabled: input.enabled ?? true,
        alwaysInject: input.alwaysInject ?? false,
        createdAt: now,
        updatedAt: now,
    };
    const local = readLocal(LOCAL_KEY);
    local.push(skill);
    writeLocal(LOCAL_KEY, local);
    return { ...skill, origin: 'local' };
}

export async function updateClientSkill(
    skill: Pick<ClientSkill, 'id' | 'origin'>,
    updates: Partial<CreateSkillInput>
): Promise<void> {
    if (skill.origin === 'server') {
        if ((await checkBackend()) !== 'available') {
            throw new Error('Dieser Skill ist auf dem Server gespeichert — das Backend ist gerade nicht erreichbar.');
        }
        const response = await fetch(`/api/skills/${encodeURIComponent(skill.id)}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(updates),
        });
        if (!response.ok) throw new Error(`Skill aktualisieren fehlgeschlagen (${response.status})`);
        return;
    }
    const local = readLocal(LOCAL_KEY);
    const index = local.findIndex(s => s.id === skill.id);
    if (index === -1) throw new Error('Skill nicht gefunden');
    local[index] = { ...local[index], ...updates, updatedAt: new Date().toISOString() } as Skill;
    writeLocal(LOCAL_KEY, local);
}

export async function deleteClientSkill(skill: Pick<ClientSkill, 'id' | 'origin'>): Promise<void> {
    if (skill.origin === 'server') {
        if ((await checkBackend()) !== 'available') {
            throw new Error('Dieser Skill ist auf dem Server gespeichert — das Backend ist gerade nicht erreichbar.');
        }
        const response = await fetch(`/api/skills/${encodeURIComponent(skill.id)}`, { method: 'DELETE' });
        if (!response.ok) throw new Error(`Skill löschen fehlgeschlagen (${response.status})`);
        return;
    }
    writeLocal(LOCAL_KEY, readLocal(LOCAL_KEY).filter(s => s.id !== skill.id));
}
