import { NextRequest, NextResponse } from 'next/server';
import { resolveServerProvider } from '@/lib/ai/store.server';
import { probeProvider } from '@/lib/ai/client';

/**
 * Server-side provider probe. The client calls this when the direct
 * browser route fails (or is not allowed) — together they answer the
 * routing question "who can reach this endpoint?".
 */
export async function GET(_request: NextRequest, context: { params: Promise<{ id: string }> }) {
    const { id } = await context.params;
    const resolved = await resolveServerProvider(id);
    if (!resolved) {
        return NextResponse.json({ error: 'Provider nicht gefunden' }, { status: 404 });
    }
    if (resolved.protocol === 'webllm') {
        return NextResponse.json({
            status: 'error',
            detail: 'WebLLM läuft ausschließlich im Browser — es gibt keine Server-Route.',
        });
    }
    const result = await probeProvider(resolved);
    return NextResponse.json(result);
}
