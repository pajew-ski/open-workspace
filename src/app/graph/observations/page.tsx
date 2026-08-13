'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Activity, AlertTriangle, Clock, Pause, Play, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { AppShell } from '@/components/layout';
import { Button, ConfirmDialog } from '@/components/ui';
import { useToast } from '@/components/ui/Toast';
import styles from './page.module.css';

/**
 * Beobachtungen: Messreihen dauerhaft erfassen (CAUSAL_LAYER_SPEC §6).
 *
 * Die Seite sagt zuerst, was auf dem Spiel steht: Home Assistants
 * Recorder hält vollständige Zustandswechsel nur wenige Tage. Was hier
 * nicht erfasst wird, ist danach unwiederbringlich weg — und zwar
 * ausgerechnet auf der Ursachenseite (Schalter, Fenster, Anwesenheit),
 * während numerische Sensoren in den Long-Term-Statistics überleben.
 *
 * Kandidaten kommen aus dem Graphen, nicht aus einem zweiten Abruf: Der
 * `home-assistant`-Connector hat die Struktur bereits materialisiert.
 * Aktoren stehen oben, weil sie die Treatment-Seite tragen.
 */

type ObservationKind = 'numeric' | 'binary' | 'categorical';
type Aggregation = 'last' | 'mean' | 'min' | 'max' | 'sum';

interface VariableView {
    id: string;
    iri: string;
    name: string;
    source: string;
    kind: ObservationKind;
    aggregation: Aggregation;
    intervalSeconds: number;
    unit?: string;
    enabled: boolean;
    retentionDays: number;
    status: {
        state: 'idle' | 'capturing' | 'error';
        capturedFrom?: string;
        capturedThrough?: string;
        count: number;
        lastRun?: { at: string; summary: string; errors: string[] };
    };
}

interface CaptureCandidate {
    iri: string;
    source: string;
    name: string;
    domain: string;
    kind: ObservationKind;
    unit?: string;
    placeName?: string;
    actuator: boolean;
    variableId?: string;
}

interface ScheduleStatus {
    active: boolean;
    intervalSeconds: number;
    running: boolean;
    lastRunAt?: string;
    lastMessage?: string;
    lastError?: string;
}

interface ObservationsResponse {
    variables: VariableView[];
    candidates: CaptureCandidate[];
    schedule: ScheduleStatus;
}

interface CaptureReport {
    results: Array<{ variableId: string; status: string; appended: number; message: string }>;
    message: string;
}

/** Wie viele Kandidaten ohne Filter gezeigt werden — eine HA-Installation hat Tausende. */
const CANDIDATE_LIMIT = 40;

const KIND_LABEL: Record<ObservationKind, string> = {
    numeric: 'numerisch',
    binary: 'zweiwertig',
    categorical: 'kategorial',
};

const AGGREGATION_LABEL: Record<Aggregation, string> = {
    last: 'letzter Wert',
    mean: 'Mittelwert',
    min: 'Minimum',
    max: 'Maximum',
    sum: 'Summe',
};

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
    const response = await fetch(url, init);
    const payload = await response.json().catch(() => null) as (T & { error?: string; details?: string }) | null;
    if (!response.ok) {
        const detail = payload?.details ? ` — ${payload.details}` : '';
        throw new Error(`${payload?.error ?? `HTTP ${response.status}`}${detail}`);
    }
    return payload as T;
}

function formatTime(iso: string | undefined): string | null {
    if (!iso) return null;
    const date = new Date(iso);
    return Number.isNaN(date.getTime())
        ? null
        : date.toLocaleString('de-DE', { dateStyle: 'medium', timeStyle: 'short' });
}

function formatInterval(seconds: number): string {
    if (seconds % 3600 === 0) return `${seconds / 3600} h`;
    if (seconds % 60 === 0) return `${seconds / 60} min`;
    return `${seconds} s`;
}

