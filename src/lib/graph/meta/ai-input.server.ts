/**
 * Serverseitiger Input des AI-Spiegels (M9): liest die operativen
 * JSON-Bestände der AI-Schicht. Bewusst getrennt von `ai.ts` (pur) und
 * von `server/instance.ts` (Store-Zustand), damit weder das Mapping noch
 * die Storages einen Import-Zyklus auf die Store-Instanz bekommen.
 */

import { loadSkills } from '@/lib/skills/store.server';
import { loadAgents } from '@/lib/agents/storage';
import { loadTools } from '@/lib/tools/storage';
import { loadAIConfig } from '@/lib/ai/store.server';
import type { AiMirrorInput } from './ai';

export async function loadAiMirrorInput(): Promise<AiMirrorInput> {
    const [skills, agents, apiTools, aiConfig] = await Promise.all([
        loadSkills(),
        loadAgents(),
        loadTools(),
        loadAIConfig(),
    ]);
    return { skills, agents, apiTools, mcpServers: aiConfig.mcpServers };
}
