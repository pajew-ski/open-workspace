'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Copy, GitBranch, Plus, Trash2 } from 'lucide-react';
import { AppShell } from '@/components/layout';
import { Button, ConfirmDialog } from '@/components/ui';
import { useToast } from '@/components/ui/Toast';
import styles from './page.module.css';

/**
 * Kausalmodelle (CAUSAL_LAYER_SPEC §5, Meilenstein C0) — read-only.
 *
 * Die Seite zeigt Annahmen, keine Ergebnisse. Ein Modell ist ein
 * gerichteter Graph aus Variablen und kausalen Kanten, den ein Mensch
 * verantwortet (Invariante C1: „Struktur ist Annahme, nicht Ergebnis").
 * Jede Kante trägt sichtbar ihre Herkunftsklasse, damit eine Hypothese
 * nie aussieht wie ein bestätigter Effekt (Invariante C2).
 *
 * Was hier bewusst FEHLT, weil es noch nicht gebaut ist: Effektstärken,
 * Konfidenzintervalle, Identifizierbarkeit, Adjustment Sets. Sie kommen
 * mit C1 und C4 — bis dahin behauptet die Oberfläche sie nicht.
 */

type EdgeClass = 'hypothesis' | 'structural' | 'learned' | 'asserted';
type EvidenceLevel = 'hypothesis' | 'estimated' | 'refuted-clean';

interface CausalVariable {
    iri: string;
    name: string;
    unit?: string;
    inModel: boolean;
    observation?: { count: number; from?: string; through?: string };
}

interface CausalEdge {
    from: string;
    to: string;
    reifier?: string;
    edgeClass: EdgeClass | null;
    edgeClassRaw?: string;
    evidenceLevel: EvidenceLevel | null;
    evidenceLevelRaw?: string;
    temporalLag?: string;
}

interface CausalModel {
    id: string;
    iri: string;
    graph: string;
    name: string;
    description?: string;
    created?: string;
    modified?: string;
    variables: CausalVariable[];
    edges: CausalEdge[];
}

interface ValidationResult {
    focusNode?: string;
    path?: string;
    message: string;
    severity: string;
    sourceShape?: string;
}

