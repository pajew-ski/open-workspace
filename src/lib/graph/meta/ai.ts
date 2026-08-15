/**
 * AI-Spiegel in `graph/meta` (SPEC §18-Muster, Meilenstein M9, erweitert
 * in M15): die Skills, Agenten, Werkzeuge UND die Inference-Provider samt
 * ihren konfigurierten Modellen DIESER Installation sind Graph-Bürger —
 * Knoten im Graphen, keine Einträge, die nur in JSON-Dateien leben
 * (Invariante 6). Damit ist die M9-Abnahmefrage per SPARQL beantwortbar:
 * welche Skills welche Tools benötigen und welcher Agent sie anbietet —
 * und seit M15 auch: welche Modelle hinter welcher Quelle stehen und
 * welche davon Werkzeuge nativ aufrufen kann (ow:toolCallMode).
 *
 * Wahrheits-Semantik (bewusst anders als die Store-first-CRUD aus §12.4):
 * Die JSON-Bestände (`data/ai/skills.json`, `data/agents/config.json`,
 * `data/tools/tools.json`, `data/ai/config.json`) bleiben die operative
 * Konfiguration — die AI-Schicht muss auch serverlos im Browser laufen,
 * wo dieser Store nicht existiert. Der Spiegel wird wie das Selbstmodell
 * (§18) GENERIERT: beim Start und nach jeder Mutation vollständig ersetzt,
 * nie von Hand gepflegt. Er ist deterministisch aus seinem Input, damit
 * Snapshots (§8.1) diff-stabil bleiben.
 *
 * Abgebildet wird, was das System JETZT anbietet (nur `enabled`-Einträge —
 * §18: „aktive Capabilities"), mit den Engine-Namen als dcterms:identifier,
 * sodass `[[TOOL:…]]`-Referenzen aus Skill-Inhalten auf die Tool-Knoten
 * zeigen. MCP-Server erscheinen als konfigurierte ow:ToolProvider OHNE
 * Tool-Liste — das Live-Inventar liefert ehrlich nur der `mcp-server`-
 * Connector (Discovery ist ein Netz-Lauf, keine Konfigurationstatsache);
 * genauso erscheinen bei einem Inference-Provider nur die KONFIGURIERTEN
 * Modelle (Voreinstellung und gepinnte), nie ein abgefragtes Live-Inventar.
 * System-Prompts lokaler Agenten und jede Form von Geheimnis
 * (`apiKeyEnc`, Auth-Header) werden bewusst nicht gespiegelt
 * (Konfiguration, kein Wissen).
 */

import type { Quad } from '@rdfjs/types';
import type { Skill } from '@/lib/skills/types';
import type { Agent } from '@/lib/agents/types';
import type { Tool } from '@/lib/tools/types';
import type { AIDefaults, AIProvider, McpServerConfig } from '@/lib/ai/types';
import { apiToolToEngineTool, makeCreateTaskTool, makeFinderTool, makeUpdateTaskTool, makeUseSkillTool } from '@/lib/ai/tools.shared';
import type { GraphStore } from '../store/types';
import type { IriFactory } from '../iri';
import { factory, namedNode, literal, typedLiteral } from '../rdf';
import { DCTERMS, FOAF, OW, RDF, SCHEMA, XSD } from '../vocab';

export interface AiMirrorInput {
    skills: Skill[];
    agents: Agent[];
    apiTools: Tool[];
    mcpServers: McpServerConfig[];
    /** Konfigurierte Inferenz-Quellen (M15). */
    providers: AIProvider[];
    /** Vorauswahl von Provider und Modell (M15). */
    defaults: AIDefaults;
}

/** Anbieter-Knoten der eingebauten und selbst konfigurierten Werkzeuge. */
export const WORKSPACE_TOOL_PROVIDER_ID = 'workspace';

