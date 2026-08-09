'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Archive, BookOpen, CloudDownload, FileCode2, GitBranch, LayoutDashboard, RefreshCw, Trash2, Upload } from 'lucide-react';
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
    capabilities?: { read: boolean; write: boolean; watch: boolean; lossyExport: boolean };
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
    lastRun?: {
        at?: string;
        revision?: string;
        summary?: string;
        errors: string[];
        /** SHACL-Kurzfassung des letzten Imports (GRAPH_CORE_SPEC §7.2, M7). */
        validation?: { conforms: boolean; violations: number; warnings: number; infos: number };
    };
}

/** Deutsche Kurzfassung des SHACL-Befunds eines Laufs. */
function validationLabel(validation: NonNullable<ConnectorView['lastRun']>['validation']): string | null {
    if (!validation) return null;
    if (validation.conforms) return 'konform';
    const parts = [
        validation.violations > 0 ? `${validation.violations} Verstoß/Verstöße` : '',
        validation.warnings > 0 ? `${validation.warnings} Warnung(en)` : '',
        validation.infos > 0 ? `${validation.infos} Hinweis(e)` : '',
    ].filter(Boolean);
    return parts.length > 0 ? parts.join(', ') : 'konform';
}

interface SyncResponse {
    result: {
        status: 'noop' | 'imported' | 'failed';
        message: string;
        quarantined: Array<{ source: string; reason: string }>;
    };
    connector: ConnectorView | null;
}

interface PushResponse {
    result: {
        status: 'pushed' | 'conflict' | 'failed';
        message: string;
        conflicts: Array<{ path?: string; reason: string }>;
    };
    connector: ConnectorView | null;
}

const KIND_ICONS: Record<string, React.ReactNode> = {
    'rdf-file': <FileCode2 size={12} aria-hidden="true" />,
    'github-rdf': <GitBranch size={12} aria-hidden="true" />,
    'obsidian-vault': <BookOpen size={12} aria-hidden="true" />,
    'json-canvas': <LayoutDashboard size={12} aria-hidden="true" />,
    'git-backup': <Archive size={12} aria-hidden="true" />,
};

