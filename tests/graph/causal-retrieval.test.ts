// @vitest-environment node
/**
 * Abnahme C2 — Causal Path Tracing im Retrieval (CAUSAL_LAYER_SPEC §9,
 * §16; Erweiterung von GRAPH_CORE_SPEC §7.5 um das Feld `causal`).
 *
 * Die beiden Abnahmesätze der Spec, wörtlich, und was dazugehört, damit
 * sie etwas heißen:
 *
 *  1. **`explain` trägt den kausalen Pfad.** Nicht die Hop-Distanz,
 *     sondern Modell, Frage, Wege mit Richtung, Adjustierung und was
 *     herausgefallen ist — jeweils mit Namen und Grund. Auch der
 *     linearisierte Kontext beginnt damit: die Kette, nicht die Wolke.
 *  2. **D-separierte Knoten fallen bei gegebener Konditionierung
 *     nachweislich raus** — und zwar an zwei Stellen: schon im Trace
 *     (die Größe selbst) und im Tor der Expansion (dieselbe Größe über
 *     einen semantischen Umweg). Gegenprobe ohne Konditionierung: sie
 *     ist wieder da.
 *
 * Dazu, weil sonst nichts davon trägt: der pure Trace gegen einen
 * Lehrbuch-DAG, die Browser-Tauglichkeit (Tier 1 bleibt Tier 1), die
 * Auflösung des Modells (nie geraten) und die Grant-Klammer (C6 — ein
 * fremdes Kausalmodell erdet nichts).
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { OxigraphStore } from '@/lib/graph/store/oxigraph';
import { createIriFactory } from '@/lib/graph/iri';
import { factory, literal, namedNode } from '@/lib/graph/rdf';
import { OW, RDF, SCHEMA } from '@/lib/graph/vocab';
import { createDag } from '@/lib/graph/causal/dag';
import { pathAsText, traceCausal } from '@/lib/graph/causal/trace';
import { createCausalModel, readCausalModel } from '@/lib/graph/causal/model';
import { applyStructureOperation } from '@/lib/graph/causal/edit';
import { dagFromModel } from '@/lib/graph/causal/view';
import { groundCausal } from '@/lib/graph/search/causal-grounding';
import { createRetrievalProfile, getRetrievalProfile } from '@/lib/graph/search/profiles';
import { retrieve, type RetrievalResult } from '@/lib/graph/search/retrieval';

const INSTANCE_BASE = 'https://ws.example.org/id/';
const alice = createIriFactory(INSTANCE_BASE, 'alice');

const handleFor = (store: OxigraphStore) => ({ store, iri: alice });
const variable = (slug: string) => alice.entity('variable', slug);
const doc = (slug: string) => alice.entity('doc', slug);

// --- Der Lehrbuch-DAG dieser Abnahme -------------------------------------
//
//   Zeitschaltuhr → Nachtabsenkung → Raumtemperatur → Heizenergie
//                                          ↑              ↑
//                                   Außentemperatur ──────┘
//   Kaffeemaschine → Stromverbrauch      (zweite, unbeteiligte Komponente)
//
// Raumtemperatur ist ein Collider (Nachtabsenkung und Außentemperatur
// wirken beide auf sie) — genau deshalb ist der Weg
// Nachtabsenkung → Raumtemperatur ← Außentemperatur → Heizenergie
// ohne Konditionierung geschlossen und mit ihr offen.

const T = variable('zeitschaltuhr');
const A = variable('nachtabsenkung');
const M = variable('raumtemperatur');
const Y = variable('heizenergie');
const U = variable('aussentemperatur');
const K = variable('kaffeemaschine');
const S = variable('stromverbrauch');

const MODEL_EDGES: Array<[string, string]> = [
    [T, A],
    [A, M],
    [M, Y],
    [U, M],
    [U, Y],
    [K, S],
];

const pureDag = createDag({ edges: MODEL_EDGES.map(([from, to]) => ({ from, to })) });

/**
 * Modell im Store, geschrieben über den EINEN Schreibweg aus C1 — nicht
 * per Hand zusammengelegte Quads. Sonst prüfte die Abnahme eine Form,
 * die im Produkt so nie entsteht.
 */
