// @vitest-environment node
/**
 * Abnahme C1, zweiter Teil — der Schreibweg (CAUSAL_LAYER_SPEC §16, §19).
 *
 * Der Tier-1-Kern ist rein und in `causal-identification.test.ts`
 * abgenommen. Hier steht, was dazugehört, damit er im Produkt ankommt:
 *
 *  1. **Ein Schreibweg** für Struktur — Variablen und Kanten über
 *     `applyStructureOperation`, mit derselben Prüfung wie im Editor.
 *  2. **Revisionen**: Jede Änderung hinterlässt eine `prov:Activity` und
 *     hebt `schema:version` — die Vorleistung für die
 *     Reproduktions-Signatur aus Invariante C7.
 *  3. **Azyklizität beim Schreiben**: Eine Kante, die einen Kreis
 *     schließt, wird abgelehnt — mit dem Kreis im Klartext.
 *  4. **Schreibziele aus Scope-Mustern**: Ein Modell darf im EIGENEN
 *     Namensraum entstehen, auch wenn sein Graph noch nicht existiert.
 *     Fremde Namensräume und Systemgraphen bleiben hart geschützt, je mit
 *     Negativtest.
 *  5. **Die Brücke Modell → DAG**: Was im Graphen steht, kommt als
 *     Identifikations-Ergebnis zurück — inklusive der Unterscheidung
 *     „strukturell identifizierbar" vs. „mit den erfassten Größen".
 */

import { describe, expect, it } from 'vitest';
import type { Quad } from '@rdfjs/types';
import { OxigraphStore } from '@/lib/graph/store/oxigraph';
import { createIriFactory } from '@/lib/graph/iri';
import { factory, literal, namedNode } from '@/lib/graph/rdf';
import { OW, PROV, RDF, SCHEMA } from '@/lib/graph/vocab';
import { createCausalModel, readCausalModel } from '@/lib/graph/causal/model';
import { applyStructureOperation, CausalEditError } from '@/lib/graph/causal/edit';
import { identifyInModel, dagFromModel } from '@/lib/graph/causal/view';
import { findCycle } from '@/lib/graph/causal/dag';
import { ensureDefaultAuthorizations } from '@/lib/graph/authz/acl-graph';
import { grantForIdentity } from '@/lib/graph/authz/resolve';
import { mayCreateGraph } from '@/lib/graph/authz/grant';
import { executeSparqlProtocol } from '@/lib/graph/sparql/protocol';
import { createVariable } from '@/lib/graph/observations/variables';

const INSTANCE_BASE = 'https://ws.example.org/id/';
const alice = createIriFactory(INSTANCE_BASE, 'alice');
const bob = createIriFactory(INSTANCE_BASE, 'bob');

function handleFor(store: OxigraphStore, who = alice) {
    return { store, iri: who };
}

async function model(store: OxigraphStore, id = 'wohnung') {
    return createCausalModel(handleFor(store), { id, name: 'Wohnung', actor: alice.principal('user', 'alice') });
}

async function withVariables(store: OxigraphStore, id: string, names: readonly string[]) {
    await model(store, id);
    for (const name of names) {
        await applyStructureOperation(handleFor(store), id, { op: 'add-variable', name });
    }
    return readCausalModel(handleFor(store), { modelId: id, graph: alice.causalGraph(id) });
}

const variableIri = (name: string) => alice.entity('variable', name);

async function dump(store: OxigraphStore, graph: string): Promise<Quad[]> {
    const quads: Quad[] = [];
    for await (const quad of store.dump(namedNode(graph))) quads.push(quad);
    return quads;
}

