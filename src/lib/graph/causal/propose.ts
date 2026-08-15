/**
 * Die Vorschlagsseite der neurosymbolischen Schleife
 * (CAUSAL_LAYER_SPEC §8, Meilenstein C6) — pur.
 *
 * §8: „Das LLM schlägt vor." Und, mindestens so wichtig, es schlägt
 * **Confounder** vor — „bei Heizungsfragen ist Außentemperatur fast immer
 * ein Störfaktor". Genau darin sind Sprachmodelle gut: den Hypothesenraum
 * aufzuspannen. Ihn zu entscheiden sind sie schlecht, und deshalb geht
 * hier nichts ins Modell, sondern alles nach `causal-hypotheses` und durch
 * die Filter (`filters.ts`).
 *
 * Drei Quellen, streng getrennt und je mit eigener Herkunft:
 *
 *  - **`llm`** — aus den Namen, Einheiten, Orten und Quellarten der
 *    Größen. Trägt `ow:edgeClass "hypothesis"`: Hörensagen, bis Daten
 *    etwas anderes sagen.
 *  - **`topology`** — aus der Geräte-Registry, die der
 *    `home-assistant`-Connector materialisiert hat (C3). Deterministisch,
 *    ohne Netz, ohne Modell. Trägt `ow:edgeClass "structural"`: Ein
 *    Heizkörper und ein Thermometer im selben Raum sind keine Vermutung.
 *  - **`wikidata`** — fremdes Weltwissen über die Föderation (M11), ohne
 *    Import. Trägt `ow:edgeClass "hypothesis"`: Dass die Literatur einen
 *    Zusammenhang kennt, macht ihn in DIESEM Haus nicht wahr.
 *
 * **Die vierte Quelle fehlt, und das steht so da.** §8 nennt als dritte
 * Strukturquelle das Struktur-Lernen aus Daten. Es ist in §16 Teil von C8
 * und darf nach §19 ohne ausdrückliche Freigabe nicht angefangen werden.
 * Die Kantenklasse `learned` bleibt deshalb leer, und der Quellenvergleich
 * weist sie als fehlend aus, statt sie zu erfinden
 * (docs/spec-widersprueche.md, Eintrag 9).
 *
 * Dieses Modul ist **pur**: Es baut Prompts und Abfragen und liest
 * Antworten. Wer sie stellt, steht in `propose.server.ts`.
 */

import type { EdgeClass } from './types';

export const PROPOSAL_SOURCES = ['llm', 'topology', 'wikidata'] as const;
export type ProposalSource = (typeof PROPOSAL_SOURCES)[number];

export const PROPOSAL_SOURCE_LABEL: Record<ProposalSource, string> = {
    llm: 'Sprachmodell',
    topology: 'Geräte-Topologie',
    wikidata: 'Wikidata',
};

/**
 * Die Kantenklasse je Quelle (Invariante C2: vier disjunkte Klassen, nie
 * vermischt). Sie ist an die Quelle gebunden und nicht wählbar — sonst
 * könnte ein Vorschlag sich als Struktur ausgeben.
 */
export const EDGE_CLASS_OF_SOURCE: Record<ProposalSource, EdgeClass> = {
    llm: 'hypothesis',
    topology: 'structural',
    wikidata: 'hypothesis',
};

/**
 * Auswahl der Quellen normalisieren (Nacharbeit zu C6): Der Lauf ersetzt
 * je Quelle (§6.2-Muster), also darf man ihn auch je Quelle anstoßen —
 * ein Topologie-Lauf nach einem Geräteumzug soll keinen
 * Sprachmodell-Aufruf mitbezahlen.
 *
 * Rein und hier statt in der Seite, weil zwei Dinge nicht verrutschen
 * dürfen: **Reihenfolge** (der Lauf hält sie ein, die Klickfolge des
 * Menschen nicht) und die **Bedeutung von „alles"** — sind alle Quellen
 * gewählt, fährt die Anfrage OHNE `sources` und trifft damit die
 * Voreinstellung der Route statt eine zufällig identische Liste.
 * `null` heißt: nichts zu fragen, kein Lauf.
 */
