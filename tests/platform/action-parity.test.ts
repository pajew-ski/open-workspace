// @vitest-environment node
/**
 * A1-Abnahme, Teil 1 (ACTIONS_SPEC §6): Parität zwischen Routen und
 * Registry.
 *
 * Jeder exportierte HTTP-Handler unter `src/app/api/` ist entweder ein
 * Aktions-Adapter (er antwortet über `respondWithAction`) oder steht auf
 * einer von zwei Listen: **bewusst ausgenommen** (mit Begründung je
 * Eintrag) oder **noch nicht migriert**. Eine neue Route ohne Aktion und
 * ohne Listeneintrag lässt den Test scheitern — das ist die Lücke, die
 * vorher nichts gemeldet hat: Eine Fähigkeit, die dem Assistenten fehlt,
 * brach keinen Test.
 *
 * Die zweite Liste darf nur schrumpfen; `NOT_MIGRATED_CEILING` hält ihre
 * Länge als Obergrenze. Ende (A4) ist erreicht, wenn sie leer ist.
 *
 * Dazu: Kein Modul, das Aktionen definiert, fehlt im Katalog — sonst
 * wären seine Aktionen der Registry unbekannt und die Parität nur
 * scheinbar erfüllt.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import '@/lib/actions/catalog';
import { listActions } from '@/lib/actions/registry';

const ROOT = path.resolve(__dirname, '..', '..');
const API_DIR = path.join(ROOT, 'src', 'app', 'api');

/**
 * Bewusst ausgenommen — jede Zeile mit dem Grund, warum die Route keine
 * Aktion ist. Die Schlüssel sind Pfade relativ zu `src/app/api`.
 */
export const EXCLUDED_ROUTES: Record<string, string> = {
    'chat': 'Streaming-Protokoll des Tool-Loops (NDJSON) — die Oberfläche, über die Aktionen laufen, nicht selbst eine',
    'mcp': 'MCP-Transport (Streamable HTTP) — exponiert die Aktionen, ist keine',
    'well-known/void': 'RDF-Protokoll (VoID, Content Negotiation) für fremde Linked-Data-Clients',
    'graph/sparql': 'SPARQL-1.1-Protokoll — Wire-Format und Content Negotiation, kein JSON-Vertrag',
    'graph/federation/sparql': 'SPARQL-1.1-Protokoll des eingehenden Föderations-Endpoints',
    'images': 'Binärer Upload (multipart/form-data), kein JSON-Vertrag',
    'images/[filename]': 'Binäre Auslieferung eines Bildes',
    'export': 'Datei-Download (Content-Disposition) — ein Backup ist kein Werkzeug-Ergebnis',
    'ai/mcp/[id]': 'Relais zu fremden MCP-Servern — MCP-Client-Tools bleiben, wie sie sind (Issue #34, „Nicht")',
    'ai/a2a': 'Relais zu fremden A2A-Agenten — Fremdfähigkeit, kein Umbau (Issue #34, „Nicht")',
    'tools/execute': 'Ausführung konfigurierter API-Tools — Fremdfähigkeit, kein Umbau (Issue #34, „Nicht")',
    'actions': 'Auskunft über die Registry selbst (Tool-Definitionen für den Browser-Loop)',
    'runtime': 'Lesemodell der konkreten HTTP-Anfrage (Ingress-Header, Base-Path) — keine Fähigkeit des Workspace',
};