describe('Schreibweg für Struktur (C1)', () => {
    it('nimmt eine Variable auf und legt sie als ow:Variable an', async () => {
        const store = new OxigraphStore();
        await model(store);
        const result = await applyStructureOperation(handleFor(store), 'wohnung', {
            op: 'add-variable',
            name: 'Fenster offen',
        });
        expect(result.model.variables.map(v => v.name)).toEqual(['Fenster offen']);
        expect(result.model.variables[0].inModel).toBe(true);
        expect(result.model.variables[0].iri).toBe(variableIri('fenster-offen'));
        expect(result.message).toContain('Fenster offen');
    });

    it('verbindet zwei Variablen und trägt Herkunft und Versatz an die Kante', async () => {
        const store = new OxigraphStore();
        await withVariables(store, 'wohnung', ['Fenster offen', 'Heizenergie']);
        const result = await applyStructureOperation(handleFor(store), 'wohnung', {
            op: 'add-edge',
            from: variableIri('fenster-offen'),
            to: variableIri('heizenergie'),
            edgeClass: 'asserted',
            temporalLag: 'PT15M',
        });
        expect(result.model.edges).toHaveLength(1);
        expect(result.model.edges[0].edgeClass).toBe('asserted');
        expect(result.model.edges[0].evidenceLevel).toBe('hypothesis');
        expect(result.model.edges[0].temporalLag).toBe('PT15M');
    });

    it('entfernt eine Kante samt ihrer Annotation — kein verwaister Reifier', async () => {
        const store = new OxigraphStore();
        await withVariables(store, 'wohnung', ['A', 'B']);
        await applyStructureOperation(handleFor(store), 'wohnung', {
            op: 'add-edge', from: variableIri('a'), to: variableIri('b'), edgeClass: 'asserted',
        });
        const after = await applyStructureOperation(handleFor(store), 'wohnung', {
            op: 'remove-edge', from: variableIri('a'), to: variableIri('b'),
        });
        expect(after.model.edges).toEqual([]);
        const quads = await dump(store, alice.causalGraph('wohnung'));
        expect(quads.some(q => q.predicate.value === RDF.reifies)).toBe(false);
        expect(quads.some(q => q.predicate.value === OW.edgeClass)).toBe(false);
    });

    it('nimmt mit einer Variablen auch ihre Kanten mit — nichts bleibt hängen', async () => {
        const store = new OxigraphStore();
        await withVariables(store, 'wohnung', ['A', 'B']);
        await applyStructureOperation(handleFor(store), 'wohnung', {
            op: 'add-edge', from: variableIri('a'), to: variableIri('b'), edgeClass: 'asserted',
        });
        const after = await applyStructureOperation(handleFor(store), 'wohnung', {
            op: 'remove-variable', iri: variableIri('a'),
        });
        expect(after.model.variables.map(v => v.iri)).toEqual([variableIri('b')]);
        expect(after.model.edges).toEqual([]);
        expect(after.message).toContain('1 Kante');
    });

    it('lässt fremde Tripel im Modell-Graphen unangetastet', async () => {
        // Was ein Mensch per SPARQL hineingeschrieben hat und wovon der
        // Editor nichts weiß, darf er nicht wegräumen.
        const store = new OxigraphStore();
        await withVariables(store, 'wohnung', ['A']);
        const graph = namedNode(alice.causalGraph('wohnung'));
        const fremd = factory.quad(
            namedNode(variableIri('a')),
            namedNode('https://example.org/eigenes#notiz'),
            literal('Von Hand ergänzt'),
            graph,
        );
        await store.load([...(await dump(store, graph.value)), fremd], graph, { replace: true });
        await applyStructureOperation(handleFor(store), 'wohnung', { op: 'add-variable', name: 'B' });
        const quads = await dump(store, graph.value);
        expect(quads.some(q => q.object.value === 'Von Hand ergänzt')).toBe(true);
    });

    it('lehnt eine Kante ab, die einen Kreis schließt — mit dem Kreis im Klartext', async () => {
        const store = new OxigraphStore();
        await withVariables(store, 'wohnung', ['Fenster offen', 'Heizenergie']);
        await applyStructureOperation(handleFor(store), 'wohnung', {
            op: 'add-edge', from: variableIri('fenster-offen'), to: variableIri('heizenergie'), edgeClass: 'asserted',
        });
        await expect(applyStructureOperation(handleFor(store), 'wohnung', {
            op: 'add-edge', from: variableIri('heizenergie'), to: variableIri('fenster-offen'), edgeClass: 'asserted',
        })).rejects.toThrowError(/Kreis.*Heizenergie.*Fenster offen/s);

        const current = await readCausalModel(handleFor(store), {
            modelId: 'wohnung', graph: alice.causalGraph('wohnung'),
        });
        expect(current?.edges).toHaveLength(1);
        expect(findCycle(dagFromModel(current!).dag)).toBeNull();
    });

    it('lehnt eine Kante auf eine unbekannte Variable ab, statt sie zu erfinden', async () => {
        const store = new OxigraphStore();
        await withVariables(store, 'wohnung', ['A']);
        await expect(applyStructureOperation(handleFor(store), 'wohnung', {
            op: 'add-edge', from: variableIri('a'), to: variableIri('gibtsnicht'), edgeClass: 'asserted',
        })).rejects.toBeInstanceOf(CausalEditError);
    });

    it('lehnt einen Zeitversatz ab, der keine ISO-8601-Dauer ist', async () => {
        const store = new OxigraphStore();
        await withVariables(store, 'wohnung', ['A', 'B']);
        await expect(applyStructureOperation(handleFor(store), 'wohnung', {
            op: 'add-edge', from: variableIri('a'), to: variableIri('b'), edgeClass: 'asserted', temporalLag: '15min',
        })).rejects.toThrowError(/ISO-8601/);
    });
});

