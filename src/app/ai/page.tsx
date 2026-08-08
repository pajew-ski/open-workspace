'use client';

import { useCallback, useState } from 'react';
import { Star, RefreshCw, Pencil, Trash2, MonitorSmartphone, Globe, Info, ChevronDown } from 'lucide-react';
import { AppShell } from '@/components/layout';
import { Button, ConfirmDialog, FloatingActionButton } from '@/components/ui';
import { useToast } from '@/components/ui/Toast';
import { useAIState, useBackendAvailability, useInvalidateAIState } from '@/lib/ai/useAI';
import {
    deleteProviderRecord,
    invalidateRoute,
    resolveRoute,
    saveDefaults,
    updateProviderRecord,
    type ClientProviderRecord,
    type ResolvedRoute,
} from '@/lib/ai/store.client';
import { getPreset } from '@/lib/ai/presets';
import { ProviderFormDialog } from './ProviderFormDialog';
import { WebLLMManager } from './WebLLMManager';
import styles from './page.module.css';

/**
 * AI-Hub: the control room of the inference layer. Every provider —
 * cloud APIs, local engines (Ollama, LM Studio, …) and the in-browser
 * WebLLM engine — with live routing (browser-direct vs. server relay),
 * diagnostics, model discovery and workspace defaults.
 */

