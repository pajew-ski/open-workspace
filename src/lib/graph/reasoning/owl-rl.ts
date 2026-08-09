/**
 * OWL RL Tier 1 (SPEC §7.3) — eigene, auf das tatsächlich genutzte
 * Fragment beschränkte Regelmenge statt eye-js (Begründung in
 * docs/decisions/0002-shacl-library.md, Nebenentscheidung).
 *
 * Deterministisches Forward-Chaining bis zum Fixpunkt über genau das in
 * der SPEC geforderte Mindest-Fragment:
 *
 *   rdfs:subClassOf        Transitivität der Hierarchie + Typ-Vererbung (scm-sco/cax-sco)
 *   rdfs:subPropertyOf     Transitivität + Tripel-Vererbung (scm-spo/prp-spo1)
 *   rdfs:domain / :range   Typ-Inferenz (prp-dom/prp-rng)
 *   owl:inverseOf          prp-inv1/inv2
 *   owl:TransitiveProperty prp-trp
 *   owl:SymmetricProperty  prp-symp
 *   owl:equivalentClass    beidseitige Subsumtion (cax-eqc1/2)
 *   owl:equivalentProperty beidseitige Vererbung (prp-eqp1/2)
 *   owl:sameAs             Symmetrie, Transitivität, Ersetzung in S/P/O (eq-sym/-trans/-rep-*)
 *
 * Bewusst NICHT enthalten: reflexive scm-Regeln (C ⊑ C für jede Klasse —
 * Rauschen ohne Abfrage-Nutzen) und alles jenseits des Fragments
 * (Listen-Konstrukte, property chains). Wächst der Bedarf, ist eye-js der
 * benannte Kandidat; die Pipeline kennt nur diese eine Funktion.
 *
 * Implementierung: naive Iteration mit globalem Dedupe statt semi-naiver
 * Deltas — bei Workspace-Größen (10³–10⁵ Tripel) klar schnell genug und
 * ohne Spezialfall-Fehlerquellen. Das Modul ist pur (Quads rein, Tripel
 * raus) und kennt weder Store noch Scopes — die Scope-Partitionierung
 * (§7.3, Inferenz-Leak) liegt beim Aufrufer in run.ts.
 */

import type { Quad, Quad_Object, Quad_Predicate, Quad_Subject, Term } from '@rdfjs/types';
import { factory } from '../rdf';
import { termToNQuads } from '../serialize/nquads';
import { OWL, PREFIXES, RDF, RDFS } from '../vocab';

const RDFS_DOMAIN = `${PREFIXES.rdfs}domain`;
const RDFS_RANGE = `${PREFIXES.rdfs}range`;
const OWL_TRANSITIVE = `${PREFIXES.owl}TransitiveProperty`;
const OWL_SYMMETRIC = `${PREFIXES.owl}SymmetricProperty`;

/** Abgeleitetes Tripel (die Graph-Komponente vergibt der Aufrufer beim Laden). */
export interface InferredTriple {
    subject: Quad_Subject;
    predicate: Quad_Predicate;
    object: Quad_Object;
}

const key = termToNQuads;

function tripleKey(t: InferredTriple): string {
    return `${key(t.subject)} ${key(t.predicate)} ${key(t.object)}`;
}

/** term → Menge von Ziel-Termen, adressiert über N-Quads-Schlüssel. */
type TermIndex = Map<string, Map<string, Term>>;

function addToIndex(index: TermIndex, from: Term, to: Term): void {
    const fromKey = key(from);
    let entry = index.get(fromKey);
    if (!entry) {
        entry = new Map();
        index.set(fromKey, entry);
    }
    entry.set(key(to), to);
}

interface Schema {
    superClasses: TermIndex;
    superProperties: TermIndex;
    domains: TermIndex;
    ranges: TermIndex;
    inverses: TermIndex;
    transitive: Set<string>;
    symmetric: Set<string>;
}

/**
 * Liest die Schema-Axiome des Fragments aus allen Fakten (OWL trennt
 * TBox/ABox nicht — auch Nutzer dürfen Axiome behaupten) und schließt
 * die Hierarchien transitiv (scm-sco/scm-spo), ohne Reflexivität.
 */
