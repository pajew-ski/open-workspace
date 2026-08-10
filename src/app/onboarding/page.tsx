'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AppShell } from '@/components/layout';
import { Button, ConfirmDialog } from '@/components/ui';
import { useToast } from '@/components/ui/Toast';
import styles from './page.module.css';

/**
 * Einführungsstrecke (GRAPH_CORE_SPEC §18, M14).
 *
 * Kein Tutorial-Format: Jeder Knopf führt eine reale Aktion im echten
 * Graphen aus — abfragen, anlegen, importieren, vergleichen — und jede
 * lässt sich zurücknehmen. Der Fortschritt ist keine UI-Erinnerung,
 * sondern kommt als `ow:OnboardingStep` aus `graph/meta` zurück; wer die
 * Seite auf einem anderen Gerät öffnet, sieht denselben Stand.
 */

type StepId = 'self-model' | 'own-node' | 'import' | 'provenance';

interface StepState {
    id: StepId;
    title: string;
    description: string;
    effect: string;
    actionLabel: string;
    undoLabel: string;
    iri: string;
    done: boolean;
    completedAt: string | null;
    generated: string[];
    used: string[];
}

interface SelfModelModule {
    iri: string;
    id: string;
    label: string;
    description: string;
    route: string;
    entityTypes: string[];
}

interface SelfModelView {
    app: {
        iri: string;
        name: string;
        description: string;
        version: string;
        schemaVersion: string;
        runtime: string;
        capabilities: string[];
        connectorKinds: string[];
    } | null;
    modules: SelfModelModule[];
}

interface ProvenanceBucket {
    graph: string;
    scope: string;
    statements: number;
}

interface OnboardingState {
    steps: StepState[];
    selfModel: SelfModelView;
    provenance: {
        native: ProvenanceBucket[];
        imported: ProvenanceBucket[];
        inferred: ProvenanceBucket[];
    };
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
    const response = await fetch(url, init);
    const payload = await response.json().catch(() => null) as (T & { error?: string }) | null;
    if (!response.ok) throw new Error(payload?.error ?? `HTTP ${response.status}`);
    return payload as T;
}

function formatTime(iso: string | null): string | null {
    if (!iso) return null;
    const date = new Date(iso);
    return Number.isNaN(date.getTime()) ? null : date.toLocaleString('de-DE', { dateStyle: 'medium', timeStyle: 'short' });
}

function total(buckets: ProvenanceBucket[]): number {
    return buckets.reduce((sum, bucket) => sum + bucket.statements, 0);
}

