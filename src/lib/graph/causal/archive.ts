/**
 * Die Studien-Chronik: was wann gesagt wurde (CAUSAL_LAYER_SPEC §13;
 * entschieden am 2026-08-14, docs/spec-widersprueche.md, Eintrag 3).
 *
 * **Das gelöste Problem.** Invariante C4 sagt: Ergebnisse liegen im
 * Inferenz-Graphen und werden bei jedem Lauf vollständig ersetzt. §8.1
 * sagt: Inferenz-Graphen werden nie persistiert. Zusammen heißt das, dass
 * es keine Historie gibt — „Was sagte dieselbe Frage vor drei Monaten?"
 * war nicht beantwortbar, und ein Modell, das sich seither geändert hat,
 * nahm seine alten Antworten mit ins Nichts.
 *
 * **Warum die Chronik keine Invariante bricht.** Sie ist keine zweite
 * Kopie des Inferenz-Graphen, sondern eine Aussage anderer Art. Der
 * Inferenz-Graph behauptet: *So ist es nach heutiger Datenlage.* Die
 * Chronik behauptet: *Am 14. August 2026 lief diese Frage auf Revision 7
 * und sagte das hier.* Das ist ein **Ereignis**, kein abgeleiteter
 * Zustand — in PROV-Begriffen eine `prov:Activity`, die stattgefunden
 * hat. Ereignisse werden behauptet, nicht inferiert, und deshalb liegen
 * sie in einem behaupteten, persistierten Graphen (Invariante 3 bleibt
 * unberührt: asserted ≠ inferred, und hier steht Behauptetes).
 *
 * **Drei Regeln halten sie ehrlich:**
 *
 * 1. **Der Effekt hängt NIE am Reifier der Kante.** Sonst lägen drei
 *    Jahre alter Läufe über derselben Kante und niemand wüsste, welcher
 *    gilt. Er trägt einen studieneigenen Knoten mit `ow:treatment`/
 *    `ow:outcome` — lesbar, aber ohne Wirkung auf das Modell,
 *    `minEvidence` (C2) oder die Adjustierung.
 * 2. **Eingetragen wird nur, was sich geändert hat.** Zwanzig identische
 *    Läufe sind keine Chronik, sondern Rauschen. Ein Eintrag entsteht
 *    beim ersten Lauf einer Frage und danach, wenn sich Urteil,
 *    Modell-Revision oder Effekt in einem Maß ändern, das über die
 *    Unsicherheit hinausgeht.
 * 3. **Der aktuelle Stand bleibt der Inferenz-Graph.** Die Chronik wird
 *    nie gelesen, um eine Frage zu beantworten — nur, um zu zeigen, was
 *    war.
 */

import type { Quad } from '@rdfjs/types';
import type { IriFactory } from '../iri';
import { namedNode } from '../rdf';
import { DCTERMS, OW, PROV, RDF, SCHEMA } from '../vocab';
import type { GraphHandle } from './model';
import type { EstimandView } from './estimand';
import { ESTIMATORS, type EstimatorId } from './estimate';
import { studyQuads, type StudyWriteContext } from './study-graph';
import { STUDY_VERDICTS, type StudyResult, type StudyVerdict } from './study';

/** `graph/<u>/causal-archive` — behauptet und im Snapshot, nicht inferiert. */
export function causalArchiveGraph(iri: IriFactory): string {
    return iri.graph('causal-archive');
}

/**
 * Adresse eines Eintrags: Frage plus Zeitpunkt. Der Zeitpunkt steckt in
 * der IRI, damit zwei Einträge derselben Frage nie kollidieren und die
 * Reihenfolge auch ohne Sortierung ablesbar ist.
 */
export function archiveEntryIri(iri: IriFactory, estimandId: string, generatedAt: string): string {
    const stamp = generatedAt.replace(/[^0-9]/g, '').slice(0, 14);
    return iri.entity('study-record', `${estimandId}-${stamp}`);
}

/** `…/study-record/<id>` → `<id>`; `null`, wenn es keiner ist. */
export function archiveEntryId(iri: IriFactory, value: string): string | null {
    const prefix = iri.entity('study-record', '');
    if (!value.startsWith(prefix)) return null;
    const rest = value.slice(prefix.length);
    return rest === '' ? null : decodeURIComponent(rest);
}