/**
 * Tool-Referenzen eines Skill-Inhalts: die `[[TOOL:name:…]]`-Syntax aus
 * dem Tool-Protokoll (callParser.ts — identische id-Zeichenklasse).
 * Dedupliziert und sortiert, damit der Spiegel deterministisch bleibt.
 */
export function referencedToolNames(content: string): string[] {
    const names = new Set<string>();
    for (const match of content.matchAll(/\[\[TOOL:([\w.-]+):/g)) {
        names.add(match[1]);
    }
    return [...names].sort();
}

interface ToolDescriptor {
    /** Engine-Name — unter diesem Namen ruft das Modell das Tool auf. */
    name: string;
    description: string;
    parameters: Record<string, unknown>;
}

const noopExecute = async () => ({ text: '' });

/**
 * Die eingebauten Werkzeuge aus derselben Quelle wie die Engine
 * (tools.shared.ts) — keine zweite, handgepflegte Beschreibungs-Kopie.
 */
function builtinToolDescriptors(): ToolDescriptor[] {
    const finder = makeFinderTool(async () => '');
    const useSkill = makeUseSkillTool([], async () => null);
    const createTask = makeCreateTaskTool(async () => '');
    const updateTask = makeUpdateTaskTool(async () => '');
    return [finder, createTask, updateTask, useSkill].map(tool => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters as Record<string, unknown>,
    }));
}

function apiToolDescriptor(tool: Tool): ToolDescriptor {
    const engineTool = apiToolToEngineTool(tool, noopExecute);
    return {
        name: engineTool.name,
        description: engineTool.description,
        parameters: engineTool.parameters as Record<string, unknown>,
    };
}

/** IRI-Kennung eines gespiegelten Skills einer Agent-Capability. */
function capabilitySlug(value: string, index: number): string {
    const slug = value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    return slug !== '' ? slug : `cap-${index + 1}`;
}

function skillSourceLiteral(skill: Skill): string {
    const ref = skill.source.ref?.trim();
    return ref ? `${skill.source.type}:${ref}` : skill.source.type;
}

/**
 * Reines Mapping Konfiguration → Quads (ohne Graph-Komponente).
 * Deterministisch: Eingaben werden nach stabilen Schlüsseln sortiert.
 */
