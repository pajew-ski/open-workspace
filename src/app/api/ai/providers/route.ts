import { NextRequest, NextResponse } from 'next/server';
import { parseBody, createProviderSchema } from '@/lib/api/validation';
import { createProvider } from '@/lib/ai/store.server';
import { refreshAiMirrorAfterMutation } from '@/lib/graph/server/instance';

export async function POST(request: NextRequest) {
    const parsed = await parseBody(createProviderSchema, request);
    if (!parsed.ok) return parsed.response;

    try {
        const provider = await createProvider(parsed.data);
        await refreshAiMirrorAfterMutation('Inference-Provider angelegt');
        return NextResponse.json({ provider }, { status: 201 });
    } catch (error) {
        return NextResponse.json(
            { error: 'Provider konnte nicht angelegt werden', details: error instanceof Error ? error.message : 'unknown' },
            { status: 500 }
        );
    }
}
