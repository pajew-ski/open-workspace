/**
 * Selbstmodell der Installation in `graph/meta` (GRAPH_CORE_SPEC §18, M14).
 *
 * Der Workspace beschreibt sich selbst in seinem eigenen Graphen: Module
 * und Seiten, die Entitätstypen, die sie verwalten, die Connector-Arten
 * dieses Builds, die AKTIVEN Fähigkeiten der laufenden Runtime und die
 * Schema-Version. Alles als reguläre Knoten mit demselben Vokabular wie
 * Nutzerinhalte — abfragbar per SPARQL, sichtbar im Graph-Explorer,
 * über den MCP-Server auch für externe Agenten erreichbar.
 *
 * Wahrheits-Semantik wie beim AI-Spiegel (`ai.ts`): Das Modell wird
 * GENERIERT — beim Start vollständig ersetzt, nie von Hand gepflegt.
 * Quelle ist der Code (Modul-Registry `lib/app/modules.ts`,
 * Connector-Katalog, RuntimeAdapter), denn „eine handgepflegte Kopie wäre
 * die vierte Wahrheit" (§18). Deterministisch aus seinem Input, damit
 * Snapshots (§8.1) diff-stabil bleiben.
 *
 * Ein Modul, dessen Runtime-Fähigkeit fehlt, erscheint NICHT: Was diese
 * Installation nicht kann, behauptet sie auch nicht (Invariante 10).
 */

import type { Quad } from '@rdfjs/types';
import type { AppModule } from '@/lib/app/modules';
import type { RuntimeCapabilities, RuntimeId } from '@/lib/platform/runtime/types';
import type { GraphStore } from '../store/types';
import type { IriFactory } from '../iri';
import { factory, namedNode, literal, typedLiteral } from '../rdf';
import { DCTERMS, OW, RDF, SCHEMA } from '../vocab';

/** Kennung des Anwendungsknotens — eine Installation, ein Selbstmodell. */
export const SELF_MODEL_APP_ID = 'workspace';

export interface SelfModelInput {
    runtime: RuntimeId;
    capabilities: RuntimeCapabilities;
    /** Version der Anwendung (package.json). */
    appVersion: string;
    /** Schema-Version der Persistenz (Snapshot-Manifest). */
    schemaVersion: number;
    modules: readonly AppModule[];
    /** Connector-Arten, die dieser Build anbietet (Katalog, nicht Instanzen). */
    connectorKinds: readonly string[];
}

/**
 * Aktive Fähigkeiten als Schlüsselmenge. Nur `true` wird behauptet;
 * abgestufte Fähigkeiten tragen ihren Wert mit (`reasoning:rl`,
 * `causal:graph`). Eine Stufe `none` wird gar nicht erst genannt — sie
 * wäre eine Fähigkeit, die es nicht gibt.
 */
export function activeCapabilities(capabilities: RuntimeCapabilities): string[] {
    const tiers: Record<string, string> = {
        reasoningTier: `reasoning:${capabilities.reasoningTier}`,
        causalTier: `causal:${capabilities.causalTier}`,
    };
    const active: string[] = [];
    for (const [key, value] of Object.entries(capabilities)) {
        if (key in tiers) continue;
        if (value === true) active.push(key);
    }
    active.sort();
    active.push(tiers.reasoningTier);
    if (capabilities.causalTier !== 'none') active.push(tiers.causalTier);
    return active;
}

/** Module, die diese Runtime wirklich anbietet (§18: aktive Capabilities). */
export function availableModules(
    modules: readonly AppModule[],
    capabilities: RuntimeCapabilities,
): AppModule[] {
    return modules.filter(module =>
        !module.requiresCapability || capabilities[module.requiresCapability] === true);
}