export default function AIHubPage() {
    const toast = useToast();
    const backend = useBackendAvailability();
    const { data: state } = useAIState();
    const invalidate = useInvalidateAIState();

    const [adding, setAdding] = useState(false);
    const [editing, setEditing] = useState<ClientProviderRecord | null>(null);
    const [deleting, setDeleting] = useState<ClientProviderRecord | null>(null);
    const [expanded, setExpanded] = useState<string | null>(null);
    const [routes, setRoutes] = useState<Record<string, ResolvedRoute & { loading?: boolean }>>({});
    const [explainerOpen, setExplainerOpen] = useState(false);

    const providers = state?.providers ?? [];
    const defaults = state?.defaults ?? {};

    const probe = useCallback(async (record: ClientProviderRecord, force = false) => {
        setRoutes(prev => ({ ...prev, [record.id]: { ...(prev[record.id] ?? { decision: { route: 'browser', reason: '' } }), loading: true } }));
        try {
            if (force) invalidateRoute(record.id);
            const route = await resolveRoute(record, force);
            setRoutes(prev => ({ ...prev, [record.id]: { ...route, loading: false } }));
        } catch (error) {
            setRoutes(prev => ({
                ...prev,
                [record.id]: {
                    decision: { route: 'browser', reason: 'Probe fehlgeschlagen' },
                    probe: { status: 'error', detail: error instanceof Error ? error.message : 'Fehler' },
                    loading: false,
                },
            }));
        }
    }, []);

    const setAsDefault = async (record: ClientProviderRecord) => {
        try {
            await saveDefaults({ providerId: record.id, model: record.defaultModel });
            invalidate();
            toast.success(`„${record.label}" ist jetzt Standard`);
        } catch (error) {
            toast.error(error instanceof Error ? error.message : 'Speichern fehlgeschlagen');
        }
    };

    const toggleEnabled = async (record: ClientProviderRecord) => {
        try {
            await updateProviderRecord(record, { enabled: !record.enabled });
            invalidateRoute(record.id);
            invalidate();
        } catch (error) {
            toast.error(error instanceof Error ? error.message : 'Aktualisierung fehlgeschlagen');
        }
    };

    const statusFor = (record: ClientProviderRecord) => {
        const route = routes[record.id];
        if (!route || route.loading) return { className: styles.dotUnknown, label: route?.loading ? 'prüfe…' : 'ungeprüft' };
        if (route.probe?.status === 'online') return { className: styles.dotOnline, label: 'online' };
        if (route.probe?.status === 'auth') return { className: styles.dotWarn, label: 'Auth-Fehler' };
        return { className: styles.dotOffline, label: 'nicht erreichbar' };
    };

    return (
        <AppShell
            title="AI-Hub"
            actions={
                <FloatingActionButton
                    icon={<span style={{ fontSize: '24px' }}>+</span>}
                    onClick={() => setAdding(true)}
                    label="Provider hinzufügen"
                />
            }
        >
            <div className={styles.container}>
                <div className={styles.pageHeader}>
                    <div>
                        <h2>AI-Hub</h2>
                        <p>
                            Alle Inference-Quellen des Workspace: Cloud-APIs, lokale Engines und Inference direkt im
                            Browser (WebGPU). Jede Anfrage nimmt automatisch den Weg, der funktioniert — direkt aus dem
                            Browser oder über das Backend.
                        </p>
                    </div>
                    <div className={styles.headerStatus}>
                        <span className={`${styles.backendChip} ${backend === 'available' ? styles.backendOn : styles.backendOff}`}>
                            {backend === 'available' ? 'Backend verbunden' : backend === 'unavailable' ? 'Serverloser Modus' : 'Prüfe Backend…'}
                        </span>
                        {backend === 'unavailable' && (
                            <span className={styles.backendNote}>
                                Der Assistent läuft weiter: Konfiguration, Chats und Inference bleiben im Browser.
                            </span>
                        )}
                    </div>
                </div>

                <button
                    type="button"
                    className={styles.explainerToggle}
                    onClick={() => setExplainerOpen(v => !v)}
                    aria-expanded={explainerOpen}
                >
                    <Info size={15} aria-hidden="true" />
                    Wie erreicht eine in der Cloud gehostete App meine lokale Inference?
                    <ChevronDown size={15} className={explainerOpen ? styles.chevronOpen : ''} aria-hidden="true" />
                </button>
                {explainerOpen && (
                    <div className={styles.explainer}>
                        <p>
                            Der Trick: <strong>Der Browser ruft lokale Endpunkte selbst auf.</strong> Ein Cloud-Server kann{' '}
                            <code>http://localhost:11434</code> auf deinem Rechner nie erreichen — die Seite in deinem Browser
                            schon. Deshalb löst der Workspace die Route pro Provider auf: private Adressen gehen immer den
                            Browser-Weg, Cloud-Schlüssel auf dem Server den Server-Weg.
                        </p>
                        <ul>
                            <li>
                                <strong>Ollama freigeben:</strong> <code>OLLAMA_ORIGINS=https://deine-app.example</code>{' '}
                                (oder <code>*</code>) setzen und Ollama neu starten — sonst blockiert CORS den Zugriff.
                            </li>
                            <li>
                                <strong>LM Studio:</strong> unter Developer „Enable CORS“ aktivieren.
                            </li>
                            <li>
                                <strong>Mixed Content:</strong> HTTPS-Apps dürfen <code>http://localhost</code> ansprechen
                                (Browser-Ausnahme). Andere HTTP-Adressen im LAN werden blockiert — dann HTTPS bereitstellen
                                oder per SSH-Tunnel auf localhost mappen.
                            </li>
                            <li>
                                <strong>Ganz ohne Server:</strong> WebLLM rechnet mit WebGPU direkt in diesem Browser —
                                nach dem Modell-Download sogar offline.
                            </li>
                        </ul>
                    </div>
                )}

                {providers.length === 0 ? (
                    <div className={styles.empty}>
                        <h3>Noch kein Provider konfiguriert</h3>
                        <p>Verbinde Ollama, LM Studio, einen Cloud-Anbieter — oder starte ohne alles mit WebLLM im Browser.</p>
                        <Button variant="primary" onClick={() => setAdding(true)}>Ersten Provider einrichten</Button>
                    </div>
                ) : (
                    <ul className={styles.providerGrid}>
                        {providers.map(record => {
                            const preset = getPreset(record.kind);
                            const route = routes[record.id];
                            const status = statusFor(record);
                            const isDefault = defaults.providerId === record.id;
                            const isExpanded = expanded === record.id;
                            const isWebllm = record.kind === 'webllm';
                            return (
                                <li key={record.id} className={`${styles.providerCard} ${!record.enabled ? styles.disabled : ''}`}>
                                    <div className={styles.cardHead}>
                                        <span className={`${styles.dot} ${status.className}`} title={status.label} />
                                        <strong className={styles.providerName}>{record.label}</strong>
                                        <span className={styles.kindTag}>{preset.label}</span>
                                        {isDefault && <span className={styles.defaultTag}><Star size={11} aria-hidden="true" /> Standard</span>}
                                        {record.origin === 'local' && <span className={styles.originTag}>nur dieser Browser</span>}
                                    </div>

                                    {record.baseUrl && <code className={styles.baseUrl}>{record.baseUrl}</code>}
                                    {isWebllm && <span className={styles.webllmTag}>Läuft in diesem Browser (WebGPU) — kein Endpunkt nötig</span>}

                                    <div className={styles.cardMeta}>
                                        {record.defaultModel && <span>Modell: <code>{record.defaultModel}</code></span>}
                                        {route?.probe?.models && <span>{route.probe.models.length} Modelle</span>}
                                        {route?.probe?.latencyMs !== undefined && <span>{route.probe.latencyMs} ms</span>}
                                        {route && !route.loading && (
                                            <span className={styles.routeTag} title={route.decision.reason}>
                                                {route.decision.route === 'browser'
                                                    ? <><MonitorSmartphone size={11} aria-hidden="true" /> Browser-Route</>
                                                    : <><Globe size={11} aria-hidden="true" /> Server-Route</>}
                                            </span>
                                        )}
                                        <span>
                                            Schlüssel: {record.keyLocation === 'none' ? 'keiner' : record.keyLocation === 'server' ? 'Server (verschlüsselt)' : 'dieser Browser'}
                                        </span>
                                    </div>

                                    {route?.probe && route.probe.status !== 'online' && !route.loading && (
                                        <p className={styles.probeDetail}>{route.probe.detail}</p>
                                    )}

                                    <div className={styles.cardActions}>
                                        <label className={styles.toggle}>
                                            <input
                                                type="checkbox"
                                                checked={record.enabled}
                                                onChange={() => toggleEnabled(record)}
                                                aria-label={`${record.label} ${record.enabled ? 'deaktivieren' : 'aktivieren'}`}
                                            />
                                            <span>{record.enabled ? 'Aktiv' : 'Aus'}</span>
                                        </label>
                                        <button
                                            type="button"
                                            className={styles.iconAction}
                                            onClick={() => probe(record, true)}
                                            disabled={route?.loading}
                                            title="Verbindung testen (Route neu auflösen)"
                                            aria-label={`${record.label} testen`}
                                        >
                                            <RefreshCw size={15} className={route?.loading ? styles.spinning : ''} aria-hidden="true" />
                                        </button>
                                        {!isDefault && (
                                            <button
                                                type="button"
                                                className={styles.iconAction}
                                                onClick={() => setAsDefault(record)}
                                                title="Als Standard setzen"
                                                aria-label={`${record.label} als Standard setzen`}
                                            >
                                                <Star size={15} aria-hidden="true" />
                                            </button>
                                        )}
                                        <button
                                            type="button"
                                            className={styles.iconAction}
                                            onClick={() => setEditing(record)}
                                            title="Bearbeiten"
                                            aria-label={`${record.label} bearbeiten`}
                                        >
                                            <Pencil size={15} aria-hidden="true" />
                                        </button>
                                        <button
                                            type="button"
                                            className={`${styles.iconAction} ${styles.danger}`}
                                            onClick={() => setDeleting(record)}
                                            title="Löschen"
                                            aria-label={`${record.label} löschen`}
                                        >
                                            <Trash2 size={15} aria-hidden="true" />
                                        </button>
                                        {isWebllm && (
                                            <button
                                                type="button"
                                                className={styles.expandButton}
                                                onClick={() => setExpanded(isExpanded ? null : record.id)}
                                                aria-expanded={isExpanded}
                                            >
                                                Modelle verwalten
                                                <ChevronDown size={14} className={isExpanded ? styles.chevronOpen : ''} aria-hidden="true" />
                                            </button>
                                        )}
                                    </div>

                                    {isWebllm && isExpanded && (
                                        <div className={styles.webllmSection}>
                                            <WebLLMManager
                                                onDefaultModel={async model => {
                                                    try {
                                                        await updateProviderRecord(record, { defaultModel: model });
                                                        invalidate();
                                                    } catch { /* non-critical */ }
                                                }}
                                            />
                                        </div>
                                    )}
                                </li>
                            );
                        })}
                    </ul>
                )}
            </div>

            {adding && (
                <ProviderFormDialog
                    backendAvailable={backend === 'available'}
                    onClose={() => setAdding(false)}
                    onSaved={invalidate}
                />
            )}
            {editing && (
                <ProviderFormDialog
                    existing={editing}
                    backendAvailable={backend === 'available'}
                    onClose={() => setEditing(null)}
                    onSaved={invalidate}
                />
            )}

            <ConfirmDialog
                isOpen={deleting !== null}
                title="Provider löschen?"
                message={`Möchtest du „${deleting?.label}" wirklich löschen? Ein browserseitig gespeicherter Schlüssel wird ebenfalls entfernt.`}
                confirmText="Löschen"
                cancelText="Abbrechen"
                variant="danger"
                onConfirm={async () => {
                    if (!deleting) return;
                    try {
                        await deleteProviderRecord(deleting);
                        const { setBrowserProviderKey } = await import('@/lib/ai/keys.client');
                        setBrowserProviderKey(deleting.id, '');
                        invalidateRoute(deleting.id);
                        setDeleting(null);
                        invalidate();
                    } catch (error) {
                        toast.error(error instanceof Error ? error.message : 'Löschen fehlgeschlagen');
                    }
                }}
                onCancel={() => setDeleting(null)}
            />
        </AppShell>
    );
}
