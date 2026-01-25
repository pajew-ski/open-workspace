'use client';

import { useState, useEffect } from 'react';
import { AppShell } from '@/components/layout';
import { Card, CardHeader, CardContent, Button, FloatingActionButton } from '@/components/ui';
import { AddAgentDialog } from '@/components/agents/AddAgentDialog';
import styles from './page.module.css';

export default function AgentsPage() {
    const [agents, setAgents] = useState<any[]>([]);
    const [isCreating, setIsCreating] = useState(false);

    useEffect(() => {
        fetchAgents();
    }, []);

    const fetchAgents = async () => {
        try {
            const res = await fetch('/api/agents');
            const data = await res.json();
            setAgents(data.agents || []);
        } catch (e) { console.error(e); }
    };

    const handleCreate = async (data: any) => {
        await fetch('/api/agents', {
            method: 'POST',
            body: JSON.stringify(data),
            headers: { 'Content-Type': 'application/json' }
        });
        setIsCreating(false);
        fetchAgents();
    };

    return (
        <AppShell
            title="Agenten"
            actions={
                <FloatingActionButton
                    icon={<span style={{ fontSize: '24px' }}>+</span>}
                    onClick={() => setIsCreating(true)}
                    label="Neuer Agent"
                />
            }
        >
            <div className={styles.container}>
                {isCreating && (
                    <AddAgentDialog
                        onClose={() => setIsCreating(false)}
                        onAdd={handleCreate}
                    />
                )}

                <div className={styles.header}>
                    <div>
                        <h2>AI Agenten</h2>
                        <p>Verwalte deine Agent2Agent (A2A) Agenten und deren Fähigkeiten.</p>
                    </div>
                </div>

                <div className={styles.grid}>
                    <Card elevated>
                        <CardHeader>
                            <h3>Aktive Agenten</h3>
                        </CardHeader>
                        <CardContent>
                            {agents.length === 0 ? (
                                <div className={styles.empty}>
                                    <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                                        <circle cx="12" cy="8" r="5" />
                                        <path d="M3 21v-2a7 7 0 0 1 7-7h4a7 7 0 0 1 7 7v2" />
                                    </svg>
                                    <h4>Keine Agenten konfiguriert</h4>
                                    <p>Erstelle deinen ersten A2A-Agenten, um mit der Automatisierung zu beginnen.</p>
                                    <Button variant="primary" onClick={() => setIsCreating(true)}>Ersten Agenten erstellen</Button>
                                </div>
                            ) : (
                                <div className={styles.agentList}>
                                    {agents.map(agent => (
                                        <div key={agent.id} className={styles.agentItem}>
                                            <div className={styles.agentInfo}>
                                                <strong>{agent.name}</strong>
                                                <span className={styles.meta}>{agent.type} {agent.connectionId ? '• Verbunden' : ''}</span>
                                                <p className={styles.description}>{agent.description}</p>
                                            </div>
                                            <div className={styles.status}>
                                                <span className={styles.badge}>Aktiv</span>
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            )}
                        </CardContent>
                    </Card>

                    <Card>
                        <CardHeader>
                            <h3>Agent-Konfiguration</h3>
                        </CardHeader>
                        <CardContent>
                            <div className={styles.configItem}>
                                <span className={styles.configLabel}>A2A-Protokoll</span>
                                <span className={styles.configValue}>Aktiviert</span>
                            </div>
                            <div className={styles.configItem}>
                                <span className={styles.configLabel}>System-Status</span>
                                <span className={styles.configValue}>Bereit</span>
                            </div>
                        </CardContent>
                    </Card>
                </div>
            </div>
        </AppShell>
    );
}