/** Modus einer git-backup-Instanz aus dem Locator (`pfad?mode=…`). */
function gitBackupMode(connector: ConnectorView): 'backup' | 'bidirectional' | null {
    if (connector.kind !== 'git-backup') return null;
    const queryIndex = connector.locator.indexOf('?');
    if (queryIndex === -1) return 'bidirectional';
    const mode = new URLSearchParams(connector.locator.slice(queryIndex + 1)).get('mode');
    return mode === 'backup' ? 'backup' : 'bidirectional';
}

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
    const [exporting, setExporting] = useState<ConnectorView | null>(null);
    const [busyId, setBusyId] = useState<string | null>(null);
    const [creating, setCreating] = useState(false);

    // Formular „Neue Quelle"
    const [formKind, setFormKind] = useState('rdf-file');
    const [formName, setFormName] = useState('');
    const [formUrl, setFormUrl] = useState('');
    const [formRepo, setFormRepo] = useState('');
    const [formRef, setFormRef] = useState('');
    const [formPath, setFormPath] = useState('');
    const [formVaultPath, setFormVaultPath] = useState('');
    const [formCanvasPath, setFormCanvasPath] = useState('');
    const [formRepoPath, setFormRepoPath] = useState('data/backup');
    const [formGitMode, setFormGitMode] = useState<'backup' | 'bidirectional'>('bidirectional');
    const [formRemote, setFormRemote] = useState('');
    const [formBranch, setFormBranch] = useState('main');

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
        setFormVaultPath('');
        setFormCanvasPath('');
        setFormRepoPath('data/backup');
        setFormGitMode('bidirectional');
        setFormRemote('');
        setFormBranch('main');
    };

    const configForForm = (): unknown => {
        if (formKind === 'rdf-file') return { url: formUrl.trim() };
        if (formKind === 'obsidian-vault') return { path: formVaultPath.trim() };
        if (formKind === 'json-canvas') return { path: formCanvasPath.trim() };
        if (formKind === 'git-backup') {
            return {
                path: formRepoPath.trim(),
                mode: formGitMode,
                remote: formRemote.trim() || undefined,
                branch: formBranch.trim() || 'main',
            };
        }
        return {
            repo: formRepo.trim(),
            ref: formRef.trim() || undefined,
            path: formPath.trim() || undefined,
        };
    };

    const formReady = formName.trim() !== '' && (
        formKind === 'rdf-file' ? formUrl.trim() !== ''
        : formKind === 'obsidian-vault' ? formVaultPath.trim() !== ''
        : formKind === 'json-canvas' ? formCanvasPath.trim() !== ''
        : formKind === 'git-backup' ? formRepoPath.trim() !== ''
        : formRepo.trim() !== ''
    );

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
            if (created.connector.kind === 'git-backup') {
                // Backup-Repos werden nicht auto-synchronisiert: im Modus
                // „backup" gibt es keinen Rücklese-Pfad, und bidirektionale
                // Repos existieren oft erst nach dem ersten Backup.
                toast.info('Starte mit „Backup erstellen", um den ersten Snapshot zu committen.');
            } else {
                await handleSync(created.connector.id, created.connector.name);
            }
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

    const handleExport = async () => {
        if (!exporting) return;
        const target = exporting;
        setExporting(null);
        setBusyId(target.id);
        try {
            const { result } = await fetchJson<PushResponse>(`/api/graph/connectors/${encodeURIComponent(target.id)}/push`, { method: 'POST' });
            if (result.status === 'pushed') {
                toast.success(`„${target.name}": ${result.message}`);
            } else {
                toast.error(`„${target.name}": ${result.message}`);
            }
        } catch (error) {
            toast.error(error instanceof Error ? error.message : 'Export fehlgeschlagen');
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
                            Binde eine RDF-Datei per URL ein, ein GitHub-Repo mit
                            <code>.ttl</code>/<code>.jsonld</code>-Dateien — z. B.{' '}
                            <code>pajew-ski/prima-materia</code> als Referenzfall — oder
                            einen lokalen Obsidian-Vault unter <code>data/vaults/</code>.
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
                                        {connector.lastRun?.validation && (
                                            <div className={styles.metaRow}>
                                                <dt>Validierung</dt>
                                                <dd data-conforms={connector.lastRun.validation.conforms}>
                                                    {validationLabel(connector.lastRun.validation)}
                                                </dd>
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
                                        {gitBackupMode(connector) !== 'backup' && (
                                            // Modus „backup" ist eine Einbahnstraße Store → Git
                                            // (SPEC §8.2) — ein Sync-Button wäre eine Attrappe.
                                            <Button
                                                variant="secondary"
                                                size="sm"
                                                onClick={() => handleSync(connector.id, connector.name)}
                                                disabled={busyId !== null}
                                            >
                                                <RefreshCw size={14} aria-hidden="true" className={busyId === connector.id ? styles.spinning : undefined} />
                                                {busyId === connector.id ? 'Synchronisiere…' : 'Synchronisieren'}
                                            </Button>
                                        )}
                                        {kindInfo?.capabilities?.write && (
                                            <Button
                                                variant="secondary"
                                                size="sm"
                                                onClick={() => setExporting(connector)}
                                                disabled={busyId !== null}
                                            >
                                                <Upload size={14} aria-hidden="true" />
                                                {connector.kind === 'git-backup' ? 'Backup erstellen' : 'Exportieren'}
                                            </Button>
                                        )}
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
                            ) : formKind === 'obsidian-vault' ? (
                                <label className={styles.field}>
                                    <span>Vault-Ordner (unter data/vaults/ oder einer Wurzel aus OW_VAULT_ROOTS)</span>
                                    <input
                                        value={formVaultPath}
                                        onChange={e => setFormVaultPath(e.target.value)}
                                        placeholder="data/vaults/mein-vault"
                                    />
                                </label>
                            ) : formKind === 'json-canvas' ? (
                                <label className={styles.field}>
                                    <span>.canvas-Datei (unter data/vaults/ oder einer Wurzel aus OW_VAULT_ROOTS)</span>
                                    <input
                                        value={formCanvasPath}
                                        onChange={e => setFormCanvasPath(e.target.value)}
                                        placeholder="data/vaults/mein-vault/plan.canvas"
                                    />
                                </label>
                            ) : formKind === 'git-backup' ? (
                                <>
                                    <label className={styles.field}>
                                        <span>Repo-Ordner (unter data/ oder einer Wurzel aus OW_GIT_ROOTS)</span>
                                        <input
                                            value={formRepoPath}
                                            onChange={e => setFormRepoPath(e.target.value)}
                                            placeholder="data/backup"
                                        />
                                    </label>
                                    <label className={styles.field}>
                                        <span>Modus</span>
                                        <select value={formGitMode} onChange={e => setFormGitMode(e.target.value as 'backup' | 'bidirectional')}>
                                            <option value="bidirectional">bidirektional — externe Edits fließen beim Sync zurück</option>
                                            <option value="backup">backup — Einbahnstraße Store → Git</option>
                                        </select>
                                    </label>
                                    <label className={styles.field}>
                                        <span>Remote-URL (optional — leer = nur lokale Commits)</span>
                                        <input
                                            type="url"
                                            value={formRemote}
                                            onChange={e => setFormRemote(e.target.value)}
                                            placeholder="https://git.example.org/backup.git"
                                        />
                                    </label>
                                    <label className={styles.field}>
                                        <span>Branch</span>
                                        <input
                                            value={formBranch}
                                            onChange={e => setFormBranch(e.target.value)}
                                            placeholder="main"
                                        />
                                    </label>
                                </>
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
                    isOpen={exporting !== null}
                    title={exporting?.kind === 'git-backup' ? 'Backup erstellen?' : 'In die Quelle exportieren?'}
                    message={exporting
                        ? exporting.kind === 'git-backup'
                            ? `Der Graph-Snapshot wird in „${exporting.locator.split('?')[0]}" geschrieben und als Git-Commit festgehalten (deterministische Serialisierung, minimale Diffs). ${gitBackupMode(exporting) === 'bidirectional' ? 'Weicht das Repo vom Stand des letzten Sync ab, wird nichts geschrieben (erst synchronisieren).' : 'Modus „backup": das Repo ist ein Spiegel des Stores, externe Änderungen darin werden überschrieben.'}`
                            : `Der Import-Graph von „${exporting.name}" wird als Markdown in den Vault geschrieben und überschreibt dort geänderte Dateien. Typisierte Verknüpfungen werden dabei zu einfachen Wikilinks abgeflacht (verlustbehafteter Export). Wurde der Vault seit dem letzten Sync extern verändert, wird nichts geschrieben.`
                        : ''}
                    confirmText={exporting?.kind === 'git-backup' ? 'Backup erstellen' : 'Exportieren'}
                    onConfirm={handleExport}
                    onCancel={() => setExporting(null)}
                />

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