describe('Revisionen (Vorleistung für Invariante C7)', () => {
    it('zählt jede Änderung und schreibt eine prov:Activity in den Modell-Graphen', async () => {
        const store = new OxigraphStore();
        await model(store);
        const first = await readCausalModel(handleFor(store), {
            modelId: 'wohnung', graph: alice.causalGraph('wohnung'),
        });
        expect(first?.revision).toBe(1);
        expect(first?.revisions).toHaveLength(1);
        expect(first?.revisions[0].description).toBe('Modell angelegt.');
        expect(first?.revisions[0].actor).toBe(alice.principal('user', 'alice'));

        await applyStructureOperation(handleFor(store), 'wohnung', { op: 'add-variable', name: 'A' },
            { actor: alice.principal('user', 'alice') });
        const second = await applyStructureOperation(handleFor(store), 'wohnung', { op: 'add-variable', name: 'B' });
        expect(second.model.revision).toBe(3);
        expect(second.model.revisions.map(r => r.revision)).toEqual([3, 2, 1]);
        expect(second.model.revisions[0].description).toContain('B');

        const quads = await dump(store, alice.causalGraph('wohnung'));
        const activities = quads.filter(q => q.predicate.value === RDF.type && q.object.value === PROV.Activity);
        expect(activities).toHaveLength(3);
        // Genau EINE Versionsangabe am Modell — sie wird ersetzt, nicht gestapelt.
        const versions = quads.filter(q =>
            q.subject.value === second.model.iri && q.predicate.value === SCHEMA.version);
        expect(versions).toHaveLength(1);
        expect(versions[0].object.value).toBe('3');
    });

    it('hält die Historie beim Modell — ein gelöschtes Modell nimmt sie mit', async () => {
        const store = new OxigraphStore();
        await model(store);
        await applyStructureOperation(handleFor(store), 'wohnung', { op: 'add-variable', name: 'A' });
        const quads = await dump(store, alice.causalGraph('wohnung'));
        expect(quads.every(q => q.graph.value === alice.causalGraph('wohnung'))).toBe(true);
    });
});

