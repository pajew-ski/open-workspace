/**
 * Ontologie-CI-Check (SPEC §4.4) — bricht den Build bei Verstößen.
 *
 * Prüft:
 *  1. `ontology/ow.ttl` parst.
 *  2. Jeder in `src/lib/graph/vocab.ts` verwendete ow:-Term ist in der
 *     Ontologie definiert.
 *  3. Jeder in der Ontologie definierte ow:-Term ist in vocab.ts
 *     exportiert (kein totes Vokabular).
 *  4. Jeder Term trägt rdfs:label (de+en), rdfs:comment (Begründung,
 *     warum kein Standard-Term existiert) und rdfs:isDefinedBy.
 *  5. Jeder Term ist als owl:Class, owl:ObjectProperty oder
 *     owl:DatatypeProperty typisiert.
 *
 * Aufruf: `bun run check:ontology`
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Store } from 'oxigraph';
import { OW, OW_ONTOLOGY_IRI, OW_VOCAB_BASE, PREFIXES } from '../src/lib/graph/vocab';

const errors: string[] = [];

const ttlPath = join(process.cwd(), 'ontology', 'ow.ttl');
const ttl = readFileSync(ttlPath, 'utf-8');

const store = new Store();
try {
    store.load(ttl, { format: 'text/turtle' });
} catch (error) {
    console.error(`✗ ontology/ow.ttl parst nicht: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
}

const RDF_TYPE = `${PREFIXES.rdf}type`;
const RDFS = {
    label: `${PREFIXES.rdfs}label`,
    comment: `${PREFIXES.rdfs}comment`,
    isDefinedBy: `${PREFIXES.rdfs}isDefinedBy`,
};
const OWL_TYPES = new Set([
    `${PREFIXES.owl}Class`,
    `${PREFIXES.owl}ObjectProperty`,
    `${PREFIXES.owl}DatatypeProperty`,
]);

function bindings(query: string): Map<string, { value: string; termType: string; language?: string }>[] {
    return store.query(query) as Map<string, { value: string; termType: string; language?: string }>[];
}

// Alle ow:-Terme der Ontologie (Subjekte mit Typ) außer der Ontologie selbst.
const definedTerms = new Set<string>();
for (const row of bindings(`SELECT DISTINCT ?s WHERE { ?s <${RDF_TYPE}> ?t }`)) {
    const iri = row.get('s')?.value;
    if (iri && iri.startsWith(OW_VOCAB_BASE)) {
        definedTerms.add(iri);
    }
}

const usedTerms = new Set<string>(Object.values(OW));

// 2. Verwendet, aber nicht definiert.
for (const term of usedTerms) {
    if (!definedTerms.has(term)) {
        errors.push(`vocab.ts verwendet ${term}, aber ontology/ow.ttl definiert ihn nicht.`);
    }
}

// 3. Definiert, aber nicht exportiert.
for (const term of definedTerms) {
    if (!usedTerms.has(term)) {
        errors.push(`ontology/ow.ttl definiert ${term}, aber vocab.ts exportiert ihn nicht.`);
    }
}

// 4./5. Pflicht-Metadaten und Typisierung pro Term.
for (const term of definedTerms) {
    const labels = bindings(`SELECT ?l WHERE { <${term}> <${RDFS.label}> ?l }`);
    const languages = new Set(labels.map(row => row.get('l')?.language ?? ''));
    if (!languages.has('de')) errors.push(`${term}: rdfs:label@de fehlt.`);
    if (!languages.has('en')) errors.push(`${term}: rdfs:label@en fehlt.`);

    const comments = bindings(`SELECT ?c WHERE { <${term}> <${RDFS.comment}> ?c }`);
    if (comments.length === 0) {
        errors.push(`${term}: rdfs:comment (Begründung gegen Standard-Term) fehlt.`);
    }

    const definedBy = bindings(`SELECT ?o WHERE { <${term}> <${RDFS.isDefinedBy}> ?o }`);
    if (!definedBy.some(row => row.get('o')?.value === OW_ONTOLOGY_IRI)) {
        errors.push(`${term}: rdfs:isDefinedBy <${OW_ONTOLOGY_IRI}> fehlt.`);
    }

    const types = bindings(`SELECT ?t WHERE { <${term}> <${RDF_TYPE}> ?t }`);
    if (!types.some(row => OWL_TYPES.has(row.get('t')?.value ?? ''))) {
        errors.push(`${term}: weder owl:Class noch owl:ObjectProperty/owl:DatatypeProperty.`);
    }
}

// Ontologie-Kopf vorhanden?
const header = bindings(`SELECT ?t WHERE { <${OW_ONTOLOGY_IRI}> <${RDF_TYPE}> <${PREFIXES.owl}Ontology> }`);
if (header.length === 0) {
    errors.push(`Ontologie-Kopf <${OW_ONTOLOGY_IRI}> a owl:Ontology fehlt.`);
}

if (errors.length > 0) {
    console.error(`✗ Ontologie-Check fehlgeschlagen (${errors.length} Fehler):`);
    for (const error of errors) {
        console.error(`  - ${error}`);
    }
    process.exit(1);
}

console.log(
    `✓ Ontologie-Check: ${definedTerms.size} Terme definiert, ${usedTerms.size} in vocab.ts, ` +
    'Labels (de+en), Kommentare und isDefinedBy vollständig.',
);