export function proposalRunBody(
    modelId: string,
    selection: readonly ProposalSource[],
): { modelId: string; sources?: ProposalSource[] } | null {
    const wanted = PROPOSAL_SOURCES.filter(source => selection.includes(source));
    if (wanted.length === 0) return null;
    if (wanted.length === PROPOSAL_SOURCES.length) return { modelId };
    return { modelId, sources: wanted };
}

/**
 * Version des Prompts. §8 verlangt die Zuschreibung „auf Modell und
 * Prompt-Version" — ohne sie wäre nicht mehr feststellbar, ob ein
 * schlechter Vorschlag am Modell oder an der Frage lag. Sie wird
 * hochgezählt, sobald sich der Prompttext ändert.
 */
export const PROPOSAL_PROMPT_VERSION = '1';

/** Verfahrensversion der beiden Quellen ohne Sprachmodell. */
export const TOPOLOGY_PROCEDURE_VERSION = '1';
export const WIKIDATA_PROCEDURE_VERSION = '1';

/** Ein Vorschlag, wie ihn eine Quelle abliefert — vor jedem Filter. */
export interface RawProposal {
    from: string;
    to: string;
    /** ISO-8601-Dauer, quelltreu; fehlt, wenn die Quelle keine nennt. */
    temporalLag?: string;
    /** Begründung in einem Satz — die Quelle sagt, warum. */
    rationale: string;
}

/** Was eine Quelle über eine Größe wissen muss, um sie vorzuschlagen. */
export interface ProposalVariable {
    iri: string;
    name: string;
    unit?: string;
    /** numeric | binary | categorical, aus der Erfassungsregel (C3). */
    kind?: string;
    /** Ort im Haus, wenn die Quelle ihn materialisiert hat. */
    placeName?: string;
    /** Art der Quelle (`home-assistant`, `rest-timeseries`, …). */
    sourceKind?: string;
    /** Gehört die Größe schon zum Modell? */
    inModel: boolean;
    /** Wird sie erfasst (C3)? Nur dann ist sie später adjustierbar. */
    observed: boolean;
}

/** Ergebnis einer Quelle: was sie sagt und woran sie gescheitert ist. */
export interface ProposalHarvest {
    proposals: RawProposal[];
    /**
     * Quarantäne statt Abbruch — dieselbe Haltung wie bei Connectoren
     * (§6.1): Was nicht lesbar war, wird gemeldet und nimmt den Rest nicht
     * mit.
     */
    problems: string[];
}

// --- Quelle 1: das Sprachmodell -----------------------------------------

const MAX_LLM_PROPOSALS = 20;

/**
 * Der Prompt. Er nennt die Größen mit allem, was der Graph über sie weiß,
 * und verlangt striktes JSON — kein Freitext, keine Erklärung daneben.
 *
 * Zwei Dinge stehen bewusst darin: Die Aufforderung, **Störgrößen** zu
 * nennen (§8 hält sie für den wertvolleren Teil), und das Verbot,
 * Größen zu erfinden. Ein Vorschlag über eine Variable, die es nicht gibt,
 * ist nicht filterbar, sondern nur wegwerfbar.
 */
