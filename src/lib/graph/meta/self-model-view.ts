/**
 * Lesemodell-Typen des Selbstmodells und ihre reinen Ableitungen
 * (GRAPH_CORE_SPEC §18, M14).
 *
 * Bewusst frei von Store und SPARQL: Diese Datei landet im Browser-Bundle
 * (Assistent, Onboarding-Seite), während `self-model-query.ts` sie
 * serverseitig aus `graph/meta` befüllt. Ein Client, der das Modell über
 * `GET /api/graph/self-model` holt, benutzt dieselben Funktionen wie der
 * Server — es gibt keine zweite Formulierung des Systemkontexts.
 */

export interface SelfModelModule {
    iri: string;
    id: string;
    label: string;
    description: string;
    route: string;
    entityTypes: string[];
    partOf: string | null;
}

export interface SelfModelApp {
    iri: string;
    name: string;
    description: string;
    version: string;
    schemaVersion: string;
    runtime: string;
    capabilities: string[];
    connectorKinds: string[];
}

export interface SelfModelView {
    /** `null`, solange kein Selbstmodell sichtbar ist (fehlendes Recht). */
    app: SelfModelApp | null;
    modules: SelfModelModule[];
}

/** `https://schema.org/Event` → `schema:Event` (nur für lesbaren Text). */
function shortType(iri: string): string {
    const local = iri.split(/[#/]/).pop() ?? iri;
    if (iri.includes('/ns/v1#')) return `ow:${local}`;
    if (iri.startsWith('https://schema.org/')) return `schema:${local}`;
    return local;
}

/** Modul zu einem Pfad: längster passender Präfix, `/` nur exakt. */
export function moduleForPath(
    modules: readonly SelfModelModule[],
    pathname: string,
): SelfModelModule | null {
    const candidates = modules
        .filter(module => pathname === module.route || (module.route !== '/' && pathname.startsWith(`${module.route}/`)))
        .sort((a, b) => b.route.length - a.route.length);
    return candidates[0] ?? null;
}

/**
 * Kompakter Systemkontext für den Assistenten — genau das, was früher als
 * Prompt-Text gepflegt wurde, jetzt aus der Abfrage erzeugt (§18). Leer,
 * wenn kein Selbstmodell sichtbar ist: dann behauptet der Prompt nichts.
 */
export function systemContextText(view: SelfModelView, pathname?: string): string {
    if (!view.app && view.modules.length === 0) return '';
    const lines: string[] = [];
    if (view.app) {
        lines.push(
            'SYSTEM (aus dem Selbstmodell in graph/meta abgefragt, nicht gepflegt):',
            `- ${view.app.name}, Version ${view.app.version || 'unbekannt'}, Runtime ${view.app.runtime}`,
        );
        if (view.app.capabilities.length > 0) {
            lines.push(`- Aktive Fähigkeiten: ${view.app.capabilities.join(', ')}`);
        }
        if (view.app.connectorKinds.length > 0) {
            lines.push(`- Einbindbare Quellen (Connector-Arten): ${view.app.connectorKinds.join(', ')}`);
        }
    }
    if (view.modules.length > 0) {
        lines.push('- Module dieser Installation:');
        for (const entry of view.modules) {
            const types = entry.entityTypes.length > 0
                ? ` (verwaltet: ${entry.entityTypes.map(shortType).join(', ')})`
                : '';
            lines.push(`  - ${entry.label} [${entry.route}]: ${entry.description}${types}`);
        }
    }
    const current = pathname ? moduleForPath(view.modules, pathname) : null;
    if (current) lines.push(`- Der Nutzer ist gerade hier: ${current.label} [${current.route}]`);
    return lines.join('\n');
}
