'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ShieldCheck, Trash2, Users } from 'lucide-react';
import { AppShell } from '@/components/layout';
import { Button, ConfirmDialog, FloatingActionButton } from '@/components/ui';
import { useToast } from '@/components/ui/Toast';
import styles from './page.module.css';

/**
 * Zugriff und Freigaben (GRAPH_CORE_SPEC §17, M13).
 *
 * Die Seite zeigt genau das, was der angemeldete Nutzer wirklich hat —
 * keine Verwaltungs-Attrappe: Regeln erscheinen nur für Graphen, die er
 * verwalten darf, und ein Raum, den er nicht lesen darf, taucht gar nicht
 * auf. Rollen sind benannte Modus-Bündel; die Modi selbst bleiben
 * sichtbar, damit niemand raten muss, was „Beitragen" bedeutet.
 */

type AclMode = 'read' | 'append' | 'write' | 'control';

interface PrincipalRef {
    kind: 'user' | 'group' | 'authenticated' | 'public';
    id?: string;
}

interface GraphView {
    iri: string;
    label: string;
    modes: AclMode[];
}

interface AuthorizationView {
    id: string;
    graph: string;
    principal: PrincipalRef;
    modes: AclMode[];
    managed: boolean;
}

interface SpaceView {
    id: string;
    name: string;
    graph: string;
    owner: string;
    description?: string;
    manageable: boolean;
}

interface AccessResponse {
    identity: {
        userId: string;
        displayName: string | null;
        mode: string;
        authenticated: boolean;
        groups: string[];
        reason: string | null;
    };
    capabilities: { multiUser: boolean };
    graphs: GraphView[];
    authorizations: AuthorizationView[];
    users: Array<{ id: string; name: string }>;
    groups: Array<{ id: string; name: string; members: string[] }>;
    spaces: SpaceView[];
    modes: AclMode[];
    roles: Array<{ role: string; label: string; modes: AclMode[] }>;
}

const MODE_LABELS: Record<AclMode, string> = {
    read: 'Lesen',
    append: 'Beitragen',
    write: 'Bearbeiten',
    control: 'Verwalten',
};

const AUTH_MODE_LABELS: Record<string, string> = {
    'single-user': 'Einzelnutzer (kein Anmeldeverfahren)',
    'ha-ingress': 'Home Assistant (Ingress-Header)',
    'proxy-header': 'Vorgelagerter Proxy (OIDC)',
    'oidc-bearer': 'OIDC-Bearer-Token',
};

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
    const response = await fetch(url, init);
    const payload = await response.json().catch(() => null) as (T & { error?: string; details?: string }) | null;
    if (!response.ok) throw new Error(payload?.details ?? payload?.error ?? `HTTP ${response.status}`);
    return payload as T;
}

function principalLabel(principal: PrincipalRef): string {
    if (principal.kind === 'user') return `Nutzer ${principal.id}`;
    if (principal.kind === 'group') return `Gruppe ${principal.id}`;
    if (principal.kind === 'authenticated') return 'Alle angemeldeten Nutzer';
    return 'Öffentlich (auch anonym)';
}

