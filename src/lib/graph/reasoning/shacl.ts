/**
 * SHACL-Validierung (SPEC §7.2, M7) — Kapselung von rdf-validate-shacl
 * (Entscheidung mit Messwerten: docs/decisions/0002-shacl-library.md).
 *
 * Kein anderes Modul importiert die Library direkt. Die drei
 * Validierungsstellen (vor UI-Schreibvorgängen, nach Connector-Pull,
 * on demand im Explorer) laufen alle über `validateQuads` bzw. die
 * Pipeline in run.ts.
 *
 * Blockier-Semantik (§7.2): Verletzungen blockieren nicht per Default —
 * blockierend sind nur sh:Violation-Ergebnisse, und im Schreibpfad nur
 * solche, die die Mutation NEU einführt (Altbestand mit Verstößen darf
 * weiter bearbeitet werden, nur nicht schlechter werden).
 */

import type { Quad, Term } from '@rdfjs/types';
import datasetFactory from '@rdfjs/dataset';
import SHACLValidator from 'rdf-validate-shacl';
import { factory, literal, namedNode, typedLiteral } from '../rdf';
import { PREFIXES, RDF } from '../vocab';

const SH = PREFIXES.sh;

export type ShaclSeverity = 'Violation' | 'Warning' | 'Info';

export interface ShaclResult {
    severity: ShaclSeverity;
    /** IRI oder Blank-Node-Label des beanstandeten Knotens. */
    focusNode: string;
    /** Prädikat-IRI, sofern der Pfad ein einfaches Prädikat ist. */
    path?: string;
    message: string;
    /** IRI der auslösenden Shape, sofern benannt. */
    sourceShape?: string;
    /** Beanstandeter Wert (lexikalisch). */
    value?: string;
}

export interface ShaclReport {
    conforms: boolean;
    results: ShaclResult[];
    /** Anzahl je Schweregrad — für kompakte UI-Anzeigen. */
    counts: { violations: number; warnings: number; infos: number };
}

function severityFromTerm(term: Term | undefined): ShaclSeverity {
    switch (term?.value) {
        case `${SH}Warning`: return 'Warning';
        case `${SH}Info`: return 'Info';
        default: return 'Violation';
    }
}

function messageText(messages: Term[]): string {
    const german = messages.find(m => m.termType === 'Literal' && m.language === 'de');
    return (german ?? messages[0])?.value ?? 'SHACL-Verstoß ohne Meldungstext.';
}

/**
 * Validiert Daten-Quads gegen Shapes-Quads. Beide Seiten kommen als
 * RDF/JS-Quads (Store-Dump oder frisch gebaut) — die Graph-Komponente
 * spielt für die Validierung keine Rolle. Ohne Shapes ist der Befund
 * trivial konform (leerer Shapes-Graph validiert nichts).
 */
export async function validateQuads(shapesQuads: Quad[], dataQuads: Quad[]): Promise<ShaclReport> {
    if (shapesQuads.length === 0) {
        return { conforms: true, results: [], counts: { violations: 0, warnings: 0, infos: 0 } };
    }
    const validator = new SHACLValidator(datasetFactory.dataset(shapesQuads));
    const report = await validator.validate(datasetFactory.dataset(dataQuads));
    const results: ShaclResult[] = report.results.map(result => {
        const severity = severityFromTerm(result.severity);
        const out: ShaclResult = {
            severity,
            focusNode: result.focusNode?.value ?? '(unbekannt)',
            message: messageText(result.message),
        };
        if (result.path?.termType === 'NamedNode') out.path = result.path.value;
        if (result.sourceShape?.termType === 'NamedNode') out.sourceShape = result.sourceShape.value;
        if (result.value !== undefined && result.value !== null) out.value = result.value.value;
        return out;
    });
    // Deterministische Reihenfolge für stabile Berichte und Tests.
    results.sort((a, b) => {
        const ka = `${a.severity}|${a.focusNode}|${a.path ?? ''}|${a.message}`;
        const kb = `${b.severity}|${b.focusNode}|${b.path ?? ''}|${b.message}`;
        return ka < kb ? -1 : ka > kb ? 1 : 0;
    });
    return {
        conforms: report.conforms,
        results,
        counts: {
            violations: results.filter(r => r.severity === 'Violation').length,
            warnings: results.filter(r => r.severity === 'Warning').length,
            infos: results.filter(r => r.severity === 'Info').length,
        },
    };
}