/** Ein Eintrag der Chronik, so wie er im Graphen steht. */
export interface ArchiveEntryView {
    iri: string;
    /** Stabile ID des Eintrags — die Adresse zum Verwerfen. */
    id: string;
    estimandId: string;
    name: string;
    verdict: StudyVerdict;
    modelRevision: number;
    estimator?: EstimatorId;
    generatedAt: string;
    softwareVersion?: string;
    reason: string;
    rows?: number;
    effect?: { value: number; ciLow: number; ciHigh: number; unit?: string };
}

/**
 * Hat sich gegenüber dem jüngsten Eintrag etwas geändert, das
 * festzuhalten lohnt?
 *
 * Die Regel ist bewusst grob: Urteil, Modell-Revision, und beim Effekt
 * die Frage, ob der neue Wert noch im alten Intervall liegt (und
 * umgekehrt). Eine feinere Schwelle wäre eine Genauigkeit, die die
 * Bootstrap-Streuung gar nicht hergibt — und eine Chronik, die bei jedem
 * Rauschen einen Eintrag schreibt, ist keine.
 */
export function hasChanged(previous: ArchiveEntryView | null, result: StudyResult): boolean {
    if (!previous) return true;
    if (previous.verdict !== result.verdict) return true;
    if (previous.modelRevision !== result.modelRevision) return true;
    const before = previous.effect;
    const now = result.effect;
    if (!before && !now) return false;
    if (!before || !now) return true;
    const outsideOld = now.effect < before.ciLow || now.effect > before.ciHigh;
    const outsideNew = before.value < now.ciLow || before.value > now.ciHigh;
    return outsideOld || outsideNew;
}

export interface ArchiveWriteInput extends Omit<StudyWriteContext, 'graph' | 'subjectIri' | 'attachEffectToEdge'> {
    estimand: EstimandView;
}

/**
 * Die Quads eines Chronik-Eintrags. Inhaltlich derselbe Lauf wie im
 * Inferenz-Graphen — nur unter eigener Adresse und ohne die
 * Kanten-Annotation.
 */
export function archiveQuads(iri: IriFactory, input: ArchiveWriteInput): Quad[] {
    return studyQuads(iri, {
        ...input,
        graph: causalArchiveGraph(iri),
        subjectIri: archiveEntryIri(iri, input.estimand.id, input.generatedAt),
        attachEffectToEdge: false,
    });
}

