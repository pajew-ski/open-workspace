'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Search } from 'lucide-react';
import { Button, Input, Card, CardContent } from '@/components/ui';
import { fetchAgentCard, type A2AAgentCard } from '@/lib/ai/a2a/client';
import { checkBackend } from '@/lib/platform/backend';
import { useAIState } from '@/lib/ai/useAI';
import styles from './AddAgentDialog.module.css';

interface AddAgentDialogProps {
    onClose: () => void;
    onAdd: (data: unknown) => Promise<void>;
}

/**
 * Agent creation with real A2A discovery: paste an agent URL, fetch its
 * card (/.well-known/agent-card.json — browser-direct with server relay
 * fallback), review name/description/skills, save. Local agents get a
 * persona prompt plus optional provider/model override.
 */
export function AddAgentDialog({ onClose, onAdd }: AddAgentDialogProps) {
    const [name, setName] = useState('');
    const [description, setDescription] = useState('');
    const [type, setType] = useState('local');
    const [connectionId, setConnectionId] = useState('');
    const [systemPrompt, setSystemPrompt] = useState('');

    // A2A discovery state
    const [agentUrl, setAgentUrl] = useState('');
    const [discovering, setDiscovering] = useState(false);
    const [discoverError, setDiscoverError] = useState('');
    const [card, setCard] = useState<A2AAgentCard | null>(null);

    // Local agent provider override
    const [providerId, setProviderId] = useState('');
    const [model, setModel] = useState('');
    const { data: aiState } = useAIState();

    const { data: connections = [] } = useQuery<Array<{ id: string; name: string; baseUrl?: string }>>({
        queryKey: ['connections'],
        queryFn: async () => {
            const res = await fetch('/api/connections');
            const data = await res.json();
            return data.connections || [];
        },
    });

    const handleDiscover = async () => {
        if (!agentUrl.trim()) return;
        setDiscovering(true);
        setDiscoverError('');
        setCard(null);
        try {
            let found: A2AAgentCard | null = null;
            try {
                found = await fetchAgentCard(agentUrl.trim());
            } catch (directError) {
                // CORS or network — try the server relay if a backend exists.
                if ((await checkBackend()) === 'available') {
                    const response = await fetch('/api/ai/a2a', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ op: 'discover', url: agentUrl.trim() }),
                    });
                    const data = await response.json().catch(() => ({}));
                    if (!response.ok) throw new Error(data.error || (directError instanceof Error ? directError.message : 'Discovery fehlgeschlagen'));
                    found = data.card;
                } else {
                    throw directError;
                }
            }
            if (found) {
                setCard(found);
                if (!name) setName(found.name);
                if (!description) setDescription(found.description);
            }
        } catch (error) {
            setDiscoverError(error instanceof Error ? error.message : 'Discovery fehlgeschlagen');
        } finally {
            setDiscovering(false);
        }
    };

    const handleSubmit = async () => {
        if (!name) return;
        await onAdd({
            name,
            description,
            type,
            connectionId: type === 'remote_a2a' && connectionId ? connectionId : undefined,
            config: type === 'remote_a2a'
                ? {
                    endpointUrl: card?.url || agentUrl.trim() || undefined,
                    cardUrl: card?.cardUrl,
                    capabilities: card?.skills?.map(s => s.name || s.id || '').filter(Boolean),
                }
                : {
                    systemPrompt,
                    providerId: providerId || undefined,
                    model: model || undefined,
                },
        });
        onClose();
    };

    const providers = aiState?.providers.filter(p => p.enabled) ?? [];

    return (
        <div className={styles.overlay}>
            <Card className={styles.dialog}>
                <CardContent>
                    <h3>Neuer Agent</h3>
                    <div className={styles.formGrid}>
                        <div className={styles.field}>
                            <label>Typ</label>
                            <select className={styles.select} value={type} onChange={(e) => setType(e.target.value)}>
                                <option value="local">Lokal (Persona auf eigenem Modell)</option>
                                <option value="remote_a2a">Remote (A2A-Protokoll)</option>
                            </select>
                        </div>

                        {type === 'remote_a2a' && (
                            <>
                                <div className={styles.field}>
                                    <label>Agent-URL</label>
                                    <div className={styles.discoverRow}>
                                        <Input
                                            value={agentUrl}
                                            onChange={(e) => setAgentUrl(e.target.value)}
                                            placeholder="https://agent.example (Agent Card wird automatisch gesucht)"
                                        />
                                        <Button variant="secondary" onClick={handleDiscover} disabled={discovering || !agentUrl.trim()}>
                                            <Search size={14} aria-hidden="true" />
                                            {discovering ? 'Suche…' : 'Card abrufen'}
                                        </Button>
                                    </div>
                                    {discoverError && <p className={styles.error} role="alert">{discoverError}</p>}
                                </div>

                                {card && (
                                    <div className={styles.cardPreview}>
                                        <strong>{card.name}</strong>
                                        {card.version && <span className={styles.cardVersion}>v{card.version}</span>}
                                        <p>{card.description || 'Keine Beschreibung.'}</p>
                                        <code className={styles.cardEndpoint}>{card.url}</code>
                                        {card.skills && card.skills.length > 0 && (
                                            <div className={styles.cardSkills}>
                                                {card.skills.slice(0, 8).map((skill, i) => (
                                                    <span key={i} className={styles.skillChip}>{skill.name || skill.id}</span>
                                                ))}
                                            </div>
                                        )}
                                    </div>
                                )}
                            </>
                        )}

                        <div className={styles.field}>
                            <label>Name</label>
                            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="z.B. Research Agent" />
                        </div>
                        <div className={styles.field}>
                            <label>Beschreibung</label>
                            <Input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Verantwortlich für..." />
                        </div>

                        {type === 'remote_a2a' && (
                            <div className={styles.field}>
                                <label>Verbindung (Auth, optional)</label>
                                <select className={styles.select} value={connectionId} onChange={(e) => setConnectionId(e.target.value)}>
                                    <option value="">Keine (öffentlicher Agent)</option>
                                    {connections.map(c => (
                                        <option key={c.id} value={c.id}>{c.name} ({c.baseUrl})</option>
                                    ))}
                                </select>
                            </div>
                        )}

                        {type === 'local' && (
                            <>
                                <div className={styles.field}>
                                    <label>System Prompt</label>
                                    <textarea
                                        className={styles.textarea}
                                        value={systemPrompt}
                                        onChange={(e) => setSystemPrompt(e.target.value)}
                                        placeholder="Du bist ein..."
                                        rows={4}
                                    />
                                </div>
                                <div className={styles.field}>
                                    <label>Inference-Provider (optional — Standard, wenn leer)</label>
                                    <select className={styles.select} value={providerId} onChange={(e) => setProviderId(e.target.value)}>
                                        <option value="">Workspace-Standard</option>
                                        {providers.map(p => (
                                            <option key={p.id} value={p.id}>{p.label}</option>
                                        ))}
                                    </select>
                                </div>
                                <div className={styles.field}>
                                    <label>Modell-Override (optional)</label>
                                    <Input value={model} onChange={(e) => setModel(e.target.value)} placeholder="z.B. qwen3:8b" />
                                </div>
                            </>
                        )}

                        <div className={styles.actions}>
                            <Button variant="ghost" onClick={onClose}>Abbrechen</Button>
                            <Button variant="primary" onClick={handleSubmit} disabled={!name}>Erstellen</Button>
                        </div>
                    </div>
                </CardContent>
            </Card>
        </div>
    );
}