describe('Schreibziele aus Scope-Mustern (C1)', () => {
    async function grantFor(store: OxigraphStore, userId: string) {
        const handle = handleFor(store, userId === 'alice' ? alice : bob);
        await ensureDefaultAuthorizations(handle, { admins: ['alice'] });
        return grantForIdentity(handle, { userId, groups: [], authenticated: true }, { sparql: true });
    }

    it('erlaubt ein Modell im eigenen Namensraum, obwohl es den Graphen noch nicht gibt', async () => {
        const store = new OxigraphStore();
        const grant = await grantFor(store, 'alice');
        expect(mayCreateGraph(grant, INSTANCE_BASE, alice.causalGraph('neu'))).toBe(true);
        expect(mayCreateGraph(grant, INSTANCE_BASE, alice.graph('causal-hypotheses'))).toBe(true);
    });

    it('legt ein Modell per SPARQL an — derselbe Schreibweg wie im Editor', async () => {
        const store = new OxigraphStore();
        // Ein vorhandener Graph, damit der Store nicht leer ist.
        await store.load([factory.quad(
            namedNode(alice.entity('doc', 'x')),
            namedNode(RDF.type),
            namedNode(OW.Document),
            namedNode(alice.graph('workspace')),
        )], namedNode(alice.graph('workspace')), { replace: true });
        const grant = await grantFor(store, 'alice');

        const response = await executeSparqlProtocol(store, alice, {
            method: 'POST',
            contentType: 'application/sparql-update',
            body: `INSERT DATA { GRAPH <${alice.causalGraph('per-sparql')}> {
                <${alice.entity('causal-model', 'per-sparql')}> a <${OW.CausalModel}> ;
                    <${SCHEMA.name}> "Per SPARQL" .
            } }`,
        }, { writableGraphs: grant.writableGraphs ?? [], writableScopes: grant.writableScopes ?? [] });
        expect(response.status).toBe(204);
        const written = await readCausalModel(handleFor(store), {
            modelId: 'per-sparql', graph: alice.causalGraph('per-sparql'),
        });
        expect(written?.name).toBe('Per SPARQL');
    });

    it('Negativtest: fremder Namensraum bleibt gesperrt', async () => {
        const store = new OxigraphStore();
        const grant = await grantFor(store, 'alice');
        expect(mayCreateGraph(grant, INSTANCE_BASE, bob.causalGraph('fremd'))).toBe(false);

        const response = await executeSparqlProtocol(store, alice, {
            method: 'POST',
            contentType: 'application/sparql-update',
            body: `INSERT DATA { GRAPH <${bob.causalGraph('fremd')}> {
                <${bob.entity('causal-model', 'fremd')}> a <${OW.CausalModel}> . } }`,
        }, { writableGraphs: grant.writableGraphs ?? [], writableScopes: grant.writableScopes ?? [] });
        expect(response.status).toBe(403);
        expect((await store.graphs()).map(g => g.value)).not.toContain(bob.causalGraph('fremd'));
    });

    it('Negativtest: Systemgraphen bleiben gesperrt, auch als „Kausalmodell" getarnt', async () => {
        const store = new OxigraphStore();
        const grant = await grantFor(store, 'alice');
        expect(mayCreateGraph(grant, INSTANCE_BASE, alice.sharedGraph('meta'))).toBe(false);
        expect(mayCreateGraph(grant, INSTANCE_BASE, alice.sharedGraph('acl'))).toBe(false);
        expect(mayCreateGraph(grant, INSTANCE_BASE, alice.importGraph('irgendwas'))).toBe(false);
        expect(mayCreateGraph(grant, INSTANCE_BASE, alice.inferredGraph('workspace'))).toBe(false);

        const response = await executeSparqlProtocol(store, alice, {
            method: 'POST',
            contentType: 'application/sparql-update',
            body: `INSERT DATA { GRAPH <${alice.sharedGraph('meta')}> {
                <${alice.entity('causal-model', 'x')}> a <${OW.CausalModel}> . } }`,
        }, { writableGraphs: grant.writableGraphs ?? [], writableScopes: grant.writableScopes ?? [] });
        expect(response.status).toBe(403);
    });

    it('Negativtest: das Muster macht keinen vorhandenen Graphen auf, dessen Recht fehlt', async () => {
        const store = new OxigraphStore();
        // Bobs Kausalmodell existiert bereits.
        await createCausalModel(handleFor(store, bob), { id: 'privat', name: 'Bobs Modell' });
        const grant = await grantFor(store, 'alice');
        expect(mayCreateGraph(grant, INSTANCE_BASE, bob.causalGraph('privat'))).toBe(false);

        const response = await executeSparqlProtocol(store, alice, {
            method: 'POST',
            contentType: 'application/sparql-update',
            body: `INSERT DATA { GRAPH <${bob.causalGraph('privat')}> {
                <${bob.entity('variable', 'x')}> a <${OW.Variable}> . } }`,
        }, { writableGraphs: grant.writableGraphs ?? [], writableScopes: grant.writableScopes ?? [] });
        expect(response.status).toBe(403);
        const untouched = await readCausalModel(handleFor(store, bob), {
            modelId: 'privat', graph: bob.causalGraph('privat'),
        });
        expect(untouched?.variables).toEqual([]);
    });

    it('Negativtest: ein anonymer Zugriff bekommt gar kein Muster', async () => {
        const store = new OxigraphStore();
        const handle = handleFor(store);
        await ensureDefaultAuthorizations(handle, { admins: ['alice'] });
        const grant = await grantForIdentity(handle, { userId: '', groups: [], authenticated: false });
        expect(grant.writableScopes).toEqual([]);
        expect(mayCreateGraph(grant, INSTANCE_BASE, alice.causalGraph('anonym'))).toBe(false);
    });

    it('Negativtest: ein verengter Zugang (nur workspace) legt keine Modelle an', async () => {
        const store = new OxigraphStore();
        const handle = handleFor(store);
        await ensureDefaultAuthorizations(handle, { admins: ['alice'] });
        const grant = await grantForIdentity(handle, { userId: 'alice', groups: [], authenticated: true }, {
            narrowTo: ['workspace'],
        });
        expect(grant.writableScopes).toEqual([]);
        expect(mayCreateGraph(grant, INSTANCE_BASE, alice.causalGraph('neu'))).toBe(false);
    });
});

