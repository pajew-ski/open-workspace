/**
 * Erreichbarkeit und Erlaubnis einer Aktion — abgeleitet aus dem Grant
 * (ACTIONS_SPEC §2, GRAPH_CORE_SPEC §17). Es gibt keine Rechteprüfung in
 * einer Aktion selbst; alles, was hier nicht steht, ist kein Recht.
 *
 * Zwei Fragen, zwei Funktionen:
 *
 *  - `availability(action, ctx)`: Erscheint die Aktion für diesen
 *    Aufrufer überhaupt als Werkzeug? Beantwortbar OHNE Eingabe — ein
 *    Ziel, das von der Eingabe abhängt (`causal/<id>`), wird erst beim
 *    Aufruf aufgelöst. Was dem Kontext fehlt (Oberfläche, Dateibaum),
 *    macht die Aktion unsichtbar statt scheiternd (Invariante 10).
 *  - `authorizeTarget(action, input, ctx)`: Darf dieser Aufruf auf sein
 *    aufgelöstes Ziel? Wirft `ActionDeniedError`, sonst nichts.
 *
 * Die Regeln für einen Graphen:
 *
 *  - Gibt es den Graphen, entscheidet allein `graph/acl` über den Grant
 *    (`readableGraphs`, `appendableGraphs`, `writableGraphs`,
 *    `controlGraphs`).
 *  - Gibt es ihn noch nicht, darf er entstehen, wenn (a) der Grant ein
 *    Scope-Muster dafür trägt (`writableScopes`, C1) oder (b) er im
 *    EIGENEN Namensraum des Aufrufers liegt. (b) ist die Standardregel
 *    aus §17.2 vorweggenommen — jeder Nutzergraph gehört seinem
 *    Eigentümer mit `control`, und `ensureGraphAuthorizations` schreibt
 *    genau diese Regel, sobald der Graph sein erstes Quad hat. Ein
 *    geteilter Raum, den es noch nicht gibt, darf von jeder angemeldeten
 *    Identität angelegt werden (sie wird Eigentümer, SPEC §17.1).
 */

import { graphScopeKey, mayCreateGraph, resolveWriteGraph, type AccessGrant } from '@/lib/graph/authz/grant';
import { describeGraph } from '@/lib/graph/iri';
import {
    ActionDeniedError,
    ActionUnavailableError,
    type Action,
    type ActionContext,
    type ActionDependency,
    type ActionTarget,
} from './contract';

type GraphMode = 'read' | 'append' | 'write' | 'control';

function requiredMode(action: Pick<Action, 'effect' | 'target'>): GraphMode {
    if (action.target.kind === 'graph' && action.target.mode) return action.target.mode;
    if (action.effect === 'read') return 'read';
    if (action.effect === 'constructive') return 'append';
    return 'write';
}

function hasDependency(ctx: ActionContext, dependency: ActionDependency): boolean {
    if (dependency === 'workspace') return typeof ctx.workspace === 'function';
    if (dependency === 'platform') return ctx.platform !== undefined;
    return ctx.surface !== undefined;
}

/** Fehlende Abhängigkeit — `null`, wenn alles da ist. */
export function missingDependency(action: Pick<Action, 'requires'>, ctx: ActionContext): ActionDependency | null {
    for (const dependency of action.requires ?? []) {
        if (!hasDependency(ctx, dependency)) return dependency;
    }
    return null;
}

/**
 * Scope-Schlüssel oder absolute IRI → absolute Graph-IRI im Namensraum
 * des Aufrufers. `null`, wenn der Schlüssel keinem Graphen entspricht.
 */
export function resolveGraphScope(ctx: ActionContext, scope: string): string | null {
    if (scope.startsWith(ctx.graph.iri.instanceBase)) return scope;
    if (scope === 'meta' || scope === 'vocab' || scope === 'shapes') return ctx.graph.iri.sharedGraph(scope);
    if (scope === 'presentation' || scope === 'causal-archive') return ctx.graph.iri.graph(scope);
    if (scope.startsWith('import/')) {
        const id = scope.slice('import/'.length);
        return id === '' || id.includes('/') ? null : ctx.graph.iri.importGraph(id);
    }
    if (scope.startsWith('inferred/')) {
        const rest = scope.slice('inferred/'.length);
        return rest === '' ? null : ctx.graph.iri.inferredGraph(rest);
    }
    return resolveWriteGraph(ctx.graph.iri, scope);
}

function grantHas(grant: AccessGrant, mode: GraphMode, graph: string): boolean {
    switch (mode) {
        case 'read': return grant.readableGraphs.includes(graph);
        case 'append':
            return (grant.appendableGraphs ?? []).includes(graph) || (grant.writableGraphs ?? []).includes(graph);
        case 'write': return (grant.writableGraphs ?? []).includes(graph);
        case 'control': return (grant.controlGraphs ?? []).includes(graph);
    }
}

function ownsNamespace(ctx: ActionContext, graph: string): boolean {
    if (!ctx.identity.authenticated && ctx.identity.userId === '') return false;
    const described = describeGraph(ctx.graph.iri.instanceBase, graph);
    if (!described) return false;
    if (described.kind === 'user') return described.userId === ctx.identity.userId;
    return false;
}

function isSpaceGraph(ctx: ActionContext, graph: string): boolean {
    return describeGraph(ctx.graph.iri.instanceBase, graph)?.kind === 'space';
}

