// @vitest-environment node
/**
 * Abnahme des `home-assistant`-Connectors (CAUSAL_LAYER_SPEC §10).
 *
 *  1. Der Zugang wird ehrlich aufgelöst: Supervisor-Token im Add-on,
 *     konfigurierter Token außerhalb — und eine Fehlermeldung, die sagt,
 *     was fehlt.
 *  2. Die Struktur landet in SOSA und schema.org, nicht in eigenen
 *     Termen: Bereich/Etage als schema:Place, Gerät als sosa:Platform,
 *     Entität als sosa:Sensor bzw. sosa:Actuator.
 *  3. Die Topologie ist vollständig: Sensor → Ort, Sensor → Gerät,
 *     Bereich → Etage. Das ist die strukturelle Vorannahme, wegen der
 *     der Connector überhaupt existiert.
 *  4. Die Revision folgt der STRUKTUR, nicht dem Messwert — sonst würde
 *     der Import-Graph minütlich ersetzt.
 *  5. Der Import scheitert nie an der Quell-Qualität: unbrauchbare
 *     Einträge werden quarantäniert, der Rest importiert.
 *  6. Die Historien-Antwort wird korrekt gelesen, auch in der Eigenart
 *     von `minimal_response` (entity_id nur am ersten Eintrag).
 */

import { describe, expect, it } from 'vitest';
import type { Quad } from '@rdfjs/types';
import { createIriFactory } from '@/lib/graph/iri';
import { SCHEMA, SOSA, RDF, OW, DCTERMS } from '@/lib/graph/vocab';
import {
    HomeAssistantClient,
    resolveHaAccess,
    parseEntityRecord,
    type HaEntityRecord,
} from '@/lib/graph/connectors/home-assistant/api';
import { homeAssistantConnector } from '@/lib/graph/connectors/home-assistant';
import { inventoryQuads } from '@/lib/graph/connectors/home-assistant/structure';
import type { ConnectorContext, QuarantineEntry } from '@/lib/graph/connectors/types';

const INSTANCE_BASE = 'urn:ow:99999999-8888-4777-8666-555555555555:';
const iri = createIriFactory(INSTANCE_BASE);

const ENTITIES: HaEntityRecord[] = [
    {
        entityId: 'sensor.wohnzimmer_temperatur',
        name: 'Wohnzimmer Temperatur',
        domain: 'sensor',
        deviceClass: 'temperature',
        stateClass: 'measurement',
        unit: '°C',
        areaId: 'wohnzimmer',
        areaName: 'Wohnzimmer',
        floorName: 'Erdgeschoss',
        deviceId: 'dev-1',
        deviceName: 'Multisensor',
    },
    {
        entityId: 'binary_sensor.wohnzimmer_fenster',
        name: 'Wohnzimmer Fenster',
        domain: 'binary_sensor',
        deviceClass: 'window',
        areaId: 'wohnzimmer',
        areaName: 'Wohnzimmer',
        floorName: 'Erdgeschoss',
        deviceId: 'dev-2',
        deviceName: 'Fensterkontakt',
    },
    {
        entityId: 'switch.heizung',
        name: 'Heizung',
        domain: 'switch',
        areaId: 'wohnzimmer',
        areaName: 'Wohnzimmer',
        floorName: 'Erdgeschoss',
    },
];

/** Findet Objekte einer Aussage in der Quad-Liste. */
function objects(quads: Quad[], subject: string, predicate: string): string[] {
    return quads
        .filter(q => q.subject.value === subject && q.predicate.value === predicate)
        .map(q => q.object.value)
        .sort();
}

function jsonResponse(body: unknown, status = 200): Response {
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
    });
}

describe('Zugang zu Home Assistant', () => {
    it('nimmt im Add-on den Supervisor-Token', () => {
        const access = resolveHaAccess({}, { SUPERVISOR_TOKEN: 'geheim' });
        expect(access).toEqual({ baseUrl: 'http://supervisor/core', token: 'geheim', origin: 'supervisor' });
    });

    it('nennt beim Fehlen des Supervisor-Tokens die Ursache im Add-on-Manifest', () => {
        expect(() => resolveHaAccess({}, {})).toThrow(/homeassistant_api/);
    });

    it('nimmt außerhalb des Add-ons URL und benannte Token-Variable', () => {
        const access = resolveHaAccess(
            { url: 'https://ha.example.org/', tokenEnv: 'MEIN_TOKEN' },
            { MEIN_TOKEN: 'abc' },
        );
        expect(access).toEqual({ baseUrl: 'https://ha.example.org', token: 'abc', origin: 'configured' });
    });

    it('sagt, WELCHE Variable fehlt, statt nur „kein Token"', () => {
        expect(() => resolveHaAccess({ url: 'https://ha.example.org', tokenEnv: 'FEHLT' }, {}))
            .toThrow(/"FEHLT"/);
    });

    it('führt den Token nie im Locator mit', () => {
        const locator = homeAssistantConnector.locatorFor({ url: 'https://ha.example.org', tokenEnv: 'MEIN_TOKEN' });
        expect(locator).not.toContain('abc');
        expect(homeAssistantConnector.configFromLocator(locator)).toEqual({
            url: 'https://ha.example.org',
            tokenEnv: 'MEIN_TOKEN',
        });
    });

    it('überlebt den Add-on-Fall im Locator (beide Teile leer)', () => {
        const locator = homeAssistantConnector.locatorFor({ url: '', tokenEnv: '' });
        expect(homeAssistantConnector.configFromLocator(locator)).toEqual({ url: '', tokenEnv: '' });
    });
});