function numberOf(value: string | undefined): number | undefined {
    if (value === undefined) return undefined;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * Die Chronik, neueste zuerst. Gelesen wird über einen Dump: Ein Eintrag
 * ist ein kleiner Baum, und ihn per SPARQL zusammenzusetzen wäre mehr
 * Aufwand als das Gruppieren hier (dieselbe Entscheidung wie in
 * `readCausalStudies`).
 */
export async function readCausalArchive(
    handle: GraphHandle,
    options: { estimandId?: string; limit?: number } = {},
): Promise<ArchiveEntryView[]> {
    const graph = causalArchiveGraph(handle.iri);
    const existing = (await handle.store.graphs()).map(g => g.value);
    if (!existing.includes(graph)) return [];

    const quads: Quad[] = [];
    for await (const quad of handle.store.dump(namedNode(graph))) quads.push(quad);

    const bySubject = new Map<string, Quad[]>();
    for (const quad of quads) {
        if (quad.subject.termType !== 'NamedNode') continue;
        const list = bySubject.get(quad.subject.value);
        if (list) list.push(quad);
        else bySubject.set(quad.subject.value, [quad]);
    }
    const valuesOf = (subject: string, predicate: string): string[] =>
        (bySubject.get(subject) ?? [])
            .filter(quad => quad.predicate.value === predicate)
            .map(quad => quad.object.value);
    const valueOf = (subject: string, predicate: string): string | undefined => valuesOf(subject, predicate)[0];

    const entries: ArchiveEntryView[] = [];
    for (const [subject, own] of bySubject) {
        if (!own.some(quad => quad.predicate.value === RDF.type && quad.object.value === OW.CausalStudy)) continue;
        const estimandId = valueOf(subject, DCTERMS.identifier) ?? '';
        if (options.estimandId && estimandId !== options.estimandId) continue;
        const verdictRaw = valueOf(subject, OW.studyVerdict) ?? 'not-estimable';
        const estimatorRaw = valueOf(subject, OW.estimator);

        // Der Effekt eines Eintrags hängt an einem studieneigenen Knoten
        // (`<eintrag>/effect`) — nie am Reifier der Kante.
        let effect: ArchiveEntryView['effect'];
        for (const candidate of valuesOf(subject, SCHEMA.hasPart).concat(`${subject}/effect`)) {
            const value = numberOf(valueOf(candidate, OW.effectSize));
            const ciLow = numberOf(valueOf(candidate, OW.ciLow));
            const ciHigh = numberOf(valueOf(candidate, OW.ciHigh));
            if (value === undefined || ciLow === undefined || ciHigh === undefined) continue;
            effect = {
                value,
                ciLow,
                ciHigh,
                ...(valueOf(candidate, SCHEMA.unitText) ? { unit: valueOf(candidate, SCHEMA.unitText) as string } : {}),
            };
            break;
        }

        entries.push({
            iri: subject,
            id: archiveEntryId(handle.iri, subject) ?? subject,
            estimandId,
            name: valueOf(subject, SCHEMA.name) ?? '',
            verdict: ((STUDY_VERDICTS as readonly string[]).includes(verdictRaw)
                ? verdictRaw
                : 'not-estimable') as StudyVerdict,
            modelRevision: numberOf(valueOf(subject, OW.modelRevision)) ?? 0,
            ...(estimatorRaw && (ESTIMATORS as readonly string[]).includes(estimatorRaw)
                ? { estimator: estimatorRaw as EstimatorId }
                : {}),
            generatedAt: valueOf(subject, PROV.generatedAtTime) ?? '',
            ...(valueOf(subject, SCHEMA.softwareVersion)
                ? { softwareVersion: valueOf(subject, SCHEMA.softwareVersion) as string }
                : {}),
            reason: valueOf(subject, SCHEMA.description) ?? '',
            ...(numberOf(valueOf(subject, SCHEMA.numberOfItems)) !== undefined
                ? { rows: numberOf(valueOf(subject, SCHEMA.numberOfItems)) as number }
                : {}),
            ...(effect ? { effect } : {}),
        });
    }

    entries.sort((a, b) => b.generatedAt.localeCompare(a.generatedAt));
    return options.limit !== undefined ? entries.slice(0, options.limit) : entries;
}

/** Der jüngste Eintrag einer Frage — Vergleichsgröße für `hasChanged`. */
export async function latestArchiveEntry(
    handle: GraphHandle,
    estimandId: string,
): Promise<ArchiveEntryView | null> {
    return (await readCausalArchive(handle, { estimandId, limit: 1 }))[0] ?? null;
}

/**
 * Verwirft einen Eintrag.
 *
 * **Warum das kein Widerspruch zur Chronik ist.** Sie hält fest, was ein
 * Lauf gesagt hat — nicht, dass der Lauf hätte stattfinden sollen. Ein
 * Lauf auf falsch erfassten Daten, ein Test, ein Modell im Bau: Solche
 * Einträge sind keine Geschichte, sondern Störung, und wer sie nicht
 * entfernen kann, hört auf, in die Chronik zu schauen.
 *
 * Was es NICHT gibt, ist ein stilles Überschreiben: Verworfen wird immer
 * ein ganzer Eintrag samt seinen Teilen, ausdrücklich und einzeln. Ein
 * Eintrag zu **ändern** wäre etwas anderes — dann stünde in der Chronik
 * etwas, das so nie gerechnet wurde.
 */
export async function deleteArchiveEntry(handle: GraphHandle, entryIri: string): Promise<boolean> {
    const graph = causalArchiveGraph(handle.iri);
    const existing = (await handle.store.graphs()).map(g => g.value);
    if (!existing.includes(graph)) return false;

    const quads: Quad[] = [];
    for await (const quad of handle.store.dump(namedNode(graph))) quads.push(quad);

    // Zum Eintrag gehört sein Knoten und alles, was unter seiner Adresse
    // hängt: Eingaben, Refutationen, Adjustierung, Kontrast, Effekt. Die
    // IRIs sind deshalb Präfixe des Eintrags — und genau darum ist das
    // Aufräumen hier vollständig, ohne dass jemand eine Teileliste pflegt.
    const belongsToEntry = (quad: Quad): boolean =>
        quad.subject.termType === 'NamedNode'
        && (quad.subject.value === entryIri || quad.subject.value.startsWith(`${entryIri}/`));

    const remaining = quads.filter(quad => !belongsToEntry(quad));
    if (remaining.length === quads.length) return false;

    await handle.store.transaction(async tx => {
        await tx.load(remaining, namedNode(graph), { replace: true });
    });
    return true;
}
