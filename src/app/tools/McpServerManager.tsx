'use client';

import { useCallback, useState } from 'react';
import { Plug, RefreshCw, Trash2, ChevronDown, Import, Server, MonitorSmartphone } from 'lucide-react';
import { Button, ConfirmDialog } from '@/components/ui';
import { useToast } from '@/components/ui/Toast';
import { useAIState, useBackendAvailability, useInvalidateAIState } from '@/lib/ai/useAI';
import {
    createMcpRecord,
    deleteMcpRecord,
    updateMcpRecord,
    type ClientMcpRecord,
} from '@/lib/ai/store.client';
import { setBrowserMcpAuth } from '@/lib/ai/keys.client';
import {
    browserMcpPrompts,
    browserMcpPromptText,
    browserMcpTools,
    invalidateBrowserMcpCache,
    probeMcpRecord,
} from '@/lib/ai/browser/deps';
import { createClientSkill } from '@/lib/skills/store.client';
import { parseSkillMarkdown } from '@/lib/skills/parse';
import type { McpPromptDescriptor } from '@/lib/ai/mcp/client';
import styles from './McpServerManager.module.css';

/**
 * MCP server management: register Streamable-HTTP/SSE servers, probe
 * them (browser-direct with server relay fallback), inspect discovered
 * tools, and import prompts as workspace skills.
 */

interface ProbeState {
    loading: boolean;
    ok?: boolean;
    detail?: string;
    via?: 'browser' | 'server';
    tools?: Array<{ name: string; description: string }>;
    prompts?: McpPromptDescriptor[];
}

