// @vitest-environment node
import { describe, it, expect } from 'vitest';
import {
    buildSameAsBridges,
    createIriFactory,
    isValidInstanceBase,
    migrateInstanceIri,
    urnInstanceBase,
} from '../../src/lib/graph/iri';
import { OW, OW_VOCAB_BASE, SPARQL_PREFIXES } from '../../src/lib/graph/vocab';

const UUID = '8f3a1b2c-4d5e-4f60-8a9b-0c1d2e3f4a5b';

describe('IRI-Strategie (SPEC §3.2/§3.3)', () => {
    it('validiert Instanz-Basen', () => {
        expect(isValidInstanceBase(urnInstanceBase(UUID))).toBe(true);
        expect(isValidInstanceBase('https://ws.example.org/id/')).toBe(true);
        expect(isValidInstanceBase('https://ws.example.org/id')).toBe(false); // fehlender Slash
        expect(isValidInstanceBase('urn:ow:nicht-uuid:')).toBe(false);
        expect(isValidInstanceBase('exocortex.local')).toBe(false);
        expect(isValidInstanceBase('ftp://x/')).toBe(false);
    });

    it('baut Entitäts- und Graph-IRIs nutzerskaliert', () => {
        const iri = createIriFactory(urnInstanceBase(UUID));
        expect(iri.entity('doc', 'architecture-agents')).toBe(
            `urn:ow:${UUID}:u/default/doc/architecture-agents`,
        );
        expect(iri.graph('workspace')).toBe(`urn:ow:${UUID}:graph/u/default/workspace`);
        expect(iri.graph('presentation')).toBe(`urn:ow:${UUID}:graph/u/default/presentation`);
        expect(iri.importGraph('prima-materia')).toBe(`urn:ow:${UUID}:graph/u/default/import/prima-materia`);
        expect(iri.inferredGraph('workspace')).toBe(`urn:ow:${UUID}:graph/u/default/inferred/workspace`);
        expect(iri.sharedGraph('meta')).toBe(`urn:ow:${UUID}:graph/meta`);
        expect(iri.spaceGraph('team-1')).toBe(`urn:ow:${UUID}:graph/shared/team-1`);
    });

    it('skaliert auf benannte Nutzer ohne Datenmigration (nur Konfiguration)', () => {
        const iri = createIriFactory('https://ws.example.org/id/', 'michael');
        expect(iri.entity('doc', 'architecture-agents')).toBe(
            'https://ws.example.org/id/u/michael/doc/architecture-agents',
        );
        expect(iri.graph('workspace')).toBe('https://ws.example.org/id/graph/u/michael/workspace');
    });

    it('prozentcodiert unsichere ID-Segmente, ohne die Identität zu ändern', () => {
        const iri = createIriFactory(urnInstanceBase(UUID));
        expect(iri.entity('tag', 'ökologie & energie')).toBe(
            `urn:ow:${UUID}:u/default/tag/%C3%B6kologie%20%26%20energie`,
        );
    });

    it('lehnt ungültige Basen mit klarem Fehler ab', () => {
        expect(() => createIriFactory('https://exocortex.local')).toThrow(/Instanz-Base/);
    });

    it('migrateInstanceIri schreibt nur eigene IRIs um', () => {
        const oldBase = urnInstanceBase(UUID);
        const newBase = 'https://ws.example.org/id/';
        expect(migrateInstanceIri(`${oldBase}u/default/doc/x`, oldBase, newBase)).toBe(
            `${newBase}u/default/doc/x`,
        );
        expect(migrateInstanceIri('urn:fremd:ding', oldBase, newBase)).toBeNull();
    });

    it('buildSameAsBridges erzeugt owl:sameAs-Brückentripel neu→alt', () => {
        const result = buildSameAsBridges([
            { oldIri: 'urn:ow:x:u/default/doc/a', newIri: 'https://ws.example.org/id/u/default/doc/a' },
        ]);
        expect(result.rewritten).toBe(1);
        expect(result.bridgeQuads[0]).toEqual({
            subject: 'https://ws.example.org/id/u/default/doc/a',
            predicate: 'http://www.w3.org/2002/07/owl#sameAs',
            object: 'urn:ow:x:u/default/doc/a',
        });
    });
});

describe('Vokabular-Konstanten', () => {
    it('die Vokabular-Base ist die produktweite Konstante', () => {
        expect(OW_VOCAB_BASE).toBe('https://pajew-ski.github.io/open-workspace/ns/v1#');
        expect(OW.Task).toBe(`${OW_VOCAB_BASE}Task`);
        expect(OW.blockedBy).toBe(`${OW_VOCAB_BASE}blockedBy`);
    });

    it('SPARQL-Prefixe enthalten ow: und schema:', () => {
        expect(SPARQL_PREFIXES).toContain(`PREFIX ow: <${OW_VOCAB_BASE}>`);
        expect(SPARQL_PREFIXES).toContain('PREFIX schema: <https://schema.org/>');
    });
});