export default function OnboardingPage() {
    const toast = useToast();
    const queryClient = useQueryClient();
    const [busy, setBusy] = useState<StepId | null>(null);
    const [undoing, setUndoing] = useState<StepState | null>(null);

    const { data, isLoading, error } = useQuery<OnboardingState>({
        queryKey: ['onboarding'],
        queryFn: () => fetchJson('/api/onboarding'),
    });

    const apply = (state: OnboardingState) => queryClient.setQueryData(['onboarding'], state);

    const handlePerform = async (step: StepState) => {
        setBusy(step.id);
        try {
            const state = await fetchJson<OnboardingState>('/api/onboarding', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ step: step.id }),
            });
            apply(state);
            toast.success(`„${step.title}" erledigt`);
        } catch (err) {
            toast.error(err instanceof Error ? err.message : 'Schritt fehlgeschlagen');
        } finally {
            setBusy(null);
        }
    };

    const handleUndo = async () => {
        const step = undoing;
        if (!step) return;
        setUndoing(null);
        setBusy(step.id);
        try {
            const state = await fetchJson<OnboardingState>(
                `/api/onboarding?step=${encodeURIComponent(step.id)}`,
                { method: 'DELETE' },
            );
            apply(state);
            toast.success(`„${step.title}" zurückgenommen`);
        } catch (err) {
            toast.error(err instanceof Error ? err.message : 'Zurücknehmen fehlgeschlagen');
        } finally {
            setBusy(null);
        }
    };

    const steps = data?.steps ?? [];
    const doneCount = steps.filter(step => step.done).length;
    const app = data?.selfModel.app ?? null;
    const provenance = data?.provenance ?? { native: [], imported: [], inferred: [] };

    return (
        <AppShell title="Einführung">
            <div className={styles.container}>
                <div className={styles.header}>
                    <h2>Einführung</h2>
                    <p>
                        Vier Schritte, die dir den Graphen an sich selbst erklären. Es gibt keinen
                        Übungsmodus: Jeder Schritt tut wirklich, was er sagt — und du kannst jeden
                        einzeln zurücknehmen.
                    </p>
                    {steps.length > 0 && (
                        <p className={styles.progress} aria-live="polite">
                            {doneCount} von {steps.length} Schritten erledigt
                        </p>
                    )}
                </div>

                {isLoading && <p className={styles.loading}>Wird geladen …</p>}
                {error && (
                    <p className={styles.error} role="alert">
                        Die Einführung ist nicht ladbar: {error instanceof Error ? error.message : 'unbekannter Fehler'}
                    </p>
                )}

                <ol className={styles.steps}>
                    {steps.map((step, index) => (
                        <li key={step.id} className={`${styles.step} ${step.done ? styles.stepDone : ''}`}>
                            <div className={styles.stepHead}>
                                <span className={styles.stepNumber} aria-hidden="true">{index + 1}</span>
                                <h3 className={styles.stepTitle}>{step.title}</h3>
                                {step.done && <span className={styles.badge}>erledigt</span>}
                            </div>
                            <p className={styles.stepText}>{step.description}</p>
                            <p className={styles.effect}>{step.effect}</p>

                            {step.id === 'self-model' && step.done && app && (
                                <dl className={styles.facts}>
                                    <div><dt>System</dt><dd>{app.name} {app.version}</dd></div>
                                    <div><dt>Runtime</dt><dd>{app.runtime}</dd></div>
                                    <div><dt>Schema-Version</dt><dd>{app.schemaVersion}</dd></div>
                                    <div>
                                        <dt>Aktive Fähigkeiten</dt>
                                        <dd>{app.capabilities.length > 0 ? app.capabilities.join(', ') : 'keine'}</dd>
                                    </div>
                                    <div>
                                        <dt>Module</dt>
                                        <dd>{data?.selfModel.modules.map(module => module.label).join(', ')}</dd>
                                    </div>
                                    <div>
                                        <dt>Einbindbare Quellen</dt>
                                        <dd>{app.connectorKinds.join(', ')}</dd>
                                    </div>
                                </dl>
                            )}

                            {step.id === 'provenance' && step.done && (
                                <dl className={styles.facts}>
                                    <div>
                                        <dt>Nativ (deine Graphen)</dt>
                                        <dd>{total(provenance.native)} Aussagen</dd>
                                    </div>
                                    <div>
                                        <dt>Importiert (Connector-Graphen)</dt>
                                        <dd>{total(provenance.imported)} Aussagen in {provenance.imported.length} Graph(en)</dd>
                                    </div>
                                    <div>
                                        <dt>Inferiert (nie behauptet)</dt>
                                        <dd>{total(provenance.inferred)} Aussagen in {provenance.inferred.length} Graph(en)</dd>
                                    </div>
                                </dl>
                            )}

                            {step.done && step.generated.length > 0 && (
                                <p className={styles.generated}>
                                    Dabei entstanden: {step.generated.map(iri => <code key={iri}>{iri}</code>)}
                                </p>
                            )}
                            {step.done && step.completedAt && (
                                <p className={styles.meta}>Ausgeführt am {formatTime(step.completedAt)}</p>
                            )}

                            <div className={styles.actions}>
                                {!step.done && (
                                    <Button
                                        onClick={() => handlePerform(step)}
                                        disabled={busy !== null}
                                    >
                                        {busy === step.id ? 'Läuft …' : step.actionLabel}
                                    </Button>
                                )}
                                {step.done && (
                                    <Button
                                        variant="secondary"
                                        onClick={() => setUndoing(step)}
                                        disabled={busy !== null}
                                    >
                                        {busy === step.id ? 'Läuft …' : step.undoLabel}
                                    </Button>
                                )}
                                {step.id === 'own-node' && step.done && (
                                    <Link className={styles.inlineLink} href="/docs">Zu den Dokumenten</Link>
                                )}
                                {step.id === 'import' && step.done && (
                                    <Link className={styles.inlineLink} href="/graph/connectors">Zu den Connectors</Link>
                                )}
                                {step.id === 'provenance' && step.done && (
                                    <Link className={styles.inlineLink} href="/graph">Im Graph-Explorer ansehen</Link>
                                )}
                            </div>
                        </li>
                    ))}
                </ol>
            </div>

            <ConfirmDialog
                isOpen={undoing !== null}
                title="Schritt zurücknehmen?"
                message={
                    undoing?.generated.length
                        ? `„${undoing.title}" wird zurückgenommen. Was dabei entstanden ist, wird gelöscht.`
                        : `„${undoing?.title ?? ''}" wird als nicht erledigt markiert. Es wurde nichts angelegt, also geht nichts verloren.`
                }
                confirmText="Zurücknehmen"
                variant="warning"
                onConfirm={handleUndo}
                onCancel={() => setUndoing(null)}
            />
        </AppShell>
    );
}