async function buildStore(options: { second?: boolean } = {}): Promise<OxigraphStore> {
    const store = new OxigraphStore();
    const handle = handleFor(store);
    await createCausalModel(handle, { id: 'wohnung', name: 'Wohnung' });
    for (const [slug, name] of [
        ['zeitschaltuhr', 'Zeitschaltuhr'],
        ['nachtabsenkung', 'Nachtabsenkung'],
        ['raumtemperatur', 'Raumtemperatur'],
        ['heizenergie', 'Heizenergie'],
        ['aussentemperatur', 'Außentemperatur'],
        ['kaffeemaschine', 'Kaffeemaschine'],
        ['stromverbrauch', 'Stromverbrauch'],
    ] as const) {
        await applyStructureOperation(handle, 'wohnung', { op: 'add-variable', name });
        expect(variable(slug)).toBeTruthy();
    }
    for (const [from, to] of MODEL_EDGES) {
        await applyStructureOperation(handle, 'wohnung', { op: 'add-edge', from, to, edgeClass: 'asserted' });
    }
    if (options.second) {
        await createCausalModel(handle, { id: 'garten', name: 'Garten' });
    }

    // Material ZUR Kette: Notizen im Arbeitsgraphen. Die Notiz zur
    // Nachtabsenkung erwähnt zusätzlich die Kaffeemaschine — der
    // semantische Umweg, an dem sich das kausale Tor beweisen muss.
    const W = namedNode(alice.graph('workspace'));
    const add = (s: string, p: string, o: Parameters<typeof factory.quad>[2]) =>
        factory.quad(namedNode(s), namedNode(p), o, W);
    await store.load([
        add(doc('nachtabsenkung'), RDF.type, namedNode(OW.Document)),
        add(doc('nachtabsenkung'), SCHEMA.name, literal('Notiz zur Nachtabsenkung')),
        add(doc('nachtabsenkung'), SCHEMA.about, namedNode(A)),
        add(doc('nachtabsenkung'), SCHEMA.about, namedNode(K)),
        add(doc('zeitschaltuhr'), RDF.type, namedNode(OW.Document)),
        add(doc('zeitschaltuhr'), SCHEMA.name, literal('Notiz zur Zeitschaltuhr')),
        add(doc('zeitschaltuhr'), SCHEMA.about, namedNode(T)),
    ], W, { replace: true });
    return store;
}

async function retrieveCausal(
    store: OxigraphStore,
    causal: Parameters<typeof groundCausal>[1],
    overrides: Record<string, unknown> = {},
): Promise<RetrievalResult> {
    return retrieve(handleFor(store), { causal, maxHops: 2, format: 'both', ...overrides });
}

const iris = (result: RetrievalResult) => result.nodes.map(node => node.iri);

// --- 1. Der pure Trace (Tier 1) ------------------------------------------