/** Noch nicht migriert. Darf nur schrumpfen (A4 leert sie). */
export const NOT_YET_MIGRATED: string[] = [
    'activity',
    'agents',
    'ai/config',
    'ai/defaults',
    'ai/mcp-servers',
    'ai/mcp-servers/[id]',
    'ai/providers',
    'ai/providers/[id]',
    'ai/providers/[id]/health',
    'calendar',
    'chat/conversations',
    'chat/health',
    'connections',
    'dashboard',
    'graph',
    'graph/access',
    'graph/access/authorizations',
    'graph/access/authorizations/[id]',
    'graph/access/groups',
    'graph/access/groups/[id]',
    'graph/access/publish',
    'graph/access/spaces',
    'graph/access/spaces/[id]',
    'graph/causal',
    'graph/causal/[id]',
    'graph/causal/archive/[id]',
    'graph/causal/estimands',
    'graph/causal/estimands/[id]',
    'graph/causal/hypotheses',
    'graph/causal/hypotheses/[id]',
    'graph/causal/studies',
    'graph/connectors',
    'graph/connectors/[id]',
    'graph/connectors/[id]/push',
    'graph/connectors/[id]/sync',
    'graph/federation/endpoints',
    'graph/federation/endpoints/[id]',
    'graph/federation/endpoints/[id]/probe',
    'graph/observations',
    'graph/observations/[id]',
    'graph/observations/[id]/backfill',
    'graph/observations/[id]/series',
    'graph/observations/capture',
    'graph/provenance',
    'graph/reasoning',
    'graph/retrieval-profiles',
    'graph/retrieval-profiles/[id]',
    'graph/self-model',
    'graph/validate',
    'graph/views',
    'graph/views/[id]',
    'graph/views/[id]/resolve',
    'graph/views/preview',
    'mcp/status',
    'onboarding',
    'settings',
    'skills',
    'skills/[id]',
    'tools',
];

/** Obergrenze der Liste — wird beim Migrieren gesenkt, nie erhöht. */
export const NOT_MIGRATED_CEILING = 61;

const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD'] as const;

export interface RouteSource {
    /** Pfad relativ zu `src/app/api`, ohne `/route.ts`. */
    route: string;
    source: string;
}

export interface Classification {
    adapters: string[];
    excluded: string[];
    notYetMigrated: string[];
    /** Handler ohne Aktion und ohne Listeneintrag — der Fehlerfall. */
    unaccounted: string[];
}

/** Exportierte HTTP-Handler einer Route mit ihrem Rumpf (bis zum nächsten Export). */
function exportedHandlers(source: string): Array<{ method: string; body: string }> {
    const pattern = new RegExp(`export\\s+(?:async\\s+)?function\\s+(${HTTP_METHODS.join('|')})\\b`, 'g');
    const matches = [...source.matchAll(pattern)];
    return matches.map(match => {
        const start = match.index ?? 0;
        const next = source.indexOf('\nexport ', start + 1);
        const end = next === -1 ? source.length : next;
        return { method: match[1], body: source.slice(start, end) };
    });
}

function isAdapter(body: string): boolean {
    return body.includes('respondWithAction');
}

/** Reine Klassifikation — testbar mit erfundenen Routen (Negativfall). */
export function classifyRoutes(
    routes: readonly RouteSource[],
    lists: { excluded: Record<string, string>; notYetMigrated: readonly string[] },
): Classification {
    const result: Classification = { adapters: [], excluded: [], notYetMigrated: [], unaccounted: [] };
    for (const { route, source } of routes) {
        if (route in lists.excluded) {
            result.excluded.push(route);
            continue;
        }
        const handlers = exportedHandlers(source);
        const nonAdapters = handlers.filter(handler => !isAdapter(handler.body));
        if (handlers.length > 0 && nonAdapters.length === 0) {
            result.adapters.push(route);
            continue;
        }
        if (lists.notYetMigrated.includes(route)) {
            result.notYetMigrated.push(route);
            continue;
        }
        for (const handler of nonAdapters) result.unaccounted.push(`${route} ${handler.method}`);
        if (handlers.length === 0) result.unaccounted.push(`${route} (keine Handler)`);
    }
    return result;
}

function routeFiles(): RouteSource[] {
    const routes: RouteSource[] = [];
    const walk = (dir: string) => {
        for (const entry of readdirSync(dir).sort()) {
            const full = path.join(dir, entry);
            if (statSync(full).isDirectory()) walk(full);
            else if (entry === 'route.ts') {
                routes.push({
                    route: path.relative(API_DIR, dir).split(path.sep).join('/'),
                    source: readFileSync(full, 'utf8'),
                });
            }
        }
    };
    walk(API_DIR);
    return routes;
}

function actionModuleFiles(): string[] {
    const files: string[] = [];
    const walk = (dir: string) => {
        for (const entry of readdirSync(dir)) {
            const full = path.join(dir, entry);
            if (statSync(full).isDirectory()) walk(full);
            else if (/^actions(\.server)?\.ts$/.test(entry)) {
                files.push(path.relative(ROOT, full).split(path.sep).join('/'));
            }
        }
    };
    walk(path.join(ROOT, 'src', 'lib'));
    return files.sort();
}