function buildSchema(facts: Iterable<InferredTriple>): Schema {
    const schema: Schema = {
        superClasses: new Map(),
        superProperties: new Map(),
        domains: new Map(),
        ranges: new Map(),
        inverses: new Map(),
        // owl:sameAs ist per Definition symmetrisch und transitiv
        // (eq-sym/eq-trans) — als reguläre Regel-Eigenschaft registriert.
        transitive: new Set([`<${OWL.sameAs}>`]),
        symmetric: new Set([`<${OWL.sameAs}>`]),
    };
    for (const t of facts) {
        switch (t.predicate.value) {
            case RDFS.subClassOf:
                addToIndex(schema.superClasses, t.subject, t.object);
                break;
            case RDFS.subPropertyOf:
                addToIndex(schema.superProperties, t.subject, t.object);
                break;
            case OWL.equivalentClass:
                addToIndex(schema.superClasses, t.subject, t.object);
                if (t.object.termType !== 'Literal') addToIndex(schema.superClasses, t.object, t.subject);
                break;
            case OWL.equivalentProperty:
                addToIndex(schema.superProperties, t.subject, t.object);
                if (t.object.termType !== 'Literal') addToIndex(schema.superProperties, t.object, t.subject);
                break;
            case RDFS_DOMAIN:
                addToIndex(schema.domains, t.subject, t.object);
                break;
            case RDFS_RANGE:
                addToIndex(schema.ranges, t.subject, t.object);
                break;
            case OWL.inverseOf:
                addToIndex(schema.inverses, t.subject, t.object);
                if (t.object.termType !== 'Literal') addToIndex(schema.inverses, t.object, t.subject);
                break;
            case RDF.type:
                if (t.object.value === OWL_TRANSITIVE) schema.transitive.add(key(t.subject));
                if (t.object.value === OWL_SYMMETRIC) schema.symmetric.add(key(t.subject));
                break;
        }
    }
    // Transitive Hülle der Hierarchie-Indizes (ohne C ⊑ C).
    for (const index of [schema.superClasses, schema.superProperties]) {
        let changed = true;
        while (changed) {
            changed = false;
            for (const [fromKey, targets] of index) {
                for (const target of [...targets.values()]) {
                    for (const [nextKey, next] of index.get(key(target)) ?? []) {
                        if (nextKey === fromKey || targets.has(nextKey)) continue;
                        targets.set(nextKey, next);
                        changed = true;
                    }
                }
            }
        }
    }
    return schema;
}

/**
 * Leitet die OWL-RL-Folgerungen des Fragments ab. Zurück kommen NUR
 * Tripel, die nicht bereits in `schemaQuads`/`dataQuads` behauptet sind,
 * deterministisch sortiert (kanonische N-Quads-Zeilenordnung).
 */
