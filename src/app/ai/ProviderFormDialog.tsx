'use client';

import { useMemo, useState } from 'react';
import { Button } from '@/components/ui';
import { useToast } from '@/components/ui/Toast';
import { PROVIDER_PRESETS, getPreset, type ProviderPreset } from '@/lib/ai/presets';
import { DEFAULT_WEBLLM_MODEL } from '@/lib/ai/protocols/webllm';
import { listProviderModels } from '@/lib/ai/client';
import {
    createProviderRecord,
    updateProviderRecord,
    resolveBrowserProvider,
    invalidateRoute,
    type ClientProviderRecord,
    type ClientProviderInput,
} from '@/lib/ai/store.client';
import { getBrowserProviderKey, setBrowserProviderKey } from '@/lib/ai/keys.client';
import type { ConnectionMode, KeyLocation, ProviderKind, ToolCallMode } from '@/lib/ai/types';
import styles from './ProviderFormDialog.module.css';

/**
 * Add/edit dialog for inference providers: preset gallery (local, in-
 * browser, cloud) followed by a configuration form with key-storage
 * choice (server-encrypted vs. browser-only) and live model discovery.
 */

interface ProviderFormDialogProps {
    existing?: ClientProviderRecord;
    backendAvailable: boolean;
    onClose(): void;
    onSaved(): void;
}

const CATEGORY_LABELS: Record<ProviderPreset['category'], string> = {
    local: 'Lokal (dein Rechner / LAN)',
    browser: 'Im Browser (kein Server nötig)',
    cloud: 'Cloud-Anbieter',
};

