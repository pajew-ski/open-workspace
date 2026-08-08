'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CloudDownload, FileCode2, GitBranch, RefreshCw, Trash2 } from 'lucide-react';
import { AppShell } from '@/components/layout';
import { Button, ConfirmDialog, FloatingActionButton } from '@/components/ui';
import { useToast } from '@/components/ui/Toast';
import styles from './page.module.css';

/**
 * Externe Quellen (Connector-Verwaltung, GRAPH_CORE_SPEC §6, M3).
 *
 * Die Auswahl der Arten kommt ausschließlich aus dem Katalog der API —
 * nicht implementierte Connectors erscheinen hier nie (Invariante 10).
 * Der Quarantäne-Bericht des letzten Laufs wird pro Quelle angezeigt
 * (M3-Abnahme: Importe scheitern nie an der Qualität der Quelle; was
 * nicht parst, wird gemeldet statt verschwiegen).
 */

interface ConnectorKindInfo {
    kind: string;
    label: string;
    description: string;
}

interface ConnectorView {
    id: string;
    name: string;
    kind: string;
    locator: string;
    targetGraph: string;
    syncState: 'idle' | 'syncing' | 'error' | 'conflict';
    revision?: string;
    modifiedAt?: string;
    lastRun?: { at?: string; revision?: string; summary?: string; errors: string[] };
}

interface SyncResponse {
    result: {
        status: 'noop' | 'imported' | 'failed';
        message: string;
        quarantined: Array<{ source: string; reason: string }>;
    };
    connector: ConnectorView | null;
}

const KIND_ICONS: Record<string, React.ReactNode> = {
    'rdf-file': <FileCode2 size={12} aria-hidden="true" />,
    'github-rdf': <GitBranch size={12} aria-hidden="true" />,
};

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
    const response = await fetch(url, init);
    const payload = await response.json().catch(() => null) as (T & { error?: string; details?: unknown }) | null;
    if (!response.ok) {
        const detail = payload && typeof payload.details === 'string' ? ` — ${payload.details}` : '';
        throw new Error(`${payload?.error ?? `HTTP ${response.status}`}${detail}`);
    }
    return payload as T;
}

function formatTime(iso: string | undefined): string | null {
    if (!iso) return null;
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return null;
    return date.toLocaleString('de-DE', { dateStyle: 'medium', timeStyle: 'short' });
}

function shortRevision(revision: string | undefined): string | null {
    if (!revision) return null;
    const value = revision.replace(/^sha256:/, '');
    return value.length > 10 ? `${value.slice(0, 10)}…` : value;
}

