'use client';

/**
 * SPARQL-Editor (GRAPH_CORE_SPEC §7.1 — M2-Rest).
 *
 * - Syntax-Highlighting über Prism (language-sparql) als Overlay unter
 *   einer transparenten Textarea, scroll-synchron.
 * - Prefix-Autovervollständigung aus graph/vocab: die ow:-Terme werden
 *   einmalig per SPARQL vom eigenen Endpoint geladen; dazu Standard-
 *   Prefixe und SPARQL-Schlüsselwörter.
 * - Ergebnisse: SELECT als Tabelle, ASK als Wahrheitswert,
 *   CONSTRUCT/DESCRIBE als Graph-Ansicht (Auflösung wie gespeicherte
 *   Views, /api/graph/views/preview), Updates über den geschützten
 *   Update-Pfad des Endpoints.
 * - Gespeicherte Queries sind ow:QueryView-Entitäten in graph/meta
 *   (dieselben wie auf der Graph-Seite) — Laden, Speichern, Löschen.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Play, Save, Trash2, X } from 'lucide-react';
import { AppShell } from '@/components/layout/AppShell';
import { Button } from '@/components/ui';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { useToast } from '@/components/ui/Toast';
import { classifySparql, type SparqlOperation } from '@/lib/graph/sparql/classify';
import { OW_VOCAB_BASE, PREFIXES, SPARQL_PREFIXES } from '@/lib/graph/vocab';
import styles from './page.module.css';

const ForceGraph2D = dynamic(() => import('react-force-graph-2d'), { ssr: false });

let Prism: typeof import('prismjs') | null = null;
if (typeof window !== 'undefined') {
    import('prismjs').then(async mod => {
        Prism = mod.default ?? mod;
        await import('prismjs/components/prism-turtle');
        await import('prismjs/components/prism-sparql');
    }).catch(() => {
        Prism = null;
    });
}

interface QueryViewRecord {
    id: string;
    name: string;
    queryText: string;
    layoutMethod: 'force-directed' | 'hierarchical' | 'radial';
}

interface SparqlJsonTerm {
    type: string;
    value?: unknown;
    'xml:lang'?: string;
    datatype?: string;
}

interface BindingsResult {
    kind: 'bindings';
    variables: string[];
    rows: Array<Record<string, SparqlJsonTerm>>;
}

interface BooleanResult {
    kind: 'boolean';
    value: boolean;
}

interface GraphResult {
    kind: 'graph';
    nodes: Array<{ id: string; name: string; type: string }>;
    links: Array<{ source: string; target: string; type: string }>;
    quadCount: number;
    truncated: boolean;
}

interface UpdateResult {
    kind: 'update';
}

type EditorResult = BindingsResult | BooleanResult | GraphResult | UpdateResult;

interface Suggestion {
    insert: string;
    label: string;
    detail?: string;
}

const KEYWORDS = [
    'SELECT', 'CONSTRUCT', 'DESCRIBE', 'ASK', 'WHERE', 'FILTER', 'OPTIONAL', 'UNION',
    'GRAPH', 'ORDER BY', 'GROUP BY', 'LIMIT', 'OFFSET', 'DISTINCT', 'PREFIX', 'BIND', 'VALUES',
];

const DEFAULT_QUERY = `PREFIX schema: <https://schema.org/>\nPREFIX ow: <${OW_VOCAB_BASE}>\n\nSELECT ?titel ?status WHERE {\n  ?aufgabe a ow:Task ;\n           schema:name ?titel ;\n           ow:workflowStatus ?status .\n}\nORDER BY ?status ?titel`;

const NODE_COLORS = ['#00674F', '#7C5CBF', '#B3541E', '#2B6CB0', '#8D6E63', '#C2185B', '#455A64'];

function nodeColor(type: string): string {
    let hash = 0;
    for (const char of type) hash = (hash * 31 + char.charCodeAt(0)) % 100_000;
    return NODE_COLORS[hash % NODE_COLORS.length];
}

function termText(term: SparqlJsonTerm | undefined): string {
    if (!term) return '';
    if (typeof term.value === 'string') return term.value;
    if (term.value && typeof term.value === 'object') return JSON.stringify(term.value);
    return '';
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
    const response = await fetch(url, init);
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
        const message = (payload as { error?: string; details?: string } | null);
        throw new Error(message?.details ? `${message.error} — ${message.details}` : message?.error ?? `HTTP ${response.status}`);
    }
    return payload as T;
}

export default function SparqlEditorPage() {
    const queryClient = useQueryClient();
    const toast = useToast();
    const [queryText, setQueryText] = useState(DEFAULT_QUERY);
    const [highlighted, setHighlighted] = useState('');
    const [running, setRunning] = useState(false);
    const [result, setResult] = useState<EditorResult | null>(null);
    const [runError, setRunError] = useState<string | null>(null);
    const [elapsedMs, setElapsedMs] = useState<number | null>(null);
    const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
    const [tokenStart, setTokenStart] = useState(0);
    const [saving, setSaving] = useState(false);
    const [saveName, setSaveName] = useState('');
    const [saveLayout, setSaveLayout] = useState<QueryViewRecord['layoutMethod']>('force-directed');
    const [saveBusy, setSaveBusy] = useState(false);
    const [deleting, setDeleting] = useState<QueryViewRecord | null>(null);
    const textareaRef = useRef<HTMLTextAreaElement | null>(null);
    const highlightRef = useRef<HTMLPreElement | null>(null);
    const loadedFromParam = useRef(false);

    const operation: SparqlOperation = useMemo(() => classifySparql(queryText), [queryText]);

    const { data: viewsData } = useQuery<{ views: QueryViewRecord[] }>({
        queryKey: ['graph-views'],
        queryFn: () => fetchJson('/api/graph/views'),
    });

    // ow:-Terme aus graph/vocab für die Autovervollständigung (SPEC §7.1).
    const { data: vocabTerms } = useQuery<Suggestion[]>({
        queryKey: ['graph-vocab-terms'],
        staleTime: Infinity,
        queryFn: async () => {
            const body = new URLSearchParams({
                query: `PREFIX rdfs: <${PREFIXES.rdfs}>\nSELECT DISTINCT ?term ?label WHERE { ?term rdfs:label ?label . FILTER(STRSTARTS(STR(?term), "${OW_VOCAB_BASE}")) FILTER(LANGMATCHES(LANG(?label), "de")) } ORDER BY ?term`,
            });
            const payload = await fetchJson<{ results: { bindings: Array<Record<string, SparqlJsonTerm>> } }>(
                '/api/graph/sparql',
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/sparql-results+json' },
                    body,
                },
            );
            return payload.results.bindings.map(row => {
                const iri = termText(row.term);
                return {
                    insert: `ow:${iri.slice(OW_VOCAB_BASE.length)}`,
                    label: `ow:${iri.slice(OW_VOCAB_BASE.length)}`,
                    detail: termText(row.label),
                };
            });
        },
    });

    // Query aus ?view=<id> laden (Verweis von der Graph-Seite).
    useEffect(() => {
        if (loadedFromParam.current || !viewsData) return;
        const viewId = new URLSearchParams(window.location.search).get('view');
        if (!viewId) return;
        const view = viewsData.views.find(v => v.id === viewId);
        if (view) {
            setQueryText(view.queryText);
            loadedFromParam.current = true;
        }
    }, [viewsData]);

    // Prism-Highlighting (Fallback: roher Text, falls Prism nicht lädt).
    useEffect(() => {
        const grammar = Prism?.languages?.sparql;
        if (Prism && grammar) {
            setHighlighted(Prism.highlight(queryText, grammar, 'sparql'));
        } else {
            setHighlighted('');
            if (typeof window !== 'undefined') {
                // Prism lädt asynchron — einmal nachziehen.
                const timer = window.setTimeout(() => {
                    const late = Prism?.languages?.sparql;
                    if (Prism && late) setHighlighted(Prism.highlight(queryText, late, 'sparql'));
                }, 300);
                return () => window.clearTimeout(timer);
            }
        }
    }, [queryText]);

    const syncScroll = useCallback(() => {
        const textarea = textareaRef.current;
        const highlight = highlightRef.current;
        if (textarea && highlight) {
            highlight.scrollTop = textarea.scrollTop;
            highlight.scrollLeft = textarea.scrollLeft;
        }
    }, []);

    const updateSuggestions = useCallback((value: string, caret: number) => {
        const before = value.slice(0, caret);
        const prefixed = before.match(/([A-Za-z][\w-]*):([\w-]*)$/);
        if (prefixed) {
            const [full, prefix, local] = prefixed;
            if (prefix === 'ow' && vocabTerms) {
                const matches = vocabTerms
                    .filter(term => term.insert.toLowerCase().startsWith(`ow:${local.toLowerCase()}`))
                    .slice(0, 8);
                setSuggestions(matches);
                setTokenStart(caret - full.length);
                return;
            }
            setSuggestions([]);
            return;
        }
        const word = before.match(/(?:^|[\s({])([A-Za-z][\w-]*)$/);
        if (word) {
            const token = word[1];
            const lower = token.toLowerCase();
            const prefixSuggestions: Suggestion[] = Object.entries(PREFIXES)
                .filter(([name]) => name.startsWith(lower))
                .map(([name, iri]) => ({ insert: `${name}:`, label: `${name}:`, detail: iri }));
            const keywordSuggestions: Suggestion[] = KEYWORDS
                .filter(keyword => keyword.toLowerCase().startsWith(lower) && keyword.toLowerCase() !== lower)
                .map(keyword => ({ insert: keyword, label: keyword }));
            const merged = [...prefixSuggestions, ...keywordSuggestions].slice(0, 8);
            setSuggestions(token.length >= 2 ? merged : []);
            setTokenStart(caret - token.length);
            return;
        }
        setSuggestions([]);
    }, [vocabTerms]);

    const applySuggestion = useCallback((suggestion: Suggestion) => {
        const textarea = textareaRef.current;
        if (!textarea) return;
        const caret = textarea.selectionStart;
        const next = `${queryText.slice(0, tokenStart)}${suggestion.insert}${queryText.slice(caret)}`;
        setQueryText(next);
        setSuggestions([]);
        requestAnimationFrame(() => {
            textarea.focus();
            const position = tokenStart + suggestion.insert.length;
            textarea.setSelectionRange(position, position);
        });
    }, [queryText, tokenStart]);

    const insertPrefixes = useCallback(() => {
        setQueryText(current => `${SPARQL_PREFIXES}\n\n${current}`);
        toast.info('Standard-Prefixe eingefügt');
    }, [toast]);

    const runQuery = useCallback(async () => {
        setRunning(true);
        setRunError(null);
        setResult(null);
        setElapsedMs(null);
        const started = performance.now();
        try {
            if (operation === 'construct' || operation === 'describe') {
                const payload = await fetchJson<Omit<GraphResult, 'kind'>>('/api/graph/views/preview', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ queryText }),
                });
                setResult({ kind: 'graph', ...payload });
            } else if (operation === 'update') {
                const response = await fetch('/api/graph/sparql', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                    body: new URLSearchParams({ update: queryText }),
                });
                if (!response.ok) {
                    throw new Error((await response.text()).trim() || `HTTP ${response.status}`);
                }
                setResult({ kind: 'update' });
            } else {
                const response = await fetch('/api/graph/sparql', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/sparql-results+json' },
                    body: new URLSearchParams({ query: queryText }),
                });
                if (!response.ok) {
                    throw new Error((await response.text()).trim() || `HTTP ${response.status}`);
                }
                const payload = await response.json() as {
                    head?: { vars?: string[] };
                    boolean?: boolean;
                    results?: { bindings: Array<Record<string, SparqlJsonTerm>> };
                };
                if (typeof payload.boolean === 'boolean') {
                    setResult({ kind: 'boolean', value: payload.boolean });
                } else {
                    setResult({
                        kind: 'bindings',
                        variables: payload.head?.vars ?? [],
                        rows: payload.results?.bindings ?? [],
                    });
                }
            }
            setElapsedMs(Math.round(performance.now() - started));
        } catch (error) {
            setRunError(error instanceof Error ? error.message : String(error));
        } finally {
            setRunning(false);
        }
    }, [operation, queryText]);

    const saveQuery = useCallback(async () => {
        setSaveBusy(true);
        try {
            await fetchJson('/api/graph/views', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: saveName.trim(), queryText, layoutMethod: saveLayout }),
            });
            toast.success(`Query „${saveName.trim()}" gespeichert`);
            setSaving(false);
            setSaveName('');
            queryClient.invalidateQueries({ queryKey: ['graph-views'] });
        } catch (error) {
            toast.error(error instanceof Error ? error.message : 'Speichern fehlgeschlagen');
        } finally {
            setSaveBusy(false);
        }
    }, [queryClient, queryText, saveLayout, saveName, toast]);

    const deleteView = useCallback(async (view: QueryViewRecord) => {
        try {
            await fetchJson(`/api/graph/views/${view.id}`, { method: 'DELETE' });
            toast.success(`Query „${view.name}" gelöscht`);
            queryClient.invalidateQueries({ queryKey: ['graph-views'] });
        } catch (error) {
            toast.error(error instanceof Error ? error.message : 'Löschen fehlgeschlagen');
        } finally {
            setDeleting(null);
        }
    }, [queryClient, toast]);

    const graphData = useMemo(() => {
        if (result?.kind !== 'graph') return { nodes: [], links: [] };
        return {
            nodes: result.nodes.map(node => ({ ...node, color: nodeColor(node.type), val: 2 })),
            links: result.links.map(link => ({ ...link })),
        };
    }, [result]);

    const operationLabel: Record<SparqlOperation, string> = {
        select: 'SELECT — Ergebnistabelle',
        ask: 'ASK — Wahrheitswert',
        construct: 'CONSTRUCT — Graph-Ansicht',
        describe: 'DESCRIBE — Graph-Ansicht',
        update: 'UPDATE — schreibt in den Store',
        unknown: 'Query-Form unbekannt',
    };

    return (
        <AppShell title="SPARQL-Editor">
            <div className={styles.container}>
                <header className={styles.header}>
                    <h2>SPARQL-Editor</h2>
                    <p>
                        Fragt den Store direkt ab (SPARQL 1.1, erlaubtes Dataset wird injiziert — <code>presentation</code>,{' '}
                        <code>inferred</code> und <code>acl</code> bleiben außen vor). Gespeicherte Queries sind{' '}
                        <code>ow:QueryView</code>-Entitäten im Graphen und erscheinen auch im{' '}
                        <Link className={styles.inlineLink} href="/graph">Wissensgraphen</Link>.{' '}
                        <code>SERVICE &lt;url&gt;</code> läuft gegen die{' '}
                        <Link className={styles.inlineLink} href="/graph/federation">föderierten Endpoints</Link>{' '}
                        — nur registrierte Ziele, mit Zeitbudget und Ergebnis-Limit.
                    </p>
                </header>

                <section className={styles.editorSection} aria-label="Query-Editor">
                    <label className={styles.editorLabel} htmlFor="sparql-editor-input">
                        SPARQL-Query <span className={styles.operationTag}>{operationLabel[operation]}</span>
                    </label>
                    <div className={styles.editorShell}>
                        {/* tabIndex -1: Chromium macht Scroll-Container sonst
                            fokussierbar — ein aria-hidden-Layer darf das nie sein. */}
                        <pre ref={highlightRef} className={styles.highlightLayer} aria-hidden="true" tabIndex={-1}>
                            <code
                                className="language-sparql"
                                // Prism-Ausgabe ist escaptes HTML aus eigener Erzeugung.
                                dangerouslySetInnerHTML={{ __html: `${highlighted || escapeHtml(queryText)}\n` }}
                            />
                        </pre>
                        <textarea
                            id="sparql-editor-input"
                            ref={textareaRef}
                            className={styles.editorInput}
                            value={queryText}
                            spellCheck={false}
                            autoCapitalize="off"
                            autoCorrect="off"
                            onChange={event => {
                                setQueryText(event.target.value);
                                updateSuggestions(event.target.value, event.target.selectionStart);
                            }}
                            onScroll={syncScroll}
                            onKeyDown={event => {
                                if (event.key === 'Escape' && suggestions.length > 0) {
                                    event.preventDefault();
                                    setSuggestions([]);
                                }
                                if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                                    event.preventDefault();
                                    void runQuery();
                                }
                            }}
                            onBlur={() => {
                                // Klicks auf Vorschläge zulassen (mousedown feuert vorher).
                                window.setTimeout(() => setSuggestions([]), 150);
                            }}
                        />
                    </div>
                    {suggestions.length > 0 && (
                        <ul className={styles.suggestions} aria-label="Vervollständigungen">
                            {suggestions.map(suggestion => (
                                <li key={suggestion.insert}>
                                    <button
                                        type="button"
                                        className={styles.suggestion}
                                        onMouseDown={event => {
                                            event.preventDefault();
                                            applySuggestion(suggestion);
                                        }}
                                    >
                                        <span className={styles.suggestionLabel}>{suggestion.label}</span>
                                        {suggestion.detail && <span className={styles.suggestionDetail}>{suggestion.detail}</span>}
                                    </button>
                                </li>
                            ))}
                        </ul>
                    )}
                    <div className={styles.actions}>
                        <Button variant="primary" onClick={() => void runQuery()} disabled={running || queryText.trim() === ''}>
                            <Play size={16} aria-hidden="true" /> {running ? 'Läuft…' : 'Ausführen'}
                        </Button>
                        <Button variant="secondary" onClick={insertPrefixes}>Prefixe einfügen</Button>
                        <Button
                            variant="secondary"
                            onClick={() => setSaving(true)}
                            disabled={queryText.trim() === '' || operation === 'update' || operation === 'unknown'}
                        >
                            <Save size={16} aria-hidden="true" /> Speichern
                        </Button>
                    </div>
                    <p className={styles.hint}>Strg/Cmd + Enter führt aus. Vervollständigung: Prefixe tippen (z. B. <code>sch…</code>) oder <code>ow:</code> für Vokabular-Terme.</p>
                </section>

                <section className={styles.resultSection} aria-label="Ergebnis" aria-live="polite">
                    {runError && <p className={styles.error} role="alert">{runError}</p>}
                    {!runError && result && (
                        <>
                            <p className={styles.resultMeta}>
                                {result.kind === 'bindings' && `${result.rows.length} Zeile(n)`}
                                {result.kind === 'graph' && `${result.nodes.length} Knoten, ${result.links.length} Kanten (${result.quadCount} Quads${result.truncated ? ', gekappt' : ''})`}
                                {result.kind === 'boolean' && 'ASK-Ergebnis'}
                                {result.kind === 'update' && 'Update ausgeführt'}
                                {elapsedMs !== null && ` · ${elapsedMs} ms`}
                            </p>
                            {result.kind === 'boolean' && (
                                <p className={styles.booleanResult}>{result.value ? 'wahr' : 'falsch'}</p>
                            )}
                            {result.kind === 'update' && (
                                <p className={styles.booleanResult}>Der Store wurde aktualisiert (systemverwaltete Graphen sind geschützt).</p>
                            )}
                            {result.kind === 'bindings' && (
                                <div className={styles.tableWrap} tabIndex={0} role="region" aria-label="Ergebnistabelle">
                                    <table className={styles.resultTable}>
                                        <thead>
                                            <tr>
                                                {result.variables.map(variable => <th key={variable} scope="col">?{variable}</th>)}
                                            </tr>
                                        </thead>
                                        <tbody>
                                            {result.rows.map((row, index) => (
                                                <tr key={index}>
                                                    {result.variables.map(variable => (
                                                        <td key={variable}>{termText(row[variable])}</td>
                                                    ))}
                                                </tr>
                                            ))}
                                        </tbody>
                                    </table>
                                    {result.rows.length === 0 && <p className={styles.emptyResult}>Keine Treffer.</p>}
                                </div>
                            )}
                            {result.kind === 'graph' && (
                                <div className={styles.graphWrap} aria-label={`Graph-Ergebnis mit ${result.nodes.length} Knoten`}>
                                    <ForceGraph2D
                                        graphData={graphData}
                                        nodeLabel={node => {
                                            const typed = node as { name?: string; type?: string };
                                            return `${typed.name ?? ''} (${typed.type ?? ''})`;
                                        }}
                                        linkLabel={link => (link as { type?: string }).type ?? ''}
                                        linkDirectionalArrowLength={4}
                                        height={360}
                                    />
                                </div>
                            )}
                        </>
                    )}
                    {!runError && !result && <p className={styles.emptyResult}>Noch kein Ergebnis — führe eine Query aus.</p>}
                </section>

                <section className={styles.savedSection} aria-label="Gespeicherte Queries">
                    <h3>Gespeicherte Queries</h3>
                    {(viewsData?.views ?? []).length === 0 && (
                        <p className={styles.emptyResult}>Noch keine gespeicherten Queries.</p>
                    )}
                    <ul className={styles.savedList}>
                        {(viewsData?.views ?? []).map(view => (
                            <li key={view.id} className={styles.savedItem}>
                                <button
                                    type="button"
                                    className={styles.savedLoad}
                                    onClick={() => {
                                        setQueryText(view.queryText);
                                        toast.info(`Query „${view.name}" geladen`);
                                    }}
                                >
                                    <span className={styles.savedName}>{view.name}</span>
                                    <span className={styles.savedKind}>{classifySparql(view.queryText).toUpperCase()}</span>
                                </button>
                                <button
                                    type="button"
                                    className={styles.savedDelete}
                                    aria-label={`Query "${view.name}" löschen`}
                                    onClick={() => setDeleting(view)}
                                >
                                    <Trash2 size={16} aria-hidden="true" />
                                </button>
                            </li>
                        ))}
                    </ul>
                </section>

                {saving && (
                    <div className={styles.overlay} role="dialog" aria-modal="true" aria-label="Query speichern">
                        <div className={styles.dialog}>
                            <div className={styles.dialogHead}>
                                <h3>Query speichern</h3>
                                <button type="button" className={styles.dialogClose} aria-label="Schließen" onClick={() => setSaving(false)}>
                                    <X size={18} aria-hidden="true" />
                                </button>
                            </div>
                            <label className={styles.field}>
                                <span>Name</span>
                                <input
                                    type="text"
                                    value={saveName}
                                    onChange={event => setSaveName(event.target.value)}
                                    placeholder="z. B. Offene Aufgaben"
                                />
                            </label>
                            {(operation === 'construct' || operation === 'describe') && (
                                <label className={styles.field}>
                                    <span>Layout-Verfahren (Graph-View)</span>
                                    <select value={saveLayout} onChange={event => setSaveLayout(event.target.value as QueryViewRecord['layoutMethod'])}>
                                        <option value="force-directed">kräftebasiert</option>
                                        <option value="hierarchical">hierarchisch</option>
                                        <option value="radial">radial</option>
                                    </select>
                                </label>
                            )}
                            <p className={styles.hint}>
                                Gespeichert als <code>ow:QueryView</code> in <code>graph/meta</code> — CONSTRUCT/DESCRIBE
                                erscheinen zusätzlich als Views im Wissensgraphen.
                            </p>
                            <div className={styles.dialogButtons}>
                                <Button variant="secondary" onClick={() => setSaving(false)}>Abbrechen</Button>
                                <Button variant="primary" onClick={() => void saveQuery()} disabled={saveBusy || saveName.trim() === ''}>
                                    {saveBusy ? 'Speichert…' : 'Speichern'}
                                </Button>
                            </div>
                        </div>
                    </div>
                )}

                <ConfirmDialog
                    isOpen={deleting !== null}
                    title="Query löschen?"
                    message={deleting ? `Die gespeicherte Query „${deleting.name}" wird endgültig gelöscht.` : ''}
                    confirmText="Löschen"
                    variant="danger"
                    onConfirm={() => deleting && void deleteView(deleting)}
                    onCancel={() => setDeleting(null)}
                />
            </div>
        </AppShell>
    );
}

function escapeHtml(value: string): string {
    return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}