export function ProviderFormDialog({ existing, backendAvailable, onClose, onSaved }: ProviderFormDialogProps) {
    const toast = useToast();
    const [step, setStep] = useState<'preset' | 'form'>(existing ? 'form' : 'preset');
    const [kind, setKind] = useState<ProviderKind>(existing?.kind ?? 'ollama');
    const [label, setLabel] = useState(existing?.label ?? '');
    const [baseUrl, setBaseUrl] = useState(existing?.baseUrl ?? '');
    const [apiKey, setApiKey] = useState('');
    const [keyLocation, setKeyLocation] = useState<KeyLocation>(existing?.keyLocation ?? 'none');
    const [connectionMode, setConnectionMode] = useState<ConnectionMode>(existing?.connectionMode ?? 'auto');
    const [toolCalls, setToolCalls] = useState<ToolCallMode>(existing?.toolCalls ?? 'auto');
    const [defaultModel, setDefaultModel] = useState(existing?.defaultModel ?? '');
    const [models, setModels] = useState<string[]>(existing?.pinnedModels ?? []);
    const [loadingModels, setLoadingModels] = useState(false);
    const [modelHint, setModelHint] = useState('');
    const [saving, setSaving] = useState(false);
    const [showAdvanced, setShowAdvanced] = useState(false);

    const preset = useMemo(() => getPreset(kind), [kind]);
    const hasBrowserKey = existing ? Boolean(getBrowserProviderKey(existing.id)) : false;

    const choosePreset = (p: ProviderPreset) => {
        setKind(p.kind);
        setLabel(p.label);
        setBaseUrl(p.defaultBaseUrl);
        setKeyLocation(p.requiresKey ? (backendAvailable ? 'server' : 'browser') : 'none');
        if (p.kind === 'webllm') setDefaultModel(DEFAULT_WEBLLM_MODEL);
        if (p.exampleModels?.length) setModels(p.exampleModels);
        setStep('form');
    };

    const fetchModels = async () => {
        setLoadingModels(true);
        setModelHint('');
        try {
            const probeRecord: ClientProviderRecord = {
                id: existing?.id ?? 'probe',
                label: label || preset.label,
                kind,
                baseUrl,
                connectionMode,
                keyLocation,
                toolCalls,
                enabled: true,
                origin: existing?.origin ?? 'local',
                createdAt: '',
                updatedAt: '',
            };
            const resolved = resolveBrowserProvider(probeRecord);
            if (apiKey) resolved.apiKey = apiKey;
            const found = await listProviderModels(resolved);
            if (found.length > 0) {
                setModels(found);
                if (!defaultModel) setDefaultModel(found[0]);
                setModelHint(`${found.length} Modelle gefunden.`);
            } else {
                setModelHint('Keine Modelle gemeldet — Modellnamen manuell eintragen.');
            }
        } catch (error) {
            setModelHint(
                `Direktabruf fehlgeschlagen (${error instanceof Error ? error.message : 'Fehler'}). ` +
                (backendAvailable ? 'Nach dem Speichern versucht es die Server-Route erneut.' : 'Modellnamen manuell eintragen.')
            );
        } finally {
            setLoadingModels(false);
        }
    };

    const handleSave = async () => {
        if (!label.trim()) return;
        if (kind !== 'webllm' && !baseUrl.trim()) {
            toast.error('Endpunkt-URL fehlt.');
            return;
        }
        setSaving(true);
        try {
            const input: ClientProviderInput = {
                label: label.trim(),
                kind,
                baseUrl: baseUrl.trim(),
                connectionMode,
                keyLocation,
                apiKey: keyLocation === 'server' && apiKey ? apiKey : undefined,
                defaultModel: defaultModel || undefined,
                pinnedModels: models.length > 0 ? models.slice(0, 100) : undefined,
                toolCalls,
                enabled: existing?.enabled ?? true,
            };
            let id: string;
            if (existing) {
                await updateProviderRecord(existing, input);
                id = existing.id;
            } else {
                const created = await createProviderRecord(input);
                id = created.id;
            }
            if (keyLocation === 'browser' && apiKey) {
                setBrowserProviderKey(id, apiKey);
            }
            if (keyLocation !== 'browser' && existing) {
                // Cleared or moved to server — remove any stale browser copy.
                if (keyLocation === 'none') setBrowserProviderKey(id, '');
            }
            invalidateRoute(id);
            toast.success(existing ? 'Provider aktualisiert' : `Provider „${label.trim()}" hinzugefügt`);
            onSaved();
            onClose();
        } catch (error) {
            toast.error(error instanceof Error ? error.message : 'Speichern fehlgeschlagen');
        } finally {
            setSaving(false);
        }
    };

    return (
        <div className={styles.overlay} role="dialog" aria-modal="true" aria-label={existing ? 'Provider bearbeiten' : 'Provider hinzufügen'}>
            <div className={styles.dialog}>
                {step === 'preset' ? (
                    <>
                        <h3>Provider hinzufügen</h3>
                        <p className={styles.intro}>
                            Cloud oder lokal — beides gleichberechtigt. Lokale Endpunkte erreicht der Browser direkt,
                            auch wenn die App selbst in der Cloud gehostet ist.
                        </p>
                        {(['local', 'browser', 'cloud'] as const).map(category => (
                            <div key={category} className={styles.presetGroup}>
                                <h4>{CATEGORY_LABELS[category]}</h4>
                                <div className={styles.presetGrid}>
                                    {PROVIDER_PRESETS.filter(p => p.category === category).map(p => (
                                        <button key={p.kind} type="button" className={styles.presetCard} onClick={() => choosePreset(p)}>
                                            <strong>{p.label}</strong>
                                            <span>{p.description}</span>
                                        </button>
                                    ))}
                                </div>
                            </div>
                        ))}
                        <div className={styles.dialogButtons}>
                            <Button variant="secondary" onClick={onClose}>Abbrechen</Button>
                        </div>
                    </>
                ) : (
                    <>
                        <h3>{existing ? `„${existing.label}" bearbeiten` : `${preset.label} einrichten`}</h3>
                        {!existing && (
                            <button type="button" className={styles.backLink} onClick={() => setStep('preset')}>
                                ← Anderes Preset wählen
                            </button>
                        )}

                        <label className={styles.field}>
                            <span>Name</span>
                            <input value={label} onChange={e => setLabel(e.target.value)} placeholder={preset.label} />
                        </label>

                        {kind !== 'webllm' && (
                            <label className={styles.field}>
                                <span>Endpunkt-URL</span>
                                <input value={baseUrl} onChange={e => setBaseUrl(e.target.value)} placeholder={preset.defaultBaseUrl || 'https://…'} type="url" />
                            </label>
                        )}

                        {kind === 'webllm' && (
                            <p className={styles.webllmNote}>
                                WebLLM lädt Modelle einmalig in den Browser-Cache und rechnet auf deiner GPU (WebGPU).
                                Kein Endpunkt, kein Schlüssel — und nach dem Download auch offline verfügbar.
                            </p>
                        )}

                        {kind !== 'webllm' && (
                            <>
                                <div className={styles.fieldRow}>
                                    <label className={styles.field}>
                                        <span>API-Schlüssel {preset.requiresKey ? '' : '(optional)'}</span>
                                        <input
                                            value={apiKey}
                                            onChange={e => setApiKey(e.target.value)}
                                            type="password"
                                            placeholder={
                                                existing?.hasServerKey ? 'Auf dem Server gespeichert — leer lassen zum Behalten'
                                                    : hasBrowserKey ? 'In diesem Browser gespeichert — leer lassen zum Behalten'
                                                        : preset.requiresKey ? 'sk-…' : 'nicht nötig'
                                            }
                                        />
                                    </label>
                                    <label className={styles.field}>
                                        <span>Schlüssel-Speicherort</span>
                                        <select value={keyLocation} onChange={e => setKeyLocation(e.target.value as KeyLocation)}>
                                            <option value="none">Kein Schlüssel</option>
                                            {backendAvailable && (
                                                <option value="server">Server (verschlüsselt) — Anfragen laufen über das Backend</option>
                                            )}
                                            <option value="browser">Nur dieser Browser — Direktverbindung, funktioniert ohne Backend</option>
                                        </select>
                                    </label>
                                </div>
                                {keyLocation === 'browser' && (
                                    <p className={styles.keyWarning}>
                                        Der Schlüssel bleibt im localStorage dieses Browsers und wird nur für direkte
                                        Anfragen an {preset.label} verwendet — er verlässt den Browser nie Richtung Workspace-Server.
                                    </p>
                                )}
                            </>
                        )}

                        <div className={styles.fieldRow}>
                            <label className={styles.field}>
                                <span>Standard-Modell</span>
                                <input
                                    value={defaultModel}
                                    onChange={e => setDefaultModel(e.target.value)}
                                    placeholder={preset.exampleModels?.[0] ?? (kind === 'webllm' ? DEFAULT_WEBLLM_MODEL : 'Modellname')}
                                    list="ai-model-suggestions"
                                />
                                <datalist id="ai-model-suggestions">
                                    {models.map(m => <option key={m} value={m} />)}
                                </datalist>
                            </label>
                            {kind !== 'webllm' && (
                                <div className={styles.fieldAction}>
                                    <Button variant="secondary" size="sm" onClick={fetchModels} disabled={loadingModels || !baseUrl.trim()}>
                                        {loadingModels ? 'Lade…' : 'Modelle abrufen'}
                                    </Button>
                                </div>
                            )}
                        </div>
                        {modelHint && <p className={styles.modelHint}>{modelHint}</p>}

                        <button type="button" className={styles.advancedToggle} onClick={() => setShowAdvanced(v => !v)} aria-expanded={showAdvanced}>
                            {showAdvanced ? '▾' : '▸'} Erweitert (Routing, Tool-Calling)
                        </button>
                        {showAdvanced && (
                            <div className={styles.fieldRow}>
                                <label className={styles.field}>
                                    <span>Verbindungsweg</span>
                                    <select value={connectionMode} onChange={e => setConnectionMode(e.target.value as ConnectionMode)}>
                                        <option value="auto">Auto — Browser zuerst, dann Server</option>
                                        <option value="browser">Nur Browser (direkt)</option>
                                        <option value="server">Nur Server (Relay)</option>
                                    </select>
                                </label>
                                <label className={styles.field}>
                                    <span>Tool-Calling</span>
                                    <select value={toolCalls} onChange={e => setToolCalls(e.target.value as ToolCallMode)}>
                                        <option value="auto">Auto — nativ, Text als Fallback</option>
                                        <option value="native">Nativ (Function Calling)</option>
                                        <option value="text">Text-Syntax ([[TOOL:…]])</option>
                                    </select>
                                </label>
                            </div>
                        )}

                        {preset.corsHint && (
                            <p className={styles.corsHint}>{preset.corsHint}</p>
                        )}

                        <div className={styles.dialogButtons}>
                            <Button variant="secondary" onClick={onClose}>Abbrechen</Button>
                            <Button variant="primary" onClick={handleSave} disabled={saving || !label.trim()}>
                                {saving ? 'Speichere…' : existing ? 'Speichern' : 'Hinzufügen'}
                            </Button>
                        </div>
                    </>
                )}
            </div>
        </div>
    );
}
