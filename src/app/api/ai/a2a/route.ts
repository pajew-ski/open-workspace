import { NextRequest, NextResponse } from 'next/server';
import { parseBody, a2aOpSchema } from '@/lib/api/validation';
import { fetchAgentCard, sendA2AMessage } from '@/lib/ai/a2a/client';
import { loadAgents } from '@/lib/agents/storage';
import { getConnectionWithSecrets } from '@/lib/connections/manager';

/**
 * Server relay for A2A operations: card discovery (any URL — discovery
 * fetches public metadata) and message dispatch (configured agents only,
 * with server-side credentials).
 */
export async function POST(request: NextRequest) {
    const parsed = await parseBody(a2aOpSchema, request);
    if (!parsed.ok) return parsed.response;

    try {
        const op = parsed.data;
        if (op.op === 'discover') {
            const card = await fetchAgentCard(op.url);
            return NextResponse.json({ card });
        }

        const agents = await loadAgents();
        const agent = agents.find(a => a.id === op.agentId);
        if (!agent || agent.type !== 'remote_a2a') {
            return NextResponse.json({ error: 'A2A-Agent nicht gefunden' }, { status: 404 });
        }

        let endpointUrl = agent.config.endpointUrl;
        const headers: Record<string, string> = {};
        if (agent.connectionId) {
            const connection = await getConnectionWithSecrets(agent.connectionId);
            if (connection) {
                endpointUrl = endpointUrl || connection.baseUrl;
                if (connection.auth.type === 'bearer' && connection.auth.token) {
                    headers['Authorization'] = `Bearer ${connection.auth.token}`;
                } else if (connection.auth.type === 'apikey' && connection.auth.apiKey && connection.auth.headerName) {
                    headers[connection.auth.headerName] = connection.auth.apiKey;
                }
            }
        }
        if (!endpointUrl) {
            return NextResponse.json({ error: 'Kein A2A-Endpunkt konfiguriert' }, { status: 400 });
        }

        const reply = await sendA2AMessage(endpointUrl, op.prompt, headers);
        return NextResponse.json({ reply });
    } catch (error) {
        return NextResponse.json(
            { error: error instanceof Error ? error.message : 'A2A-Operation fehlgeschlagen' },
            { status: 502 }
        );
    }
}