export function buildProposalPrompt(
    modelName: string,
    variables: readonly ProposalVariable[],
    existingEdges: readonly { from: string; to: string }[],
): string {
    const byIri = new Map(variables.map(variable => [variable.iri, variable]));
    const describe = (variable: ProposalVariable): string => {
        const parts = [
            `- "${variable.iri}" — ${variable.name}`,
            variable.unit ? `Einheit ${variable.unit}` : null,
            variable.kind ? `Skalenniveau ${variable.kind}` : null,
            variable.placeName ? `Ort ${variable.placeName}` : null,
            variable.sourceKind ? `Quelle ${variable.sourceKind}` : null,
            variable.inModel ? 'bereits im Modell' : 'noch nicht im Modell',
            variable.observed ? 'wird erfasst' : 'wird nicht erfasst',
        ].filter((part): part is string => part !== null);
        return parts.join(', ');
    };
    const edges = existingEdges.length === 0
        ? '(noch keine)'
        : existingEdges
            .map(edge => `- "${byIri.get(edge.from)?.name ?? edge.from}" → `
                + `"${byIri.get(edge.to)?.name ?? edge.to}"`)
            .join('\n');

    return [
        'Du hilfst beim Aufstellen eines kausalen Modells für ein Zuhause (Smart Home).',
        `Das Modell heißt "${modelName}".`,
        '',
        'Verfügbare Größen (die IRI in Anführungszeichen ist die Adresse, die du zurückgeben musst):',
        variables.map(describe).join('\n'),
        '',
        'Bereits gesetzte kausale Kanten (Ursache → Wirkung):',
        edges,
        '',
        'Deine Aufgabe: Schlage kausale Kanten zwischen diesen Größen vor, die noch fehlen.',
        'Wichtiger als offensichtliche Wirkungen sind STÖRGRÖSSEN — Größen, die auf zwei',
        'andere zugleich wirken und einen Zusammenhang vortäuschen können',
        '(Beispiel: die Außentemperatur wirkt auf das Heizverhalten UND auf den Verbrauch).',
        '',
        'Regeln:',
        '1. Verwende ausschließlich die oben genannten IRIs. Erfinde keine Größen.',
        '2. Eine Kante zeigt von der Ursache auf die Wirkung.',
        '3. Schlage keine Kante vor, die es schon gibt.',
        `4. Höchstens ${MAX_LLM_PROPOSALS} Vorschläge.`,
        '5. Nenne, wenn du kannst, den erwarteten Zeitversatz als ISO-8601-Dauer ("PT15M").',
        '6. Begründe jeden Vorschlag in einem deutschen Satz.',
        '',
        'Antworte NUR mit JSON in genau dieser Form, ohne weiteren Text:',
        '{"edges":[{"from":"<IRI>","to":"<IRI>","lag":"PT15M","why":"<ein Satz>"}]}',
        'Das Feld "lag" darfst du weglassen. Gibt es nichts vorzuschlagen: {"edges":[]}',
    ].join('\n');
}

/** Schneidet Code-Zäune und Vor-/Nachgeplapper weg. */
function jsonBody(text: string): string | null {
    const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
    const candidate = (fenced?.[1] ?? text).trim();
    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');
    if (start < 0 || end <= start) return null;
    return candidate.slice(start, end + 1);
}

