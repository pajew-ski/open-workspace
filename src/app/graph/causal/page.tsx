'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Copy, GitBranch, Lightbulb, Plus, Sigma, Trash2 } from 'lucide-react';
import { AppShell } from '@/components/layout';
import { Button, ConfirmDialog } from '@/components/ui';
import { useToast } from '@/components/ui/Toast';
import {
    EDGE_CLASSES,
    type CausalEdgeView,
    type CausalModelView,
    type EdgeClass,
    type EvidenceLevel,
} from '@/lib/graph/causal/types';
import { identifyInModel } from '@/lib/graph/causal/view';
import { ESTIMATOR_LABEL, type EstimatorId } from '@/lib/graph/causal/estimate';
import { REFUTATION_LABEL, type RefutationMethod, type RefutationVerdict } from '@/lib/graph/causal/refute';
import { ESTIMATOR_CHOICES, STUDY_VERDICT_LABEL, type StudyVerdict } from '@/lib/graph/causal/study';
import { formatInterval } from '@/lib/graph/causal/panel';
import type { EstimandView } from '@/lib/graph/causal/estimand';
import type { StudyView } from '@/lib/graph/causal/study-graph';
import type { ArchiveEntryView } from '@/lib/graph/causal/archive';
import type { DagPath } from '@/lib/graph/causal/dsep';
import { HYPOTHESIS_FILTER_LABEL, HYPOTHESIS_VERDICT_LABEL } from '@/lib/graph/causal/filters';
import { PROPOSAL_SOURCE_LABEL } from '@/lib/graph/causal/propose';
import { ABSENT_SOURCES, STRUCTURE_SOURCE_LABEL, type Agreement, type StructureComparison } from '@/lib/graph/causal/compare';
import type { HypothesisView } from '@/lib/graph/causal/hypothesis';
import type { ProposalRunSummary } from '@/lib/graph/causal/propose.server';
import styles from './page.module.css';

/**
 * Kausalmodelle (CAUSAL_LAYER_SPEC §5/§7, Meilensteine C0 und C1).
 *
 * Die Seite zeigt Annahmen — und seit C1 auch, was aus ihnen folgt. Ein
 * Modell ist ein gerichteter Graph aus Variablen und kausalen Kanten, den
 * ein Mensch verantwortet (Invariante C1: „Struktur ist Annahme, nicht
 * Ergebnis"). Jede Kante trägt sichtbar ihre Herkunftsklasse, damit eine
 * Hypothese nie aussieht wie ein bestätigter Effekt (Invariante C2).
 *
 * **Die Identifikation rechnet hier, im Browser.** Der Tier-1-Kern
 * (`lib/graph/causal/{dag,dsep,identify}.ts`) ist pur — kein Store, kein
 * Netz, keine Route. Deshalb antwortet die Seite auf jede gezogene Kante
 * sofort, und deshalb läuft dieselbe Rechnung später auch in der Runtime
 * `local` (Invariante C9, `capabilities.causalTier`).
 *
 * **Seit C4 gibt es Zahlen** — und zwar nur unter Bedingungen. Eine Frage
 * (`ow:Estimand`) bleibt beim Modell; ihr Ergebnis entsteht im Lauf und
 * steht nie ohne den DAG, aus dem es folgt (Invariante C1). Ein Effekt
 * erscheint ausschließlich mit Konfidenzintervall und bestandener
 * Refutation (Invariante C5); ein durchgefallener Versuch wird als
 * durchgefallen angezeigt und nicht als kleinerer Effekt.
 *
 * **Seit C6 schlagen Quellen vor** — und keine davon schreibt ins Modell.
 * Sprachmodell, Geräte&shy;topologie und Wikidata liefern Kandidatenkanten
 * und vor allem Störgrößen nach `causal-hypotheses`; die symbolischen
 * Filter urteilen davor, und übernehmen tut ein Mensch. Ein verworfener
 * Vorschlag bleibt sichtbar samt Grund: Zu wissen, dass eine Quelle etwas
 * Unmögliches gesagt hat, ist mehr wert als eine aufgeräumte Liste.
 *
 * Was hier weiterhin FEHLT: Struktur-Lernen aus Daten (C8) und
 * randomisierte Eingriffe über Aktoren (C7). Beide brauchen eine
 * ausdrückliche Freigabe und erscheinen deshalb nirgends — der
 * Quellenvergleich benennt das Struktur-Lernen als fehlende Stimme,
 * statt so zu tun, als seien alle Quellen befragt.
 */

interface ObservedVariable {
    iri: string;
    name: string;
    unit?: string;
    count: number;
    enabled: boolean;
    /** Abtastabstand der Reihe in Sekunden (Erfassungsregel, C3). */
    intervalSeconds: number;
    /** Raster der aus Aggregaten nachgefüllten Strecke, falls es eine gibt. */
    aggregateIntervalSeconds?: number;
}

interface ValidationResult {
    focusNode?: string;
    path?: string;
    message: string;
    severity: string;
    sourceShape?: string;
}

interface CausalResponse {
    models: CausalModelView[];
    /** Vorschläge samt Herkunft und Urteil der Filter (§8, C6). */
    hypotheses: HypothesisView[];
    /** Was die Quellen zusammen sagen — je Modell (§8 Rückkopplung). */
    comparisons: Array<{ modelId: string; entries: StructureComparison[] }>;
    hypothesesGraph: string;
    observedVariables: ObservedVariable[];
    estimands: EstimandView[];
    studies: StudyView[];
    /** Chronik: was dieselbe Frage früher gesagt hat (Widerspruch 3). */
    archive: ArchiveEntryView[];
    causalTier: 'none' | 'graph' | 'full';
    validation: { conforms: boolean; graphs: string[]; results: ValidationResult[] };
}

interface RunResponse {
    generatedAt: string;
    durationMs: number;
    counts: {
        total: number;
        passed: number;
        refuted: number;
        notEstimable: number;
        notIdentifiable: number;
    };
    skipped: Array<{ estimandId: string; reason: string }>;
    rejected: Array<{ estimandId: string; messages: string[] }>;
}

const AGREEMENT_LABEL: Record<Agreement, string> = {
    contradiction: 'Widerspruch',
    agreed: 'Mehrere Quellen einig',
    single: 'Eine Stimme',
};

const VERDICT_HINT: Record<StudyVerdict, string> = {
    passed: 'Geschätzt und allen blockierenden Falsifikationsversuchen standgehalten.',
    refuted: 'Geschätzt und durchgefallen — der Wert wird nicht ausgegeben (Invariante C5).',
    'not-estimable': 'Identifizierbar, aber die Datenlage trägt keine Schätzung.',
    'not-identifiable': 'Der DAG oder die Erfassung geben die Frage nicht her.',
};

const REFUTATION_VERDICT_LABEL: Record<RefutationVerdict, string> = {
    passed: 'bestanden',
    failed: 'durchgefallen',
    inconclusive: 'nicht prüfbar',
    informative: 'Kennzahl',
};

/** Zahlen deutsch und knapp — drei Nachkommastellen reichen für einen Effekt. */
function num(value: number, digits = 3): string {
    return value.toLocaleString('de-DE', { maximumFractionDigits: digits });
}

const EDGE_CLASS_LABEL: Record<EdgeClass, string> = {
    hypothesis: 'Hypothese',
    structural: 'strukturell',
    learned: 'gelernt',
    asserted: 'gesetzt',
};

const EDGE_CLASS_HINT: Record<EdgeClass, string> = {
    hypothesis: 'Vorschlag aus Text oder Modell — keine Evidenz.',
    structural: 'Aus Geräte-Topologie oder Physik abgeleitet.',
    learned: 'Aus Daten gelernte Struktur.',
    asserted: 'Von Hand gesetzt.',
};