describe('Trace über den DAG (§9, pur)', () => {
    it('nennt die Ursachenseite mit Abstand und Weg', () => {
        const trace = traceCausal(pureDag, { mode: 'ancestors', outcome: Y });
        expect(trace.nodes.map(node => node.node).sort()).toEqual([A, U, M, T, Y].sort());
        const nachtabsenkung = trace.nodes.find(node => node.node === A);
        expect(nachtabsenkung?.distance).toBe(2);
        // Der Weg steht in Wirkrichtung, nicht in Laufrichtung der Suche.
        expect(nachtabsenkung?.path).toEqual([A, M, Y]);
    });

    it('nennt die Folgenseite und lässt die Ursachen weg', () => {
        const trace = traceCausal(pureDag, { mode: 'descendants', treatment: A });
        expect(trace.nodes.map(node => node.node).sort()).toEqual([A, M, Y].sort());
        expect(trace.nodes.some(node => node.node === T)).toBe(false);
    });

    it('klassifiziert die Wege und schließt den Collider-Weg von selbst', () => {
        const trace = traceCausal(pureDag, { mode: 'paths', treatment: A, outcome: Y });
        const causal = trace.paths.find(p => p.kind === 'causal');
        expect(causal?.nodes).toEqual([A, M, Y]);
        expect(causal?.open).toBe(true);
        const collider = trace.paths.find(p => p.nodes.includes(U));
        expect(collider?.open).toBe(false);
        expect(collider?.blockedBy).toEqual([M]);
        // Wer nur auf dem geschlossenen Weg liegt, fällt heraus — mit Grund.
        expect(trace.dropped).toEqual([{ node: U, reason: 'blocked-path' }]);
        expect(pathAsText(causal!, node => node.split('/').pop() as string))
            .toBe('nachtabsenkung → raumtemperatur → heizenergie');
    });

    it('öffnet den Collider-Weg, sobald auf den Collider konditioniert wird', () => {
        const trace = traceCausal(pureDag, { mode: 'paths', treatment: A, outcome: Y, blockedBy: [M] });
        const collider = trace.paths.find(p => p.nodes.includes(U));
        expect(collider?.open).toBe(true);
        // Und der Wirkweg ist jetzt zu — Konditionieren hat einen Preis.
        expect(trace.paths.find(p => p.kind === 'causal')?.open).toBe(false);
    });

    it('lässt gegeben der Konditionierung d-separierte Größen fallen', () => {
        const offen = traceCausal(pureDag, { mode: 'ancestors', outcome: Y });
        expect(offen.nodes.some(node => node.node === T)).toBe(true);

        const konditioniert = traceCausal(pureDag, { mode: 'ancestors', outcome: Y, blockedBy: [A] });
        expect(konditioniert.nodes.some(node => node.node === T)).toBe(false);
        expect(konditioniert.dropped).toEqual([{ node: T, reason: 'd-separated' }]);
        // Die adjustierte Größe selbst bleibt: Wer über sie adjustiert,
        // will sie im Kontext sehen.
        expect(konditioniert.nodes.find(node => node.node === A)?.role).toBe('conditioned');
    });

    it('behält Ursache und Wirkung, auch wenn alle Wege geschlossen sind', () => {
        // Reine Kette, adjustiert auf den Mediator: Danach ist kein Weg
        // mehr offen. Ursache und Wirkung bleiben trotzdem — sie sind die
        // Frage, nicht ein Beitrag zu ihr; dass nichts offen blieb, steht
        // im Hinweis. Der Mediator dazwischen fällt heraus.
        const kette = createDag({ edges: [{ from: T, to: A }, { from: A, to: M }, { from: M, to: Y }] });
        const trace = traceCausal(kette, { mode: 'paths', treatment: T, outcome: Y, blockedBy: [A] });
        expect(trace.nodes.map(node => node.node).sort()).toEqual([A, T, Y].sort());
        expect(trace.dropped).toEqual([{ node: M, reason: 'blocked-path' }]);
        expect(trace.notes.join(' ')).toContain('geschlossen');
    });

    it('gibt den Markov-Kragen aus Eltern, Kindern und Mit-Eltern', () => {
        const trace = traceCausal(pureDag, { mode: 'markov-blanket', treatment: M });
        expect(trace.nodes.map(node => node.node).sort()).toEqual([A, M, U, Y].sort());
        expect(trace.nodes.some(node => node.node === T)).toBe(false);
    });

    it('sagt es, statt zu raten, wenn die Frage im Modell nicht steht', () => {
        const trace = traceCausal(pureDag, { mode: 'paths', treatment: A });
        expect(trace.nodes).toEqual([]);
        expect(trace.notes.join(' ')).toContain('Ursache UND Wirkung');
    });
});

// --- 2. Browser-Tauglichkeit (Tier 1 bleibt Tier 1) ----------------------

describe('Abnahme: der Trace läuft im Browser (§7 Tier 1)', () => {
    it('importiert nichts, was es nur auf dem Server gibt', () => {
        const source = readFileSync(path.join(process.cwd(), 'src/lib/graph/causal/trace.ts'), 'utf-8');
        const imports = [...source.matchAll(/from\s+'([^']+)'/g)].map(match => match[1]);
        expect(imports.length).toBeGreaterThan(0);
        for (const specifier of imports) {
            expect(specifier.startsWith('./') || specifier.startsWith('../')).toBe(true);
            expect(specifier).not.toContain('node:');
            expect(specifier).not.toContain('store');
        }
        expect(source).not.toContain('process.');
    });
});

// --- 3. Belegstand (§9 minEvidence) --------------------------------------

describe('Belegschwelle (§9 minEvidence, Invariante C5)', () => {
    it('nimmt Kanten heraus, die den Belegstand nicht erreichen — und sagt es', async () => {
        const store = await buildStore();
        const model = await readCausalModel(handleFor(store), {
            modelId: 'wohnung',
            graph: alice.causalGraph('wohnung'),
        });
        const ohne = dagFromModel(model!);
        expect(ohne.dag.edges).toHaveLength(MODEL_EDGES.length);
        expect(ohne.droppedByEvidence).toEqual([]);

        // Bis C4 ist jede Kante eine Annahme: Unter „geschätzt" bleibt
        // nichts übrig — und das ist die ehrliche Antwort, kein Fehler.
        const streng = dagFromModel(model!, { minEvidence: 'estimated' });
        expect(streng.dag.edges).toHaveLength(0);
        expect(streng.droppedByEvidence).toHaveLength(MODEL_EDGES.length);

        const grounding = await groundCausal(handleFor(store), {
            mode: 'ancestors',
            outcome: Y,
            minEvidence: 'estimated',
        });
        expect(grounding.explain.notes.join(' ')).toContain('Belegstand');
    });
});

