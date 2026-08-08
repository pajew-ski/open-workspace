'use client';

import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Zap, Trash2 } from 'lucide-react';
import { AppShell } from '@/components/layout';
import { Card, CardHeader, CardContent, Button, FloatingActionButton, ConfirmDialog } from '@/components/ui';
import { useToast } from '@/components/ui/Toast';
import { AddAgentDialog } from '@/components/agents/AddAgentDialog';
import type { Agent } from '@/lib/agents/types';
import styles from './page.module.css';

export default function AgentsPage() {
    const [isCreating, setIsCreating] = useState(false);
    const [deleting, setDeleting] = useState<Agent | null>(null);
    const [testing, setTesting] = useState<string | null>(null);
    const [testResults, setTestResults] = useState<Record<string, string>>({});
    const queryClient = useQueryClient();
    const toast = useToast();

    const { data: agents = [] } = useQuery<Agent[]>({
        queryKey: ['agents'],
        queryFn: async () => {
            const res = await fetch('/api/agents');
            const data = await res.json();
            return data.agents || [];
        },
    });

    const handleCreate = async (data: unknown) => {
        await fetch('/api/agents', {
            method: 'POST',
            body: JSON.stringify(data),
            headers: { 'Content-Type': 'application/json' }
        });
        setIsCreating(false);
        queryClient.invalidateQueries({ queryKey: ['agents'] });
    };

    const toggleEnabled = async (agent: Agent) => {
        await fetch('/api/agents', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: agent.id, enabled: !agent.enabled }),
        });
        queryClient.invalidateQueries({ queryKey: ['agents'] });
    };

    const handleDelete = async () => {
        if (!deleting) return;
        await fetch(`/api/agents?id=${encodeURIComponent(deleting.id)}`, { method: 'DELETE' });
        setDeleting(null);
        queryClient.invalidateQueries({ queryKey: ['agents'] });
    };

    /** Live check: send a ping through the real delegation path. */
    const testAgent = async (agent: Agent) => {
        setTesting(agent.id);
        setTestResults(prev => ({ ...prev, [agent.id]: '' }));
        try {
            const response = await fetch('/api/ai/a2a', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ op: 'send', agentId: agent.id, prompt: 'Antworte mit einem kurzen Satz: Wer bist du?' }),
            });
            const data = await response.json().catch(() => ({}));
            if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
            setTestResults(prev => ({ ...prev, [agent.id]: `✓ ${String(data.reply).slice(0, 200)}` }));
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Test fehlgeschlagen';
            setTestResults(prev => ({ ...prev, [agent.id]: `✗ ${message}` }));
            toast.error(message);
        } finally {
            setTesting(null);
        }
    };

    const remoteCount = agents.filter(a => a.type === 'remote_a2a').length;
    const localCount = agents.length - remoteCount;

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
                        <p>
                            Verbundene Agenten sind im Chat delegierbar — der Assistent reicht Teilaufgaben mit{' '}
                            <code>[[AGENT:id:Auftrag]]</code> weiter. Remote-Agenten werden per A2A-Protokoll
                            (Agent Card + JSON-RPC) angesprochen, lokale Agenten laufen als Persona auf einem konfigurierten Provider.
                        </p>
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
                                    <p>Verbinde einen A2A-Agenten über seine URL oder definiere eine lokale Persona.</p>
                                    <Button variant="primary" onClick={() => setIsCreating(true)}>Ersten Agenten erstellen</Button>
                                </div>
                            ) : (
                                <div className={styles.agentList}>
                                    {agents.map(agent => (
                                        <div key={agent.id} className={styles.agentItem}>
                                            <div className={styles.agentInfo}>
                                                <strong>{agent.name}</strong>
                                                <span className={styles.meta}>
                                                    {agent.type === 'remote_a2a' ? 'Remote (A2A)' : 'Lokal'}
                                                    {agent.type === 'remote_a2a' && agent.config.endpointUrl ? ` • ${agent.config.endpointUrl}` : ''}
                                                    {agent.type === 'local' && agent.config.model ? ` • ${agent.config.model}` : ''}
                                                </span>
                                                <p className={styles.description}>{agent.description}</p>
                                                {agent.config.capabilities && agent.config.capabilities.length > 0 && (
                                                    <div className={styles.capabilities}>
                                                        {agent.config.capabilities.slice(0, 6).map((cap, i) => (
                                                            <span key={i} className={styles.capChip}>{cap}</span>
                                                        ))}
                                                    </div>
                                                )}
                                                {testResults[agent.id] && (
                                                    <p className={styles.testResult}>{testResults[agent.id]}</p>
                                                )}
                                            </div>
                                            <div className={styles.status}>
                                                <label className={styles.enabledToggle}>
                                                    <input
                                                        type="checkbox"
                                                        checked={agent.enabled}
                                                        onChange={() => toggleEnabled(agent)}
                                                        aria-label={`${agent.name} ${agent.enabled ? 'deaktivieren' : 'aktivieren'}`}
                                                    />
                                                    <span>{agent.enabled ? 'Aktiv' : 'Aus'}</span>
                                                </label>
                                                <button
                                                    type="button"
                                                    className={styles.iconAction}
                                                    onClick={() => testAgent(agent)}
                                                    disabled={testing === agent.id}
                                                    title="Testnachricht senden"
                                                    aria-label={`${agent.name} testen`}
                                                >
                                                    <Zap size={15} aria-hidden="true" />
                                                </button>
                                                <button
                                                    type="button"
                                                    className={`${styles.iconAction} ${styles.dangerAction}`}
                                                    onClick={() => setDeleting(agent)}
                                                    title="Löschen"
                                                    aria-label={`${agent.name} löschen`}
                                                >
                                                    <Trash2 size={15} aria-hidden="true" />
                                                </button>
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
                                <span className={styles.configLabel}>Lokale Agenten</span>
                                <span className={styles.configValue}>{localCount} konfiguriert</span>
                            </div>
                            <div className={styles.configItem}>
                                <span className={styles.configLabel}>Remote-Agenten (A2A)</span>
                                <span className={styles.configValue}>{remoteCount} konfiguriert</span>
                            </div>
                            <div className={styles.configItem}>
                                <span className={styles.configLabel}>A2A-Protokoll</span>
                                <span className={styles.configValue}>
                                    Agent-Card-Discovery + message/send (JSON-RPC) aktiv; Task-Polling via tasks/get
                                </span>
                            </div>
                            <div className={styles.configItem}>
                                <span className={styles.configLabel}>Delegation im Chat</span>
                                <span className={styles.configValue}>
                                    Aktivierte Agenten erscheinen automatisch im System-Prompt des Assistenten
                                </span>
                            </div>
                        </CardContent>
                    </Card>
                </div>
            </div>

            <ConfirmDialog
                isOpen={deleting !== null}
                title="Agent löschen?"
                message={`Möchtest du „${deleting?.name}" wirklich löschen?`}
                confirmText="Löschen"
                cancelText="Abbrechen"
                variant="danger"
                onConfirm={handleDelete}
                onCancel={() => setDeleting(null)}
            />
        </AppShell>
    );
}
