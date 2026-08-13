/**
 * D-Separation und Pfade (CAUSAL_LAYER_SPEC §7, Tier 1, C1).
 *
 * Zwei Verfahren, absichtlich getrennt:
 *
 *  - **Die Entscheidung** (`dSeparated`) läuft über den moralisierten
 *    Vorfahrengraphen. Sie ist polynomiell und deshalb das, worauf sich
 *    Identifikation, Adjustment Sets und der Editor stützen.
 *  - **Die Erklärung** (`findPaths`) zählt Pfade auf. Das ist im
 *    schlimmsten Fall exponentiell, deshalb hart gedeckelt — und es
 *    beantwortet die Frage, die ein Mensch wirklich stellt: „welcher Weg
 *    ist noch offen?". Wird der Deckel erreicht, sagt das Ergebnis es
 *    (`truncated`), statt Vollständigkeit vorzutäuschen (Invariante 10).
 *
 * Rein wie `dag.ts`: keine Bindung an Store, Netz oder Umgebung.
 */

import { ancestors, inducedSubgraph, type CausalDag } from './dag';

/**
 * Sind `x` und `y` durch `given` d-separiert?
 *
 * Verfahren (Lauritzen u. a.): Vorfahrengraph über x ∪ y ∪ given bilden,
 * moralisieren (Eltern eines gemeinsamen Kindes verbinden), Richtungen
 * vergessen, die konditionierten Knoten entfernen — bleibt kein Weg, sind
 * sie d-separiert. Das ist dieselbe Aussage wie die Pfad-Definition, nur
 * ohne Pfade aufzählen zu müssen.
 */
export function dSeparated(
    dag: CausalDag,
    x: Iterable<string>,
    y: Iterable<string>,
    given: Iterable<string> = [],
): boolean {
    const xs = [...x].filter(node => dag.has(node));
    const ys = [...y].filter(node => dag.has(node));
    const zs = new Set([...given].filter(node => dag.has(node)));
    if (xs.length === 0 || ys.length === 0) return true;
    // Ein konditionierter Knoten kann nicht zugleich der Endpunkt sein —
    // die Frage wäre sinnlos, und jede Antwort darauf wäre eine Behauptung.
    if (xs.some(node => zs.has(node)) || ys.some(node => zs.has(node))) return false;
    // Derselbe Knoten auf beiden Seiten ist nie separiert.
    if (xs.some(node => ys.includes(node))) return false;

    const relevant = ancestors(dag, [...xs, ...ys, ...zs], true);
    const sub = inducedSubgraph(dag, relevant);

    // Moralisieren: ungerichtete Nachbarschaft plus Verbindung aller
    // Eltern-Paare. Damit wird aus „Collider öffnet, wenn konditioniert"
    // eine gewöhnliche Kante, und die Wegsuche ist wieder trivial.
    const adjacency = new Map<string, Set<string>>();
    const link = (a: string, b: string) => {
        if (a === b) return;
        if (!adjacency.has(a)) adjacency.set(a, new Set());
        if (!adjacency.has(b)) adjacency.set(b, new Set());
        adjacency.get(a)?.add(b);
        adjacency.get(b)?.add(a);
    };
    for (const node of sub.nodes) {
        if (!adjacency.has(node)) adjacency.set(node, new Set());
        for (const child of sub.children(node)) link(node, child);
        const parents = sub.parents(node);
        for (let i = 0; i < parents.length; i += 1) {
            for (let j = i + 1; j < parents.length; j += 1) link(parents[i], parents[j]);
        }
    }

    const targets = new Set(ys);
    const visited = new Set<string>(zs);
    const queue = xs.filter(node => !zs.has(node));
    for (const node of queue) visited.add(node);
    while (queue.length > 0) {
        const node = queue.shift() as string;
        if (targets.has(node) && !xs.includes(node)) return false;
        for (const next of adjacency.get(node) ?? []) {
            if (visited.has(next)) continue;
            if (targets.has(next)) return false;
            visited.add(next);
            queue.push(next);
        }
    }
    return true;
}

/** Umkehrung, weil die Frage meistens so gestellt wird. */
export function dConnected(
    dag: CausalDag,
    x: Iterable<string>,
    y: Iterable<string>,
    given: Iterable<string> = [],
): boolean {
    return !dSeparated(dag, x, y, given);
}

/** Ein Pfad als Knotenfolge samt Richtung jedes Schritts. */
export interface DagPath {
    nodes: readonly string[];
    /** `true`, wenn Schritt i von nodes[i] nach nodes[i+1] zeigt. */
    forward: readonly boolean[];
    /**
     * `causal` — durchgehend gerichtet von Anfang zu Ende (der Wirkweg);
     * `backdoor` — beginnt mit einer Kante IN den Startknoten hinein (der
     * klassische Störweg); `other` — sonst (beginnt vorwärts, endet aber
     * nicht am Ziel als gerichteter Weg, z. B. über einen Collider).
     */
    kind: 'causal' | 'backdoor' | 'other';
    /** Ist der Pfad unter der gegebenen Konditionierung offen? */
    open: boolean;
    /** Knoten, die den Pfad blockieren (Nicht-Collider in Z, Collider ohne Z). */
    blockedBy: readonly string[];
    /** Collider auf dem Pfad — die Stellen, an denen Konditionieren schadet. */
    colliders: readonly string[];
}