export function deriveOwlRlInferences(schemaQuads: Quad[], dataQuads: Quad[]): InferredTriple[] {
    // Faktenbasis deduplizieren (Graph-Komponente spielt keine Rolle).
    const facts: InferredTriple[] = [];
    const seen = new Set<string>();
    const assertedKeys = new Set<string>();
    const push = (t: InferredTriple): boolean => {
        const k = tripleKey(t);
        if (seen.has(k)) return false;
        seen.add(k);
        facts.push(t);
        return true;
    };
    for (const q of [...schemaQuads, ...dataQuads]) {
        const t = { subject: q.subject, predicate: q.predicate, object: q.object };
        if (push(t)) assertedKeys.add(tripleKey(t));
    }

    const schema = buildSchema(facts);
    const rdfType = factory.namedNode(RDF.type);

    let changed = true;
    while (changed) {
        changed = false;

        // sameAs-Partner (für eq-rep-s/p/o) und Adjazenzen transitiver
        // Properties aus dem aktuellen Bestand aufbauen. `subjects` merkt
        // sich zu jedem Adjazenz-Schlüssel den Subjekt-Term.
        const sameAs: TermIndex = new Map();
        const transitiveEdges = new Map<string, {
            predicate: Quad_Predicate;
            out: TermIndex;
            subjects: Map<string, Term>;
        }>();
        for (const t of facts) {
            if (t.predicate.value === OWL.sameAs && t.object.termType !== 'Literal') {
                addToIndex(sameAs, t.subject, t.object);
            }
            const pKey = key(t.predicate);
            if (schema.transitive.has(pKey) && t.object.termType !== 'Literal') {
                let entry = transitiveEdges.get(pKey);
                if (!entry) {
                    entry = { predicate: t.predicate, out: new Map(), subjects: new Map() };
                    transitiveEdges.set(pKey, entry);
                }
                addToIndex(entry.out, t.subject, t.object);
                entry.subjects.set(key(t.subject), t.subject);
            }
        }

        const emit = (subject: Term, predicate: Term, object: Term): void => {
            if (subject.termType === 'Literal' || subject.termType === 'DefaultGraph') return;
            if (predicate.termType !== 'NamedNode') return;
            if (object.termType === 'DefaultGraph') return;
            // eq-trans erzeugt sonst reflexives `x sameAs x` — Rauschen.
            if (predicate.value === OWL.sameAs && key(subject) === key(object)) return;
            const t: InferredTriple = {
                subject: subject as Quad_Subject,
                predicate: predicate as Quad_Predicate,
                object: object as Quad_Object,
            };
            if (push(t)) changed = true;
        };

        // Momentaufnahme — während der Runde neu erzeugte Tripel kommen in
        // der nächsten Runde dran (Fixpunkt-Schleife).
        const snapshot = [...facts];
        for (const t of snapshot) {
            const pKey = key(t.predicate);

            // prp-spo1 (+ prp-eqp über den Index): Vererbung der Aussage
            for (const superProp of schema.superProperties.get(pKey)?.values() ?? []) {
                emit(t.subject, superProp, t.object);
            }
            // prp-inv1/2
            for (const inverse of schema.inverses.get(pKey)?.values() ?? []) {
                if (t.object.termType !== 'Literal') emit(t.object, inverse, t.subject);
            }
            // prp-symp (owl:sameAs ist hier als symmetrisch registriert)
            if (schema.symmetric.has(pKey) && t.object.termType !== 'Literal') {
                emit(t.object, t.predicate, t.subject);
            }
            // prp-dom / prp-rng
            for (const domain of schema.domains.get(pKey)?.values() ?? []) {
                emit(t.subject, rdfType, domain);
            }
            for (const range of schema.ranges.get(pKey)?.values() ?? []) {
                if (t.object.termType !== 'Literal') emit(t.object, rdfType, range);
            }
            // cax-sco (+ cax-eqc über den Index): Typ-Vererbung
            if (t.predicate.value === RDF.type) {
                for (const superClass of schema.superClasses.get(key(t.object))?.values() ?? []) {
                    emit(t.subject, rdfType, superClass);
                }
            }
            // eq-rep-s / eq-rep-p / eq-rep-o: Aussagen-Ersetzung entlang sameAs
            if (t.predicate.value !== OWL.sameAs) {
                for (const twin of sameAs.get(key(t.subject))?.values() ?? []) {
                    emit(twin, t.predicate, t.object);
                }
                for (const twin of sameAs.get(pKey)?.values() ?? []) {
                    emit(t.subject, twin, t.object);
                }
                for (const twin of sameAs.get(key(t.object))?.values() ?? []) {
                    emit(t.subject, t.predicate, twin);
                }
            }
        }

        // prp-trp (+ eq-trans für owl:sameAs): ein Schritt Wegverlängerung
        // pro Runde — die Fixpunkt-Schleife liefert die volle Hülle.
        for (const { predicate, out, subjects } of transitiveEdges.values()) {
            for (const [fromKey, targets] of out) {
                const start = subjects.get(fromKey);
                if (!start) continue;
                for (const middle of targets.values()) {
                    for (const end of out.get(key(middle))?.values() ?? []) {
                        emit(start, predicate, end);
                    }
                }
            }
        }
    }

    return facts
        .filter(t => !assertedKeys.has(tripleKey(t)))
        .sort((a, b) => {
            const ka = tripleKey(a);
            const kb = tripleKey(b);
            return ka < kb ? -1 : ka > kb ? 1 : 0;
        });
}