/** Stabiler Schlüssel eines Ergebnisses (für den Neu-Verstoß-Vergleich). */
export function resultKey(result: ShaclResult): string {
    return `${result.severity}|${result.focusNode}|${result.path ?? ''}|${result.sourceShape ?? ''}|${result.value ?? ''}`;
}

/**
 * Blockierende NEUE Verstöße: sh:Violation-Ergebnisse des Nachher-Berichts,
 * die im Vorher-Bericht nicht vorkamen (§7.2 — Altbestand blockiert nicht).
 */
export function newViolations(before: ShaclReport, after: ShaclReport): ShaclResult[] {
    const known = new Set(before.results.filter(r => r.severity === 'Violation').map(resultKey));
    return after.results.filter(r => r.severity === 'Violation' && !known.has(resultKey(r)));
}

/** Schreibvorgang wegen SHACL-Verstößen abgelehnt (HTTP 422 im API-Layer). */
export class ShaclViolationError extends Error {
    constructor(readonly violations: ShaclResult[]) {
        const first = violations[0];
        const rest = violations.length > 1 ? ` (und ${violations.length - 1} weitere)` : '';
        super(`Änderung abgelehnt — SHACL-Verstoß: ${first?.message ?? 'unbekannt'}${rest}`);
        this.name = 'ShaclViolationError';
    }
}

/**
 * Serialisiert einen Bericht als sh:ValidationReport-Knoten mit STABILEN
 * IRIs (kein Blank-Node-Müll in graph/meta — der Bericht wird pro
 * Connector-Lauf ersetzt und muss dafür adressierbar sein).
 */
export function reportQuads(
    report: ShaclReport,
    reportIri: string,
    graphIri: string,
    generatedAtIso: string,
): Quad[] {
    const graph = namedNode(graphIri);
    const subject = namedNode(reportIri);
    const quads: Quad[] = [
        factory.quad(subject, namedNode(RDF.type), namedNode(`${SH}ValidationReport`), graph),
        factory.quad(subject, namedNode(`${SH}conforms`), typedLiteral.boolean(report.conforms), graph),
        factory.quad(subject, namedNode(`${PREFIXES.prov}generatedAtTime`), typedLiteral.dateTime(generatedAtIso), graph),
    ];
    report.results.forEach((result, index) => {
        const node = namedNode(`${reportIri}/result-${index}`);
        quads.push(
            factory.quad(subject, namedNode(`${SH}result`), node, graph),
            factory.quad(node, namedNode(RDF.type), namedNode(`${SH}ValidationResult`), graph),
            factory.quad(node, namedNode(`${SH}resultSeverity`), namedNode(`${SH}${result.severity}`), graph),
            factory.quad(node, namedNode(`${SH}focusNode`), focusTerm(result.focusNode), graph),
            factory.quad(node, namedNode(`${SH}resultMessage`), literal(result.message, 'de'), graph),
        );
        if (result.path) {
            quads.push(factory.quad(node, namedNode(`${SH}resultPath`), namedNode(result.path), graph));
        }
        if (result.sourceShape) {
            quads.push(factory.quad(node, namedNode(`${SH}sourceShape`), namedNode(result.sourceShape), graph));
        }
        if (result.value !== undefined) {
            quads.push(factory.quad(node, namedNode(`${SH}value`), literal(result.value), graph));
        }
    });
    return quads;
}

function focusTerm(focusNode: string): ReturnType<typeof namedNode> | ReturnType<typeof literal> {
    // Blank-Node-Fokusknoten sind nach dem Store-Dump nicht stabil
    // adressierbar — als Literal-Label festhalten statt eine falsche
    // IRI zu prägen.
    if (/^[a-z][a-z0-9+.-]*:/i.test(focusNode)) return namedNode(focusNode);
    return literal(focusNode);
}