export function aiMirrorQuads(iri: IriFactory, input: AiMirrorInput): Quad[] {
    const type = namedNode(RDF.type);
    const quads: Quad[] = [];

    // Werkzeug-Anbieter „workspace": die App selbst (§18 — das System
    // beschreibt sich). Builtins und API-Tools hängen an ihm.
    const workspaceProvider = namedNode(iri.entity('tool-provider', WORKSPACE_TOOL_PROVIDER_ID));
    quads.push(
        factory.quad(workspaceProvider, type, namedNode(OW.ToolProvider)),
        factory.quad(workspaceProvider, type, namedNode(SCHEMA.SoftwareApplication)),
        factory.quad(workspaceProvider, namedNode(SCHEMA.name), literal('Open Workspace')),
        factory.quad(workspaceProvider, namedNode(SCHEMA.description), typedLiteral.de('Eingebaute und selbst konfigurierte Werkzeuge dieser Installation.')),
    );

    const toolDescriptors = [
        ...builtinToolDescriptors(),
        ...input.apiTools.filter(tool => tool.enabled).map(apiToolDescriptor),
    ].sort((a, b) => a.name.localeCompare(b.name));
    for (const tool of toolDescriptors) {
        const node = namedNode(iri.entity('tool', tool.name));
        quads.push(
            factory.quad(node, type, namedNode(OW.Tool)),
            factory.quad(node, namedNode(SCHEMA.name), literal(tool.name)),
            factory.quad(node, namedNode(DCTERMS.identifier), literal(tool.name)),
            factory.quad(node, namedNode(SCHEMA.description), literal(tool.description)),
            factory.quad(node, namedNode(OW.inputSchema), literal(JSON.stringify(tool.parameters))),
            factory.quad(node, namedNode(OW.providedBy), workspaceProvider),
        );
    }

    // Konfigurierte MCP-Server als ow:ToolProvider — nur die
    // Konfigurationstatsachen (Endpoint, Transport), kein erfundenes
    // Tool-Inventar (Invariante 10; das Live-Inventar liefert der
    // mcp-server-Connector).
    for (const server of [...input.mcpServers].filter(s => s.enabled).sort((a, b) => a.id.localeCompare(b.id))) {
        const node = namedNode(iri.entity('tool-provider', `mcp-${server.id}`));
        quads.push(
            factory.quad(node, type, namedNode(OW.ToolProvider)),
            factory.quad(node, type, namedNode(SCHEMA.SoftwareApplication)),
            factory.quad(node, namedNode(SCHEMA.name), literal(server.label)),
            factory.quad(node, namedNode(OW.endpoint), typedLiteral.anyUri(server.url)),
            factory.quad(node, namedNode(OW.transport), literal(server.transport)),
            factory.quad(node, namedNode(DCTERMS.created), typedLiteral.dateTime(server.createdAt)),
            factory.quad(node, namedNode(DCTERMS.modified), typedLiteral.dateTime(server.updatedAt)),
        );
    }

    // Skills: ow:Skill mit Trigger (SKILL.md: die Beschreibung sagt, wann
    // der Skill greift), Ladeweg, Anleitung (schema:text — damit ist der
    // Skill-Inhalt volltext-suchbar, M8) und Werkzeugbedarf.
    for (const skill of [...input.skills].filter(s => s.enabled).sort((a, b) => a.id.localeCompare(b.id))) {
        const node = namedNode(iri.entity('skill', skill.id));
        quads.push(
            factory.quad(node, type, namedNode(OW.Skill)),
            factory.quad(node, namedNode(SCHEMA.name), literal(skill.name)),
            factory.quad(node, namedNode(DCTERMS.identifier), literal(skill.id)),
            factory.quad(node, namedNode(OW.skillSource), literal(skillSourceLiteral(skill))),
            factory.quad(node, namedNode(SCHEMA.text), literal(skill.content)),
            factory.quad(node, namedNode(DCTERMS.created), typedLiteral.dateTime(skill.createdAt)),
            factory.quad(node, namedNode(DCTERMS.modified), typedLiteral.dateTime(skill.updatedAt)),
        );
        if (skill.description.trim() !== '') {
            quads.push(
                factory.quad(node, namedNode(SCHEMA.description), literal(skill.description)),
                factory.quad(node, namedNode(OW.trigger), literal(skill.description)),
            );
        }
        for (const toolName of referencedToolNames(skill.content)) {
            // Die Kante behauptet den Bedarf; ob ein beschriebener
            // Tool-Knoten existiert, hängt von der Konfiguration ab
            // (offene Welt — ein fehlendes Tool ist abfragbar).
            quads.push(factory.quad(node, namedNode(OW.requiresTool), namedNode(iri.entity('tool', toolName))));
        }
    }

    // Agenten: lokale Personas und konfigurierte Remote-A2A-Agenten.
    for (const agent of [...input.agents].filter(a => a.enabled).sort((a, b) => a.id.localeCompare(b.id))) {
        const node = namedNode(iri.entity('agent', agent.id));
        quads.push(
            factory.quad(node, type, namedNode(OW.Agent)),
            factory.quad(node, type, namedNode(FOAF.Agent)),
            factory.quad(node, type, namedNode(SCHEMA.SoftwareApplication)),
            factory.quad(node, namedNode(SCHEMA.name), literal(agent.name)),
            factory.quad(node, namedNode(DCTERMS.identifier), literal(agent.id)),
            factory.quad(node, namedNode(DCTERMS.created), typedLiteral.dateTime(agent.createdAt)),
            factory.quad(node, namedNode(DCTERMS.modified), typedLiteral.dateTime(agent.updatedAt)),
        );
        if (agent.description.trim() !== '') {
            quads.push(factory.quad(node, namedNode(SCHEMA.description), literal(agent.description)));
        }
        if (agent.type === 'remote_a2a') {
            if (agent.config.endpointUrl) {
                quads.push(factory.quad(node, namedNode(OW.endpoint), typedLiteral.anyUri(agent.config.endpointUrl)));
            }
            if (agent.config.cardUrl) {
                quads.push(factory.quad(node, namedNode(OW.agentCardUrl), typedLiteral.anyUri(agent.config.cardUrl)));
            }
            // Bei der Discovery übernommene Card-Skills (Namen): der Agent
            // hat sie angeboten — als ow:Skill-Knoten abfragbar.
            const seen = new Set<string>();
            (agent.config.capabilities ?? []).forEach((capability, index) => {
                const name = capability.trim();
                if (name === '') return;
                const slug = capabilitySlug(name, index);
                if (seen.has(slug)) return;
                seen.add(slug);
                const skillNode = namedNode(iri.entity('skill', `${agent.id}/${slug}`));
                quads.push(
                    factory.quad(skillNode, type, namedNode(OW.Skill)),
                    factory.quad(skillNode, namedNode(SCHEMA.name), literal(name)),
                    factory.quad(node, namedNode(OW.providesSkill), skillNode),
                );
                if (agent.config.cardUrl) {
                    quads.push(factory.quad(skillNode, namedNode(OW.skillSource), literal(`a2a-card:${agent.config.cardUrl}`)));
                }
            });
        }
    }

    // Inference-Provider und ihre Modelle (M15). Gespiegelt wird die
    // KONFIGURATION, nie ein Geheimnis: `apiKeyEnc` und Header-Werte
    // bleiben in der operativen Konfiguration. Modelle erscheinen nur,
    // soweit sie konfiguriert SIND (Voreinstellung + gepinnte Modelle) —
    // ein Live-Inventar ist ein Netz-Lauf und wird nicht erfunden
    // (Invariante 10, dasselbe Prinzip wie beim MCP-Tool-Inventar).
    for (const provider of [...input.providers].filter(p => p.enabled).sort((a, b) => a.id.localeCompare(b.id))) {
        const node = namedNode(iri.entity('ai-provider', provider.id));
        quads.push(
            factory.quad(node, type, namedNode(OW.InferenceProvider)),
            factory.quad(node, type, namedNode(SCHEMA.Service)),
            factory.quad(node, namedNode(SCHEMA.name), literal(provider.label)),
            factory.quad(node, namedNode(DCTERMS.identifier), literal(provider.id)),
            factory.quad(node, namedNode(OW.providerKind), literal(provider.kind)),
            factory.quad(node, namedNode(OW.toolCallMode), literal(provider.toolCalls)),
            factory.quad(node, namedNode(DCTERMS.created), typedLiteral.dateTime(provider.createdAt)),
            factory.quad(node, namedNode(DCTERMS.modified), typedLiteral.dateTime(provider.updatedAt)),
        );
        // WebLLM läuft im Browser und hat deshalb keinen Endpoint — ein
        // leerer wäre eine Behauptung über eine Adresse, die es nicht gibt.
        if (provider.baseUrl !== '') {
            quads.push(factory.quad(node, namedNode(OW.endpoint), typedLiteral.anyUri(provider.baseUrl)));
        }
        const models = [...new Set([
            ...(provider.defaultModel ? [provider.defaultModel] : []),
            ...(provider.pinnedModels ?? []),
            // Das workspace-weit vorausgewählte Modell ist an diesem
            // Provider konfiguriert, auch wenn es nicht sein eigener
            // Default ist — sonst fehlte im Spiegel genau das Modell,
            // mit dem die Installation tatsächlich antwortet.
            ...(input.defaults.providerId === provider.id && input.defaults.model
                ? [input.defaults.model]
                : []),
        ].filter(name => name.trim() !== ''))].sort();
        for (const name of models) {
            const modelNode = namedNode(iri.entity('model', `${provider.id}/${name}`));
            quads.push(
                factory.quad(modelNode, type, namedNode(OW.Model)),
                factory.quad(modelNode, type, namedNode(SCHEMA.SoftwareApplication)),
                factory.quad(modelNode, namedNode(SCHEMA.name), literal(name)),
                factory.quad(modelNode, namedNode(DCTERMS.identifier), literal(name)),
                factory.quad(modelNode, namedNode(SCHEMA.provider), node),
            );
        }
        if (provider.defaultModel && provider.defaultModel.trim() !== '') {
            quads.push(factory.quad(
                node,
                namedNode(OW.defaultModel),
                namedNode(iri.entity('model', `${provider.id}/${provider.defaultModel}`)),
            ));
        }
    }

    return quads;
}