export interface PathSearchOptions {
    given?: Iterable<string>;
    /** Höchstzahl zurückgegebener Pfade (Default 64). */
    limit?: number;
    /** Höchstzahl besuchter Teilpfade (Default 20000) — harte Bremse. */
    budget?: number;
    /** Nur offene Pfade zurückgeben (die interessanten). */
    openOnly?: boolean;
}

export interface PathSearchResult {
    paths: DagPath[];
    /** `true`, wenn Limit oder Budget erreicht wurde — nicht vollständig. */
    truncated: boolean;
}

/**
 * Alle Pfade zwischen zwei Knoten (Richtung egal, kein Knoten doppelt),
 * klassifiziert und auf Offenheit geprüft. Für die Erklärung, nicht für
 * die Entscheidung — dafür ist `dSeparated` da.
 */
export function findPaths(
    dag: CausalDag,
    from: string,
    to: string,
    options: PathSearchOptions = {},
): PathSearchResult {
    const limit = options.limit ?? 64;
    const budget = options.budget ?? 20000;
    const given = new Set([...(options.given ?? [])].filter(node => dag.has(node)));
    const paths: DagPath[] = [];
    let steps = 0;
    let truncated = false;

    if (!dag.has(from) || !dag.has(to) || from === to) return { paths, truncated };

    // Ein Collider ist offen, wenn er SELBST oder einer seiner Nachfahren
    // konditioniert wird. „Hat einen konditionierten Nachfahren" ist
    // dasselbe wie „ist Vorfahre eines konditionierten Knotens" — einmal
    // rückwärts gerechnet statt für jeden Collider vorwärts.
    const openColliders = ancestors(dag, given, true);

    const nodesOnPath: string[] = [from];
    const forward: boolean[] = [];
    const onPath = new Set<string>([from]);

    const finish = () => {
        const blockedBy: string[] = [];
        const colliders: string[] = [];
        for (let i = 1; i < nodesOnPath.length - 1; i += 1) {
            const node = nodesOnPath[i];
            const isCollider = forward[i - 1] && !forward[i];
            if (isCollider) {
                colliders.push(node);
                if (!openColliders.has(node)) blockedBy.push(node);
            } else if (given.has(node)) {
                blockedBy.push(node);
            }
        }
        const kind: DagPath['kind'] = forward.every(step => step)
            ? 'causal'
            : forward[0] === false ? 'backdoor' : 'other';
        const path: DagPath = {
            nodes: [...nodesOnPath],
            forward: [...forward],
            kind,
            open: blockedBy.length === 0,
            blockedBy,
            colliders,
        };
        if (options.openOnly && !path.open) return;
        if (paths.length >= limit) {
            truncated = true;
            return;
        }
        paths.push(path);
    };

    const walk = (node: string) => {
        if (paths.length >= limit || steps >= budget) {
            truncated = true;
            return;
        }
        for (const next of dag.neighbours(node)) {
            if (onPath.has(next)) continue;
            steps += 1;
            if (steps >= budget) {
                truncated = true;
                return;
            }
            nodesOnPath.push(next);
            forward.push(dag.hasEdge(node, next));
            onPath.add(next);
            if (next === to) finish();
            else walk(next);
            onPath.delete(next);
            forward.pop();
            nodesOnPath.pop();
            if (paths.length >= limit || steps >= budget) {
                truncated = true;
                return;
            }
        }
    };

    walk(from);
    return { paths, truncated };
}

/**
 * Implizierte bedingte Unabhängigkeiten (§7 Tier 1): die testbaren
 * Aussagen des Modells. Geprüft werden nicht-adjazente Paare gegen ihre
 * Eltern-Mengen — die „basis set"-Fassung, die auch DAGitty ausgibt.
 * Sie ist klein, vollständig im Sinne der Implikation und damit das, was
 * man einer Datenlage wirklich vorlegen kann.
 */
export interface ImpliedIndependence {
    a: string;
    b: string;
    given: string[];
}

export function impliedIndependencies(dag: CausalDag): ImpliedIndependence[] {
    const order = [...dag.nodes];
    const index = new Map(order.map((node, position) => [node, position]));
    const out: ImpliedIndependence[] = [];
    for (const a of order) {
        for (const b of order) {
            if ((index.get(a) ?? 0) >= (index.get(b) ?? 0)) continue;
            if (dag.hasEdge(a, b) || dag.hasEdge(b, a)) continue;
            const given = [...new Set([...dag.parents(a), ...dag.parents(b)])]
                .filter(node => node !== a && node !== b)
                .sort();
            if (dSeparated(dag, [a], [b], given)) out.push({ a, b, given });
        }
    }
    return out;
}
