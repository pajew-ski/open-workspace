import { NextRequest, NextResponse } from 'next/server';
import { parseBody, aiDefaultsSchema } from '@/lib/api/validation';
import { setDefaults } from '@/lib/ai/store.server';

export async function PUT(request: NextRequest) {
    const parsed = await parseBody(aiDefaultsSchema, request);
    if (!parsed.ok) return parsed.response;

    try {
        await setDefaults(parsed.data.providerId, parsed.data.model);
        return NextResponse.json({ success: true });
    } catch (error) {
        return NextResponse.json(
            { error: 'Standard konnte nicht gespeichert werden', details: error instanceof Error ? error.message : 'unknown' },
            { status: 500 }
        );
    }
}