/**
 * Stabile Vergleichs-Kennung eines Spiegel-Quads (keine Blank Nodes).
 * xsd:dateTime wird als Zeitpunkt verglichen, nicht als Lexik — Oxigraph
 * normalisiert Endnullen (.000Z → Z), und derselbe Zeitpunkt ist kein
 * geänderter Spiegel.
 */
function quadKey(quad: Quad): string {
    const object = quad.object;
    let objectKey: string;
    if (object.termType === 'Literal') {
        let value = object.value;
        if (object.datatype.value === XSD.dateTime) {
            const epoch = Date.parse(value);
            if (Number.isFinite(epoch)) value = String(epoch);
        }
        objectKey = `L|${value}|${object.language}|${object.datatype.value}`;
    } else {
        objectKey = `${object.termType}|${object.value}`;
    }
    return `${quad.subject.value}|${quad.predicate.value}|${objectKey}`;
}

/** Die Entitäts-Präfixe, deren meta-Knoten dem Spiegel gehören. */
function mirrorPrefixes(iri: IriFactory): string[] {
    return (['skill', 'agent', 'tool', 'tool-provider', 'ai-provider', 'model'] as const)
        .map(kind => `${iri.entity(kind, 'x').slice(0, -1)}`);
}

export interface AiMirrorReport {
    /** true, wenn sich der Spiegel-Abschnitt tatsächlich geändert hat. */
    changed: boolean;
    quads: number;
}

