'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Globe, RefreshCw, Trash2 } from 'lucide-react';
import { AppShell } from '@/components/layout';
import { Button, ConfirmDialog, FloatingActionButton } from '@/components/ui';
import { useToast } from '@/components/ui/Toast';
import styles from './page.module.css';

/**
 * Föderation (GRAPH_CORE_SPEC §7.4, M11).
 *
 * Zwei Richtungen auf einer Seite:
 *  - **ausgehend**: die Endpoint-Registry (`ow:FederatedEndpoint` in
 *    `graph/meta`). Nur was hier steht, ist als `SERVICE`-Ziel erlaubt;
 *    die Vertrauensstufe entscheidet, ob lokale Werte mitgeschickt
 *    werden. Die Erreichbarkeits-Probe ist eine echte ASK-Query — ein
 *    nicht erreichbarer Endpoint wird ehrlich als solcher markiert.
 *  - **eingehend**: Statuskarte des eigenen Endpoints, read-only. Ohne
 *    Token sieht ein fremder Client nichts (leeres Dataset).
 */

type TrustLevel = 'unknown' | 'known' | 'trusted';

interface EndpointView {
    id: string;
    iri: string;
    name: string;
    url: string;
    trustLevel: TrustLevel;
    description?: string;
    createdAt?: string;
    modifiedAt?: string;
}

interface EndpointsResponse {
    endpoints: EndpointView[];
    trustLevels: Array<{ level: TrustLevel; label: string }>;
    capabilities: { outbound: boolean; inbound: boolean };
    inboundEndpoint: string;
    limits: { timeoutMs: number; maxRows: number; maxBindings: number };
}

interface ProbeResponse {
    endpointId: string;
    reachable: boolean;
    message: string;
    durationMs: number;
    checkedAt: string;
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
    const response = await fetch(url, init);
    const payload = await response.json().catch(() => null) as (T & { error?: string }) | null;
    if (!response.ok) throw new Error(payload?.error ?? `HTTP ${response.status}`);
    return payload as T;
}

function formatTime(iso: string | undefined): string | null {
    if (!iso) return null;
    const date = new Date(iso);
    return Number.isNaN(date.getTime()) ? null : date.toLocaleString('de-DE', { dateStyle: 'medium', timeStyle: 'short' });
}

const TRUST_TAG: Record<TrustLevel, string> = {
    unknown: 'unbekannt',
    known: 'bekannt',
    trusted: 'vertraut',
};