const EVIDENCE_LABEL: Record<EvidenceLevel, string> = {
    hypothesis: 'unbelegt',
    estimated: 'geschätzt',
    'refuted-clean': 'refutiert bestanden',
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

/** `PT15M` → „15 min"; Unbekanntes bleibt, wie es im Graphen steht. */
function formatLag(value: string): string {
    const match = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(value);
    if (!match) return value;
    const parts = [
        match[1] ? `${match[1]} d` : '',
        match[2] ? `${match[2]} h` : '',
        match[3] ? `${match[3]} min` : '',
        match[4] ? `${match[4]} s` : '',
    ].filter(Boolean);
    return parts.length > 0 ? parts.join(' ') : value;
}

function shortName(model: CausalModelView, iri: string): string {
    return model.variables.find(variable => variable.iri === iri)?.name
        ?? decodeURIComponent(iri.split('/').filter(Boolean).pop() ?? iri);
}

/**
 * Ebenen für die Darstellung. Die Zahl wird nur zum Zeichnen gebraucht und
 * liegt deshalb nirgends im Graphen (Invariante 2). Die Iterationsgrenze
 * macht das Verfahren auch bei einem zyklisch modellierten Graphen
 * endlich; ob ein Modell azyklisch IST, entscheidet der Tier-1-Kern.
 */
function layerOf(variables: readonly string[], edges: readonly CausalEdgeView[]): Map<string, number> {
    const layers = new Map(variables.map(iri => [iri, 0]));
    for (let round = 0; round < variables.length; round += 1) {
        let changed = false;
        for (const edge of edges) {
            const from = layers.get(edge.from);
            const to = layers.get(edge.to);
            if (from === undefined || to === undefined) continue;
            if (from + 1 > to && from + 1 <= variables.length) {
                layers.set(edge.to, from + 1);
                changed = true;
            }
        }
        if (!changed) break;
    }
    return layers;
}

const NODE_WIDTH = 148;
const NODE_HEIGHT = 44;
const COLUMN_GAP = 72;
const ROW_GAP = 20;

function DagDiagram({ model, highlight }: { model: CausalModelView; highlight: ReadonlySet<string> }) {
    const nodes = model.variables.map(variable => variable.iri);
    const layers = useMemo(() => layerOf(nodes, model.edges), [nodes, model.edges]);
    const columns = new Map<number, string[]>();
    for (const iri of nodes) {
        const layer = layers.get(iri) ?? 0;
        columns.set(layer, [...(columns.get(layer) ?? []), iri]);
    }
    const positions = new Map<string, { x: number; y: number }>();
    for (const [layer, members] of columns) {
        members.forEach((iri, index) => {
            positions.set(iri, {
                x: layer * (NODE_WIDTH + COLUMN_GAP),
                y: index * (NODE_HEIGHT + ROW_GAP),
            });
        });
    }
    const width = (Math.max(...columns.keys(), 0) + 1) * (NODE_WIDTH + COLUMN_GAP) - COLUMN_GAP;
    const rows = Math.max(...[...columns.values()].map(members => members.length), 1);
    const height = rows * (NODE_HEIGHT + ROW_GAP) - ROW_GAP;
    // Eine Kante, die eine Ebene überspringt, liefe quer durch den Knoten
    // dazwischen und wäre unsichtbar — sie bekommt einen Bogen unterhalb
    // des Bildes. Genau solche Kanten sind die interessanten (der direkte
    // Weg NEBEN dem Zwischenschritt), also dürfen sie nicht verschwinden.
    const skipping = model.edges.some(edge =>
        Math.abs((layers.get(edge.to) ?? 0) - (layers.get(edge.from) ?? 0)) > 1);
    const bowY = height + 24;
    const canvasHeight = skipping ? bowY + 8 : height;

    return (
        <div className={styles.diagramScroll}>
            <svg
                className={styles.diagram}
                viewBox={`-2 -2 ${width + 4} ${canvasHeight + 4}`}
                width={width + 4}
                height={canvasHeight + 4}
                role="img"
                aria-label={
                    `Kausalmodell ${model.name}: ${model.variables.length} Variablen, ` +
                    `${model.edges.length} Kanten. Dieselben Kanten stehen darunter als Liste.`
                }
            >
                <defs>
                    <marker id="ow-causal-arrow" viewBox="0 0 10 10" refX="9" refY="5"
                        markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                        <path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor" />
                    </marker>
                </defs>
                {model.edges.map(edge => {
                    const from = positions.get(edge.from);
                    const to = positions.get(edge.to);
                    if (!from || !to) return null;
                    const x1 = from.x + NODE_WIDTH;
                    const y1 = from.y + NODE_HEIGHT / 2;
                    const x2 = to.x;
                    const y2 = to.y + NODE_HEIGHT / 2;
                    const mid = (x1 + x2) / 2;
                    const skips = Math.abs(
                        (layers.get(edge.to) ?? 0) - (layers.get(edge.from) ?? 0)) > 1;
                    const d = skips
                        ? `M ${x1} ${y1} C ${mid} ${bowY}, ${mid} ${bowY}, ${x2} ${y2}`
                        : `M ${x1} ${y1} C ${mid} ${y1}, ${mid} ${y2}, ${x2} ${y2}`;
                    return (
                        <path
                            key={`${edge.from}->${edge.to}`}
                            className={`${styles.edge} ${edge.edgeClass === 'hypothesis' ? styles.edgeHypothesis : ''}`}
                            d={d}
                            markerEnd="url(#ow-causal-arrow)"
                            fill="none"
                        />
                    );
                })}
                {nodes.map(iri => {
                    const position = positions.get(iri);
                    if (!position) return null;
                    const label = shortName(model, iri);
                    return (
                        <g key={iri} transform={`translate(${position.x} ${position.y})`}>
                            <rect
                                className={`${styles.node} ${highlight.has(iri) ? styles.nodeAdjusted : ''}`}
                                width={NODE_WIDTH}
                                height={NODE_HEIGHT}
                                rx="8"
                            />
                            <text className={styles.nodeLabel} x={NODE_WIDTH / 2} y={NODE_HEIGHT / 2 + 4}>
                                {label.length > 18 ? `${label.slice(0, 17)}…` : label}
                            </text>
                        </g>
                    );
                })}
            </svg>
        </div>
    );
}

/** Vorlage für den SPARQL-Editor — derselbe Schreibweg, nur von Hand. */
function updateTemplate(model: CausalModelView): string {
    const base = model.iri.slice(0, model.iri.lastIndexOf('/causal-model/'));
    const ursache = `${base}/variable/beispiel-ursache`;
    const wirkung = `${base}/variable/beispiel-wirkung`;
    const reifier = `${base}/link/causal/${model.id}/beispiel-ursache/beispiel-wirkung`;
    return [
        'PREFIX ow: <https://pajew-ski.github.io/open-workspace/ns/v1#>',
        'PREFIX obo: <http://purl.obolibrary.org/obo/>',
        'PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>',
        'PREFIX schema: <https://schema.org/>',
        'PREFIX xsd: <http://www.w3.org/2001/XMLSchema#>',
        '',
        'INSERT DATA {',
        `  GRAPH <${model.graph}> {`,
        `    <${model.iri}> schema:hasPart <${ursache}>, <${wirkung}> .`,
        `    <${ursache}> a ow:Variable ; schema:name "Beispiel: Ursache" .`,
        `    <${wirkung}> a ow:Variable ; schema:name "Beispiel: Wirkung" .`,
        '',
        '    # Die Kante selbst ist fremdes Vokabular: RO_0002411 "causally upstream of".',
        `    <${ursache}> obo:RO_0002411 <${wirkung}> .`,
        '',
        '    # Alles ÜBER die Kante hängt am benannten Reifier (RDF 1.2).',
        `    <${reifier}> rdf:reifies <<( <${ursache}> obo:RO_0002411 <${wirkung}> )>> ;`,
        '        ow:edgeClass "asserted" ;',
        '        ow:evidenceLevel "hypothesis" ;',
        '        ow:temporalLag "PT15M"^^xsd:duration .',
        '  }',
        '}',
    ].join('\n');
}

function EdgeBadges({ edge }: { edge: CausalEdgeView }) {
    return (
        <div className={styles.badges}>
            {edge.edgeClass ? (
                <span
                    className={`${styles.badge} ${edge.edgeClass === 'hypothesis' ? styles.badgeHypothesis : styles.badgeClass}`}
                    title={EDGE_CLASS_HINT[edge.edgeClass]}
                >
                    {EDGE_CLASS_LABEL[edge.edgeClass]}
                </span>
            ) : (
                <span className={`${styles.badge} ${styles.badgeMissing}`}>
                    {edge.edgeClassRaw ? `unbekannte Klasse: ${edge.edgeClassRaw}` : 'ohne Herkunftsklasse'}
                </span>
            )}
            <span className={`${styles.badge} ${edge.studyEvidence ? styles.badgePassed : ''}`}>
                {edge.studyEvidence
                    ? EVIDENCE_LABEL[edge.studyEvidence]
                    : edge.evidenceLevel
                        ? EVIDENCE_LABEL[edge.evidenceLevel]
                        : edge.evidenceLevelRaw ?? 'unbelegt'}
            </span>
            {edge.temporalLag && <span className={styles.badge}>Versatz {formatLag(edge.temporalLag)}</span>}
            {edge.effect && (
                <span className={`${styles.badge} ${styles.badgePassed}`}>
                    Effekt {num(edge.effect.value)}
                    {edge.effect.unit ? ` ${edge.effect.unit}` : ''}
                    {' '}[{num(edge.effect.ciLow)}; {num(edge.effect.ciHigh)}]
                </span>
            )}
        </div>
    );
}

/** `X ← U → Y`: die Richtung jedes Schritts, damit ein Pfad lesbar ist. */
function pathText(model: CausalModelView, path: DagPath): string {
    return path.nodes
        .map((node, index) => {
            const name = shortName(model, node);
            if (index === 0) return name;
            return `${path.forward[index - 1] ? '→' : '←'} ${name}`;
        })
        .join(' ');
}

interface EditorProps {
    model: CausalModelView;
    observedVariables: readonly ObservedVariable[];
    onOperation(operation: Record<string, unknown>): Promise<void>;
    busy: boolean;
}

/**
 * Der DAG-Editor. Er kommt bewusst erst mit C1 und nicht früher: Erst mit
 * Azyklizität, Identifizierbarkeit und Adjustment Sets antwortet er auf
 * jede gezogene Kante, statt nur zeichnen zu lassen.
 */
function StructureEditor({ model, observedVariables, onOperation, busy }: EditorProps) {
    const inModel = new Set(model.variables.map(variable => variable.iri));
    const offered = observedVariables.filter(variable => !inModel.has(variable.iri));
    const [pick, setPick] = useState('');
    const [freeName, setFreeName] = useState('');
    const [from, setFrom] = useState('');
    const [to, setTo] = useState('');
    const [edgeClass, setEdgeClass] = useState<EdgeClass>('asserted');
    const [lag, setLag] = useState('');

    const addVariable = async (event: React.FormEvent) => {
        event.preventDefault();
        if (pick === '' && freeName.trim() === '') return;
        await onOperation(pick !== ''
            ? { op: 'add-variable', iri: pick }
            : { op: 'add-variable', name: freeName.trim() });
        setPick('');
        setFreeName('');
    };

    const addEdge = async (event: React.FormEvent) => {
        event.preventDefault();
        if (from === '' || to === '') return;
        await onOperation({
            op: 'add-edge',
            from,
            to,
            edgeClass,
            ...(lag.trim() !== '' ? { temporalLag: lag.trim() } : {}),
        });
        setLag('');
    };

    return (
        <div className={styles.editor}>
            <form className={styles.editorForm} onSubmit={addVariable}>
                <h5 className={styles.editorTitle}>Variable aufnehmen</h5>
                <div className={styles.editorRow}>
                    <label className={styles.field}>
                        <span className={styles.fieldLabel}>Erfasste Größe</span>
                        <select
                            className={styles.input}
                            value={pick}
                            onChange={event => setPick(event.target.value)}
                        >
                            <option value="">— auswählen —</option>
                            {offered.map(variable => (
                                <option key={variable.iri} value={variable.iri}>
                                    {variable.name}
                                    {variable.unit ? ` (${variable.unit})` : ''}
                                </option>
                            ))}
                        </select>
                    </label>
                    <label className={styles.field}>
                        <span className={styles.fieldLabel}>Oder neue Modellvariable</span>
                        <input
                            className={styles.input}
                            value={freeName}
                            onChange={event => setFreeName(event.target.value)}
                            placeholder="Außentemperatur"
                            maxLength={200}
                        />
                    </label>
                    <Button type="submit" variant="secondary" disabled={busy}>
                        <Plus size={16} aria-hidden="true" />
                        Aufnehmen
                    </Button>
                </div>
                <p className={styles.editorHint}>
                    Nur eine <strong>erfasste</strong> Größe lässt sich später adjustieren oder
                    schätzen. Eine reine Modellvariable ist trotzdem sinnvoll: Sie macht sichtbar,
                    was fehlt — die Identifikation nennt sie dann beim Namen.
                </p>
            </form>

            <form className={styles.editorForm} onSubmit={addEdge}>
                <h5 className={styles.editorTitle}>Kante ziehen</h5>
                <div className={styles.editorRow}>
                    <label className={styles.field}>
                        <span className={styles.fieldLabel}>Ursache</span>
                        <select className={styles.input} value={from} onChange={event => setFrom(event.target.value)}>
                            <option value="">— auswählen —</option>
                            {model.variables.map(variable => (
                                <option key={variable.iri} value={variable.iri}>{variable.name}</option>
                            ))}
                        </select>
                    </label>
                    <label className={styles.field}>
                        <span className={styles.fieldLabel}>Wirkung</span>
                        <select className={styles.input} value={to} onChange={event => setTo(event.target.value)}>
                            <option value="">— auswählen —</option>
                            {model.variables.map(variable => (
                                <option key={variable.iri} value={variable.iri}>{variable.name}</option>
                            ))}
                        </select>
                    </label>
                    <label className={styles.field}>
                        <span className={styles.fieldLabel}>Herkunft</span>
                        <select
                            className={styles.input}
                            value={edgeClass}
                            onChange={event => setEdgeClass(event.target.value as EdgeClass)}
                        >
                            {EDGE_CLASSES.map(value => (
                                <option key={value} value={value}>{EDGE_CLASS_LABEL[value]}</option>
                            ))}
                        </select>
                    </label>
                    <label className={styles.field}>
                        <span className={styles.fieldLabel}>Zeitversatz (optional)</span>
                        <input
                            className={styles.input}
                            value={lag}
                            onChange={event => setLag(event.target.value)}
                            placeholder="PT15M"
                            maxLength={40}
                        />
                    </label>
                    <Button type="submit" variant="secondary" disabled={busy}>
                        <Plus size={16} aria-hidden="true" />
                        Verbinden
                    </Button>
                </div>
                <p className={styles.editorHint}>
                    Eine Kante sagt: <em>die Ursache wirkt auf die Wirkung</em>. Sie wird abgelehnt,
                    wenn sie einen Kreis schließt — in einem Kreis ist keine Aussage über
                    Identifizierbarkeit mehr möglich. Der Zeitversatz ist eine ISO-8601-Dauer
                    (<code>PT15M</code> = 15 Minuten).
                </p>
            </form>
        </div>
    );
}

interface IdentificationProps {
    model: CausalModelView;
    exposure: string;
    outcome: string;
    onExposure(value: string): void;
    onOutcome(value: string): void;
    result: ReturnType<typeof identifyInModel> | null;
}

function IdentificationPanel({ model, exposure, outcome, onExposure, onOutcome, result }: IdentificationProps) {
    const setExposure = onExposure;
    const setOutcome = onOutcome;
    const observed = result?.observed ?? null;
    const structural = result?.structural ?? null;
    const names = (nodes: readonly string[]) =>
        nodes.length === 0 ? 'nichts (keine Adjustierung nötig)' : nodes.map(node => shortName(model, node)).join(', ');

    return (
        <div className={styles.identify}>
            <h5 className={styles.editorTitle}>Identifikation</h5>
            <div className={styles.editorRow}>
                <label className={styles.field}>
                    <span className={styles.fieldLabel}>Wirkung von</span>
                    <select
                        className={styles.input}
                        value={exposure}
                        onChange={event => setExposure(event.target.value)}
                    >
                        <option value="">— auswählen —</option>
                        {model.variables.map(variable => (
                            <option key={variable.iri} value={variable.iri}>{variable.name}</option>
                        ))}
                    </select>
                </label>
                <label className={styles.field}>
                    <span className={styles.fieldLabel}>auf</span>
                    <select className={styles.input} value={outcome} onChange={event => setOutcome(event.target.value)}>
                        <option value="">— auswählen —</option>
                        {model.variables.map(variable => (
                            <option key={variable.iri} value={variable.iri}>{variable.name}</option>
                        ))}
                    </select>
                </label>
            </div>

            {!observed ? (
                <p className={styles.editorHint}>
                    Wähl eine Ursache und eine Wirkung. Die Antwort sagt, ob der Effekt aus
                    Beobachtungsdaten überhaupt bestimmbar wäre — und worüber dafür adjustiert
                    werden müsste. Eine <strong>Zahl</strong> ist das nicht; geschätzt wird nichts.
                </p>
            ) : (
                <div className={styles.verdict} role="status">
                    <p className={observed.identifiable ? styles.verdictYes : styles.verdictNo}>
                        {observed.identifiable
                            ? observed.zeroEffect ? 'Kein Wirkweg im Modell' : 'Identifizierbar'
                            : 'Nicht identifizierbar'}
                    </p>
                    <p className={styles.verdictReason}>{observed.reason}</p>

                    {observed.adjustmentSets.length > 0 && (
                        <ul className={styles.verdictList}>
                            {observed.adjustmentSets.map(set => (
                                <li key={set.join('|') || 'leer'}>
                                    Adjustieren über: {names(set)}
                                    {!observed.adjustmentSetsMinimal && ' (kanonische Menge, nicht minimal)'}
                                </li>
                            ))}
                        </ul>
                    )}
                    {observed.frontdoorSets.length > 0 && (
                        <ul className={styles.verdictList}>
                            {observed.frontdoorSets.map(set => (
                                <li key={set.join('|')}>Wirkweg (Frontdoor) über: {names(set)}</li>
                            ))}
                        </ul>
                    )}
                    {observed.instruments.length > 0 && (
                        <ul className={styles.verdictList}>
                            {observed.instruments.map(instrument => (
                                <li key={instrument.node}>
                                    Instrument: {shortName(model, instrument.node)}
                                    {instrument.given.length > 0 ? ` (gegeben ${names(instrument.given)})` : ''}
                                </li>
                            ))}
                        </ul>
                    )}
                    {observed.openBackdoorPaths.length > 0 && (
                        <>
                            <p className={styles.verdictSub}>Offene Wege ohne Adjustierung:</p>
                            <ul className={styles.verdictList}>
                                {observed.openBackdoorPaths.map(path => (
                                    <li key={path.nodes.join('|')} className={styles.pathText}>
                                        {pathText(model, path)}
                                    </li>
                                ))}
                            </ul>
                        </>
                    )}
                    {structural?.identifiable && !observed.identifiable && (
                        <p className={styles.verdictSub}>
                            Die <strong>Struktur</strong> gäbe eine Antwort her — es fehlt die Erfassung.
                            Sobald {names(observed.missingVariables)} unter{' '}
                            <Link className={styles.inlineLink} href="/graph/observations">Beobachtungen</Link>{' '}
                            erfasst wird, ist der Effekt identifizierbar.
                        </p>
                    )}
                    {observed.truncated && (
                        <p className={styles.verdictSub}>
                            Die Suche wurde gedeckelt — es kann weitere zulässige Mengen geben, als hier stehen.
                        </p>
                    )}
                </div>
            )}
        </div>
    );
}

interface StudiesProps {
    model: CausalModelView;
    estimands: readonly EstimandView[];
    studies: readonly StudyView[];
    archive: readonly ArchiveEntryView[];
    observedVariables: readonly ObservedVariable[];
    busy: boolean;
    onAsk(input: Record<string, unknown>): Promise<void>;
    onRemove(estimandId: string): Promise<void>;
    onDiscardArchive(entryId: string): Promise<void>;
}

/**
 * Auswahl fürs Rechenraster. „Automatisch" ist der Normalfall — dann
 * nimmt das Panel den gröbsten Abstand der beteiligten Reihen. Gesetzt
 * wird es für die aus Stundenaggregaten nachgefüllte Strecke (§15.5):
 * Dort trägt eine Fünf-Minuten-Reihe nur die vollen Stunden bei, und auf
 * ihrem eigenen Raster fallen elf von zwölf Zeilen als Lücke heraus.
 */
const INTERVAL_CHOICES: ReadonlyArray<{ value: number; label: string }> = [
    { value: 300, label: '5 min' },
    { value: 900, label: '15 min' },
    { value: 3600, label: '1 h (Statistik-Strecke)' },
    { value: 21600, label: '6 h' },
    { value: 86400, label: '1 d' },
];

function StudyCard({ model, estimand, study, history, busy, onDiscardArchive }: {
    model: CausalModelView;
    estimand: EstimandView;
    study?: StudyView;
    history: readonly ArchiveEntryView[];
    busy: boolean;
    onDiscardArchive(entryId: string): Promise<void>;
}) {
    const verdict = study?.verdict;
    return (
        <div className={styles.study}>
            <div className={styles.studyHead}>
                <h6 className={styles.studyTitle}>{estimand.name}</h6>
                <span className={styles.badges}>
                    {verdict ? (
                        <span
                            className={`${styles.badge} ${verdict === 'passed'
                                ? styles.badgePassed
                                : verdict === 'refuted' ? styles.badgeFailed : styles.badgeMissing}`}
                            title={VERDICT_HINT[verdict]}
                        >
                            {STUDY_VERDICT_LABEL[verdict]}
                        </span>
                    ) : (
                        <span className={`${styles.badge} ${styles.badgeMissing}`}>noch nicht gerechnet</span>
                    )}
                </span>
            </div>

            <p className={styles.verdictReason}>
                Wirkung von <strong>{shortName(model, estimand.treatment)}</strong> auf{' '}
                <strong>{shortName(model, estimand.outcome)}</strong>
                {estimand.estimator !== 'auto' && ` — ${ESTIMATOR_LABEL[estimand.estimator as EstimatorId]}`}
                {estimand.intervalSeconds !== undefined
                    && ` — gerechnet im Raster ${formatInterval(estimand.intervalSeconds)}`}
            </p>

            {study?.effect && (
                <div className={styles.effect}>
                    <span className={styles.effectValue}>
                        {num(study.effect.value)}
                        {study.effect.unit ? ` ${study.effect.unit}` : ''}
                    </span>
                    <span className={styles.effectInterval}>
                        95-%-Intervall {num(study.effect.ciLow)} bis {num(study.effect.ciHigh)}
                    </span>
                </div>
            )}

            {study && <p className={styles.verdictReason}>{study.reason}</p>}

            {study && study.adjustedFor.length > 0 && (
                <p className={styles.verdictSub}>
                    Adjustiert über {study.adjustedFor.map(node => shortName(model, node)).join(', ')}.
                </p>
            )}

            {/*
              * Was die Adjustierung geändert hat (C5). Der rohe Wert heißt hier
              * bewusst „Zusammenhang" und nie „Effekt": Er ist die Zahl, die
              * ohne Störgröße herauskäme, und genau deshalb steht sie da —
              * nicht als zweites Ergebnis, sondern als Beleg dafür, was das
              * Einbinden der Quelle gebracht hat.
              */}
            {study?.contrast && (
                <div className={styles.contrast}>
                    <p className={styles.contrastHead}>
                        Ohne Adjustierung:{' '}
                        <strong>
                            {study.contrast.crude !== undefined
                                ? `${num(study.contrast.crude)}${study.effect?.unit ? ` ${study.effect.unit}` : ''}`
                                : 'nicht zu rechnen'}
                        </strong>
                        {study.contrast.crudeCiLow !== undefined && study.contrast.crudeCiHigh !== undefined
                            && ` [${num(study.contrast.crudeCiLow)}; ${num(study.contrast.crudeCiHigh)}]`}
                        {study.contrast.shift !== undefined
                            && ` · Verschiebung durch Adjustierung ${num(study.contrast.shift)}`}
                    </p>
                    <p className={styles.contrastText}>{study.contrast.explanation}</p>
                </div>
            )}

            {study && study.refutations.length > 0 && (
                <ul className={styles.refutationList}>
                    {study.refutations.map(refutation => (
                        <li key={refutation.method} className={styles.refutation}>
                            <span className={styles.refutationName}>
                                {REFUTATION_LABEL[refutation.method as RefutationMethod]}
                            </span>
                            <span
                                className={`${styles.badge} ${refutation.verdict === 'passed'
                                    ? styles.badgePassed
                                    : refutation.verdict === 'failed' ? styles.badgeFailed : styles.badgeMissing}`}
                            >
                                {REFUTATION_VERDICT_LABEL[refutation.verdict]}
                            </span>
                            <span>{refutation.description}</span>
                        </li>
                    ))}
                </ul>
            )}

            {/*
              * Die Chronik (docs/spec-widersprueche.md, Eintrag 3): Der
              * Inferenz-Graph trägt immer nur den aktuellen Stand, und er
              * wird bei jedem Lauf ersetzt. Was eine Frage FRÜHER gesagt
              * hat, stünde damit nirgends — deshalb hält ein Lauf jede
              * Änderung fest, und nur die.
              */}
            {history.length > 0 && (
                <details className={styles.template}>
                    <summary>Chronik ({history.length} {history.length === 1 ? 'Eintrag' : 'Einträge'})</summary>
                    <ul className={styles.edgeList}>
                        {history.map(entry => (
                            <li key={entry.iri} className={styles.edgeRow}>
                                <span className={styles.edgeText}>
                                    {entry.effect
                                        ? `${num(entry.effect.value)}${entry.effect.unit ? ` ${entry.effect.unit}` : ''} `
                                            + `[${num(entry.effect.ciLow)}; ${num(entry.effect.ciHigh)}]`
                                        : STUDY_VERDICT_LABEL[entry.verdict]}
                                </span>
                                <span className={styles.badges}>
                                    <span className={styles.badge}>Rev. {entry.modelRevision}</span>
                                    {entry.intervalSeconds !== undefined && (
                                        <span className={styles.badge}>
                                            {formatInterval(entry.intervalSeconds)}
                                        </span>
                                    )}
                                    {entry.generatedAt && (
                                        <span className={styles.badge}>
                                            {new Date(entry.generatedAt).toLocaleDateString('de-DE')}
                                        </span>
                                    )}
                                    {entry.softwareVersion && (
                                        <span className={styles.badge}>v{entry.softwareVersion}</span>
                                    )}
                                    <button
                                        type="button"
                                        className={styles.discard}
                                        onClick={() => { void onDiscardArchive(entry.id); }}
                                        disabled={busy}
                                        title="Eintrag verwerfen — ein Lauf auf falschen Daten ist keine Geschichte"
                                    >
                                        <Trash2 size={14} aria-hidden="true" />
                                        <span className={styles.visuallyHidden}>
                                            Chronik-Eintrag vom {entry.generatedAt
                                                ? new Date(entry.generatedAt).toLocaleDateString('de-DE')
                                                : 'unbekannten Datum'} verwerfen
                                        </span>
                                    </button>
                                </span>
                            </li>
                        ))}
                    </ul>
                </details>
            )}

            {study && (
                <p className={styles.signature}>
                    Modell-Revision {study.modelRevision}
                    {study.estimator ? ` · ${ESTIMATOR_LABEL[study.estimator]}` : ''}
                    {study.rows !== undefined ? ` · ${study.rows.toLocaleString('de-DE')} Zeilen` : ''}
                    {/*
                      * Die Zeilenzahl ohne ihr Raster wäre eine Zahl ohne
                      * Maßstab: dieselbe Strecke ergibt stündlich ein
                      * Zwölftel der Zeilen von fünfminütlich.
                      */}
                    {study.intervalSeconds !== undefined
                        ? ` · Raster ${formatInterval(study.intervalSeconds)}`
                        : ''}
                    {` · Startwert ${study.seed}`}
                    {study.softwareVersion ? ` · Version ${study.softwareVersion}` : ''}
                    {study.generatedAt ? ` · ${new Date(study.generatedAt).toLocaleString('de-DE')}` : ''}
                </p>
            )}
        </div>
    );
}

/**
 * Fragen und Ergebnisse — bewusst IM Modell und nicht auf einer eigenen
 * Seite: Ein Effekt wird nie ohne den DAG ausgegeben, aus dem er folgt
 * (Invariante C1). Wer die Struktur darüber ändert, sieht sofort, dass
 * das Ergebnis darunter zu einer anderen Revision gehört.
 */
function StudiesPanel({
    model, estimands, studies, archive, observedVariables, busy, onAsk, onRemove, onDiscardArchive,
}: StudiesProps) {
    const [treatment, setTreatment] = useState('');
    const [outcome, setOutcome] = useState('');
    const [estimator, setEstimator] = useState<string>('auto');
    const [name, setName] = useState('');
    const [interventionAt, setInterventionAt] = useState('');
    const [controlOutcome, setControlOutcome] = useState('');
    const [interval, setInterval] = useState('auto');
    const byId = new Map(studies.map(study => [study.estimandId, study]));

    const inModel = new Set(model.variables.map(variable => variable.iri));
    const involved = observedVariables.filter(variable => inModel.has(variable.iri));
    // Das gröbste Raster der beteiligten Reihen ist die Untergrenze: Ein
    // feineres würde das Panel begründet ablehnen (verfeinern hieße
    // Werte erfinden), und darauf sollte niemand erst nach einem Lauf
    // stoßen.
    const coarsest = involved.reduce((max, variable) => Math.max(max, variable.intervalSeconds), 0);
    // Größen mit einer aus Aggregaten nachgefüllten Strecke: Sie sind der
    // Grund, warum es die Einstellung überhaupt gibt.
    const aggregated = involved.filter(variable => variable.aggregateIntervalSeconds !== undefined);
    const aggregateInterval = aggregated.reduce(
        (max, variable) => Math.max(max, variable.aggregateIntervalSeconds ?? 0),
        0,
    );
    const chosen = interval === 'auto' ? undefined : Number(interval);
    const tooFine = chosen !== undefined && coarsest > 0 && chosen < coarsest;

    const ask = async (event: React.FormEvent) => {
        event.preventDefault();
        if (treatment === '' || outcome === '') return;
        const label = name.trim() !== ''
            ? name.trim()
            : `Wirkung von ${shortName(model, treatment)} auf ${shortName(model, outcome)}`;
        await onAsk({
            id: `${model.id}-${Date.now().toString(36)}`,
            name: label,
            modelId: model.id,
            treatment,
            outcome,
            estimator,
            ...(controlOutcome !== '' ? { controlOutcome } : {}),
            ...(interventionAt !== ''
                ? { interventionAt: new Date(interventionAt).toISOString() }
                : {}),
            ...(chosen !== undefined ? { intervalSeconds: chosen } : {}),
        });
        setName('');
        setInterventionAt('');
        setControlOutcome('');
        setInterval('auto');
    };

    return (
        <div className={styles.studies}>
            <h5 className={styles.editorTitle}>Fragen und Ergebnisse</h5>

            {estimands.length === 0 ? (
                <p className={styles.editorHint}>
                    Noch keine Frage. Eine Frage bleibt beim Modell; ihr Ergebnis entsteht erst im
                    Lauf und wird bei jedem weiteren Lauf ersetzt.
                </p>
            ) : (
                <ul className={styles.studyList}>
                    {estimands.map(estimand => (
                        <li key={estimand.id}>
                            <StudyCard
                                model={model}
                                estimand={estimand}
                                study={byId.get(estimand.id)}
                                history={archive.filter(entry => entry.estimandId === estimand.id)}
                                busy={busy}
                                onDiscardArchive={onDiscardArchive}
                            />
                            <Button variant="ghost" disabled={busy} onClick={() => onRemove(estimand.id)}>
                                <Trash2 size={16} aria-hidden="true" />
                                <span className={styles.visuallyHidden}>Frage {estimand.name} </span>
                                entfernen
                            </Button>
                        </li>
                    ))}
                </ul>
            )}

            <form className={styles.editorForm} onSubmit={ask}>
                <div className={styles.editorRow}>
                    <label className={styles.field}>
                        <span className={styles.fieldLabel}>Wirkung von</span>
                        <select
                            className={styles.input}
                            value={treatment}
                            onChange={event => setTreatment(event.target.value)}
                        >
                            <option value="">— auswählen —</option>
                            {model.variables.map(variable => (
                                <option key={variable.iri} value={variable.iri}>{variable.name}</option>
                            ))}
                        </select>
                    </label>
                    <label className={styles.field}>
                        <span className={styles.fieldLabel}>auf</span>
                        <select
                            className={styles.input}
                            value={outcome}
                            onChange={event => setOutcome(event.target.value)}
                        >
                            <option value="">— auswählen —</option>
                            {model.variables.map(variable => (
                                <option key={variable.iri} value={variable.iri}>{variable.name}</option>
                            ))}
                        </select>
                    </label>
                    <label className={styles.field}>
                        <span className={styles.fieldLabel}>Verfahren</span>
                        <select
                            className={styles.input}
                            value={estimator}
                            onChange={event => setEstimator(event.target.value)}
                        >
                            {ESTIMATOR_CHOICES.map(choice => (
                                <option key={choice} value={choice}>
                                    {choice === 'auto' ? 'automatisch' : ESTIMATOR_LABEL[choice]}
                                </option>
                            ))}
                        </select>
                    </label>
                    <label className={styles.field}>
                        <span className={styles.fieldLabel}>Rechenraster</span>
                        <select
                            className={styles.input}
                            value={interval}
                            onChange={event => setInterval(event.target.value)}
                        >
                            <option value="auto">
                                automatisch{coarsest > 0 ? ` (${formatInterval(coarsest)})` : ''}
                            </option>
                            {INTERVAL_CHOICES.map(choice => (
                                <option key={choice.value} value={String(choice.value)}>{choice.label}</option>
                            ))}
                        </select>
                    </label>
                    <label className={styles.field}>
                        <span className={styles.fieldLabel}>Name (optional)</span>
                        <input
                            className={styles.input}
                            value={name}
                            onChange={event => setName(event.target.value)}
                            placeholder="Bringt die Nachtabsenkung etwas?"
                            maxLength={200}
                        />
                    </label>
                </div>
                {(estimator === 'did' || estimator === 'its') && (
                    <div className={styles.editorRow}>
                        <label className={styles.field}>
                            <span className={styles.fieldLabel}>Zeitpunkt des Eingriffs</span>
                            <input
                                className={styles.input}
                                type="datetime-local"
                                value={interventionAt}
                                onChange={event => setInterventionAt(event.target.value)}
                                required
                            />
                        </label>
                        {estimator === 'did' && (
                            <label className={styles.field}>
                                <span className={styles.fieldLabel}>Kontroll-Wirkung</span>
                                <select
                                    className={styles.input}
                                    value={controlOutcome}
                                    onChange={event => setControlOutcome(event.target.value)}
                                    required
                                >
                                    <option value="">— auswählen —</option>
                                    {model.variables.map(variable => (
                                        <option key={variable.iri} value={variable.iri}>{variable.name}</option>
                                    ))}
                                </select>
                            </label>
                        )}
                    </div>
                )}
                <div className={styles.editorRow}>
                    <Button type="submit" variant="secondary" disabled={busy}>
                        <Plus size={16} aria-hidden="true" />
                        Frage stellen
                    </Button>
                </div>
                {tooFine && (
                    <p className={styles.editorHint}>
                        <AlertTriangle size={14} aria-hidden="true" /> Das gewählte Raster (
                        {formatInterval(chosen as number)}) ist feiner als die gröbste beteiligte Reihe (
                        {formatInterval(coarsest)}). Das Panel wird es ablehnen: Auf diesem Raster gäbe es
                        nur Werte, die niemand gemessen hat — verdichten ist zulässig, verfeinern nicht.
                    </p>
                )}
                {aggregated.length > 0 && (
                    <p className={styles.editorHint}>
                        {aggregated.length === 1
                            ? `${aggregated[0].name} hat`
                            : `${aggregated.length} beteiligte Größen haben`}{' '}
                        eine aus Aggregaten nachgefüllte Strecke (
                        {formatInterval(aggregateInterval)}, Long-Term-Statistics). Dort liegt nur zu jeder
                        vollen Stunde ein Punkt; auf einem feineren Raster fallen die übrigen Zeilen als Lücke
                        heraus. Wer diese Strecke auswerten will, setzt das Rechenraster bewusst auf{' '}
                        {formatInterval(aggregateInterval)} — das verliert nichts und erfindet nichts, es
                        fragt seltener.
                    </p>
                )}
                <p className={styles.editorHint}>
                    Das Verfahren darf <strong>automatisch</strong> bleiben — dann entscheidet die
                    Datenlage: binäre Behandlung über Propensity-Gewichtung, stetige über Regression,
                    mit gesetztem Eingriffszeitpunkt über die Zeitreihe. Auch das Rechenraster darf
                    automatisch bleiben; dann ist es das gröbste der beteiligten Reihen. Was gerechnet
                    wurde, steht hinterher am Ergebnis, samt Raster, Startwert, Datenfenster und
                    Modell-Revision.
                </p>
            </form>
        </div>
    );
}

/**
 * Vorschläge und Quellenvergleich (§8, C6).
 *
 * Die Reihenfolge auf dem Bildschirm ist die Aussage: erst der Knopf, der
 * fremde Quellen befragt, dann die **Widersprüche** (§8: „der interessante
 * Fall"), dann die Vorschläge selbst — zulässige zuerst, verworfene
 * zuletzt, aber sichtbar. Ein verworfener Vorschlag verschwindet nicht:
 * Zu wissen, dass ein Sprachmodell etwas Unmögliches vorgeschlagen hat,
 * ist mehr wert als eine aufgeräumte Liste.
 */
function HypothesesPanel({
    hypotheses,
    comparison,
    lastRun,
    running,
    busy,
    onPropose,
    onAdopt,
    onDiscard,
}: {
    hypotheses: readonly HypothesisView[];
    comparison: readonly StructureComparison[];
    lastRun: ProposalRunSummary | null;
    running: boolean;
    busy: boolean;
    onPropose(): Promise<void>;
    onAdopt(id: string): Promise<void>;
    onDiscard(id: string): Promise<void>;
}) {
    return (
        <div className={styles.hypotheses}>
            <h5 className={styles.editorTitle}>Vorschläge</h5>
            <p className={styles.editorHint}>
                Drei Quellen schlagen Kanten und vor allem <strong>Störgrößen</strong> vor: ein
                Sprachmodell, die Geräte&shy;topologie aus der Registry und Wikidata über die
                Föderation. Nichts davon landet im Modell. Jeder Vorschlag durchläuft zuerst
                die harten Filter — Kreis, Shapes, Zeit, Topologie — und erst was sie überlebt,
                kannst du übernehmen. Struktur&shy;lernen aus Daten gibt es hier nicht; es
                gehört zu C8 und ist nicht gebaut.
            </p>
            <div className={styles.runRow}>
                <Button variant="secondary" onClick={onPropose} disabled={running || busy}>
                    <Lightbulb size={16} aria-hidden="true" />
                    {running ? 'Frage die Quellen…' : 'Vorschläge holen'}
                </Button>
                {lastRun && (
                    <span className={styles.signature} role="status">
                        {lastRun.sources.map(source =>
                            `${source.label}: ${source.unavailable
                                ? 'nicht verfügbar'
                                : `${source.proposed} Vorschläge, ${source.accepted} zulässig, `
                                    + `${source.open} ohne Schätzbarkeit, ${source.rejected} verworfen`}`,
                        ).join(' · ')}
                    </span>
                )}
            </div>
            {lastRun?.sources.filter(source => source.unavailable || source.problems.length > 0).map(source => (
                <ul key={source.source} className={styles.findingList}>
                    {[source.unavailable, ...source.problems].filter((entry): entry is string => Boolean(entry))
                        .map((entry, index) => (
                            <li key={`${source.source}-${index}`} className={styles.finding}>
                                <AlertTriangle size={16} aria-hidden="true" />
                                <span><strong>{source.label}:</strong> {entry}</span>
                            </li>
                        ))}
                </ul>
            ))}

            {comparison.length > 0 && (
                <>
                    <h5 className={styles.editorTitle}>Was die Quellen zusammen sagen</h5>
                    <ul className={styles.comparisonList}>
                        {comparison.map(entry => (
                            <li
                                key={entry.key}
                                className={`${styles.comparison}${entry.agreement === 'contradiction' ? ` ${styles.contradiction}` : ''}`}
                            >
                                <span className={styles.hypothesisEdge}>
                                    {entry.fromName}
                                    <span aria-hidden="true"> → </span>
                                    <span className={styles.visuallyHidden}> wirkt auf </span>
                                    {entry.toName}
                                </span>
                                <span className={styles.badges}>
                                    <span className={`${styles.badge} ${entry.agreement === 'contradiction'
                                        ? styles.badgeFailed
                                        : entry.agreement === 'agreed' ? styles.badgePassed : styles.badgeMissing}`}>
                                        {AGREEMENT_LABEL[entry.agreement]}
                                    </span>
                                    {entry.claims.map(claim => (
                                        <span key={`${claim.source}-${claim.direction}`} className={styles.badge}>
                                            {STRUCTURE_SOURCE_LABEL[claim.source]}
                                            {claim.direction === 'reverse' ? ' (umgekehrt)' : ''}
                                        </span>
                                    ))}
                                </span>
                                <p className={styles.hypothesisReason}>{entry.summary}</p>
                            </li>
                        ))}
                    </ul>
                    {ABSENT_SOURCES.map(absent => (
                        <p key={absent.id} className={styles.absentSource}>
                            <strong>{absent.label}</strong> fehlt als vierte Stimme. {absent.reason}
                        </p>
                    ))}
                </>
            )}

            {hypotheses.length === 0 ? (
                <p className={styles.hint}>
                    Noch keine Vorschläge. Der Lauf kostet einen Aufruf beim Sprachmodell und
                    schreibt nichts ins Modell — er füllt nur diese Liste.
                </p>
            ) : (
                <ul className={styles.hypothesisList}>
                    {hypotheses.map(hypothesis => (
                        <li
                            key={hypothesis.id}
                            className={`${styles.hypothesis}${hypothesis.verdict === 'rejected' ? ` ${styles.hypothesisRejected}` : ''}`}
                        >
                            <div className={styles.hypothesisHead}>
                                <span className={styles.hypothesisEdge}>
                                    {hypothesis.fromName}
                                    <span aria-hidden="true"> → </span>
                                    <span className={styles.visuallyHidden}> wirkt auf </span>
                                    {hypothesis.toName}
                                </span>
                                <span className={styles.badges}>
                                    <span className={`${styles.badge} ${hypothesis.verdict === 'accepted'
                                        ? styles.badgePassed
                                        : hypothesis.verdict === 'open' ? styles.badgeOpen : styles.badgeFailed}`}>
                                        {HYPOTHESIS_VERDICT_LABEL[hypothesis.verdict]}
                                        {hypothesis.rejectedBy
                                            ? `: ${HYPOTHESIS_FILTER_LABEL[hypothesis.rejectedBy]}`
                                            : ''}
                                    </span>
                                    <span className={`${styles.badge} ${styles.badgeClass}`}>
                                        {PROPOSAL_SOURCE_LABEL[hypothesis.source]}
                                    </span>
                                    <span className={`${styles.badge} ${styles.badgeHypothesis}`}>
                                        {EDGE_CLASS_LABEL[hypothesis.edgeClass]}
                                    </span>
                                    {hypothesis.temporalLag && (
                                        <span className={styles.badge}>{formatLag(hypothesis.temporalLag)}</span>
                                    )}
                                    {hypothesis.inModel && (
                                        <span className={styles.badge}>übernommen</span>
                                    )}
                                </span>
                            </div>
                            <p className={styles.hypothesisReason}>{hypothesis.reason}</p>
                            <span className={styles.signature}>
                                {hypothesis.agentName} · Version {hypothesis.agentVersion}
                                {hypothesis.generatedAt
                                    ? ` · ${new Date(hypothesis.generatedAt).toLocaleString('de-DE')}`
                                    : ''}
                            </span>
                            <div className={styles.hypothesisActions}>
                                {hypothesis.verdict !== 'rejected' && !hypothesis.inModel && (
                                    <Button
                                        variant="secondary"
                                        disabled={busy}
                                        onClick={() => onAdopt(hypothesis.id)}
                                    >
                                        <Plus size={16} aria-hidden="true" />
                                        Ins Modell übernehmen
                                    </Button>
                                )}
                                <Button variant="ghost" disabled={busy} onClick={() => onDiscard(hypothesis.id)}>
                                    <Trash2 size={16} aria-hidden="true" />
                                    <span className={styles.visuallyHidden}>
                                        Vorschlag {hypothesis.fromName} nach {hypothesis.toName}{' '}
                                    </span>
                                    Verwerfen
                                </Button>
                            </div>
                        </li>
                    ))}
                </ul>
            )}
        </div>
    );
}

interface ModelCardProps {
    model: CausalModelView;
    observedVariables: readonly ObservedVariable[];
    estimands: readonly EstimandView[];
    studies: readonly StudyView[];
    archive: readonly ArchiveEntryView[];
    hypotheses: readonly HypothesisView[];
    comparison: readonly StructureComparison[];
    lastProposal: ProposalRunSummary | null;
    proposing: boolean;
    busy: boolean;
    onOperation(operation: Record<string, unknown>): Promise<void>;
    onAsk(input: Record<string, unknown>): Promise<void>;
    onRemoveEstimand(estimandId: string): Promise<void>;
    onDiscardArchive(entryId: string): Promise<void>;
    onPropose(): Promise<void>;
    onAdopt(id: string): Promise<void>;
    onDiscardHypothesis(id: string): Promise<void>;
    onCopy(): void;
    onRemove(): void;
}

/**
 * Ein Modell mit allem, was dazugehört: Bild, Kanten, Variablen, Editor,
 * Identifikation, Verlauf. Die gewählte Ursache-Wirkung-Frage lebt HIER
 * und nicht im Panel — nur so kann das Bild zeigen, worüber adjustiert
 * würde.
 */
function ModelCard({
    model,
    observedVariables,
    estimands,
    studies,
    archive,
    hypotheses,
    comparison,
    lastProposal,
    proposing,
    busy,
    onOperation,
    onAsk,
    onRemoveEstimand,
    onDiscardArchive,
    onPropose,
    onAdopt,
    onDiscardHypothesis,
    onCopy,
    onRemove,
}: ModelCardProps) {
    const [exposure, setExposure] = useState('');
    const [outcome, setOutcome] = useState('');

    const result = useMemo(() => {
        if (exposure === '' || outcome === '' || exposure === outcome) return null;
        // Hier rechnet der Browser: der Tier-1-Kern ist pur (C1).
        return identifyInModel(model, exposure, outcome);
    }, [model, exposure, outcome]);

    const highlight = new Set(result?.observed.adjustmentSets[0] ?? []);

    return (
        <li className={styles.card}>
            <div className={styles.cardHead}>
                <h4 className={styles.cardTitle}>{model.name}</h4>
                <span className={styles.source}>{model.graph}</span>
            </div>
            {model.description && <p className={styles.description}>{model.description}</p>}
            <div className={styles.badges}>
                <span className={styles.badge}>{model.variables.length} Variablen</span>
                <span className={styles.badge}>{model.edges.length} Kanten</span>
                {model.variables.some(variable => variable.observation) && (
                    <span className={styles.badge}>
                        {model.variables.filter(variable => variable.observation).length} davon erfasst
                    </span>
                )}
                <span className={styles.badge}>Revision {model.revision}</span>
            </div>

            {model.edges.length > 0 && <DagDiagram model={model} highlight={highlight} />}

            {model.edges.length === 0 ? (
                <p className={styles.hint}>
                    Noch keine Kante. Ohne Kanten ist ein Modell eine Liste, kein Modell —
                    nimm zwei Größen auf und verbinde sie.
                </p>
            ) : (
                <ul className={styles.edgeList}>
                    {model.edges.map(edge => (
                        <li key={`${edge.from}->${edge.to}`} className={styles.edgeRow}>
                            <span className={styles.edgeText}>
                                {shortName(model, edge.from)}
                                <span aria-hidden="true"> → </span>
                                <span className={styles.visuallyHidden}> wirkt auf </span>
                                {shortName(model, edge.to)}
                            </span>
                            <EdgeBadges edge={edge} />
                            <Button
                                variant="ghost"
                                disabled={busy}
                                onClick={() => onOperation({ op: 'remove-edge', from: edge.from, to: edge.to })}
                            >
                                <Trash2 size={16} aria-hidden="true" />
                                <span className={styles.visuallyHidden}>
                                    Kante {shortName(model, edge.from)} nach {shortName(model, edge.to)}{' '}
                                </span>
                                entfernen
                            </Button>
                        </li>
                    ))}
                </ul>
            )}

            {model.variables.length > 0 && (
                <ul className={styles.variableList}>
                    {model.variables.map(variable => (
                        <li key={variable.iri} className={styles.variableRow}>
                            <span className={styles.variableName}>{variable.name}</span>
                            <span className={styles.badges}>
                                {variable.unit && <span className={styles.badge}>{variable.unit}</span>}
                                {variable.observation ? (
                                    <span className={styles.badge}>
                                        {variable.observation.count.toLocaleString('de-DE')} Messpunkte
                                    </span>
                                ) : (
                                    <span className={`${styles.badge} ${styles.badgeMissing}`}>nicht erfasst</span>
                                )}
                                {!variable.inModel && (
                                    <span className={`${styles.badge} ${styles.badgeMissing}`}>nur an einer Kante</span>
                                )}
                            </span>
                            <Button
                                variant="ghost"
                                disabled={busy}
                                onClick={() => onOperation({ op: 'remove-variable', iri: variable.iri })}
                            >
                                <Trash2 size={16} aria-hidden="true" />
                                <span className={styles.visuallyHidden}>Variable {variable.name} </span>
                                entfernen
                            </Button>
                        </li>
                    ))}
                </ul>
            )}

            <StructureEditor
                model={model}
                observedVariables={observedVariables}
                busy={busy}
                onOperation={onOperation}
            />

            <HypothesesPanel
                hypotheses={hypotheses}
                comparison={comparison}
                lastRun={lastProposal}
                running={proposing}
                busy={busy}
                onPropose={onPropose}
                onAdopt={onAdopt}
                onDiscard={onDiscardHypothesis}
            />

            <IdentificationPanel
                model={model}
                exposure={exposure}
                outcome={outcome}
                onExposure={setExposure}
                onOutcome={setOutcome}
                result={result}
            />

            <StudiesPanel
                model={model}
                estimands={estimands}
                studies={studies}
                archive={archive}
                observedVariables={observedVariables}
                busy={busy}
                onAsk={onAsk}
                onRemove={onRemoveEstimand}
                onDiscardArchive={onDiscardArchive}
            />

            {model.revisions.length > 0 && (
                <details className={styles.template}>
                    <summary>Verlauf ({model.revisions.length} Revisionen)</summary>
                    <ul className={styles.edgeList}>
                        {model.revisions.map(revision => (
                            <li key={revision.iri} className={styles.edgeRow}>
                                <span className={styles.edgeText}>{revision.description}</span>
                                <span className={styles.badges}>
                                    <span className={styles.badge}>Rev. {revision.revision}</span>
                                    {revision.at && (
                                        <span className={styles.badge}>
                                            {new Date(revision.at).toLocaleString('de-DE')}
                                        </span>
                                    )}
                                </span>
                            </li>
                        ))}
                    </ul>
                </details>
            )}

            <details className={styles.template}>
                <summary>Struktur per SPARQL (Vorlage)</summary>
                <pre className={styles.templateCode}>{updateTemplate(model)}</pre>
            </details>

            <div className={styles.actions}>
                <Button variant="secondary" onClick={onCopy}>
                    <Copy size={16} aria-hidden="true" />
                    Vorlage kopieren
                </Button>
                <Link className={styles.buttonLink} href="/graph/sparql">
                    SPARQL-Editor öffnen
                </Link>
                <Button variant="ghost" onClick={onRemove}>
                    <Trash2 size={16} aria-hidden="true" />
                    Modell entfernen
                </Button>
            </div>
        </li>
    );
}

export default function GraphCausalPage() {
    const toast = useToast();
    const queryClient = useQueryClient();
    const [creating, setCreating] = useState(false);
    const [busy, setBusy] = useState(false);
    const [newId, setNewId] = useState('');
    const [newName, setNewName] = useState('');
    const [removing, setRemoving] = useState<CausalModelView | null>(null);
    const [running, setRunning] = useState(false);
    const [lastRun, setLastRun] = useState<RunResponse | null>(null);
    const [proposing, setProposing] = useState<string | null>(null);
    const [lastProposal, setLastProposal] = useState<Record<string, ProposalRunSummary>>({});

    const { data, isLoading } = useQuery<CausalResponse>({
        queryKey: ['graph-causal'],
        queryFn: () => fetchJson('/api/graph/causal'),
    });

    const models = data?.models ?? [];
    const estimands = data?.estimands ?? [];
    const studies = data?.studies ?? [];
    const hypotheses = data?.hypotheses ?? [];
    const comparisons = data?.comparisons ?? [];
    const findings = (data?.validation.results ?? []).filter(result => !result.severity.endsWith('Info'));
    // Vorschläge zu einem gelöschten Modell: Sie stehen weiter im
    // Hypothesen-Graphen, aber ohne DAG lässt sich über sie nichts sagen.
    // Sie zu verschweigen wäre ein stiller Rest im Graphen.
    const orphaned = hypotheses.filter(entry => !models.some(model => model.id === entry.modelId));

    const invalidate = () => queryClient.invalidateQueries({ queryKey: ['graph-causal'] });

    const handleCreate = async (event: React.FormEvent) => {
        event.preventDefault();
        setCreating(true);
        try {
            await fetchJson('/api/graph/causal', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ id: newId.trim(), name: newName.trim() }),
            });
            toast.success(`Modell „${newName.trim()}" angelegt.`);
            setNewId('');
            setNewName('');
        } catch (error) {
            toast.error(error instanceof Error ? error.message : 'Anlegen fehlgeschlagen');
        } finally {
            setCreating(false);
            invalidate();
        }
    };

    const runOperation = async (modelId: string, operation: Record<string, unknown>) => {
        setBusy(true);
        try {
            const result = await fetchJson<{ message: string }>(
                `/api/graph/causal/${encodeURIComponent(modelId)}`,
                {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(operation),
                },
            );
            toast.success(result.message);
        } catch (error) {
            toast.error(error instanceof Error ? error.message : 'Änderung fehlgeschlagen');
        } finally {
            setBusy(false);
            invalidate();
        }
    };

    const askQuestion = async (input: Record<string, unknown>) => {
        setBusy(true);
        try {
            await fetchJson('/api/graph/causal/estimands', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(input),
            });
            toast.success('Frage angelegt. Sie wird beim nächsten Lauf gerechnet.');
        } catch (error) {
            toast.error(error instanceof Error ? error.message : 'Frage konnte nicht angelegt werden.');
        } finally {
            setBusy(false);
            invalidate();
        }
    };

    /**
     * Einen Chronik-Eintrag verwerfen. Die Chronik hält fest, was ein Lauf
     * gesagt hat — nicht, dass er hätte stattfinden sollen: Ein Lauf auf
     * falsch erfassten Daten ist keine Geschichte, sondern Störung.
     */
    const discardArchiveEntry = async (entryId: string) => {
        setBusy(true);
        try {
            const result = await fetchJson<{ message: string }>(
                `/api/graph/causal/archive/${encodeURIComponent(entryId)}`,
                { method: 'DELETE' },
            );
            toast.success(result.message);
        } catch (error) {
            toast.error(error instanceof Error ? error.message : 'Eintrag konnte nicht verworfen werden.');
        } finally {
            setBusy(false);
            invalidate();
        }
    };

    const removeQuestion = async (estimandId: string) => {
        setBusy(true);
        try {
            const result = await fetchJson<{ message: string }>(
                `/api/graph/causal/estimands/${encodeURIComponent(estimandId)}`,
                { method: 'DELETE' },
            );
            toast.success(result.message);
        } catch (error) {
            toast.error(error instanceof Error ? error.message : 'Frage konnte nicht entfernt werden.');
        } finally {
            setBusy(false);
            invalidate();
        }
    };

    /**
     * Die Quellen befragen (§8). Der Lauf schreibt ausschließlich nach
     * `causal-hypotheses` — ins Modell kommt erst, was ein Mensch
     * übernimmt, und auch das nur, wenn die Filter es durchgelassen haben.
     */
    const proposeFor = async (modelId: string) => {
        setProposing(modelId);
        try {
            const result = await fetchJson<ProposalRunSummary>('/api/graph/causal/hypotheses', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ modelId }),
            });
            setLastProposal(previous => ({ ...previous, [modelId]: result }));
            const total = result.sources.reduce((sum, source) => sum + source.proposed, 0);
            const usable = result.sources.reduce((sum, source) => sum + source.accepted + source.open, 0);
            toast.success(total === 0
                ? 'Keine Quelle hatte etwas vorzuschlagen — was daran lag, steht unter „Vorschläge".'
                : `${total} Vorschläge, ${usable} davon durch die Filter gekommen.`);
        } catch (error) {
            toast.error(error instanceof Error ? error.message : 'Der Vorschlagslauf ist fehlgeschlagen.');
        } finally {
            setProposing(null);
            invalidate();
        }
    };

    const adoptHypothesis = async (id: string) => {
        setBusy(true);
        try {
            const result = await fetchJson<{ message: string }>(
                `/api/graph/causal/hypotheses/${encodeURIComponent(id)}`,
                { method: 'POST' },
            );
            toast.success(result.message);
        } catch (error) {
            toast.error(error instanceof Error ? error.message : 'Vorschlag konnte nicht übernommen werden.');
        } finally {
            setBusy(false);
            invalidate();
        }
    };

    const discardHypothesis = async (id: string) => {
        setBusy(true);
        try {
            const result = await fetchJson<{ message: string }>(
                `/api/graph/causal/hypotheses/${encodeURIComponent(id)}`,
                { method: 'DELETE' },
            );
            toast.success(result.message);
        } catch (error) {
            toast.error(error instanceof Error ? error.message : 'Vorschlag konnte nicht verworfen werden.');
        } finally {
            setBusy(false);
            invalidate();
        }
    };

    /**
     * Ein Lauf rechnet ALLE Fragen neu und ersetzt den Inferenz-Graphen
     * vollständig (Invariante C4). Das steht auch so auf der Seite —
     * sonst sähe es aus, als ginge dabei etwas verloren.
     */
    const runStudies = async () => {
        setRunning(true);
        try {
            const result = await fetchJson<RunResponse>('/api/graph/causal/studies', { method: 'POST' });
            setLastRun(result);
            const { counts } = result;
            toast.success(
                counts.total === 0
                    ? 'Keine Frage zu rechnen — stell erst eine.'
                    : `${counts.total} Frage(n) gerechnet: ${counts.passed} mit Effekt, `
                        + `${counts.refuted} durchgefallen, `
                        + `${counts.notEstimable + counts.notIdentifiable} ohne Schätzung.`,
            );
        } catch (error) {
            toast.error(error instanceof Error ? error.message : 'Der Lauf ist fehlgeschlagen.');
        } finally {
            setRunning(false);
            invalidate();
        }
    };

    const handleCopy = async (model: CausalModelView) => {
        const template = updateTemplate(model);
        try {
            await navigator.clipboard.writeText(template);
            toast.success('Vorlage kopiert — im SPARQL-Editor einfügen und anpassen.');
        } catch {
            toast.error('Kopieren nicht möglich. Die Vorlage steht unter „Struktur per SPARQL" zum Markieren.');
        }
    };

    const handleRemove = async () => {
        if (!removing) return;
        const target = removing;
        setRemoving(null);
        try {
            const result = await fetchJson<{ message: string }>(
                `/api/graph/causal/${encodeURIComponent(target.id)}`,
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
        <AppShell title="Kausalmodelle">
            <div className={styles.container}>
                <div className={styles.header}>
                    <h2>Kausalmodelle</h2>
                    <p>
                        Ein Kausalmodell ist eine <strong>Annahme</strong>, kein Ergebnis: Es sagt,
                        welche Größe auf welche wirkt — und genau daraus folgt, worüber adjustiert
                        werden muss. Wer den Graphen ändert, ändert das Ergebnis; das ist die
                        Aussage und keine Schwäche. Jede Kante zeigt deshalb offen, woher sie
                        kommt: gesetzt, strukturell, gelernt oder bloß vorgeschlagen.
                    </p>
                    <p>
                        Du kannst die Struktur hier bearbeiten, und zu jedem Paar aus Ursache und
                        Wirkung sagt die Seite, ob der Effekt aus Beobachtungsdaten überhaupt
                        <strong> bestimmbar</strong> wäre — und woran es sonst liegt. Ist er das,
                        kannst du ihn <strong>schätzen</strong> lassen. Eine Zahl erscheint
                        allerdings nur mit Konfidenz&shy;intervall und erst, wenn sie jeden
                        Falsifikations&shy;versuch überstanden hat; hält sie nicht stand, siehst du
                        den durchgefallenen Versuch statt eines kleineren Effekts.
                    </p>
                </div>

                <section className={styles.section}>
                    <h3>Schätzen</h3>
                    <p className={styles.sectionHint}>
                        Ein Lauf rechnet <strong>alle</strong> Fragen neu und ersetzt die
                        bisherigen Ergebnisse vollständig — Ergebnisse sind abgeleitet und werden
                        nie fortgeschrieben. Die Fragen selbst bleiben. Gerechnet wird gegen die
                        Messreihen aus{' '}
                        <Link className={styles.inlineLink} href="/graph/observations">Beobachtungen</Link>;
                        ohne erfasste Größen kommt keine Zahl zustande, sondern die Auskunft, welche
                        fehlt.
                    </p>
                    <div className={styles.runRow}>
                        <Button variant="primary" onClick={runStudies} disabled={running || estimands.length === 0}>
                            <Sigma size={16} aria-hidden="true" />
                            {running ? 'Rechne…' : 'Alle Fragen rechnen'}
                        </Button>
                        {estimands.length === 0 && (
                            <span className={styles.sectionHint}>
                                Noch keine Frage — stell sie unten bei deinem Modell.
                            </span>
                        )}
                        {lastRun && (
                            <span className={styles.signature} role="status">
                                {lastRun.counts.total} Frage(n) in {Math.round(lastRun.durationMs / 100) / 10} s:{' '}
                                {lastRun.counts.passed} mit Effekt, {lastRun.counts.refuted} durchgefallen,{' '}
                                {lastRun.counts.notEstimable} nicht schätzbar,{' '}
                                {lastRun.counts.notIdentifiable} nicht identifizierbar.
                            </span>
                        )}
                    </div>
                    {lastRun && lastRun.rejected.length > 0 && (
                        <ul className={styles.findingList}>
                            {lastRun.rejected.map(entry => (
                                <li key={entry.estimandId} className={styles.finding}>
                                    <AlertTriangle size={16} aria-hidden="true" />
                                    <span>
                                        &bdquo;{entry.estimandId}&ldquo; wurde nicht geschrieben — die
                                        Studie war unvollständig: {entry.messages.join(' ')}
                                    </span>
                                </li>
                            ))}
                        </ul>
                    )}
                    {lastRun && lastRun.skipped.length > 0 && (
                        <ul className={styles.findingList}>
                            {lastRun.skipped.map(entry => (
                                <li key={entry.estimandId} className={styles.finding}>
                                    <AlertTriangle size={16} aria-hidden="true" />
                                    <span>&bdquo;{entry.estimandId}&ldquo;: {entry.reason}</span>
                                </li>
                            ))}
                        </ul>
                    )}
                </section>

                <section className={styles.section}>
                    <h3>Neues Modell</h3>
                    <p className={styles.sectionHint}>
                        Ein Modell ist ein eigener Named Graph. Die Kennung benennt ihn dauerhaft und
                        besteht aus Kleinbuchstaben, Ziffern und Bindestrichen.
                    </p>
                    <form className={styles.createForm} onSubmit={handleCreate}>
                        <label className={styles.field}>
                            <span className={styles.fieldLabel}>Kennung</span>
                            <input
                                className={styles.input}
                                value={newId}
                                onChange={event => setNewId(event.target.value)}
                                placeholder="wohnung-heizung"
                                pattern="[a-z0-9][a-z0-9-]*"
                                maxLength={64}
                                required
                            />
                        </label>
                        <label className={styles.field}>
                            <span className={styles.fieldLabel}>Name</span>
                            <input
                                className={styles.input}
                                value={newName}
                                onChange={event => setNewName(event.target.value)}
                                placeholder="Heizung in der Wohnung"
                                maxLength={200}
                                required
                            />
                        </label>
                        <Button type="submit" variant="primary" disabled={creating}>
                            <Plus size={16} aria-hidden="true" />
                            {creating ? 'Lege an…' : 'Modell anlegen'}
                        </Button>
                    </form>
                </section>

                <section className={styles.section}>
                    <h3>Modelle</h3>
                    {isLoading ? (
                        <p className={styles.loading}>Lade Kausalmodelle…</p>
                    ) : models.length === 0 ? (
                        <div className={styles.empty}>
                            <GitBranch size={40} aria-hidden="true" />
                            <h3>Noch kein Modell</h3>
                            <p>
                                Fang mit der Frage an, die dich wirklich interessiert („bringt die
                                Nachtabsenkung etwas?&ldquo;), und modelliere nur die Größen, die
                                dafür nötig sind — samt der Störgrößen, die auf beide wirken.
                                Was du erfasst, siehst du unter{' '}
                                <Link className={styles.inlineLink} href="/graph/observations">Beobachtungen</Link>.
                            </p>
                        </div>
                    ) : (
                        <ul className={styles.list}>
                            {models.map(model => (
                                <ModelCard
                                    key={model.id}
                                    model={model}
                                    observedVariables={data?.observedVariables ?? []}
                                    estimands={estimands.filter(estimand => estimand.modelId === model.id)}
                                    studies={studies}
                                    archive={data?.archive ?? []}
                                    hypotheses={hypotheses.filter(entry => entry.modelId === model.id)}
                                    comparison={comparisons.find(entry => entry.modelId === model.id)?.entries ?? []}
                                    lastProposal={lastProposal[model.id] ?? null}
                                    proposing={proposing === model.id}
                                    busy={busy}
                                    onOperation={operation => runOperation(model.id, operation)}
                                    onAsk={askQuestion}
                                    onRemoveEstimand={removeQuestion}
                                    onDiscardArchive={discardArchiveEntry}
                                    onPropose={() => proposeFor(model.id)}
                                    onAdopt={adoptHypothesis}
                                    onDiscardHypothesis={discardHypothesis}
                                    onCopy={() => handleCopy(model)}
                                    onRemove={() => setRemoving(model)}
                                />
                            ))}
                        </ul>
                    )}
                </section>

                {orphaned.length > 0 && (
                    <section className={styles.section}>
                        <h3>Vorschläge ohne Modell</h3>
                        <p className={styles.sectionHint}>
                            Diese Vorschläge in <code>causal-hypotheses</code> beziehen sich auf ein
                            Modell, das es nicht mehr gibt. Ohne DAG lässt sich über sie nichts sagen —
                            weder ob sie einen Kreis schlössen noch ob ihr Effekt bestimmbar wäre.
                            Verwirf sie, oder leg das Modell erneut an.
                        </p>
                        <ul className={styles.hypothesisList}>
                            {orphaned.map(hypothesis => (
                                <li key={hypothesis.id} className={`${styles.hypothesis} ${styles.hypothesisRejected}`}>
                                    <div className={styles.hypothesisHead}>
                                        <span className={styles.hypothesisEdge}>
                                            {hypothesis.fromName}
                                            <span aria-hidden="true"> → </span>
                                            {hypothesis.toName}
                                        </span>
                                        <span className={styles.badges}>
                                            <span className={`${styles.badge} ${styles.badgeMissing}`}>
                                                Modell {hypothesis.modelId || 'unbekannt'} fehlt
                                            </span>
                                            <span className={`${styles.badge} ${styles.badgeClass}`}>
                                                {PROPOSAL_SOURCE_LABEL[hypothesis.source]}
                                            </span>
                                        </span>
                                    </div>
                                    <div className={styles.hypothesisActions}>
                                        <Button
                                            variant="ghost"
                                            disabled={busy}
                                            onClick={() => discardHypothesis(hypothesis.id)}
                                        >
                                            <Trash2 size={16} aria-hidden="true" />
                                            <span className={styles.visuallyHidden}>
                                                Vorschlag {hypothesis.fromName} nach {hypothesis.toName}{' '}
                                            </span>
                                            Verwerfen
                                        </Button>
                                    </div>
                                </li>
                            ))}
                        </ul>
                    </section>
                )}

                {findings.length > 0 && (
                    <section className={styles.section}>
                        <h3>Befunde der Shapes</h3>
                        <p className={styles.sectionHint}>
                            SHACL prüft die billigen Dinge: Klassenwerte, Typen, Form des Zeitversatzes.
                            Befunde blockieren nichts — sie sagen, wo ein Modell später nicht tragen wird.
                        </p>
                        <ul className={styles.findingList}>
                            {findings.map((finding, index) => (
                                <li key={`${finding.focusNode ?? ''}-${index}`} className={styles.finding}>
                                    <AlertTriangle size={16} aria-hidden="true" />
                                    <span>
                                        {finding.message}
                                        {finding.focusNode && (
                                            <span className={styles.source}> {finding.focusNode}</span>
                                        )}
                                    </span>
                                </li>
                            ))}
                        </ul>
                    </section>
                )}
            </div>

            <ConfirmDialog
                isOpen={removing !== null}
                title="Kausalmodell entfernen?"
                message={removing
                    ? `„${removing.name}" wird mit allen ${removing.edges.length} Kanten gelöscht. ` +
                      'Erfasste Beobachtungen bleiben erhalten — verworfen wird nur die Annahme.'
                    : ''}
                confirmText="Entfernen"
                cancelText="Abbrechen"
                variant="danger"
                onConfirm={handleRemove}
                onCancel={() => setRemoving(null)}
            />
        </AppShell>
    );
}