describe('Struktur-Mapping', () => {
    const { quads, counts } = inventoryQuads(iri, ENTITIES);

    it('zählt Entitäten, Geräte, Bereiche und Etagen', () => {
        expect(counts).toEqual({ entities: 3, devices: 2, areas: 1, floors: 1 });
    });

    it('bildet Bereich und Etage als schema:Place mit Enthaltensein ab', () => {
        const area = iri.entity('place', 'area-wohnzimmer');
        const floor = iri.entity('place', 'floor-erdgeschoss');
        expect(objects(quads, area, RDF.type)).toEqual([SCHEMA.Place]);
        expect(objects(quads, area, SCHEMA.containedInPlace)).toEqual([floor]);
        expect(objects(quads, floor, SCHEMA.name)).toEqual(['Erdgeschoss']);
    });

    it('macht aus einem Gerät eine sosa:Platform im richtigen Bereich', () => {
        const device = iri.entity('device', 'dev-1');
        expect(objects(quads, device, RDF.type)).toEqual([SOSA.Platform]);
        expect(objects(quads, device, SCHEMA.location)).toEqual([iri.entity('place', 'area-wohnzimmer')]);
        expect(objects(quads, device, SOSA.hosts)).toEqual([iri.entity('sensor', 'sensor.wohnzimmer_temperatur')]);
    });

    it('trennt Sensoren von Aktoren — die Treatment-Seite muss erkennbar sein', () => {
        expect(objects(quads, iri.entity('sensor', 'sensor.wohnzimmer_temperatur'), RDF.type)).toEqual([SOSA.Sensor]);
        expect(objects(quads, iri.entity('sensor', 'switch.heizung'), RDF.type)).toEqual([SOSA.Actuator]);
    });

    it('verknüpft jeden Sensor mit seinem Ort — die eigentliche Vorannahme', () => {
        for (const entityId of ['sensor.wohnzimmer_temperatur', 'binary_sensor.wohnzimmer_fenster', 'switch.heizung']) {
            expect(objects(quads, iri.entity('sensor', entityId), SCHEMA.location))
                .toEqual([iri.entity('place', 'area-wohnzimmer')]);
        }
    });

    it('führt gleichartige Sensoren über eine gemeinsame beobachtete Größe zusammen', () => {
        const observable = iri.entity('observable', 'temperature');
        expect(objects(quads, iri.entity('sensor', 'sensor.wohnzimmer_temperatur'), SOSA.observes)).toEqual([observable]);
        expect(objects(quads, observable, RDF.type)).toEqual([SOSA.ObservableProperty]);
    });

    it('hält Skalenniveau, Einheit und entity_id quelltreu am Knoten', () => {
        const sensor = iri.entity('sensor', 'sensor.wohnzimmer_temperatur');
        expect(objects(quads, sensor, OW.observationKind)).toEqual(['numeric']);
        expect(objects(quads, sensor, SCHEMA.unitText)).toEqual(['°C']);
        expect(objects(quads, sensor, DCTERMS.identifier)).toEqual(['sensor.wohnzimmer_temperatur']);
        expect(objects(quads, iri.entity('sensor', 'binary_sensor.wohnzimmer_fenster'), OW.observationKind))
            .toEqual(['binary']);
    });

    it('kommt ohne Gerät aus (der Schalter hat keins)', () => {
        const sensor = iri.entity('sensor', 'switch.heizung');
        expect(objects(quads, sensor, SOSA.isHostedBy)).toEqual([]);
        expect(objects(quads, sensor, SCHEMA.name)).toEqual(['Heizung']);
    });
});

