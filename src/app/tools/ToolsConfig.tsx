'use client';

import { useState, useEffect } from 'react';
import { Card, CardContent, Button } from '@/components/ui';
import { AddApiToolDialog } from '@/components/tools/AddApiToolDialog';
import styles from './ToolsConfig.module.css';

export function ToolsConfig() {
    const [tools, setTools] = useState<any[]>([]);
    const [isAdding, setIsAdding] = useState(false);

    useEffect(() => {
        fetchTools();
    }, []);

    const fetchTools = async () => {
        try {
            const res = await fetch('/api/tools');
            const data = await res.json();
            setTools(data.tools || []);
        } catch (e) {
            console.error(e);
        }
    };

    const handleAddApi = async (data: any) => {
        const res = await fetch('/api/tools', {
            method: 'POST',
            body: JSON.stringify(data),
            headers: { 'Content-Type': 'application/json' }
        });
        if (res.ok) {
            fetchTools();
        }
    };

    return (
        <div className={styles.container}>
            {isAdding && (
                <AddApiToolDialog
                    onClose={() => setIsAdding(false)}
                    onAdd={handleAddApi}
                />
            )}

            <div className={styles.header}>
                <div className={styles.info}>
                    <span className={styles.label}>MCP Server</span>
                    <span className={styles.description}>
                        Konfiguriere Model Context Protocol (MCP) Server für erweiterte Agenten-Funktionen.
                    </span>
                </div>
                <Button variant="primary" size="sm" disabled>+ Server verbinden</Button>
            </div>

            <Card className={styles.serverList}>
                <CardContent>
                    <div className={styles.emptyState}>
                        <p>Keine MCP Server konfiguriert.</p>
                        <p className={styles.emptySub}>Verbinde einen Server, um Tools bereitzustellen.</p>
                    </div>
                </CardContent>
            </Card>

            <div className={styles.header} style={{ marginTop: 'var(--space-6)' }}>
                <div className={styles.info}>
                    <span className={styles.label}>API Integrationen</span>
                    <span className={styles.description}>
                        Verbinde externe APIs (z.B. OpenAI, Anthropic, Search), um sie als Tools zu nutzen.
                    </span>
                </div>
                <Button variant="primary" size="sm" onClick={() => setIsAdding(true)}>+ API verbinden</Button>
            </div>

            <Card className={styles.serverList}>
                <CardContent>
                    {tools.filter(t => t.type === 'api').length === 0 ? (
                        <div className={styles.emptyState}>
                            <p>Keine APIs konfiguriert.</p>
                            <p className={styles.emptySub}>Füge API-Keys hinzu, um externe Dienste anzubinden.</p>
                        </div>
                    ) : (
                        <div className={styles.toolList}>
                            {tools.filter(t => t.type === 'api').map(tool => (
                                <div key={tool.id} className={styles.toolItem}>
                                    <div>
                                        <strong>{tool.name}</strong>
                                        <div style={{ fontSize: '0.8em', color: '#666' }}>{tool.config.url}</div>
                                    </div>
                                    <div className={styles.toolBadge}>{tool.config.method}</div>
                                </div>
                            ))}
                        </div>
                    )}
                </CardContent>
            </Card>
        </div>
    );
}
