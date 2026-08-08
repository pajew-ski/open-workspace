import { NextResponse } from 'next/server';
import { loadAIConfig, toClientMcpServer, toClientProvider } from '@/lib/ai/store.server';

/**
 * Client-safe view of the AI platform config: providers and MCP servers
 * without any secret material (only has-key flags), plus defaults.
 * Also serves as the backend-availability probe for the client gateway.
 */
export async function GET() {
    try {
        const config = await loadAIConfig();
        return NextResponse.json({
            defaults: config.defaults,
            providers: config.providers.map(toClientProvider),
            mcpServers: config.mcpServers.map(toClientMcpServer),
        });
    } catch (error) {
        return NextResponse.json(
            { error: 'AI-Konfiguration nicht ladbar', details: error instanceof Error ? error.message : 'unknown' },
            { status: 500 }
        );
    }
}
