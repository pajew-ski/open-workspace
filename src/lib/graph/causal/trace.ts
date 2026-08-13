/**
 * Causal Path Tracing (CAUSAL_LAYER_SPEC §9, Meilenstein C2) — pur.
 *
 * Dieses Modul beantwortet die Frage, die vor jedem kausal geerdeten
 * Retrieval steht: **Welche Größen gehören zu dieser Frage, und über
 * welchen Weg?** Es liefert keine Dokumente und kennt keinen Store — es
 * kennt nur den DAG (eine Annahme, Invariante C1) und rechnet mit den
 * Bausteinen aus C1 (`dag.ts`, `dsep.ts`). Damit läuft es wie der übrige
 * Tier-1-Kern in allen drei Runtimes, auch im Browser.
 *
 * Vier Modi, wörtlich aus §9:
 *
 *  - `ancestors` — was auf die Wirkung einwirkt (die Ursachenseite),
 *  - `descendants` — was von der Ursache abhängt (die Folgenseite),
 *  - `paths` — die Wege zwischen Ursache und Wirkung, klassifiziert in
 *    Wirkweg und Hintertür,
 *  - `markov-blanket` — der Kragen aus Eltern, Kindern und Mit-Eltern:
 *    genau die Menge, gegeben die der Knoten vom Rest unabhängig ist.
 *
 * **Die Konditionierung ist der Kern** (§9 `blockedBy`): Was gegeben
 * `blockedBy` d-separiert ist, fällt heraus — und zwar nachweislich, mit
 * Namen und Begründung in `dropped`. Genau das unterscheidet einen
 * kausalen Kontext von einer semantischen Wolke: Ein Knoten, der über
 * einen geschlossenen Weg hängt, trägt zur Frage nichts bei, egal wie
 * ähnlich er klingt.
 *
 * Was hier NICHT passiert: schätzen, gewichten nach Daten, Effekte
 * behaupten. Die Zahlen kommen mit C4, und bis dahin sagt dieses Modul
 * ausschließlich, was der Graph strukturell hergibt.
 */

import type { CausalDag } from './dag';
import { dSeparated, findPaths, type DagPath } from './dsep';

export const CAUSAL_MODES = ['ancestors', 'descendants', 'paths', 'markov-blanket'] as const;
export type CausalMode = (typeof CAUSAL_MODES)[number];

/** Rolle eines Knotens IM Trace — die Antwort auf „warum ist der dabei?". */
export type CausalRole =
    | 'treatment'
    | 'outcome'
    | 'conditioned'
    | 'ancestor'
    | 'descendant'
    | 'on-path'
    | 'blanket';

export interface CausalTraceNode {
    node: string;
    /**
     * Schritte vom Bezugsknoten (0 = er selbst). Bei `paths` zählt der
     * Abstand zum NÄHEREN der beiden Enden: Auf einem Weg zwischen
     * Ursache und Wirkung sind beide Enden gleich wichtig, und ein
     * Mediator liegt zu beiden näher als zu einem allein.
     */
    distance: number;
    role: CausalRole;
    /** Weg vom Bezugsknoten hierher, Knotenfolge inklusive beider Enden. */
    path: string[];
}

export interface CausalDrop {
    node: string;
    /**
     * `d-separated` — gegeben die Konditionierungsmenge trägt der Knoten
     * nichts mehr bei; `blocked-path` — er lag ausschließlich auf Wegen,
     * die geschlossen sind.
     */
    reason: 'd-separated' | 'blocked-path';
}

export interface CausalTraceOptions {
    mode: CausalMode;
    treatment?: string;
    outcome?: string;
    /** Konditionierungsmenge (§9) — d-separierte Knoten fallen raus. */
    blockedBy?: Iterable<string>;
    /** Höchstzahl aufgezählter Pfade (Default 24, gedeckelt wie in C1). */
    pathLimit?: number;
}

export interface CausalTraceResult {
    mode: CausalMode;
    /** Bezugsknoten der Traversierung; `null`, wenn er im Modell fehlt. */
    focus: string | null;
    treatment: string | null;
    outcome: string | null;
    /** Aufgenommene Knoten, nach Nähe und dann Name — deterministisch. */
    nodes: CausalTraceNode[];
    /** Wege zwischen Ursache und Wirkung (nur `paths`), offen wie blockiert. */
    paths: DagPath[];
    /** Was die Konditionierung herausgenommen hat, mit Grund. */
    dropped: CausalDrop[];
    /** Die wirksame Konditionierungsmenge (nur Knoten, die es gibt). */
    conditioned: string[];
    /** Pfad-Aufzählung gedeckelt? Dann ist `paths` nicht vollständig. */
    truncated: boolean;
    /** Ehrliche Hinweise, wenn der Trace nicht das tun konnte, was gefragt war. */
    notes: string[];
}

/**
 * Ungerichtete Abstände und Wege vom Bezugsknoten. Sie sind der
 * Auffangfall für Knoten, die kein Modus direkt einordnet (etwa die
 * konditionierten selbst) — und sie sind deterministisch, weil die BFS
 * die Nachbarn sortiert abarbeitet.
 */