interface CausalResponse {
    models: CausalModel[];
    hypotheses: CausalEdge[];
    hypothesesGraph: string;
    validation: { conforms: boolean; graphs: string[]; results: ValidationResult[] };
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

function shortName(model: CausalModel, iri: string): string {
    return model.variables.find(variable => variable.iri === iri)?.name
        ?? decodeURIComponent(iri.split('/').filter(Boolean).pop() ?? iri);
}

/**
 * Ebenen für die Darstellung — bewusst KEINE topologische Analyse: Der
 * Wert wird nur zum Zeichnen gebraucht und liegt deshalb nirgends im
 * Graphen (Invariante 2). Die Iterationsgrenze macht das Verfahren auch
 * bei einem versehentlich zyklisch modellierten Graphen endlich; ob ein
 * Modell azyklisch ist, entscheidet C1 und nicht diese Funktion.
 */
function layerOf(variables: readonly string[], edges: readonly CausalEdge[]): Map<string, number> {
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

function DagDiagram({ model }: { model: CausalModel }) {
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
                                className={styles.node}
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

/** Vorlage für den SPARQL-Editor: der vorgesehene Schreibweg in C0. */
function updateTemplate(model: CausalModel): string {
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

function EdgeBadges({ edge }: { edge: CausalEdge }) {
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
            <span className={styles.badge}>
                {edge.evidenceLevel
                    ? EVIDENCE_LABEL[edge.evidenceLevel]
                    : edge.evidenceLevelRaw ?? 'unbelegt'}
            </span>
            {edge.temporalLag && <span className={styles.badge}>Versatz {formatLag(edge.temporalLag)}</span>}
        </div>
    );
}

export default function GraphCausalPage() {
    const toast = useToast();
    const queryClient = useQueryClient();
    const [creating, setCreating] = useState(false);
    const [newId, setNewId] = useState('');
    const [newName, setNewName] = useState('');
    const [removing, setRemoving] = useState<CausalModel | null>(null);

    const { data, isLoading } = useQuery<CausalResponse>({
        queryKey: ['graph-causal'],
        queryFn: () => fetchJson('/api/graph/causal'),
    });

    const models = data?.models ?? [];
    const hypotheses = data?.hypotheses ?? [];
    const findings = (data?.validation.results ?? []).filter(result => !result.severity.endsWith('Info'));

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
            toast.success(`Modell „${newName.trim()}" angelegt. Die Struktur schreibst du im SPARQL-Editor.`);
            setNewId('');
            setNewName('');
        } catch (error) {
            toast.error(error instanceof Error ? error.message : 'Anlegen fehlgeschlagen');
        } finally {
            setCreating(false);
            invalidate();
        }
    };

    const handleCopy = async (model: CausalModel) => {
        const template = updateTemplate(model);
        try {
            await navigator.clipboard.writeText(template);
            toast.success('Vorlage kopiert — im SPARQL-Editor einfügen und anpassen.');
        } catch {
            toast.error('Kopieren nicht möglich. Die Vorlage steht unter „Struktur schreiben" zum Markieren.');
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
                        welche Größe auf welche wirkt — und genau daraus folgt später, worüber
                        adjustiert werden muss. Wer den Graphen ändert, ändert das Ergebnis; das ist
                        die Aussage und keine Schwäche. Jede Kante zeigt deshalb offen, woher sie
                        kommt: gesetzt, strukturell, gelernt oder bloß vorgeschlagen.
                    </p>
                    <p>
                        Diese Ansicht ist <strong>read-only</strong>. Modelle entstehen hier, ihre
                        Struktur schreibst du im{' '}
                        <Link className={styles.inlineLink} href="/graph/sparql">SPARQL-Editor</Link>{' '}
                        — jedes Modell bringt dafür eine Vorlage mit. Schätzungen, Konfidenz&shy;intervalle
                        und Identifizierbarkeit gibt es noch nicht; sie kämen sonst als Zahlen daher,
                        für die niemand geradestehen kann.
                    </p>
                </div>

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
                                <li key={model.id} className={styles.card}>
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
                                    </div>

                                    {model.edges.length > 0 && <DagDiagram model={model} />}

                                    {model.edges.length === 0 ? (
                                        <p className={styles.hint}>
                                            Noch keine Kante. Ohne Kanten ist ein Modell eine Liste, kein Modell —
                                            die Vorlage unten zeigt, wie eine Kante samt Herkunft geschrieben wird.
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
                                                            <span className={`${styles.badge} ${styles.badgeMissing}`}>
                                                                nicht erfasst
                                                            </span>
                                                        )}
                                                        {!variable.inModel && (
                                                            <span className={`${styles.badge} ${styles.badgeMissing}`}>
                                                                nur an einer Kante
                                                            </span>
                                                        )}
                                                    </span>
                                                </li>
                                            ))}
                                        </ul>
                                    )}

                                    <details className={styles.template}>
                                        <summary>Struktur schreiben (SPARQL-Vorlage)</summary>
                                        <pre className={styles.templateCode}>{updateTemplate(model)}</pre>
                                    </details>

                                    <div className={styles.actions}>
                                        <Button variant="secondary" onClick={() => handleCopy(model)}>
                                            <Copy size={16} aria-hidden="true" />
                                            Vorlage kopieren
                                        </Button>
                                        <Link className={styles.buttonLink} href="/graph/sparql">
                                            SPARQL-Editor öffnen
                                        </Link>
                                        <Button variant="ghost" onClick={() => setRemoving(model)}>
                                            <Trash2 size={16} aria-hidden="true" />
                                            Modell entfernen
                                        </Button>
                                    </div>
                                </li>
                            ))}
                        </ul>
                    )}
                </section>

                {hypotheses.length > 0 && (
                    <section className={styles.section}>
                        <h3>Hypothesen</h3>
                        <p className={styles.sectionHint}>
                            Vorschläge aus <code>causal-hypotheses</code>. Sie gehören zu keinem Modell und
                            zählen als Hörensagen, bis jemand sie in ein Modell übernimmt — deshalb stehen
                            sie hier getrennt und nicht im DAG.
                        </p>
                        <ul className={styles.edgeList}>
                            {hypotheses.map(edge => (
                                <li key={`${edge.from}->${edge.to}`} className={styles.edgeRow}>
                                    <span className={styles.edgeText}>
                                        {decodeURIComponent(edge.from.split('/').pop() ?? edge.from)}
                                        <span aria-hidden="true"> → </span>
                                        {decodeURIComponent(edge.to.split('/').pop() ?? edge.to)}
                                    </span>
                                    <EdgeBadges edge={edge} />
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