/** Abdeckung in Tagen — die ehrliche Grenze jeder späteren Auswertung. */
function coverageDays(variable: VariableView): number | null {
    if (!variable.status.capturedFrom || !variable.status.capturedThrough) return null;
    const from = Date.parse(variable.status.capturedFrom);
    const through = Date.parse(variable.status.capturedThrough);
    if (!Number.isFinite(from) || !Number.isFinite(through)) return null;
    return Math.max(0, Math.round((through - from) / 86_400_000));
}

export default function GraphObservationsPage() {
    const toast = useToast();
    const queryClient = useQueryClient();
    const [filter, setFilter] = useState('');
    const [busyId, setBusyId] = useState<string | null>(null);
    const [capturing, setCapturing] = useState(false);
    const [removing, setRemoving] = useState<VariableView | null>(null);

    const { data, isLoading } = useQuery<ObservationsResponse>({
        queryKey: ['graph-observations'],
        queryFn: () => fetchJson('/api/graph/observations'),
    });

    const variables = useMemo(() => data?.variables ?? [], [data]);
    const schedule = data?.schedule;

    const candidates = useMemo(() => {
        const all = (data?.candidates ?? []).filter(candidate => !candidate.variableId);
        const needle = filter.trim().toLowerCase();
        if (needle === '') return all;
        return all.filter(candidate =>
            candidate.name.toLowerCase().includes(needle) ||
            candidate.source.toLowerCase().includes(needle) ||
            (candidate.placeName ?? '').toLowerCase().includes(needle));
    }, [data, filter]);

    const invalidate = () => queryClient.invalidateQueries({ queryKey: ['graph-observations'] });

    const handleAdd = async (candidate: CaptureCandidate) => {
        setBusyId(candidate.source);
        try {
            await fetchJson('/api/graph/observations', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ source: candidate.source, intervalSeconds: 300 }),
            });
            toast.success(`„${candidate.name}" wird ab jetzt erfasst.`);
        } catch (error) {
            toast.error(error instanceof Error ? error.message : 'Aufnehmen fehlgeschlagen');
        } finally {
            setBusyId(null);
            invalidate();
        }
    };

    const handleToggle = async (variable: VariableView) => {
        setBusyId(variable.id);
        try {
            await fetchJson(`/api/graph/observations/${encodeURIComponent(variable.id)}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ enabled: !variable.enabled }),
            });
            toast.success(variable.enabled
                ? `„${variable.name}" pausiert. Der Bestand bleibt erhalten.`
                : `„${variable.name}" wird wieder erfasst.`);
        } catch (error) {
            toast.error(error instanceof Error ? error.message : 'Änderung fehlgeschlagen');
        } finally {
            setBusyId(null);
            invalidate();
        }
    };

    const handleCapture = async () => {
        setCapturing(true);
        try {
            const report = await fetchJson<CaptureReport>('/api/graph/observations/capture', { method: 'POST' });
            toast.success(report.message);
        } catch (error) {
            toast.error(error instanceof Error ? error.message : 'Erfassungslauf fehlgeschlagen');
        } finally {
            setCapturing(false);
            invalidate();
        }
    };

    const handleRemove = async () => {
        if (!removing) return;
        const target = removing;
        setRemoving(null);
        try {
            const result = await fetchJson<{ message: string }>(
                `/api/graph/observations/${encodeURIComponent(target.id)}`,
                { method: 'DELETE' },
            );
            toast.success(result.message);
        } catch (error) {
            toast.error(error instanceof Error ? error.message : 'Entfernen fehlgeschlagen');
        } finally {
            invalidate();
        }
    };

    return (
        <AppShell title="Beobachtungen">
            <div className={styles.container}>
                <div className={styles.header}>
                    <h2>Beobachtungen</h2>
                    <p>
                        Home Assistants Recorder hält vollständige Zustandswechsel nur wenige Tage
                        (<code>purge_keep_days</code>, Standard 10). Danach bleiben allein stündliche
                        Aggregate — und die auch nur für numerische Sensoren mit <code>state_class</code>.
                        Schalter, Fenster, Bewegung, Anwesenheit sind dann ersatzlos fort. Was hier
                        aufgenommen ist, wird dauerhaft behalten, verdichtet auf ein festes Raster.
                        Die Quellen kommen aus dem{' '}
                        <Link className={styles.inlineLink} href="/graph/connectors">Home-Assistant-Connector</Link>.
                    </p>
                </div>

                {schedule && (
                    <div className={styles.schedule}>
                        <Clock size={20} aria-hidden="true" />
                        <div className={styles.scheduleText}>
                            {schedule.active ? (
                                <>
                                    <strong>Erfassung läuft alle {formatInterval(schedule.intervalSeconds)}</strong>
                                    {schedule.lastRunAt
                                        ? `Zuletzt ${formatTime(schedule.lastRunAt)} — ${schedule.lastMessage ?? ''}`
                                        : 'Noch kein Lauf in diesem Prozess.'}
                                </>
                            ) : (
                                <>
                                    <strong className={styles.scheduleWarning}>Zeitgeber ist aus</strong>
                                    Ohne ihn wird nur auf Knopfdruck erfasst — und was Home Assistant
                                    inzwischen verwirft, ist weg. Einschalten über <code>OW_CAPTURE_INTERVAL</code>.
                                </>
                            )}
                            {schedule.lastError && (
                                <span className={styles.stateError}> Letzter Fehler: {schedule.lastError}</span>
                            )}
                        </div>
                        <Button
                            variant="primary"
                            onClick={handleCapture}
                            disabled={capturing || variables.length === 0}
                        >
                            <RefreshCw size={16} aria-hidden="true" />
                            {capturing ? 'Erfasse…' : 'Jetzt erfassen'}
                        </Button>
                    </div>
                )}

                <section className={styles.section}>
                    <h3>Erfasste Größen</h3>
                    {isLoading ? (
                        <p className={styles.loading}>Lade Beobachtungsgrößen…</p>
                    ) : variables.length === 0 ? (
                        <div className={styles.empty}>
                            <Activity size={40} aria-hidden="true" />
                            <h3>Noch nichts erfasst</h3>
                            <p>
                                Nimm unten zuerst die Quellen auf, die Home Assistant am schnellsten verwirft:
                                Schalter, Fenster- und Bewegungsmelder, Anwesenheit. Sie tragen später die
                                Ursachenseite — numerische Sensoren überleben ohnehin länger.
                            </p>
                        </div>
                    ) : (
                        <ul className={styles.list}>
                            {variables.map(variable => {
                                const days = coverageDays(variable);
                                const errors = variable.status.lastRun?.errors ?? [];
                                return (
                                    <li key={variable.id} className={styles.card}>
                                        <div className={styles.cardHead}>
                                            <h4 className={styles.cardTitle}>{variable.name}</h4>
                                            <span className={styles.source}>{variable.source}</span>
                                        </div>
                                        <div className={styles.badges}>
                                            <span className={styles.badge}>{KIND_LABEL[variable.kind]}</span>
                                            <span className={styles.badge}>{AGGREGATION_LABEL[variable.aggregation]}</span>
                                            <span className={styles.badge}>alle {formatInterval(variable.intervalSeconds)}</span>
                                            {variable.unit && <span className={styles.badge}>{variable.unit}</span>}
                                            <span className={styles.badge}>
                                                {variable.retentionDays === 0
                                                    ? 'unbegrenzt aufbewahrt'
                                                    : `${variable.retentionDays} Tage aufbewahrt`}
                                            </span>
                                            {!variable.enabled && <span className={styles.badge}>pausiert</span>}
                                        </div>
                                        <p className={styles.coverage}>
                                            <span className={
                                                variable.status.state === 'error' ? styles.stateError
                                                    : variable.status.count > 0 ? styles.stateOk
                                                    : styles.stateNeutral
                                            }>
                                                {variable.status.count.toLocaleString('de-DE')} Messpunkte
                                            </span>
                                            {days !== null && ` über ${days} Tage`}
                                            {variable.status.capturedFrom && ` (ab ${formatTime(variable.status.capturedFrom)})`}
                                            {variable.status.lastRun && ` · ${variable.status.lastRun.summary}`}
                                        </p>
                                        {errors.length > 0 && (
                                            <ul className={styles.errors}>
                                                {errors.map(message => <li key={message}>{message}</li>)}
                                            </ul>
                                        )}
                                        <div className={styles.actions}>
                                            <Button
                                                variant="secondary"
                                                onClick={() => handleToggle(variable)}
                                                disabled={busyId === variable.id}
                                            >
                                                {variable.enabled
                                                    ? <><Pause size={16} aria-hidden="true" />Pausieren</>
                                                    : <><Play size={16} aria-hidden="true" />Fortsetzen</>}
                                            </Button>
                                            <Button variant="ghost" onClick={() => setRemoving(variable)}>
                                                <Trash2 size={16} aria-hidden="true" />
                                                Entfernen
                                            </Button>
                                        </div>
                                    </li>
                                );
                            })}
                        </ul>
                    )}
                </section>

                <section className={styles.section}>
                    <h3>Verfügbare Quellen</h3>
                    <p className={styles.sectionHint}>
                        Aus dem Graphen, nicht aus einem zweiten Abruf — die Liste steht auch dann,
                        wenn Home Assistant gerade nicht erreichbar ist. Schaltbares zuerst: Es ist
                        das, was am schnellsten verloren geht.
                    </p>
                    <div className={styles.filterRow}>
                        <input
                            className={styles.filterInput}
                            type="search"
                            value={filter}
                            onChange={event => setFilter(event.target.value)}
                            placeholder="Nach Name, entity_id oder Raum filtern…"
                            aria-label="Quellen filtern"
                        />
                    </div>
                    {isLoading ? (
                        <p className={styles.loading}>Lade Quellen…</p>
                    ) : candidates.length === 0 ? (
                        <div className={styles.empty}>
                            <AlertTriangle size={32} aria-hidden="true" />
                            <p>
                                {filter.trim() === ''
                                    ? 'Keine Quellen im Graphen. Lege unter Graph → Quellen einen Connector der Art „Home Assistant" an und synchronisiere ihn.'
                                    : 'Kein Treffer für diesen Filter.'}
                            </p>
                        </div>
                    ) : (
                        <>
                            <ul className={styles.candidateList}>
                                {candidates.slice(0, CANDIDATE_LIMIT).map(candidate => (
                                    <li key={candidate.iri} className={styles.candidate}>
                                        <div className={styles.candidateText}>
                                            <span className={styles.candidateName}>{candidate.name}</span>
                                            <span className={styles.source}>{candidate.source}</span>
                                        </div>
                                        <div className={styles.badges}>
                                            {candidate.actuator && (
                                                <span className={`${styles.badge} ${styles.badgeTreatment}`}>schaltbar</span>
                                            )}
                                            <span className={styles.badge}>{KIND_LABEL[candidate.kind]}</span>
                                            {candidate.placeName && <span className={styles.badge}>{candidate.placeName}</span>}
                                        </div>
                                        <Button
                                            variant="secondary"
                                            onClick={() => handleAdd(candidate)}
                                            disabled={busyId === candidate.source}
                                        >
                                            <Plus size={16} aria-hidden="true" />
                                            Erfassen
                                        </Button>
                                    </li>
                                ))}
                            </ul>
                            {candidates.length > CANDIDATE_LIMIT && (
                                <p className={styles.moreHint}>
                                    {candidates.length - CANDIDATE_LIMIT} weitere — grenze die Liste mit dem Filter ein.
                                </p>
                            )}
                        </>
                    )}
                </section>
            </div>

            <ConfirmDialog
                isOpen={removing !== null}
                title="Beobachtungsgröße entfernen?"
                message={removing
                    ? `„${removing.name}" wird nicht mehr erfasst. Die bereits erfassten ` +
                      `${removing.status.count.toLocaleString('de-DE')} Messpunkte bleiben auf der Platte — ` +
                      'sie sind genau das, was Home Assistant nicht mehr hat.'
                    : ''}
                confirmText="Entfernen"
                onConfirm={handleRemove}
                onCancel={() => setRemoving(null)}
            />
        </AppShell>
    );
}