function undirectedReach(dag: CausalDag, focus: string): Map<string, string[]> {
    const paths = new Map<string, string[]>([[focus, [focus]]]);
    const queue = [focus];
    while (queue.length > 0) {
        const node = queue.shift() as string;
        const here = paths.get(node) as string[];
        for (const next of [...dag.neighbours(node)].sort()) {
            if (paths.has(next)) continue;
            paths.set(next, [...here, next]);
            queue.push(next);
        }
    }
    return paths;
}

/** Gerichtete Wege (aufwärts über Eltern oder abwärts über Kinder). */
function directedReach(
    dag: CausalDag,
    focus: string,
    step: (node: string) => readonly string[],
): Map<string, string[]> {
    const paths = new Map<string, string[]>([[focus, [focus]]]);
    const queue = [focus];
    while (queue.length > 0) {
        const node = queue.shift() as string;
        const here = paths.get(node) as string[];
        for (const next of [...step(node)].sort()) {
            if (paths.has(next)) continue;
            paths.set(next, [...here, next]);
            queue.push(next);
        }
    }
    return paths;
}

/** Eltern, Kinder und Mit-Eltern der Kinder — der Markov-Kragen. */
function markovBlanket(dag: CausalDag, focus: string): Map<string, number> {
    const out = new Map<string, number>();
    for (const parent of dag.parents(focus)) out.set(parent, 1);
    for (const child of dag.children(focus)) {
        out.set(child, 1);
        for (const coParent of dag.parents(child)) {
            if (coParent === focus || out.has(coParent)) continue;
            out.set(coParent, 2);
        }
    }
    out.delete(focus);
    return out;
}

function roleFor(node: string, treatment: string | null, outcome: string | null, fallback: CausalRole): CausalRole {
    if (node === treatment) return 'treatment';
    if (node === outcome) return 'outcome';
    return fallback;
}

/**
 * Der Trace. Reihenfolge der Antwort ist Teil der Antwort: erst der
 * Bezugsknoten, dann nach Nähe, bei Gleichstand nach Name. Zwei gleiche
 * Anfragen auf gleichem Modell ergeben dieselbe Liste — sonst wäre ein
 * Retrieval nicht reproduzierbar (Invariante C7 in der Vorstufe).
 */