export default function GraphConnectorsPage() {
    const toast = useToast();
    const queryClient = useQueryClient();
    const [adding, setAdding] = useState(false);
    const [deleting, setDeleting] = useState<ConnectorView | null>(null);
    const [busyId, setBusyId] = useState<string | null>(null);
    const [creating, setCreating] = useState(false);

    // Formular „Neue Quelle"
    const [formKind, setFormKind] = useState('rdf-file');
    const [formName, setFormName] = useState('');
    const [formUrl, setFormUrl] = useState('');
    const [formRepo, setFormRepo] = useState('');
    const [formRef, setFormRef] = useState('');
    const [formPath, setFormPath] = useState('');

    const { data, isLoading } = useQuery<{ connectors: ConnectorView[]; kinds: ConnectorKindInfo[] }>({
        queryKey: ['graph-connectors'],
        queryFn: () => fetchJson('/api/graph/connectors'),
    });
    const connectors = useMemo(() => data?.connectors ?? [], [data]);
    const kinds = useMemo(() => data?.kinds ?? [], [data]);

    const invalidate = () => queryClient.invalidateQueries({ queryKey: ['graph-connectors'] });

    const resetForm = () => {
        setFormKind('rdf-file');
        setFormName('');
        setFormUrl('');
        setFormRepo('');
        setFormRef('');
        setFormPath('');
    };

    const configForForm = (): unknown => {
        if (formKind === 'rdf-file') return { url: formUrl.trim() };
        return {
            repo: formRepo.trim(),
            ref: formRef.trim() || undefined,
            path: formPath.trim() || undefined,
        };
    };

    const formReady = formName.trim() !== '' && (formKind === 'rdf-file' ? formUrl.trim() !== '' : formRepo.trim() !== '');

    const handleCreate = async () => {
        setCreating(true);
        try {
            const created = await fetchJson<{ connector: ConnectorView }>('/api/graph/connectors', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ kind: formKind, name: formName.trim(), config: configForForm() }),
            });
            setAdding(false);
            resetForm();
            invalidate();
            toast.success(`Quelle „${created.connector.name}" angelegt`);
            await handleSync(created.connector.id, created.connector.name);
        } catch (error) {
            toast.error(error instanceof Error ? error.message : 'Anlegen fehlgeschlagen');
        } finally {
            setCreating(false);
        }
    };

    const handleSync = async (id: string, name: string) => {
        setBusyId(id);
        try {
            const { result } = await fetchJson<SyncResponse>(`/api/graph/connectors/${encodeURIComponent(id)}/sync`, { method: 'POST' });
            if (result.status === 'failed') {
                toast.error(`„${name}": ${result.message}`);
            } else if (result.quarantined.length > 0) {
                toast.info(`„${name}": ${result.message}`);
            } else {
                toast.success(`„${name}": ${result.message}`);
            }
        } catch (error) {
            toast.error(error instanceof Error ? error.message : 'Synchronisierung fehlgeschlagen');
        } finally {
            setBusyId(null);
            invalidate();
        }
    };

    const handleDelete = async () => {
        if (!deleting) return;
        const target = deleting;
        setDeleting(null);
        try {
            await fetchJson(`/api/graph/connectors/${encodeURIComponent(target.id)}`, { method: 'DELETE' });
            toast.success(`Quelle „${target.name}" samt Import-Graph entfernt`);
        } catch (error) {
            toast.error(error instanceof Error ? error.message : 'Löschen fehlgeschlagen');
        } finally {
            invalidate();
        }
    };

    const stateInfo = (connector: ConnectorView): { label: string; className: string } => {
        if (connector.syncState === 'error') return { label: 'Fehler', className: styles.stateError };
        if (connector.syncState === 'conflict') return { label: 'Konflikt', className: styles.stateError };
        if (!connector.revision) return { label: 'Noch nie synchronisiert', className: styles.stateNeutral };
        return { label: 'Synchronisiert', className: styles.stateOk };
    };

    return (
        <AppShell
            title="Externe Quellen"
            actions={
                <FloatingActionButton
                    icon={<span style={{ fontSize: '24px' }}>+</span>}
                    onClick={() => { resetForm(); setAdding(true); }}
                    label="Neue Quelle"
                />
            }
        >
            <div className={styles.container}>
                <div className={styles.header}>
                    <div>
                        <h2>Externe Quellen</h2>
                        <p>
                            Materialisierte Wissensquellen im Graphen: jeder Import landet in einem eigenen Named
                            Graph (<code>graph/…/import/…</code>) mit Provenienz (PROV) und Commit- bzw.
                            Inhalts-Revision. Was nicht parst, wird quarantäniert und hier gemeldet — ein Import
                            scheitert nie an der Qualität der Quelle. Ansicht im{' '}
                            <Link className={styles.inlineLink} href="/graph">Wissensgraph</Link>.
                        </p>
                    </div>
                </div>

                {isLoading ? (
                    <p className={styles.loading}>Lade Quellen…</p>
                ) : connectors.length === 0 ? (
                    <div className={styles.empty}>
                        <CloudDownload size={40} aria-hidden="true" />
                        <h3>Noch keine externen Quellen</h3>
                        <p>
                            Binde eine RDF-Datei per URL ein oder ein GitHub-Repo mit
                            <code>.ttl</code>/<code>.jsonld</code>-Dateien — z. B.{' '}
                            <code>pajew-ski/prima-materia</code> als Referenzfall.
                        </p>
                        <Button variant="primary" onClick={() => { resetForm(); setAdding(true); }}>
                            Erste Quelle einbinden
                        </Button>
                    </div>
                ) : (
                    <ul className={styles.grid}>
                        {connectors.map(connector => {
                            const state = stateInfo(connector);
                            const kindInfo = kinds.find(k => k.kind === connector.kind);
                            const errors = connector.lastRun?.errors ?? [];
                            const lastRunTime = formatTime(connector.lastRun?.at);
                            return (
                                <li key={connector.id} className={styles.card}>
                                    <div className={styles.cardHead}>
                                        <strong className={styles.cardName}>{connector.name}</strong>
                                        <span className={styles.kindTag}>
                                            {KIND_ICONS[connector.kind]} {kindInfo?.label ?? connector.kind}
                                        </span>
                                        <span className={`${styles.stateTag} ${state.className}`}>{state.label}</span>
                                    </div>
                                    <code className={styles.locator} title={connector.locator}>{connector.locator}</code>
                                    <dl className={styles.metaList}>
                                        {lastRunTime && (
                                            <div className={styles.metaRow}>
                                                <dt>Letzter Lauf</dt>
                                                <dd>{lastRunTime}</dd>
                                            </div>
                                        )}
                                        {connector.revision && (
                                            <div className={styles.metaRow}>
                                                <dt>Revision</dt>
                                                <dd><code>{shortRevision(connector.revision)}</code></dd>
                                            </div>
                                        )}
                                        {connector.lastRun?.summary && (
                                            <div className={styles.metaRow}>
                                                <dt>Ergebnis</dt>
                                                <dd>{connector.lastRun.summary}</dd>
                                            </div>
                                        )}
                                    </dl>
                                    {errors.length > 0 && (
                                        <details className={styles.quarantine}>
                                            <summary>Fehlerbericht ({errors.length})</summary>
                                            <ul>
                                                {errors.map((message, index) => (
                                                    <li key={index}>{message}</li>
                                                ))}
                                            </ul>
                                        </details>
                                    )}
                                    <div className={styles.cardFooter}>
                                        <Button
                                            variant="secondary"
                                            size="sm"
                                            onClick={() => handleSync(connector.id, connector.name)}
                                            disabled={busyId !== null}
                                        >
                                            <RefreshCw size={14} aria-hidden="true" className={busyId === connector.id ? styles.spinning : undefined} />
                                            {busyId === connector.id ? 'Synchronisiere…' : 'Synchronisieren'}
                                        </Button>
                                        <button
                                            type="button"
                                            className={styles.deleteAction}
                                            onClick={() => setDeleting(connector)}
                                            title="Löschen"
                                            aria-label={`Quelle ${connector.name} löschen`}
                                        >
                                            <Trash2 size={15} aria-hidden="true" />
                                        </button>
                                    </div>
                                </li>
                            );
                        })}
                    </ul>
                )}

                {adding && (
                    <div className={styles.overlay} role="dialog" aria-modal="true" aria-label="Neue Quelle einbinden">
                        <div className={styles.dialog}>
                            <h3>Neue Quelle einbinden</h3>
                            <label className={styles.field}>
                                <span>Art der Quelle</span>
                                <select value={formKind} onChange={e => setFormKind(e.target.value)}>
                                    {kinds.map(kind => (
                                        <option key={kind.kind} value={kind.kind}>{kind.label}</option>
                                    ))}
                                </select>
                            </label>
                            <p className={styles.kindDescription}>
                                {kinds.find(k => k.kind === formKind)?.description}
                            </p>
                            <label className={styles.field}>
                                <span>Name</span>
                                <input
                                    value={formName}
                                    onChange={e => setFormName(e.target.value)}
                                    placeholder={formKind === 'github-rdf' ? 'z. B. prima-materia' : 'z. B. Wikidata-Auszug'}
                                />
                            </label>
                            {formKind === 'rdf-file' ? (
                                <label className={styles.field}>
                                    <span>URL der RDF-Datei</span>
                                    <input
                                        type="url"
                                        value={formUrl}
                                        onChange={e => setFormUrl(e.target.value)}
                                        placeholder="https://example.org/daten.ttl"
                                    />
                                </label>
                            ) : (
                                <>
                                    <label className={styles.field}>
                                        <span>GitHub-Repo (owner/name oder github.com-URL)</span>
                                        <input
                                            value={formRepo}
                                            onChange={e => setFormRepo(e.target.value)}
                                            placeholder="pajew-ski/prima-materia"
                                        />
                                    </label>
                                    <label className={styles.field}>
                                        <span>Branch, Tag oder Commit (leer = Default-Branch)</span>
                                        <input value={formRef} onChange={e => setFormRef(e.target.value)} placeholder="main" />
                                    </label>
                                    <label className={styles.field}>
                                        <span>Unterordner (leer = ganzes Repo)</span>
                                        <input value={formPath} onChange={e => setFormPath(e.target.value)} placeholder="ontology" />
                                    </label>
                                </>
                            )}
                            <div className={styles.dialogButtons}>
                                <Button variant="secondary" onClick={() => { setAdding(false); resetForm(); }}>Abbrechen</Button>
                                <Button variant="primary" onClick={handleCreate} disabled={creating || !formReady}>
                                    {creating ? 'Lege an…' : 'Anlegen und synchronisieren'}
                                </Button>
                            </div>
                        </div>
                    </div>
                )}

                <ConfirmDialog
                    isOpen={deleting !== null}
                    title="Quelle löschen?"
                    message={deleting
                        ? `„${deleting.name}" wird aus der Registry entfernt und der Import-Graph mit allen importierten Aussagen gelöscht. Die Quelle selbst bleibt unberührt.`
                        : ''}
                    confirmText="Löschen"
                    onConfirm={handleDelete}
                    onCancel={() => setDeleting(null)}
                />
            </div>
        </AppShell>
    );
}