export function McpServerManager() {
    const toast = useToast();
    const backend = useBackendAvailability();
    const { data: state } = useAIState();
    const invalidate = useInvalidateAIState();

    const [adding, setAdding] = useState(false);
    const [deleting, setDeleting] = useState<ClientMcpRecord | null>(null);
    const [expanded, setExpanded] = useState<string | null>(null);
    const [probes, setProbes] = useState<Record<string, ProbeState>>({});

    // Form state
    const [label, setLabel] = useState('');
    const [url, setUrl] = useState('');
    const [transport, setTransport] = useState<'auto' | 'streamable-http' | 'sse'>('auto');
    const [connectionMode, setConnectionMode] = useState<'auto' | 'browser' | 'server'>('auto');
    const [authName, setAuthName] = useState('');
    const [authValue, setAuthValue] = useState('');
    const [authLocation, setAuthLocation] = useState<'server' | 'browser'>('server');
    const [saving, setSaving] = useState(false);

    const servers = state?.mcpServers ?? [];

    const resetForm = () => {
        setLabel(''); setUrl(''); setTransport('auto'); setConnectionMode('auto');
        setAuthName(''); setAuthValue(''); setAuthLocation('server');
    };

    const handleAdd = async () => {
        if (!label.trim() || !url.trim()) return;
        setSaving(true);
        try {
            const record = await createMcpRecord({
                label: label.trim(),
                url: url.trim(),
                transport,
                connectionMode,
                authHeaderName: authName.trim() || undefined,
                authHeaderValue: authLocation === 'server' ? (authValue || undefined) : undefined,
                enabled: true,
            });
            if (authName.trim() && authValue && (authLocation === 'browser' || backend !== 'available')) {
                setBrowserMcpAuth(record.id, authValue);
            }
            toast.success(`MCP-Server „${record.label}" hinzugefügt`);
            setAdding(false);
            resetForm();
            invalidate();
        } catch (error) {
            toast.error(error instanceof Error ? error.message : 'Hinzufügen fehlgeschlagen');
        } finally {
            setSaving(false);
        }
    };

    const probe = useCallback(async (record: ClientMcpRecord) => {
        setProbes(prev => ({ ...prev, [record.id]: { ...prev[record.id], loading: true } }));
        invalidateBrowserMcpCache(record.id);
        try {
            const result = await probeMcpRecord(record);
            let tools: Array<{ name: string; description: string }> = [];
            let prompts: McpPromptDescriptor[] = [];
            if (result.ok) {
                try {
                    tools = (await browserMcpTools(record)).map(t => ({ name: t.name, description: t.description }));
                } catch { /* tools optional */ }
                try {
                    prompts = await browserMcpPrompts(record);
                } catch { /* prompts optional */ }
            }
            setProbes(prev => ({
                ...prev,
                [record.id]: { loading: false, ok: result.ok, detail: result.detail, via: result.via, tools, prompts },
            }));
        } catch (error) {
            setProbes(prev => ({
                ...prev,
                [record.id]: { loading: false, ok: false, detail: error instanceof Error ? error.message : 'Fehler' },
            }));
        }
    }, []);

    const importPrompt = async (record: ClientMcpRecord, prompt: McpPromptDescriptor) => {
        try {
            const text = await browserMcpPromptText(record, prompt.name);
            const parsed = parseSkillMarkdown(text, prompt.title || prompt.name);
            await createClientSkill({
                name: parsed.name,
                description: prompt.description || parsed.description,
                content: parsed.content || text,
                source: { type: 'mcp-prompt', ref: `${record.label}:${prompt.name}` },
            });
            toast.success(`Skill „${parsed.name}" aus MCP-Prompt importiert`);
        } catch (error) {
            toast.error(error instanceof Error ? error.message : 'Import fehlgeschlagen');
        }
    };

    const toggleEnabled = async (record: ClientMcpRecord) => {
        try {
            await updateMcpRecord(record, { enabled: !record.enabled });
            invalidateBrowserMcpCache(record.id);
            invalidate();
        } catch (error) {
            toast.error(error instanceof Error ? error.message : 'Aktualisierung fehlgeschlagen');
        }
    };

    return (
        <div className={styles.section}>
            <div className={styles.sectionHeader}>
                <div className={styles.info}>
                    <span className={styles.label}>MCP-Server</span>
                    <span className={styles.description}>
                        Model-Context-Protocol-Server liefern Tools, Prompts (als Skills importierbar) und eingebettete UI.
                        Verbindung direkt aus dem Browser — funktioniert auch ohne Backend — oder über die Server-Route.
                    </span>
                </div>
                <Button variant="primary" size="sm" onClick={() => setAdding(true)}>+ MCP-Server</Button>
            </div>

            {servers.length === 0 ? (
                <div className={styles.emptyState}>
                    <Plug size={28} aria-hidden="true" />
                    <p>Noch kein MCP-Server verbunden.</p>
                    <p className={styles.emptySub}>Unterstützt werden Streamable-HTTP- und SSE-Endpunkte (z. B. `https://server.example/mcp`).</p>
                </div>
            ) : (
                <ul className={styles.serverList}>
                    {servers.map(server => {
                        const probeState = probes[server.id];
                        const isExpanded = expanded === server.id;
                        return (
                            <li key={server.id} className={`${styles.serverItem} ${!server.enabled ? styles.disabled : ''}`}>
                                <div className={styles.serverRow}>
                                    <div className={styles.serverMain}>
                                        <div className={styles.serverTitle}>
                                            <strong>{server.label}</strong>
                                            {server.origin === 'local' && <span className={styles.originTag}>nur dieser Browser</span>}
                                            {probeState?.ok !== undefined && (
                                                <span className={`${styles.statusTag} ${probeState.ok ? styles.statusOk : styles.statusFail}`}>
                                                    {probeState.ok
                                                        ? <>{probeState.via === 'server' ? <Server size={11} aria-hidden="true" /> : <MonitorSmartphone size={11} aria-hidden="true" />} verbunden</>
                                                        : 'nicht erreichbar'}
                                                </span>
                                            )}
                                        </div>
                                        <span className={styles.serverUrl}>{server.url}</span>
                                        {probeState?.detail && !probeState.ok && (
                                            <span className={styles.probeDetail}>{probeState.detail}</span>
                                        )}
                                    </div>
                                    <div className={styles.serverActions}>
                                        <label className={styles.toggle}>
                                            <input
                                                type="checkbox"
                                                checked={server.enabled}
                                                onChange={() => toggleEnabled(server)}
                                                aria-label={`${server.label} ${server.enabled ? 'deaktivieren' : 'aktivieren'}`}
                                            />
                                            <span>{server.enabled ? 'Aktiv' : 'Aus'}</span>
                                        </label>
                                        <button
                                            type="button"
                                            className={styles.iconAction}
                                            onClick={() => { void probe(server); setExpanded(server.id); }}
                                            disabled={probeState?.loading}
                                            title="Verbindung testen und Tools entdecken"
                                            aria-label={`${server.label} testen`}
                                        >
                                            <RefreshCw size={15} className={probeState?.loading ? styles.spinning : ''} aria-hidden="true" />
                                        </button>
                                        <button
                                            type="button"
                                            className={styles.iconAction}
                                            onClick={() => setExpanded(isExpanded ? null : server.id)}
                                            aria-expanded={isExpanded}
                                            aria-label={`Details von ${server.label} ${isExpanded ? 'einklappen' : 'anzeigen'}`}
                                        >
                                            <ChevronDown size={15} className={isExpanded ? styles.chevronOpen : ''} aria-hidden="true" />
                                        </button>
                                        <button
                                            type="button"
                                            className={`${styles.iconAction} ${styles.danger}`}
                                            onClick={() => setDeleting(server)}
                                            title="Löschen"
                                            aria-label={`${server.label} löschen`}
                                        >
                                            <Trash2 size={15} aria-hidden="true" />
                                        </button>
                                    </div>
                                </div>

                                {isExpanded && (
                                    <div className={styles.details}>
                                        {!probeState && (
                                            <p className={styles.hint}>Klicke auf <RefreshCw size={12} aria-hidden="true" />, um Tools und Prompts zu entdecken.</p>
                                        )}
                                        {probeState?.tools && probeState.tools.length > 0 && (
                                            <div>
                                                <h4 className={styles.detailHeading}>Tools ({probeState.tools.length})</h4>
                                                <ul className={styles.toolList}>
                                                    {probeState.tools.map(tool => (
                                                        <li key={tool.name}>
                                                            <code>{tool.name}</code>
                                                            <span>{tool.description}</span>
                                                        </li>
                                                    ))}
                                                </ul>
                                            </div>
                                        )}
                                        {probeState?.prompts && probeState.prompts.length > 0 && (
                                            <div>
                                                <h4 className={styles.detailHeading}>Prompts — als Skills importierbar</h4>
                                                <ul className={styles.promptList}>
                                                    {probeState.prompts.map(prompt => (
                                                        <li key={prompt.name}>
                                                            <div className={styles.promptInfo}>
                                                                <code>{prompt.title || prompt.name}</code>
                                                                <span>{prompt.description}</span>
                                                            </div>
                                                            <Button size="sm" variant="secondary" onClick={() => importPrompt(server, prompt)}>
                                                                <Import size={13} aria-hidden="true" /> Als Skill
                                                            </Button>
                                                        </li>
                                                    ))}
                                                </ul>
                                            </div>
                                        )}
                                        {probeState?.ok && !probeState.tools?.length && !probeState.prompts?.length && (
                                            <p className={styles.hint}>Server verbunden, aber keine Tools/Prompts gemeldet.</p>
                                        )}
                                    </div>
                                )}
                            </li>
                        );
                    })}
                </ul>
            )}

            {adding && (
                <div className={styles.dialogOverlay} role="dialog" aria-modal="true" aria-label="MCP-Server hinzufügen">
                    <div className={styles.dialog}>
                        <h3>MCP-Server hinzufügen</h3>
                        <label className={styles.field}>
                            <span>Name</span>
                            <input value={label} onChange={e => setLabel(e.target.value)} placeholder="z. B. Kontext7" />
                        </label>
                        <label className={styles.field}>
                            <span>Endpunkt-URL</span>
                            <input value={url} onChange={e => setUrl(e.target.value)} placeholder="https://server.example/mcp" type="url" />
                        </label>
                        <div className={styles.fieldRow}>
                            <label className={styles.field}>
                                <span>Transport</span>
                                <select value={transport} onChange={e => setTransport(e.target.value as typeof transport)}>
                                    <option value="auto">Auto (HTTP, dann SSE)</option>
                                    <option value="streamable-http">Streamable HTTP</option>
                                    <option value="sse">SSE (Legacy)</option>
                                </select>
                            </label>
                            <label className={styles.field}>
                                <span>Verbindung</span>
                                <select value={connectionMode} onChange={e => setConnectionMode(e.target.value as typeof connectionMode)}>
                                    <option value="auto">Auto (Browser, dann Server)</option>
                                    <option value="browser">Nur Browser (direkt)</option>
                                    <option value="server">Nur Server (Relay)</option>
                                </select>
                            </label>
                        </div>
                        <div className={styles.fieldRow}>
                            <label className={styles.field}>
                                <span>Auth-Header (optional)</span>
                                <input value={authName} onChange={e => setAuthName(e.target.value)} placeholder="Authorization" />
                            </label>
                            <label className={styles.field}>
                                <span>Wert</span>
                                <input value={authValue} onChange={e => setAuthValue(e.target.value)} placeholder="Bearer …" type="password" />
                            </label>
                        </div>
                        {authName.trim() && authValue && backend === 'available' && (
                            <label className={styles.field}>
                                <span>Auth-Speicherort</span>
                                <select value={authLocation} onChange={e => setAuthLocation(e.target.value as typeof authLocation)}>
                                    <option value="server">Server (verschlüsselt, für Server-Route nutzbar)</option>
                                    <option value="browser">Nur dieser Browser (für Direktverbindung)</option>
                                </select>
                            </label>
                        )}
                        {backend !== 'available' && (
                            <p className={styles.hint}>Serverloser Modus: Konfiguration und Auth bleiben in diesem Browser.</p>
                        )}
                        <div className={styles.dialogButtons}>
                            <Button variant="secondary" onClick={() => { setAdding(false); resetForm(); }}>Abbrechen</Button>
                            <Button variant="primary" onClick={handleAdd} disabled={saving || !label.trim() || !url.trim()}>
                                {saving ? 'Speichere…' : 'Hinzufügen'}
                            </Button>
                        </div>
                    </div>
                </div>
            )}

            <ConfirmDialog
                isOpen={deleting !== null}
                title="MCP-Server löschen?"
                message={`Möchtest du „${deleting?.label}" wirklich löschen? Seine Tools verschwinden aus dem Assistenten.`}
                confirmText="Löschen"
                cancelText="Abbrechen"
                variant="danger"
                onConfirm={async () => {
                    if (!deleting) return;
                    try {
                        await deleteMcpRecord(deleting);
                        invalidateBrowserMcpCache(deleting.id);
                        setDeleting(null);
                        invalidate();
                    } catch (error) {
                        toast.error(error instanceof Error ? error.message : 'Löschen fehlgeschlagen');
                    }
                }}
                onCancel={() => setDeleting(null)}
            />
        </div>
    );
}