// --- 4. Abnahme: explain trägt den kausalen Pfad -------------------------

describe('Abnahme C2: explain trägt den kausalen Pfad (§16)', () => {
    it('nennt Modell, Frage, Wege mit Richtung und die Adjustierung', async () => {
        const store = await buildStore();
        const result = await retrieveCausal(store, { mode: 'paths', treatment: A, outcome: Y });
        const causal = result.explain.causal;
        expect(causal).toBeDefined();
        expect(causal?.model?.id).toBe('wohnung');
        expect(causal?.treatment?.label).toBe('Nachtabsenkung');
        expect(causal?.outcome?.label).toBe('Heizenergie');
        const wirkweg = causal?.paths.find(entry => entry.kind === 'causal');
        expect(wirkweg?.text).toBe('Nachtabsenkung → Raumtemperatur → Heizenergie');
        expect(wirkweg?.open).toBe(true);
        // Der Hop-Abstand allein wäre die alte Auskunft — hier steht der Weg.
        const raumtemperatur = result.nodes.find(node => node.iri === M);
        expect(raumtemperatur?.causal?.path).toEqual([A, M]);
        expect(raumtemperatur?.causal?.role).toBe('on-path');
    });

    it('stellt dem linearisierten Kontext die Kette voran', async () => {
        const store = await buildStore();
        const result = await retrieveCausal(store, { mode: 'paths', treatment: A, outcome: Y });
        expect(result.context).toContain('Kausale Erdung: Modell „Wohnung"');
        expect(result.context).toContain('Weg (Wirkweg): Nachtabsenkung → Raumtemperatur → Heizenergie');
        expect(result.context).toContain('Keine Effektstärke');
        expect(result.explain.seedStrategy).toContain('kausal:paths');
    });

    it('lässt das gewöhnliche Retrieval unberührt — ohne `causal` kein kausales explain', async () => {
        const store = await buildStore();
        const result = await retrieve(handleFor(store), { seeds: { iri: [doc('nachtabsenkung')] }, maxHops: 1 });
        expect(result.explain.causal).toBeUndefined();
        expect(iris(result)).toContain(doc('nachtabsenkung'));
    });
});

// --- 5. Abnahme: d-separierte Knoten fallen raus -------------------------

describe('Abnahme C2: d-separierte Knoten fallen bei Konditionierung raus (§16)', () => {
    it('nimmt die Zeitschaltuhr heraus, sobald über die Nachtabsenkung adjustiert wird', async () => {
        const store = await buildStore();

        const offen = await retrieveCausal(store, { mode: 'ancestors', outcome: Y });
        expect(iris(offen)).toContain(T);
        // Die Notiz zur Zeitschaltuhr hängt an ihr und kommt mit.
        expect(iris(offen)).toContain(doc('zeitschaltuhr'));

        const konditioniert = await retrieveCausal(store, {
            mode: 'ancestors',
            outcome: Y,
            blockedBy: [A],
        });
        expect(iris(konditioniert)).not.toContain(T);
        // Und mit ihr verschwindet, was nur über sie erreichbar war.
        expect(iris(konditioniert)).not.toContain(doc('zeitschaltuhr'));
        expect(konditioniert.context).not.toContain('Notiz zur Zeitschaltuhr');
        expect(konditioniert.explain.causal?.dropped).toContainEqual({
            iri: T,
            label: 'Zeitschaltuhr',
            reason: 'd-separated',
        });
        // Wer adjustiert wird, bleibt sichtbar — sonst stünde im Ergebnis
        // eine Adjustierung über eine Größe, die nirgends vorkommt.
        expect(iris(konditioniert)).toContain(A);
        expect(konditioniert.explain.causal?.conditionedOn).toEqual([{ iri: A, label: 'Nachtabsenkung' }]);
    });

    it('hält die Buchhaltung des Modells aus der Antwort heraus', async () => {
        // Jede Änderung am Modell ist eine prov:Activity am Modell-Knoten
        // (C1). Über ihn wären sie zwei Hops von jeder Variablen entfernt —
        // ein Kontext aus lauter „Kante hinzugefügt" wäre keiner.
        const store = await buildStore();
        const result = await retrieveCausal(store, { mode: 'ancestors', outcome: Y });
        expect(iris(result).some(iri => iri.includes('/revision/'))).toBe(false);
        expect(result.context).not.toContain('hinzugefügt');
    });

    it('lässt eine Modellgröße auch über den semantischen Umweg nicht herein', async () => {
        const store = await buildStore();
        const result = await retrieveCausal(store, { mode: 'ancestors', outcome: Y });
        // Die Notiz zur Nachtabsenkung ist dabei und erwähnt die
        // Kaffeemaschine — die gehört zum Modell, aber nicht zur Frage.
        expect(iris(result)).toContain(doc('nachtabsenkung'));
        expect(iris(result)).not.toContain(K);
        expect(result.explain.causal?.dropped).toContainEqual({
            iri: K,
            label: 'Kaffeemaschine',
            reason: 'off-chain',
        });
        expect(result.context).toContain('Nicht enthalten');
    });
});