function asString(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

/**
 * Liest die Antwort. Jeder Eintrag wird einzeln geprüft: Ein kaputter
 * nimmt die anderen nicht mit, und was durchfällt, steht als Klartext im
 * Bericht (Quarantäne wie bei Connectoren).
 */
export function parseProposalResponse(
    text: string,
    variables: readonly ProposalVariable[],
): ProposalHarvest {
    const known = new Set(variables.map(variable => variable.iri));
    const body = jsonBody(text);
    if (!body) {
        return {
            proposals: [],
            problems: ['Die Antwort des Sprachmodells enthielt kein JSON-Objekt.'],
        };
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(body);
    } catch (error) {
        return {
            proposals: [],
            problems: [`Die Antwort des Sprachmodells war kein gültiges JSON: `
                + `${error instanceof Error ? error.message : String(error)}`],
        };
    }
    const edges = (parsed as { edges?: unknown }).edges;
    if (!Array.isArray(edges)) {
        return { proposals: [], problems: ['Die Antwort enthielt kein Feld „edges" mit einer Liste.'] };
    }

    const proposals: RawProposal[] = [];
    const problems: string[] = [];
    const seen = new Set<string>();
    for (const [index, raw] of edges.entries()) {
        if (proposals.length >= MAX_LLM_PROPOSALS) {
            problems.push(`Mehr als ${MAX_LLM_PROPOSALS} Vorschläge — der Rest wurde verworfen.`);
            break;
        }
        if (typeof raw !== 'object' || raw === null) {
            problems.push(`Vorschlag ${index + 1} war kein Objekt.`);
            continue;
        }
        const entry = raw as Record<string, unknown>;
        const from = asString(entry.from);
        const to = asString(entry.to);
        if (!from || !to) {
            problems.push(`Vorschlag ${index + 1} nennt keine Ursache und Wirkung.`);
            continue;
        }
        if (!known.has(from) || !known.has(to)) {
            // Der häufigste Fehler und der wichtigste zu melden: Das Modell
            // hat sich eine Größe ausgedacht. Sie wäre nicht filterbar,
            // sondern nur unsichtbar falsch.
            problems.push(`Vorschlag ${index + 1} nennt eine Größe, die es nicht gibt `
                + `(${known.has(from) ? to : from}).`);
            continue;
        }
        const key = `${from}\u0000${to}`;
        if (seen.has(key)) continue;
        seen.add(key);
        proposals.push({
            from,
            to,
            ...(asString(entry.lag) ? { temporalLag: asString(entry.lag) as string } : {}),
            rationale: asString(entry.why) ?? 'Vom Sprachmodell vorgeschlagen, ohne Begründung.',
        });
    }
    return { proposals, problems };
}

// --- Quelle 2: die Geräte-Topologie -------------------------------------

/** Was die Registry über die Messquelle einer Größe sagt (C3). */
export interface TopologyFact {
    variableIri: string;
    name: string;
    /** Kann geschaltet werden — die Treatment-Seite eines Modells. */
    actuator: boolean;
    /** `sosa:Platform`, auf der die Entität sitzt. */
    deviceIri?: string;
    deviceName?: string;
    placeIri?: string;
    placeName?: string;
}

const MAX_TOPOLOGY_PROPOSALS = 40;

/**
 * Die Registry als Prior (§8, Filter 4 in umgekehrter Richtung): Was
 * geschaltet werden kann, wirkt plausibel auf das, was am selben Gerät
 * oder im selben Raum gemessen wird. Das ist keine Vermutung über die
 * Welt, sondern eine Ablesung der Installation — deshalb `structural`.
 *
 * Bewusst eng: nur Aktor → Sensor, nur gleiches Gerät oder gleicher Ort.
 * Ein Raum weiter wäre schon Physik, und Physik behauptet dieses Verfahren
 * nicht. Die Gegenrichtung (ein Sensor wirkt auf einen Aktor) ist keine
 * Struktur, sondern eine Automation — und die steht als solche im Graphen,
 * nicht hier.
 */
export function proposeFromTopology(facts: readonly TopologyFact[]): ProposalHarvest {
    const actuators = facts.filter(fact => fact.actuator);
    const sensors = facts.filter(fact => !fact.actuator);
    const proposals: RawProposal[] = [];
    const problems: string[] = [];
    for (const actuator of actuators) {
        for (const sensor of sensors) {
            if (actuator.variableIri === sensor.variableIri) continue;
            const sameDevice = actuator.deviceIri !== undefined && actuator.deviceIri === sensor.deviceIri;
            const samePlace = actuator.placeIri !== undefined && actuator.placeIri === sensor.placeIri;
            if (!sameDevice && !samePlace) continue;
            if (proposals.length >= MAX_TOPOLOGY_PROPOSALS) {
                problems.push(`Mehr als ${MAX_TOPOLOGY_PROPOSALS} topologische Paare — `
                    + 'die Liste wurde gekappt. Nimm weniger Größen ins Modell.');
                return { proposals, problems };
            }
            proposals.push({
                from: actuator.variableIri,
                to: sensor.variableIri,
                rationale: sameDevice
                    ? `„${actuator.name}" und „${sensor.name}" sitzen auf demselben Gerät `
                        + `(${actuator.deviceName ?? 'unbenannt'}).`
                    : `„${actuator.name}" schaltet in ${actuator.placeName ?? 'demselben Bereich'}, `
                        + `wo „${sensor.name}" misst.`,
            });
        }
    }
    return { proposals, problems };
}

// --- Quelle 3: Wikidata über die Föderation -----------------------------

/**
 * Die Abfrage. Sie fragt nur nach dem, was Wikidata über die
 * **Größenarten** weiß — nicht über dieses Haus, von dem es nichts wissen
 * kann. `wdt:P828 (has cause)` und `wdt:P1542 (has effect)` sind
 * Wikidatas eigene Kausalaussagen; sie hier zu LESEN ist etwas anderes,
 * als sie als eigenes Kantenvokabular zu übernehmen — das wurde in C0
 * geprüft und verworfen, weil sie außerhalb von Wikidata nicht definiert
 * sind.
 *
 * Die Labels kommen aus den Größen des Modells. Trifft keines, ist das
 * Ergebnis leer, und genau das wird gemeldet — eine leere Antwort ist
 * kein Fehler, sondern eine Auskunft.
 */
export function buildWikidataQuery(labels: readonly string[], limit = 50): string {
    const values = labels
        .map(label => `"${label.replace(/["\\]/g, '\\$&')}"@en`)
        .join(' ');
    return [
        'PREFIX wdt: <http://www.wikidata.org/prop/direct/>',
        'PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>',
        'SELECT DISTINCT ?causeLabel ?effectLabel WHERE {',
        `  VALUES ?causeLabel { ${values} }`,
        `  VALUES ?effectLabel { ${values} }`,
        '  ?cause rdfs:label ?causeLabel .',
        '  ?effect rdfs:label ?effectLabel .',
        '  FILTER(?cause != ?effect)',
        '  { ?effect wdt:P828 ?cause } UNION { ?cause wdt:P1542 ?effect }',
        `} LIMIT ${limit}`,
    ].join('\n');
}

/**
 * Bildet die Antwort auf Modellvariablen zurück. Der Schlüssel ist das
 * Label, mit dem gefragt wurde — deshalb kann hier nichts landen, wonach
 * nicht gefragt wurde.
 */
export function parseWikidataRows(
    rows: ReadonlyArray<Record<string, { value: string }>>,
    variableByLabel: ReadonlyMap<string, ProposalVariable>,
): ProposalHarvest {
    const proposals: RawProposal[] = [];
    const problems: string[] = [];
    const seen = new Set<string>();
    for (const row of rows) {
        const causeLabel = row.causeLabel?.value;
        const effectLabel = row.effectLabel?.value;
        if (!causeLabel || !effectLabel) continue;
        const cause = variableByLabel.get(causeLabel.toLowerCase());
        const effect = variableByLabel.get(effectLabel.toLowerCase());
        if (!cause || !effect || cause.iri === effect.iri) continue;
        const key = `${cause.iri}\u0000${effect.iri}`;
        if (seen.has(key)) continue;
        seen.add(key);
        proposals.push({
            from: cause.iri,
            to: effect.iri,
            rationale: `Wikidata führt „${effectLabel}" als Wirkung von „${causeLabel}" — `
                + 'allgemeines Wissen über die Größenart, keine Aussage über dieses Haus.',
        });
    }
    return { proposals, problems };
}

/**
 * Die englischen Suchbegriffe einer Größe. Wikidata hat für die
 * Hausdomäne fast nur englische Labels; die `device_class` aus Home
 * Assistant ist genau der Schlüssel, unter dem gleichartige Sensoren
 * verschiedener Hersteller vergleichbar werden (C3), und sie ist bereits
 * englisch. Geraten wird nichts: Wo kein Schlüssel vorliegt, gibt es
 * keinen Suchbegriff.
 */
export function wikidataLabelsOf(variable: ProposalVariable & { observableName?: string }): string[] {
    const labels = new Set<string>();
    if (variable.observableName) labels.add(variable.observableName.replace(/_/g, ' ').toLowerCase());
    return [...labels].filter(label => label.length > 2);
}