export default function GraphFederationPage() {
    const toast = useToast();
    const queryClient = useQueryClient();
    const [adding, setAdding] = useState(false);
    const [creating, setCreating] = useState(false);
    const [deleting, setDeleting] = useState<EndpointView | null>(null);
    const [busyId, setBusyId] = useState<string | null>(null);
    const [probes, setProbes] = useState<Record<string, ProbeResponse>>({});

    const [formId, setFormId] = useState('');
    const [formName, setFormName] = useState('');
    const [formUrl, setFormUrl] = useState('');
    const [formTrust, setFormTrust] = useState<TrustLevel>('unknown');
    const [formDescription, setFormDescription] = useState('');

    const { data, isLoading } = useQuery<EndpointsResponse>({
        queryKey: ['graph-federation'],
        queryFn: () => fetchJson('/api/graph/federation/endpoints'),
    });
    const endpoints = useMemo(() => data?.endpoints ?? [], [data]);
    const trustLevels = useMemo(
        () => data?.trustLevels ?? [{ level: 'unknown' as TrustLevel, label: 'unbekannt' }],
        [data],
    );

    const invalidate = () => queryClient.invalidateQueries({ queryKey: ['graph-federation'] });

    const resetForm = () => {
        setFormId('');
        setFormName('');
        setFormUrl('');
        setFormTrust('unknown');
        setFormDescription('');
    };

    const handleCreate = async () => {
        setCreating(true);
        try {
            const { endpoint } = await fetchJson<{ endpoint: EndpointView }>('/api/graph/federation/endpoints', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    id: formId.trim(),
                    name: formName.trim(),
                    url: formUrl.trim(),
                    trustLevel: formTrust,
                    ...(formDescription.trim() ? { description: formDescription.trim() } : {}),
                }),
            });
            setAdding(false);
            resetForm();
            invalidate();
            toast.success(`Endpoint „${endpoint.name}" registriert`);
            await handleProbe(endpoint);
        } catch (error) {
            toast.error(error instanceof Error ? error.message : 'Registrieren fehlgeschlagen');
        } finally {
            setCreating(false);
        }
    };

    const handleTrustChange = async (endpoint: EndpointView, trustLevel: TrustLevel) => {
        setBusyId(endpoint.id);
        try {
            await fetchJson(`/api/graph/federation/endpoints/${encodeURIComponent(endpoint.id)}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ trustLevel }),
            });
            toast.success(`„${endpoint.name}": Vertrauensstufe ist jetzt „${TRUST_TAG[trustLevel]}"`);
        } catch (error) {
            toast.error(error instanceof Error ? error.message : 'Änderung fehlgeschlagen');
        } finally {
            setBusyId(null);
            invalidate();
        }
    };

    const handleProbe = async (endpoint: EndpointView) => {
        setBusyId(endpoint.id);
        try {
            const probe = await fetchJson<ProbeResponse>(
                `/api/graph/federation/endpoints/${encodeURIComponent(endpoint.id)}/probe`,
                { method: 'POST' },
            );
            setProbes(current => ({ ...current, [endpoint.id]: probe }));
            if (probe.reachable) toast.success(`„${endpoint.name}": ${probe.message}`);
            else toast.error(`„${endpoint.name}" nicht erreichbar`);
        } catch (error) {
            toast.error(error instanceof Error ? error.message : 'Probe fehlgeschlagen');
        } finally {
            setBusyId(null);
        }
    };

    const handleDelete = async () => {
        if (!deleting) return;
        const target = deleting;
        setDeleting(null);
        try {
            await fetchJson(`/api/graph/federation/endpoints/${encodeURIComponent(target.id)}`, { method: 'DELETE' });
            toast.success(`Endpoint „${target.name}" entfernt`);
        } catch (error) {
            toast.error(error instanceof Error ? error.message : 'Löschen fehlgeschlagen');
        } finally {
            invalidate();
        }
    };

    const formReady = /^[a-z0-9][a-z0-9-]*$/i.test(formId.trim())
        && formName.trim() !== ''
        && formUrl.trim() !== '';

    return (
        <AppShell
            title="Föderation"
            actions={
                <FloatingActionButton
                    icon={<span style={{ fontSize: '24px' }}>+</span>}
                    onClick={() => { resetForm(); setAdding(true); }}
                    label="Neuer Endpoint"
                />
            }
        >
            <div className={styles.container}>
                <div className={styles.header}>
                    <h2>Föderation</h2>
                    <p>
                        Fremde SPARQL-Endpoints anfragen, ohne ihre Daten zu kopieren:{' '}
                        <code>SERVICE &lt;url&gt;</code> im{' '}
                        <Link className={styles.inlineLink} href="/graph/sparql">SPARQL-Editor</Link>{' '}
                        läuft ausschließlich gegen hier registrierte Endpoints. Ausgehende Aufrufe gehen über
                        denselben SSRF-Schutz wie Connector-Importe, mit Zeitbudget
                        {data ? ` (${Math.round(data.limits.timeoutMs / 1000)} s)` : ''} und Ergebnis-Limit
                        {data ? ` (${data.limits.maxRows} Zeilen)` : ''} — abgeschnitten wird nie, ein
                        überschrittenes Limit ist ein Fehler.
                    </p>
                    <p>
                        Die Vertrauensstufe entscheidet, was den Rechner verlässt:
                        <strong> unbekannt</strong> = gesperrt, <strong>bekannt</strong> = das entfernte Muster
                        wird eigenständig ausgewertet (keine lokale Bindung geht raus),
                        <strong> vertraut</strong> = Bound-Join, die lokalen Join-Schlüssel werden mitgeschickt.
                    </p>
                </div>

                <section className={styles.inbound} aria-labelledby="inbound-heading">
                    <h3 id="inbound-heading">Eingehende Föderation</h3>
                    <div className={styles.badges}>
                        <span className={`${styles.stateTag} ${data?.capabilities.outbound ? styles.stateOk : styles.stateNeutral}`}>
                            Ausgehend: {data?.capabilities.outbound ? 'verfügbar' : 'nicht verfügbar'}
                        </span>
                        <span className={`${styles.stateTag} ${data?.capabilities.inbound ? styles.stateOk : styles.stateNeutral}`}>
                            Eingehend: {data?.capabilities.inbound ? 'verfügbar' : 'nicht verfügbar'}
                        </span>
                    </div>
                    <p>
                        Fremde Workspaces fragen diesen Graphen unter <code>{data?.inboundEndpoint ?? '/api/graph/federation/sparql'}</code>{' '}
                        ab — read-only, ohne <code>SERVICE</code> (der Endpoint ist Quelle, kein Relais). Das
                        erlaubte Dataset wird aus dem Bearer-Token abgeleitet und in die Query injiziert;{' '}
                        <code>FROM</code>-Angaben des Aufrufers werden dabei überschrieben. Ohne gültiges Token
                        ist das Dataset leer — die Query läuft, sieht aber nichts. Zugänge werden wie beim
                        MCP-Server über <code>OW_MCP_TOKENS</code> vergeben (Recht <code>sparql</code>); die
                        Übersicht steht unter <Link className={styles.inlineLink} href="/tools">Werkzeuge</Link>.
                    </p>
                </section>

                {isLoading ? (
                    <p className={styles.loading}>Lade Endpoints…</p>
                ) : endpoints.length === 0 ? (
                    <div className={styles.empty}>
                        <Globe size={40} aria-hidden="true" />
                        <h3>Noch keine föderierten Endpoints</h3>
                        <p>
                            Registriere einen öffentlichen SPARQL-Endpoint — etwa Wikidata unter{' '}
                            <code>https://query.wikidata.org/sparql</code> — und hebe ihn auf
                            {' '}„bekannt&ldquo;, um ihn in <code>SERVICE</code>-Abfragen zu benutzen.
                        </p>
                        <Button variant="primary" onClick={() => { resetForm(); setAdding(true); }}>
                            Ersten Endpoint registrieren
                        </Button>
                    </div>
                ) : (
                    <ul className={styles.grid}>
                        {endpoints.map(endpoint => {
                            const probe = probes[endpoint.id];
                            const modified = formatTime(endpoint.modifiedAt);
                            return (
                                <li key={endpoint.id} className={styles.card}>
                                    <div className={styles.cardHead}>
                                        <strong className={styles.cardName}>{endpoint.name}</strong>
                                        <span className={`${styles.stateTag} ${endpoint.trustLevel === 'unknown' ? styles.stateNeutral : styles.stateOk}`}>
                                            {TRUST_TAG[endpoint.trustLevel]}
                                        </span>
                                    </div>
                                    <code className={styles.locator} title={endpoint.url}>{endpoint.url}</code>
                                    {endpoint.description && <p className={styles.description}>{endpoint.description}</p>}
                                    <label className={styles.field}>
                                        <span>Vertrauensstufe</span>
                                        <select
                                            value={endpoint.trustLevel}
                                            disabled={busyId !== null}
                                            onChange={event => handleTrustChange(endpoint, event.target.value as TrustLevel)}
                                        >
                                            {trustLevels.map(level => (
                                                <option key={level.level} value={level.level}>{level.label}</option>
                                            ))}
                                        </select>
                                    </label>
                                    {probe ? (
                                        <p className={styles.probeResult} data-reachable={probe.reachable}>
                                            {probe.reachable ? 'Erreichbar' : 'Nicht erreichbar'} — {probe.message}
                                        </p>
                                    ) : (
                                        <p className={styles.probeResult}>Noch nicht geprüft.</p>
                                    )}
                                    {modified && <p className={styles.trustHint}>Zuletzt geändert: {modified}</p>}
                                    <div className={styles.cardFooter}>
                                        <Button
                                            variant="secondary"
                                            size="sm"
                                            onClick={() => handleProbe(endpoint)}
                                            disabled={busyId !== null}
                                        >
                                            <RefreshCw size={14} aria-hidden="true" className={busyId === endpoint.id ? styles.spinning : undefined} />
                                            {busyId === endpoint.id ? 'Prüfe…' : 'Erreichbarkeit prüfen'}
                                        </Button>
                                        <button
                                            type="button"
                                            className={styles.deleteAction}
                                            onClick={() => setDeleting(endpoint)}
                                            title="Löschen"
                                            aria-label={`Endpoint ${endpoint.name} entfernen`}
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
                    <div className={styles.overlay} role="dialog" aria-modal="true" aria-label="Endpoint registrieren">
                        <div className={styles.dialog}>
                            <h3>Endpoint registrieren</h3>
                            <label className={styles.field}>
                                <span>Kurz-ID (Buchstaben, Ziffern, Bindestriche)</span>
                                <input value={formId} onChange={e => setFormId(e.target.value)} placeholder="wikidata" />
                            </label>
                            <label className={styles.field}>
                                <span>Name</span>
                                <input value={formName} onChange={e => setFormName(e.target.value)} placeholder="Wikidata" />
                            </label>
                            <label className={styles.field}>
                                <span>SPARQL-Endpoint-URL</span>
                                <input
                                    type="url"
                                    value={formUrl}
                                    onChange={e => setFormUrl(e.target.value)}
                                    placeholder="https://query.wikidata.org/sparql"
                                />
                            </label>
                            <label className={styles.field}>
                                <span>Vertrauensstufe</span>
                                <select value={formTrust} onChange={e => setFormTrust(e.target.value as TrustLevel)}>
                                    {trustLevels.map(level => (
                                        <option key={level.level} value={level.level}>{level.label}</option>
                                    ))}
                                </select>
                            </label>
                            <label className={styles.field}>
                                <span>Beschreibung (optional)</span>
                                <input
                                    value={formDescription}
                                    onChange={e => setFormDescription(e.target.value)}
                                    placeholder="Öffentlicher Endpoint der Wikimedia Foundation"
                                />
                            </label>
                            <div className={styles.dialogButtons}>
                                <Button variant="secondary" onClick={() => { setAdding(false); resetForm(); }}>Abbrechen</Button>
                                <Button variant="primary" onClick={handleCreate} disabled={creating || !formReady}>
                                    {creating ? 'Registriere…' : 'Registrieren und prüfen'}
                                </Button>
                            </div>
                        </div>
                    </div>
                )}

                <ConfirmDialog
                    isOpen={deleting !== null}
                    title="Endpoint entfernen?"
                    message={deleting
                        ? `„${deleting.name}" wird aus der Registry entfernt. Laufende SERVICE-Abfragen gegen diesen Endpoint werden danach abgelehnt; importierte Daten sind nicht betroffen (Föderation kopiert nichts).`
                        : ''}
                    confirmText="Entfernen"
                    variant="danger"
                    onConfirm={handleDelete}
                    onCancel={() => setDeleting(null)}
                />
            </div>
        </AppShell>
    );
}