export default function GraphAccessPage() {
    const toast = useToast();
    const queryClient = useQueryClient();
    const [creatingSpace, setCreatingSpace] = useState(false);
    const [busy, setBusy] = useState(false);
    const [deletingSpace, setDeletingSpace] = useState<SpaceView | null>(null);

    const [spaceId, setSpaceId] = useState('');
    const [spaceName, setSpaceName] = useState('');
    const [spaceDescription, setSpaceDescription] = useState('');

    const [ruleGraph, setRuleGraph] = useState('');
    const [ruleKind, setRuleKind] = useState<PrincipalRef['kind']>('user');
    const [ruleId, setRuleId] = useState('');
    const [ruleModes, setRuleModes] = useState<AclMode[]>(['read']);

    const { data, isLoading } = useQuery<AccessResponse>({
        queryKey: ['graph-access'],
        queryFn: () => fetchJson('/api/graph/access'),
    });

    const invalidate = () => queryClient.invalidateQueries({ queryKey: ['graph-access'] });

    const manageable = useMemo(
        () => (data?.graphs ?? []).filter(graph => graph.modes.includes('control')),
        [data],
    );

    const rulesByGraph = useMemo(() => {
        const map = new Map<string, AuthorizationView[]>();
        for (const rule of data?.authorizations ?? []) {
            map.set(rule.graph, [...(map.get(rule.graph) ?? []), rule]);
        }
        return map;
    }, [data]);

    const toggleMode = (mode: AclMode) => {
        setRuleModes(current => current.includes(mode)
            ? current.filter(entry => entry !== mode)
            : [...current, mode]);
    };

    const handleCreateSpace = async () => {
        setBusy(true);
        try {
            const { space } = await fetchJson<{ space: SpaceView }>('/api/graph/access/spaces', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    id: spaceId.trim(),
                    name: spaceName.trim(),
                    ...(spaceDescription.trim() ? { description: spaceDescription.trim() } : {}),
                }),
            });
            setCreatingSpace(false);
            setSpaceId('');
            setSpaceName('');
            setSpaceDescription('');
            toast.success(`Raum „${space.name}" angelegt`);
            invalidate();
        } catch (error) {
            toast.error(error instanceof Error ? error.message : 'Raum nicht angelegt');
        } finally {
            setBusy(false);
        }
    };

    const handleDeleteSpace = async () => {
        if (!deletingSpace) return;
        const target = deletingSpace;
        setDeletingSpace(null);
        try {
            await fetchJson(`/api/graph/access/spaces/${encodeURIComponent(target.id)}`, { method: 'DELETE' });
            toast.success(`Raum „${target.name}" aufgelöst`);
        } catch (error) {
            toast.error(error instanceof Error ? error.message : 'Raum nicht aufgelöst');
        } finally {
            invalidate();
        }
    };

    const handleAddRule = async () => {
        setBusy(true);
        try {
            const principal = ruleKind === 'user' || ruleKind === 'group'
                ? { kind: ruleKind, id: ruleId.trim() }
                : { kind: ruleKind };
            await fetchJson('/api/graph/access/authorizations', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ graph: ruleGraph, principal, modes: ruleModes }),
            });
            toast.success('Freigabe gesetzt');
            setRuleId('');
            invalidate();
        } catch (error) {
            toast.error(error instanceof Error ? error.message : 'Freigabe nicht gesetzt');
        } finally {
            setBusy(false);
        }
    };

    const handleDeleteRule = async (rule: AuthorizationView) => {
        try {
            await fetchJson(`/api/graph/access/authorizations/${encodeURIComponent(rule.id)}`, { method: 'DELETE' });
            toast.success('Freigabe entfernt');
        } catch (error) {
            toast.error(error instanceof Error ? error.message : 'Freigabe nicht entfernt');
        } finally {
            invalidate();
        }
    };

    const ruleReady = ruleGraph !== ''
        && ruleModes.length > 0
        && (ruleKind === 'authenticated' || ruleKind === 'public' || ruleId.trim() !== '');

    return (
        <AppShell
            title="Zugriff"
            actions={
                <FloatingActionButton
                    icon={<span style={{ fontSize: '24px' }}>+</span>}
                    onClick={() => setCreatingSpace(true)}
                    label="Neuer geteilter Raum"
                />
            }
        >
            <div className={styles.container}>
                <div className={styles.header}>
                    <h2>Zugriff und Freigaben</h2>
                    <p>
                        Rechte gelten <strong>pro Named Graph</strong> und liegen als Web-Access-Control-Regeln
                        in <code>graph/acl</code> — in derselben Welt wie die Daten, nicht in einer zweiten
                        Konfigurationsdatei. Per Default gehört jeder Graph nur seinem Eigentümer; nichts ist
                        ohne ausdrückliche Regel sichtbar.
                    </p>
                    <p>
                        Wer <strong>Verwalten</strong> auf einem Graphen hat, darf dessen Regeln ändern. Der
                        öffentliche Graph <code>public</code> ist ohne Anmeldung lesbar und föderierbar; alles
                        Übrige ist es nicht. Rohe Abfragen im{' '}
                        <Link className={styles.inlineLink} href="/graph/sparql">SPARQL-Editor</Link>{' '}
                        laufen durch dieselbe Klammer wie diese Seite.
                    </p>
                </div>

                <section className={styles.panel} aria-labelledby="identity-heading">
                    <h3 id="identity-heading"><ShieldCheck size={16} aria-hidden="true" /> Deine Identität</h3>
                    {isLoading || !data ? (
                        <p className={styles.loading}>Lade…</p>
                    ) : (
                        <>
                            <dl className={styles.definitions}>
                                <dt>Nutzer</dt>
                                <dd>{data.identity.displayName ?? (data.identity.userId || "anonym")}</dd>
                                <dt>Kennung</dt>
                                <dd><code>{data.identity.userId || '—'}</code></dd>
                                <dt>Verfahren</dt>
                                <dd>{AUTH_MODE_LABELS[data.identity.mode] ?? data.identity.mode}</dd>
                                <dt>Angemeldet</dt>
                                <dd>{data.identity.authenticated ? 'ja, geprüft' : 'nein'}</dd>
                                <dt>Gruppen</dt>
                                <dd>{data.identity.groups.length > 0 ? data.identity.groups.join(', ') : '—'}</dd>
                                <dt>Mehrbenutzerbetrieb</dt>
                                <dd>{data.capabilities.multiUser ? 'verfügbar' : 'in dieser Runtime nicht verfügbar'}</dd>
                            </dl>
                            {data.identity.reason && <p className={styles.hint}>{data.identity.reason}</p>}
                        </>
                    )}
                </section>

                <section className={styles.panel} aria-labelledby="graphs-heading">
                    <h3 id="graphs-heading">Sichtbare Graphen</h3>
                    {isLoading || !data ? (
                        <p className={styles.loading}>Lade…</p>
                    ) : data.graphs.length === 0 ? (
                        <p className={styles.hint}>
                            Für diese Identität ist kein Graph freigegeben. Das ist der Default — Rechte
                            vergibt, wer <strong>Verwalten</strong> auf dem jeweiligen Graphen hat.
                        </p>
                    ) : (
                        <ul className={styles.graphList}>
                            {data.graphs.map(graph => (
                                <li key={graph.iri} className={styles.graphRow}>
                                    <span className={styles.graphLabel}>{graph.label}</span>
                                    <span className={styles.modes}>
                                        {graph.modes.map(mode => (
                                            <span key={mode} className={styles.modeTag}>{MODE_LABELS[mode]}</span>
                                        ))}
                                    </span>
                                </li>
                            ))}
                        </ul>
                    )}
                </section>

                <section className={styles.panel} aria-labelledby="spaces-heading">
                    <h3 id="spaces-heading"><Users size={16} aria-hidden="true" /> Geteilte Räume</h3>
                    <p className={styles.hint}>
                        Ein Raum ist ein eigener Named Graph mit eigener Mitgliederliste. Die Mitgliedschaft
                        ist keine zweite Liste, sondern genau die Freigaben unten auf dem Raum-Graphen.
                    </p>
                    {data && data.spaces.length === 0 && (
                        <p className={styles.hint}>Noch kein Raum angelegt.</p>
                    )}
                    <ul className={styles.graphList}>
                        {(data?.spaces ?? []).map(space => (
                            <li key={space.id} className={styles.graphRow}>
                                <span className={styles.graphLabel}>
                                    {space.name} <code>{space.id}</code>
                                    {space.description && <em className={styles.description}>{space.description}</em>}
                                </span>
                                <span className={styles.modes}>
                                    <span className={styles.modeTag}>Eigentümer: {space.owner}</span>
                                    {space.manageable && (
                                        <button
                                            type="button"
                                            className={styles.deleteAction}
                                            onClick={() => setDeletingSpace(space)}
                                            aria-label={`Raum ${space.name} auflösen`}
                                        >
                                            <Trash2 size={15} aria-hidden="true" />
                                        </button>
                                    )}
                                </span>
                            </li>
                        ))}
                    </ul>
                </section>

                <section className={styles.panel} aria-labelledby="rules-heading">
                    <h3 id="rules-heading">Freigaben</h3>
                    {manageable.length === 0 ? (
                        <p className={styles.hint}>
                            Du verwaltest derzeit keinen Graphen — hier gibt es deshalb nichts zu setzen.
                        </p>
                    ) : (
                        <>
                            <div className={styles.ruleForm}>
                                <label className={styles.field}>
                                    <span>Graph</span>
                                    <select value={ruleGraph} onChange={event => setRuleGraph(event.target.value)}>
                                        <option value="">– auswählen –</option>
                                        {manageable.map(graph => (
                                            <option key={graph.iri} value={graph.iri}>{graph.label}</option>
                                        ))}
                                    </select>
                                </label>
                                <label className={styles.field}>
                                    <span>Für wen</span>
                                    <select
                                        value={ruleKind}
                                        onChange={event => setRuleKind(event.target.value as PrincipalRef['kind'])}
                                    >
                                        <option value="user">Nutzer</option>
                                        <option value="group">Gruppe</option>
                                        <option value="authenticated">Alle angemeldeten Nutzer</option>
                                        <option value="public">Öffentlich (auch anonym)</option>
                                    </select>
                                </label>
                                {(ruleKind === 'user' || ruleKind === 'group') && (
                                    <label className={styles.field}>
                                        <span>{ruleKind === 'user' ? 'Nutzer-Kennung' : 'Gruppen-Kennung'}</span>
                                        <input
                                            value={ruleId}
                                            onChange={event => setRuleId(event.target.value)}
                                            placeholder={ruleKind === 'user' ? 'alice' : 'team'}
                                            list={ruleKind === 'user' ? 'access-users' : 'access-groups'}
                                        />
                                    </label>
                                )}
                                <fieldset className={styles.modeChoice}>
                                    <legend>Rechte</legend>
                                    {(data?.modes ?? []).map(mode => (
                                        <label key={mode} className={styles.checkbox}>
                                            <input
                                                type="checkbox"
                                                checked={ruleModes.includes(mode)}
                                                onChange={() => toggleMode(mode)}
                                            />
                                            <span>{MODE_LABELS[mode]}</span>
                                        </label>
                                    ))}
                                </fieldset>
                                <Button variant="primary" onClick={handleAddRule} disabled={busy || !ruleReady}>
                                    Freigabe setzen
                                </Button>
                            </div>

                            <datalist id="access-users">
                                {(data?.users ?? []).map(user => <option key={user.id} value={user.id}>{user.name}</option>)}
                            </datalist>
                            <datalist id="access-groups">
                                {(data?.groups ?? []).map(group => <option key={group.id} value={group.id}>{group.name}</option>)}
                            </datalist>

                            {manageable.map(graph => {
                                const rules = rulesByGraph.get(graph.iri) ?? [];
                                return (
                                    <div key={graph.iri} className={styles.ruleGroup}>
                                        <h4>{graph.label}</h4>
                                        {rules.length === 0 ? (
                                            <p className={styles.hint}>Keine Regel — nur du siehst diesen Graphen.</p>
                                        ) : (
                                            <ul className={styles.graphList}>
                                                {rules.map(rule => (
                                                    <li key={rule.id} className={styles.graphRow}>
                                                        <span className={styles.graphLabel}>
                                                            {principalLabel(rule.principal)}
                                                            {rule.managed && <em className={styles.description}>Standardregel</em>}
                                                        </span>
                                                        <span className={styles.modes}>
                                                            {rule.modes.map(mode => (
                                                                <span key={mode} className={styles.modeTag}>{MODE_LABELS[mode]}</span>
                                                            ))}
                                                            <button
                                                                type="button"
                                                                className={styles.deleteAction}
                                                                onClick={() => handleDeleteRule(rule)}
                                                                aria-label={`Freigabe für ${principalLabel(rule.principal)} entfernen`}
                                                            >
                                                                <Trash2 size={15} aria-hidden="true" />
                                                            </button>
                                                        </span>
                                                    </li>
                                                ))}
                                            </ul>
                                        )}
                                    </div>
                                );
                            })}
                        </>
                    )}
                </section>

                {creatingSpace && (
                    <div className={styles.overlay} role="dialog" aria-modal="true" aria-label="Geteilten Raum anlegen">
                        <div className={styles.dialog}>
                            <h3>Geteilten Raum anlegen</h3>
                            <label className={styles.field}>
                                <span>Kurz-ID</span>
                                <input value={spaceId} onChange={event => setSpaceId(event.target.value)} placeholder="labor" />
                            </label>
                            <label className={styles.field}>
                                <span>Name</span>
                                <input value={spaceName} onChange={event => setSpaceName(event.target.value)} placeholder="Labor" />
                            </label>
                            <label className={styles.field}>
                                <span>Beschreibung (optional)</span>
                                <input
                                    value={spaceDescription}
                                    onChange={event => setSpaceDescription(event.target.value)}
                                    placeholder="Gemeinsame Notizen des Teams"
                                />
                            </label>
                            <div className={styles.dialogButtons}>
                                <Button variant="secondary" onClick={() => setCreatingSpace(false)}>Abbrechen</Button>
                                <Button
                                    variant="primary"
                                    onClick={handleCreateSpace}
                                    disabled={busy || spaceId.trim() === '' || spaceName.trim() === ''}
                                >
                                    Anlegen
                                </Button>
                            </div>
                        </div>
                    </div>
                )}

                <ConfirmDialog
                    isOpen={deletingSpace !== null}
                    title="Raum auflösen?"
                    message={deletingSpace
                        ? `„${deletingSpace.name}" wird entfernt: Inhalt des Raum-Graphen, die Raum-Entität und alle Freigaben darauf. Das lässt sich nicht rückgängig machen.`
                        : ''}
                    confirmText="Auflösen"
                    variant="danger"
                    onConfirm={handleDeleteSpace}
                    onCancel={() => setDeletingSpace(null)}
                />
            </div>
        </AppShell>
    );
}
