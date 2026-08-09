'use client';

import { AppShell } from '@/components/layout';
import { Card, CardHeader, CardContent } from '@/components/ui';
import { ToolsConfig } from './ToolsConfig';
import { GraphMcpServer } from './GraphMcpServer';

export default function ToolsPage() {
    return (
        <AppShell title="Werkzeuge">
            <Card>
                <CardHeader>
                    <h3>Konfiguration</h3>
                </CardHeader>
                <CardContent>
                    <ToolsConfig />
                </CardContent>
            </Card>
            <Card>
                <CardHeader>
                    <h3>MCP-Server (eingehend)</h3>
                </CardHeader>
                <CardContent>
                    <GraphMcpServer />
                </CardContent>
            </Card>
        </AppShell>
    );
}