describe('A1 — Parität Routen ↔ Aktionen (ACTIONS_SPEC §6)', () => {
    const classification = classifyRoutes(routeFiles(), {
        excluded: EXCLUDED_ROUTES,
        notYetMigrated: NOT_YET_MIGRATED,
    });

    it('kennt jeden Handler unter src/app/api: Adapter, ausgenommen oder noch nicht migriert', () => {
        expect(classification.unaccounted, classification.unaccounted.join('\n')).toEqual([]);
    });

    it('listet nur Routen, die es gibt — ein Listeneintrag ohne Route wäre Geschichtsschreibung', () => {
        const known = new Set(routeFiles().map(route => route.route));
        for (const route of [...Object.keys(EXCLUDED_ROUTES), ...NOT_YET_MIGRATED]) {
            expect(known.has(route), `${route} steht in einer Liste, existiert aber nicht`).toBe(true);
        }
        // Und eine migrierte Route steht nicht mehr auf der Warteliste.
        for (const route of classification.adapters) {
            expect(NOT_YET_MIGRATED, `${route} ist Adapter und steht trotzdem auf „noch nicht migriert"`).not.toContain(route);
        }
    });

    it('hält die Liste „noch nicht migriert" unter ihrer Obergrenze — sie darf nur schrumpfen', () => {
        expect(NOT_YET_MIGRATED.length).toBeLessThanOrEqual(NOT_MIGRATED_CEILING);
        expect(new Set(NOT_YET_MIGRATED).size).toBe(NOT_YET_MIGRATED.length);
    });

    it('begründet jede Ausnahme', () => {
        for (const [route, reason] of Object.entries(EXCLUDED_ROUTES)) {
            expect(reason.trim().length, `${route} ohne Begründung`).toBeGreaterThan(20);
        }
    });

    it('Negativfall: eine erfundene Route ohne Aktion und ohne Listeneintrag fällt auf', () => {
        const invented = classifyRoutes([
            ...routeFiles(),
            {
                route: 'erfunden',
                source: 'export async function GET() { return Response.json({ neu: true }); }\n',
            },
        ], { excluded: EXCLUDED_ROUTES, notYetMigrated: NOT_YET_MIGRATED });
        expect(invented.unaccounted).toEqual(['erfunden GET']);

        // Ein Adapter neben einem Nicht-Adapter in derselben Datei fällt
        // ebenfalls auf — geprüft wird je Handler, nicht je Datei.
        const mixed = classifyRoutes([{
            route: 'gemischt',
            source: [
                "import { respondWithAction } from '@/lib/actions/route';",
                'export async function GET() { return respondWithAction(x, {}); }',
                'export async function POST() { return Response.json({}); }',
            ].join('\n'),
        }], { excluded: {}, notYetMigrated: [] });
        expect(mixed.unaccounted).toEqual(['gemischt POST']);
    });

    it('hat die migrierten Kern-Module (A1) als Adapter', () => {
        for (const route of ['finder', 'tasks', 'tasks/[id]', 'projects', 'projects/[id]', 'docs', 'docs/[id]', 'canvas', 'actions/[name]']) {
            expect(classification.adapters, `${route} ist kein Adapter`).toContain(route);
        }
    });
});

describe('A1 — Katalog und Registry', () => {
    it('importiert jedes Aktionsmodul unter src/lib in den Katalog', () => {
        const catalog = readFileSync(path.join(ROOT, 'src', 'lib', 'actions', 'catalog.ts'), 'utf8');
        for (const file of actionModuleFiles()) {
            const specifier = `@/${file.replace(/^src\//, '').replace(/\.ts$/, '')}`;
            expect(catalog, `${file} fehlt in actions/catalog.ts`).toContain(`import '${specifier}'`);
        }
        expect(actionModuleFiles().length).toBeGreaterThan(1);
    });

    it('kennt die Aktionen, deren Namen bestehen bleiben (Issue #34, „Nicht")', () => {
        const names = listActions().map(action => action.name);
        for (const kept of ['workspace_finder', 'workspace_create_task', 'workspace_update_task']) {
            expect(names).toContain(kept);
        }
    });
});