export function traceCausal(dag: CausalDag, options: CausalTraceOptions): CausalTraceResult {
    const notes: string[] = [];
    const treatment = options.treatment && dag.has(options.treatment) ? options.treatment : null;
    const outcome = options.outcome && dag.has(options.outcome) ? options.outcome : null;
    if (options.treatment && !treatment) {
        notes.push('Die angegebene Ursache steht nicht im Kausalmodell.');
    }
    if (options.outcome && !outcome) {
        notes.push('Die angegebene Wirkung steht nicht im Kausalmodell.');
    }
    const conditioned = [...new Set(options.blockedBy ?? [])].filter(node => dag.has(node)).sort();

    const empty: CausalTraceResult = {
        mode: options.mode,
        focus: null,
        treatment,
        outcome,
        nodes: [],
        paths: [],
        dropped: [],
        conditioned,
        truncated: false,
        notes,
    };

    // Bezugsknoten je Modus. `paths` braucht beide Enden — ohne sie gibt es
    // keinen Weg, über den sich reden ließe.
    if (options.mode === 'paths' && (!treatment || !outcome)) {
        return {
            ...empty,
            notes: [...notes, 'Für Wege braucht es Ursache UND Wirkung — der Modus „paths" bleibt sonst leer.'],
        };
    }
    const focus = options.mode === 'ancestors'
        ? outcome ?? treatment
        : treatment ?? outcome;
    if (!focus) {
        return { ...empty, notes: [...notes, 'Ohne Ursache oder Wirkung gibt es keinen Bezugspunkt im Modell.'] };
    }

    const collected = new Map<string, CausalTraceNode>();
    const dropped: CausalDrop[] = [];
    const fallbackPaths = undirectedReach(dag, focus);
    let paths: DagPath[] = [];
    let truncated = false;

    const admit = (node: string, distance: number, role: CausalRole, path: string[]) => {
        const existing = collected.get(node);
        if (existing && existing.distance <= distance) return;
        collected.set(node, { node, distance, role, path });
    };

    if (options.mode === 'paths') {
        const search = findPaths(dag, focus, outcome as string, {
            given: conditioned,
            limit: options.pathLimit ?? 24,
        });
        paths = search.paths;
        truncated = search.truncated;
        const onOpen = new Set<string>();
        for (const path of paths) {
            if (!path.open) continue;
            path.nodes.forEach((node, index) => {
                onOpen.add(node);
                admit(
                    node,
                    Math.min(index, path.nodes.length - 1 - index),
                    roleFor(node, treatment, outcome, 'on-path'),
                    path.nodes.slice(0, index + 1),
                );
            });
        }
        // Wer nur auf geschlossenen Wegen lag, ist genau der Fall, für den
        // `blockedBy` da ist: Er verschwindet — aber nicht schweigend.
        for (const path of paths) {
            if (path.open) continue;
            for (const node of path.nodes) {
                if (onOpen.has(node) || conditioned.includes(node)) continue;
                // Ursache und Wirkung fallen NIE heraus: Sie sind die
                // Frage, nicht ein Beitrag zu ihr. Dass zwischen ihnen
                // nichts offen bleibt, sagt der Hinweis — ein Kontext
                // ohne die beiden benannten Größen wäre unlesbar.
                if (node === treatment || node === outcome) continue;
                if (dropped.some(entry => entry.node === node)) continue;
                dropped.push({ node, reason: 'blocked-path' });
            }
        }
        if (onOpen.size === 0 && paths.length > 0) {
            notes.push('Alle gefundenen Wege sind unter dieser Konditionierung geschlossen.');
        }
        if (paths.length === 0) {
            notes.push('Zwischen diesen beiden Größen gibt es im Modell keinen Weg.');
        }
    } else if (options.mode === 'ancestors' || options.mode === 'descendants') {
        const reach = options.mode === 'ancestors'
            ? directedReach(dag, focus, node => dag.parents(node))
            : directedReach(dag, focus, node => dag.children(node));
        const role: CausalRole = options.mode === 'ancestors' ? 'ancestor' : 'descendant';
        for (const [node, path] of reach) {
            if (node !== focus && conditioned.length > 0 && !conditioned.includes(node)
                && dSeparated(dag, [focus], [node], conditioned)) {
                dropped.push({ node, reason: 'd-separated' });
                continue;
            }
            // Aufwärts gelaufen, abwärts erzählt: Der Weg steht in
            // Wirkrichtung, sonst läse sich die Ursachenseite rückwärts.
            const ordered = options.mode === 'ancestors' ? [...path].reverse() : path;
            admit(node, path.length - 1, roleFor(node, treatment, outcome, role), ordered);
        }
    } else {
        const blanket = markovBlanket(dag, focus);
        admit(focus, 0, roleFor(focus, treatment, outcome, 'blanket'), [focus]);
        for (const [node, distance] of blanket) {
            if (conditioned.length > 0 && !conditioned.includes(node)
                && dSeparated(dag, [focus], [node], conditioned)) {
                dropped.push({ node, reason: 'd-separated' });
                continue;
            }
            admit(node, distance, roleFor(node, treatment, outcome, 'blanket'), fallbackPaths.get(node) ?? [focus, node]);
        }
    }

    // Die konditionierten Größen bleiben drin: Wer über sie adjustiert,
    // will sie im Kontext sehen — sonst stünde im Ergebnis eine
    // Adjustierung, deren Größen nirgends vorkommen.
    for (const node of conditioned) {
        const existing = collected.get(node);
        if (existing) {
            // Die Rolle „adjustiert" gewinnt gegen jede andere: Sie sagt,
            // WARUM die Größe im Kontext steht, und das ist hier die
            // interessantere Auskunft als „Vorfahre".
            collected.set(node, { ...existing, role: 'conditioned' });
            continue;
        }
        admit(node, (fallbackPaths.get(node)?.length ?? 2) - 1, 'conditioned', fallbackPaths.get(node) ?? [focus, node]);
    }
    // Die Wirkung gehört zur Frage, auch wenn kein Modus sie einsammelt
    // (etwa `ancestors` mit einer angegebenen Ursache weiter unten).
    for (const endpoint of [treatment, outcome]) {
        if (endpoint && !collected.has(endpoint) && !dropped.some(entry => entry.node === endpoint)) {
            const path = fallbackPaths.get(endpoint);
            if (path) admit(endpoint, path.length - 1, roleFor(endpoint, treatment, outcome, 'on-path'), path);
        }
    }

    const nodes = [...collected.values()].sort((a, b) => a.distance - b.distance || a.node.localeCompare(b.node));
    return {
        mode: options.mode,
        focus,
        treatment,
        outcome,
        nodes,
        paths,
        dropped: dropped.sort((a, b) => a.node.localeCompare(b.node)),
        conditioned,
        truncated,
        notes,
    };
}

/**
 * Der Wirkweg als Satz: `Nachtabsenkung → Raumtemperatur → Heizenergie`.
 * Beschriftet wird über den Aufrufer, weil der Kern nur opake Knoten
 * kennt (dieselbe Trennung wie in `identify.ts`).
 */
export function pathAsText(path: DagPath, label: (node: string) => string = node => node): string {
    return path.nodes
        .map((node, index) => (index === 0 ? label(node) : `${path.forward[index - 1] ? '→' : '←'} ${label(node)}`))
        .join(' ');
}

/**
 * Ein Trace-Weg als Knotenfolge. Bewusst OHNE Pfeile: Über einen
 * Hintertürweg läuft man teils gegen die Wirkrichtung, und eine Kette aus
 * Pfeilen wäre dort eine Behauptung. Wo die Richtung feststeht, steht sie
 * in `paths` — dafür ist `pathAsText` da.
 */
export function traceNodePathAsText(path: readonly string[], label: (node: string) => string = node => node): string {
    return path.map(label).join(' – ');
}