/**
 * Ersetzt den AI-Spiegel-Abschnitt in `graph/meta`, ohne andere
 * Meta-Inhalte (Connector-Registry, Views, Profile, Berichte) anzufassen —
 * dasselbe Muster wie die Connector-Registry: dump → modify → replace in
 * einer Transaktion.
 */
export async function replaceAiMirror(
    handle: { store: GraphStore; iri: IriFactory },
    input: AiMirrorInput,
): Promise<AiMirrorReport> {
    const metaGraph = namedNode(handle.iri.sharedGraph('meta'));
    const prefixes = mirrorPrefixes(handle.iri);
    const ownedBySelf = (subject: string): boolean => prefixes.some(prefix => subject.startsWith(prefix));
    const next = aiMirrorQuads(handle.iri, input);

    let changed = false;
    await handle.store.transaction(async tx => {
        const remaining: Quad[] = [];
        const previousKeys = new Set<string>();
        for await (const quad of tx.dump(metaGraph)) {
            if (quad.subject.termType === 'NamedNode' && ownedBySelf(quad.subject.value)) {
                previousKeys.add(quadKey(quad));
            } else {
                remaining.push(quad);
            }
        }
        const nextKeys = new Set(next.map(quadKey));
        changed = previousKeys.size !== nextKeys.size || [...nextKeys].some(key => !previousKeys.has(key));
        if (changed) {
            await tx.load([...remaining, ...next], metaGraph, { replace: true });
        }
    });
    return { changed, quads: next.length };
}