/** Reines Mapping Code → Quads (ohne Graph-Komponente), deterministisch. */
export function selfModelQuads(iri: IriFactory, input: SelfModelInput): Quad[] {
    const type = namedNode(RDF.type);
    const quads: Quad[] = [];
    const app = namedNode(iri.entity('app', SELF_MODEL_APP_ID));

    quads.push(
        factory.quad(app, type, namedNode(SCHEMA.SoftwareApplication)),
        factory.quad(app, namedNode(SCHEMA.name), literal('Open Workspace')),
        factory.quad(app, namedNode(DCTERMS.identifier), literal(SELF_MODEL_APP_ID)),
        factory.quad(
            app,
            namedNode(SCHEMA.description),
            typedLiteral.de('Diese Installation, wie sie sich selbst kennt: Module, Entitätstypen, Connector-Arten, aktive Fähigkeiten der Runtime.'),
        ),
        factory.quad(app, namedNode(SCHEMA.softwareVersion), literal(input.appVersion)),
        factory.quad(app, namedNode(SCHEMA.schemaVersion), literal(String(input.schemaVersion))),
        factory.quad(app, namedNode(OW.runtime), literal(input.runtime)),
    );
    for (const capability of activeCapabilities(input.capabilities)) {
        quads.push(factory.quad(app, namedNode(OW.capability), literal(capability)));
    }
    for (const kind of [...input.connectorKinds].sort()) {
        quads.push(factory.quad(app, namedNode(OW.availableConnectorKind), literal(kind)));
    }

    const modules = availableModules(input.modules, input.capabilities);
    const present = new Set(modules.map(module => module.id));
    for (const entry of [...modules].sort((a, b) => a.id.localeCompare(b.id))) {
        const node = namedNode(iri.entity('module', entry.id));
        // Ein Untermodul hängt an seinem Modul, ein Modul an der Anwendung.
        // Fehlt das Elternmodul (fehlende Fähigkeit), hängt es direkt an
        // der Anwendung — eine Kante ins Nichts wäre eine Attrappe.
        const parent = entry.partOf && present.has(entry.partOf)
            ? namedNode(iri.entity('module', entry.partOf))
            : app;
        quads.push(
            factory.quad(node, type, namedNode(OW.Module)),
            factory.quad(node, namedNode(SCHEMA.name), literal(entry.label)),
            factory.quad(node, namedNode(DCTERMS.identifier), literal(entry.id)),
            factory.quad(node, namedNode(SCHEMA.description), typedLiteral.de(entry.description)),
            factory.quad(node, namedNode(OW.route), literal(entry.route)),
            factory.quad(node, namedNode(SCHEMA.isPartOf), parent),
        );
        for (const entityType of [...entry.entityTypes].sort()) {
            quads.push(factory.quad(node, namedNode(OW.entityType), namedNode(entityType)));
        }
    }
    return quads;
}

/** Die Entitäts-Präfixe, deren meta-Knoten dem Selbstmodell gehören. */
function selfModelPrefixes(iri: IriFactory): string[] {
    return (['app', 'module'] as const).map(kind => iri.entity(kind, 'x').slice(0, -1));
}

export interface SelfModelReport {
    /** true, wenn sich das Selbstmodell tatsächlich geändert hat. */
    changed: boolean;
    quads: number;
}

/**
 * Ersetzt den Selbstmodell-Abschnitt in `graph/meta`, ohne andere
 * Meta-Inhalte (AI-Spiegel, Connector-Registry, Views, Profile, Berichte)
 * anzufassen — dasselbe Muster wie `replaceAiMirror`: dump → modify →
 * replace in EINER Transaktion.
 */
export async function replaceSelfModel(
    handle: { store: GraphStore; iri: IriFactory },
    input: SelfModelInput,
): Promise<SelfModelReport> {
    const metaGraph = namedNode(handle.iri.sharedGraph('meta'));
    const prefixes = selfModelPrefixes(handle.iri);
    const ownedBySelf = (subject: string): boolean => prefixes.some(prefix => subject.startsWith(prefix));
    const next = selfModelQuads(handle.iri, input);
    // Sprache und Datentyp gehören in den Vergleich: ein geändertes Label
    // ändert das Modell, auch wenn der Zeichenwert gleich bleibt.
    const key = (quad: Quad): string => {
        const object = quad.object;
        const objectKey = object.termType === 'Literal'
            ? `L|${object.value}|${object.language}|${object.datatype.value}`
            : `${object.termType}|${object.value}`;
        return `${quad.subject.value}|${quad.predicate.value}|${objectKey}`;
    };

    let changed = false;
    await handle.store.transaction(async tx => {
        const remaining: Quad[] = [];
        const previousKeys = new Set<string>();
        for await (const quad of tx.dump(metaGraph)) {
            if (quad.subject.termType === 'NamedNode' && ownedBySelf(quad.subject.value)) {
                previousKeys.add(key(quad));
            } else {
                remaining.push(quad);
            }
        }
        const nextKeys = new Set(next.map(key));
        changed = previousKeys.size !== nextKeys.size || [...nextKeys].some(k => !previousKeys.has(k));
        if (changed) {
            await tx.load([...remaining, ...next], metaGraph, { replace: true });
        }
    });
    return { changed, quads: next.length };
}
