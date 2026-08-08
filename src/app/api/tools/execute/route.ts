import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { parseBody } from '@/lib/api/validation';
import { loadTools } from '@/lib/tools/storage';
import { executeTool } from '@/lib/tools/executor';

const executeSchema = z.object({
    toolId: z.string().min(1).max(200),
    args: z.record(z.string(), z.unknown()).default({}),
});

/**
 * Execute a configured API tool server-side. Used by the in-browser
 * engine: connection credentials live encrypted on the server, so the
 * browser delegates execution here whenever a backend is reachable
 * (direct browser fetch remains the serverless fallback).
 */
export async function POST(request: NextRequest) {
    const parsed = await parseBody(executeSchema, request);
    if (!parsed.ok) return parsed.response;

    const tools = await loadTools();
    const tool = tools.find(t => t.id === parsed.data.toolId);
    if (!tool || !tool.enabled) {
        return NextResponse.json({ error: 'Tool nicht gefunden oder deaktiviert' }, { status: 404 });
    }

    const result = await executeTool(tool, parsed.data.args as Record<string, unknown>);
    return NextResponse.json(result);
}
