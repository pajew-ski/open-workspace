import { promises as fs } from 'fs';
import path from 'path';

/**
 * Workspace settings persisted server-side (data/settings.json).
 *
 * Resolution order for inference config: stored settings override
 * environment defaults; environment overrides built-in defaults.
 */

export interface WorkspaceSettings {
    inference: {
        endpoint: string;
        model: string;
    };
}

const DATA_DIR = path.join(process.cwd(), 'data');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');

const ENV_DEFAULTS: WorkspaceSettings = {
    inference: {
        endpoint:
            process.env.LLM_API_BASE_URL ||
            process.env.NEXT_PUBLIC_LLM_API_BASE_URL ||
            'http://localhost:11434',
        model:
            process.env.LLM_MODEL ||
            process.env.NEXT_PUBLIC_LLM_MODEL ||
            'gpt-oss:20b',
    },
};

export async function loadSettings(): Promise<WorkspaceSettings> {
    try {
        const raw = await fs.readFile(SETTINGS_FILE, 'utf-8');
        const stored = JSON.parse(raw) as Partial<WorkspaceSettings>;
        return {
            inference: {
                endpoint: stored.inference?.endpoint || ENV_DEFAULTS.inference.endpoint,
                model: stored.inference?.model || ENV_DEFAULTS.inference.model,
            },
        };
    } catch {
        // Missing or unreadable file → environment defaults
        return ENV_DEFAULTS;
    }
}

export interface WorkspaceSettingsUpdate {
    inference?: Partial<WorkspaceSettings['inference']>;
}

export async function saveSettings(update: WorkspaceSettingsUpdate): Promise<WorkspaceSettings> {
    const current = await loadSettings();
    const next: WorkspaceSettings = {
        inference: {
            endpoint: update.inference?.endpoint ?? current.inference.endpoint,
            model: update.inference?.model ?? current.inference.model,
        },
    };
    await fs.mkdir(DATA_DIR, { recursive: true });
    const tmp = `${SETTINGS_FILE}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(next, null, 2), 'utf-8');
    await fs.rename(tmp, SETTINGS_FILE);
    return next;
}