/**
 * Erlaubnis auf einem konkreten Graphen. Exportiert, damit Aktionen mit
 * ZWEI Zielen (Freigabehandlung: Quelle und Ziel) dieselbe Regel für
 * das zweite anwenden, statt eine eigene zu formulieren.
 */
export async function mayAccessGraph(ctx: ActionContext, graph: string, mode: GraphMode): Promise<boolean> {
    if (graphScopeKey(ctx.graph.iri, graph) === 'acl') return false;
    if (grantHas(ctx.grant, mode, graph)) return true;
    if (mode === 'control') return false;
    const existing = (await ctx.graph.store.graphs()).map(g => g.value);
    if (existing.includes(graph)) return false;
    if (mode !== 'read' && mayCreateGraph(ctx.grant, ctx.graph.iri.instanceBase, graph)) return true;
    if (ownsNamespace(ctx, graph)) return true;
    return mode !== 'read' && isSpaceGraph(ctx, graph) && ctx.identity.authenticated;
}

function describeTarget(target: ActionTarget): string {
    switch (target.kind) {
        case 'dataset': return 'das erlaubte Dataset';
        case 'graph': return typeof target.scope === 'string' ? `den Graphen "${target.scope}"` : 'den Zielgraphen';
        case 'grant-write': return 'den freigegebenen Schreibgraphen';
        case 'sparql': return 'rohes SPARQL';
        case 'surface': return 'die Oberfläche';
        case 'instance': return 'die Konfiguration der Installation';
    }
}

/**
 * Sichtbarkeit ohne Eingabe: Abhängigkeiten, Grant-Flaggen und feste
 * Ziele. Ein eingabeabhängiges Ziel gilt hier als erreichbar, wenn der
 * Aufrufer überhaupt eine Identität hat — die genaue Prüfung folgt beim
 * Aufruf.
 */
export async function availability(action: Action, ctx: ActionContext): Promise<{ available: boolean; reason?: string }> {
    const missing = missingDependency(action, ctx);
    if (missing) return { available: false, reason: `Kontext ohne ${missing}` };
    const { target } = action;
    switch (target.kind) {
        case 'dataset':
            return { available: true };
        case 'sparql':
            return ctx.grant.sparql ? { available: true } : { available: false, reason: 'kein SPARQL-Recht' };
        case 'grant-write':
            return ctx.grant.writableGraph
                ? { available: true }
                : { available: false, reason: 'kein freigegebener Schreibgraph' };
        case 'surface':
            return { available: true };
        case 'instance': {
            const meta = ctx.graph.iri.sharedGraph('meta');
            const ok = action.effect === 'read'
                ? ctx.grant.readableGraphs.includes(meta)
                : (ctx.grant.controlGraphs ?? []).includes(meta);
            return ok ? { available: true } : { available: false, reason: 'kein Recht auf graph/meta' };
        }
        case 'graph': {
            if (typeof target.scope !== 'string') {
                return ctx.identity.userId !== ''
                    ? { available: true }
                    : { available: false, reason: 'anonym' };
            }
            const graph = resolveGraphScope(ctx, target.scope);
            if (!graph) return { available: false, reason: `Ziel "${target.scope}" nicht auflösbar` };
            const ok = await mayAccessGraph(ctx, graph, requiredMode(action));
            return ok ? { available: true } : { available: false, reason: `kein Recht auf ${target.scope}` };
        }
    }
}

/**
 * Erlaubnis für einen konkreten Aufruf. Wirft `ActionUnavailableError`,
 * wenn dem Kontext etwas fehlt, `ActionDeniedError`, wenn der Grant nicht
 * reicht. Liefert das aufgelöste Ziel (für PROV und Logs).
 */
export async function authorizeTarget(action: Action, input: unknown, ctx: ActionContext): Promise<{ graph: string | null }> {
    const missing = missingDependency(action, ctx);
    if (missing) throw new ActionUnavailableError(action.name, missing);
    const { target } = action;
    const deny = (why: string): never => {
        throw new ActionDeniedError(`Kein Recht auf ${describeTarget(target)}: ${why}.`);
    };
    switch (target.kind) {
        case 'dataset':
        case 'surface':
            return { graph: null };
        case 'sparql':
            if (!ctx.grant.sparql) deny('dieses Zugangs-Recht fehlt');
            return { graph: null };
        case 'grant-write':
            if (!ctx.grant.writableGraph) deny('für diesen Zugang ist kein Schreibgraph freigegeben');
            return { graph: ctx.grant.writableGraph };
        case 'instance': {
            const meta = ctx.graph.iri.sharedGraph('meta');
            if (action.effect === 'read') {
                if (!ctx.grant.readableGraphs.includes(meta)) deny('graph/meta ist nicht lesbar');
            } else if (!(ctx.grant.controlGraphs ?? []).includes(meta)) {
                deny('instanzweite Konfiguration verlangt die Verwaltung von graph/meta');
            }
            return { graph: meta };
        }
        case 'graph': {
            const scope = typeof target.scope === 'string' ? target.scope : await target.scope(input, ctx);
            if (scope === null) return deny('das Ziel ist aus der Eingabe nicht bestimmbar');
            const graph = resolveGraphScope(ctx, scope);
            if (!graph) return deny(`"${scope}" ist kein zulässiges Ziel`);
            const mode = requiredMode(action);
            if (!(await mayAccessGraph(ctx, graph, mode))) {
                deny(mode === 'read' ? 'nicht lesbar' : `Modus ${mode} fehlt`);
            }
            return { graph };
        }
    }
}