describe('Brücke Modell → DAG und Identifikation im Produktivpfad (C1)', () => {
    /**
     * Die Hausfrage: Wirkt das offene Fenster auf die Heizenergie? Die
     * Außentemperatur wirkt auf beides — sie ist der Störfaktor.
     */
    async function haushalt(erfasst: readonly string[]) {
        const store = new OxigraphStore();
        const handle = handleFor(store);
        for (const id of erfasst) {
            await createVariable(handle, {
                id,
                name: id === 'aussentemperatur' ? 'Außentemperatur' : id,
                sourceKind: 'home-assistant',
                source: `sensor.${id}`,
                kind: 'numeric',
                aggregation: 'mean',
                intervalSeconds: 300,
                enabled: true,
                retentionDays: 0,
            });
        }
        await model(store, 'haushalt');
        const add = async (name: string) =>
            applyStructureOperation(handle, 'haushalt', { op: 'add-variable', name });
        await add('Fenster offen');
        await add('Heizenergie');
        await add('Außentemperatur');
        const edge = async (from: string, to: string) =>
            applyStructureOperation(handle, 'haushalt', {
                op: 'add-edge', from: variableIri(from), to: variableIri(to), edgeClass: 'asserted',
            });
        await edge('fenster-offen', 'heizenergie');
        await edge('aussentemperatur', 'fenster-offen');
        await edge('aussentemperatur', 'heizenergie');
        const current = await readCausalModel(handle, {
            modelId: 'haushalt', graph: alice.causalGraph('haushalt'),
        });
        return current!;
    }

    it('beantwortet die Frage mit den erfassten Größen', async () => {
        const current = await haushalt(['fenster-offen', 'heizenergie', 'aussentemperatur']);
        const { observed, structural } = identifyInModel(
            current, variableIri('fenster-offen'), variableIri('heizenergie'));
        expect(structural.identifiable).toBe(true);
        expect(observed.identifiable).toBe(true);
        expect(observed.strategy).toBe('backdoor');
        expect(observed.adjustmentSets).toEqual([[variableIri('aussentemperatur')]]);
        expect(observed.reason).toContain('Außentemperatur');
    });

    it('trennt „strukturell identifizierbar" von „mit den erfassten Größen"', async () => {
        // Die Außentemperatur steht im Modell, wird aber nicht erfasst.
        const current = await haushalt(['fenster-offen', 'heizenergie']);
        const { observed, structural } = identifyInModel(
            current, variableIri('fenster-offen'), variableIri('heizenergie'));
        expect(structural.identifiable).toBe(true);
        expect(observed.identifiable).toBe(false);
        expect(observed.missingVariables).toEqual([variableIri('aussentemperatur')]);
        expect(observed.reason).toContain('Außentemperatur');
        expect(observed.reason).toContain('nicht erfasst');
    });

    it('nennt die Variablen im Ergebnis beim Namen, nicht bei der IRI', async () => {
        const current = await haushalt(['fenster-offen', 'heizenergie', 'aussentemperatur']);
        const { label } = dagFromModel(current);
        expect(label(variableIri('aussentemperatur'))).toBe('Außentemperatur');
    });
});
