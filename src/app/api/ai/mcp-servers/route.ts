import { NextRequest, NextResponse } from 'next/server';
import { parseBody, createMcpServerSchema } from '@/lib/api/validation';
import { createMcpServer } from '@/lib/ai/store.server';

export async function POST(request: NextRequest) {
    const parsed = await parseBody(createMcpServerSchema, request);
    if (!parsed.ok) return parsed.response;

    try {
        const server = await createMcpServer(parsed.data);
        return NextResponse.json({ server }, { status: 201 });
    } catch (error) {
        return NextResponse.json(
            { error: 'MCP-Server konnte nicht angelegt werden', details: error instanceof Error ? error.message : 'unknown' },
            { status: 500 }
        );
    }
}