describe('Inventar-Antwort', () => {
    it('verwirft Einträge ohne brauchbare entity_id, statt zu raten', () => {
        expect(parseEntityRecord({ entityId: 'sensor.a', name: 'A', domain: 'sensor' })?.entityId).toBe('sensor.a');
        expect(parseEntityRecord({ entityId: 'kaputt' })).toBeNull();
        expect(parseEntityRecord({})).toBeNull();
        expect(parseEntityRecord('sensor.a')).toBeNull();
    });

    it('behandelt Jinjas „None" wie einen fehlenden Wert', () => {
        const record = parseEntityRecord({
            entityId: 'sensor.a', name: 'A', domain: 'sensor', areaId: 'None', deviceId: 'None',
        });
        expect(record?.areaId).toBeUndefined();
        expect(record?.deviceId).toBeUndefined();
    });
});

describe('Historien-Antwort', () => {
    const client = new HomeAssistantClient(
        { baseUrl: 'http://supervisor/core', token: 't', origin: 'supervisor' },
        async () => jsonResponse([[
            { entity_id: 'sensor.a', state: '1', last_changed: '2026-08-13T10:00:00Z' },
            // minimal_response: ab hier ohne entity_id — sie wird geerbt.
            { state: '2', last_changed: '2026-08-13T10:05:00Z' },
            { state: '3', last_updated: '2026-08-13T10:10:00Z' },
        ]]),
    );

    it('erbt die entity_id über die Gruppe hinweg', async () => {
        const points = await client.history(['sensor.a'], '2026-08-13T10:00:00Z', '2026-08-13T11:00:00Z');
        expect(points.map(p => p.entityId)).toEqual(['sensor.a', 'sensor.a', 'sensor.a']);
        expect(points.map(p => p.state)).toEqual(['1', '2', '3']);
        expect(points[0].t).toBeLessThan(points[2].t);
    });

    it('meldet einen abgewiesenen Token mit dem Hinweis auf das Add-on-Recht', async () => {
        const rejecting = new HomeAssistantClient(
            { baseUrl: 'http://supervisor/core', token: 't', origin: 'supervisor' },
            async () => new Response('nope', { status: 401 }),
        );
        await expect(rejecting.version()).rejects.toThrow(/homeassistant_api/);
    });
});

describe('Connector-Lauf', () => {
    /** Kontext-Double: nur was der Connector wirklich benutzt. */
    function contextFor(inventory: unknown, quarantined: QuarantineEntry[]): ConnectorContext {
        return {
            iri,
            signal: new AbortController().signal,
            fetch: async (url: string) => {
                if (url.endsWith('/api/config')) return jsonResponse({ version: '2026.8.0' });
                if (url.endsWith('/api/template')) return jsonResponse(JSON.stringify(inventory));
                throw new Error(`unerwarteter Aufruf: ${url}`);
            },
            report: () => undefined,
            quarantine: (entry: QuarantineEntry) => quarantined.push(entry),
            presentation: () => undefined,
        } as unknown as ConnectorContext;
    }

    const config = { url: 'https://ha.example.org', tokenEnv: 'HA_TEST_TOKEN' };

    it('bindet die Revision an die Struktur, nicht an den Messwert', async () => {
        process.env.HA_TEST_TOKEN = 'abc';
        const quarantined: QuarantineEntry[] = [];
        const first = await homeAssistantConnector.probe(config, contextFor(ENTITIES, quarantined));

        // Gleiche Struktur, anderer Zustand → dieselbe Revision. (Der
        // Zustand kommt im Inventar gar nicht vor — genau das ist der Test.)
        const second = await homeAssistantConnector.probe(config, contextFor(ENTITIES, quarantined));
        expect(second.revision).toBe(first.revision);

        // Umbenannter Bereich → neue Revision.
        const moved = ENTITIES.map(entity => ({ ...entity, areaName: 'Salon' }));
        const third = await homeAssistantConnector.probe(config, contextFor(moved, quarantined));
        expect(third.revision).not.toBe(first.revision);
        delete process.env.HA_TEST_TOKEN;
    });

    it('importiert, was geht, und quarantäniert den Rest', async () => {
        process.env.HA_TEST_TOKEN = 'abc';
        const quarantined: QuarantineEntry[] = [];
        const ctx = contextFor([...ENTITIES, { name: 'kaputt' }], quarantined);
        const ref = {
            id: 'ha',
            kind: 'home-assistant',
            locator: homeAssistantConnector.locatorFor(config),
        };

        const quads: Quad[] = [];
        for await (const quad of homeAssistantConnector.pull!(ref, ctx)) quads.push(quad);

        expect(quads.length).toBeGreaterThan(0);
        expect(quarantined).toHaveLength(1);
        expect(quarantined[0].reason).toContain('entity_id');
        delete process.env.HA_TEST_TOKEN;
    });

    it('schreibt nichts und bietet keinen Export an (read-only, C10)', () => {
        expect(homeAssistantConnector.capabilities.write).toBe(false);
        expect(homeAssistantConnector.push).toBeUndefined();
        expect(homeAssistantConnector.mode).toBe('materialize');
    });
});