// --- 6. Auflösung des Modells und Grant-Klammer (C6) ---------------------

describe('Erdung: Modell auflösen, nie raten (§9)', () => {
    it('nimmt das einzige Modell ohne Angabe', async () => {
        const store = await buildStore();
        const grounding = await groundCausal(handleFor(store), { mode: 'ancestors', outcome: Y });
        expect(grounding.grounded).toBe(true);
        expect(grounding.modelGraph).toBe(alice.causalGraph('wohnung'));
    });

    it('fragt nach, statt bei mehreren Modellen eines zu wählen', async () => {
        const store = await buildStore({ second: true });
        const result = await retrieveCausal(store, { mode: 'ancestors', outcome: Y });
        expect(result.nodes).toEqual([]);
        expect(result.explain.causal?.notes.join(' ')).toContain('garten');
        expect(result.explain.seedStrategy).toBe('kausal(nicht geerdet)');
        // Gegenprobe: mit Angabe läuft dieselbe Anfrage.
        const benannt = await retrieveCausal(store, { mode: 'ancestors', outcome: Y, model: 'wohnung' });
        expect(iris(benannt)).toContain(M);
    });

    it('erdet nichts an einem Modell, das der Aufrufer nicht lesen darf (C6)', async () => {
        const store = await buildStore();
        const result = await retrieve(
            handleFor(store),
            { causal: { mode: 'ancestors', outcome: Y }, maxHops: 2 },
            {},
            { allowedGraphs: [alice.graph('workspace')] },
        );
        expect(result.nodes).toEqual([]);
        expect(result.explain.causal?.notes.join(' ')).toContain('kein lesbares Kausalmodell');
        // Kein stiller Rückfall auf semantisches Retrieval: Wer kausalen
        // Kontext bestellt, bekommt keinen, der bloß so aussieht.
        expect(result.explain.seedStrategy).toBe('kausal(nicht geerdet)');
    });

    it('speichert eine kausale Frage als Retrieval-Profil', async () => {
        // Ein Profil ist eine ow:-Entität in graph/meta (M8). Trägt es die
        // kausale Frage, ist sie selbst abfragbar — und über MCP als
        // Prompt exponierbar, ohne dass jemand sie neu tippt.
        const store = await buildStore();
        const handle = handleFor(store);
        await createRetrievalProfile(handle, {
            id: 'heizung-kausal',
            name: 'Heizung, kausal',
            config: {
                maxHops: 2,
                causal: { mode: 'paths', treatment: A, outcome: Y, model: 'wohnung' },
            },
        });
        const gelesen = await getRetrievalProfile(handle, 'heizung-kausal');
        expect(gelesen?.config.causal).toEqual({ mode: 'paths', treatment: A, outcome: Y, model: 'wohnung' });

        // Unfug fällt raus, statt bis zur Ausführung mitzulaufen.
        await createRetrievalProfile(handle, {
            id: 'unfug',
            name: 'Unfug',
            config: { causal: { mode: 'seitwaerts', treatment: A } } as never,
        });
        expect((await getRetrievalProfile(handle, 'unfug'))?.config.causal).toBeUndefined();
    });

    it('liefert dasselbe Ergebnis bei gleicher Anfrage (Determinismus)', async () => {
        const store = await buildStore();
        const erste = await retrieveCausal(store, { mode: 'paths', treatment: A, outcome: Y });
        const zweite = await retrieveCausal(store, { mode: 'paths', treatment: A, outcome: Y });
        expect(iris(zweite)).toEqual(iris(erste));
        expect(zweite.nodes.map(node => node.score)).toEqual(erste.nodes.map(node => node.score));
        expect(zweite.explain.causal).toEqual(erste.explain.causal);
    });
});
