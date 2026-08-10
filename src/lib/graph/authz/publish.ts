/**
 * Freigabehandlung (SPEC §17.1, M13).
 *
 * „Ein Knoten wandert nicht in den öffentlichen Graphen, er wird dorthin
 * **kopiert oder verschoben** durch eine explizite Freigabehandlung, die
 * als `prov:Activity` protokolliert wird."
 *
 * Genau zwei Bewegungen, beide in EINER Transaktion:
 *
 *   `copy` — die Aussagen über den Knoten stehen danach in beiden
 *            Graphen. Für Inhalte, die privat weiterbearbeitet werden und
 *            deren öffentlicher Stand ein Abzug ist.
 *   `move` — die Aussagen verlassen den Quellgraphen. Für Inhalte, die
 *            schlicht am falschen Ort lagen.
 *
 * Mitgenommen werden die Aussagen **über** den Knoten (ausgehende Kanten)
 * und die RDF-1.2-Annotationen an ihnen. Eingehende Kanten bleiben, wo
 * sie sind: Sie gehören ihrem Subjekt, nicht dem freigegebenen Knoten —
 * wer sie mitnähme, veröffentlichte fremde Aussagen.
 */

import type { Quad } from '@rdfjs/types';
import type { GraphStore } from '../store/types';
import type { IriFactory } from '../iri';
import { factory, namedNode, typedLiteral } from '../rdf';
import { PROV, RDF } from '../vocab';

export interface PublishHandle {
    store: GraphStore;
    iri: IriFactory;
}

export type PublishMode = 'copy' | 'move';

export interface PublishInput {
    /** Knoten, der freigegeben wird. */
    entityIri: string;
    /** Quellgraph (Default: eigener Workspace-Graph). */
    from?: string;
    /** Zielgraph (Default: eigener öffentlicher Graph). */
    to?: string;
    mode: PublishMode;
    /** Nutzer-ID des Handelnden — landet als `prov:wasAttributedTo`. */
    actor: string;
    now?: Date;
}

export interface PublishReport {
    entityIri: string;
    from: string;
    to: string;
    mode: PublishMode;
    /** Verschobene bzw. kopierte Tripel. */
    quads: number;
    activityIri: string;
}

async function dump(store: GraphStore, graph: string): Promise<Quad[]> {
    const quads: Quad[] = [];
    for await (const quad of store.dump(namedNode(graph))) quads.push(quad);
    return quads;
}

/**
 * Gehört dieses Quad zur Beschreibung des Knotens? Das Subjekt selbst,
 * plus die Reifier-Knoten seiner annotierten Kanten (RDF 1.2).
 */
function belongsToEntity(quad: Quad, entityIri: string, reifiers: ReadonlySet<string>): boolean {
    if (quad.subject.termType === 'NamedNode' && quad.subject.value === entityIri) return true;
    return quad.subject.termType === 'NamedNode' && reifiers.has(quad.subject.value);
}

/** Reifier-Knoten, deren Triple Term den Knoten als Subjekt hat. */
function reifiersOf(quads: readonly Quad[], entityIri: string): Set<string> {
    const out = new Set<string>();
    for (const quad of quads) {
        if (quad.predicate.value !== RDF.reifies) continue;
        if (quad.object.termType !== 'Quad') continue;
        if (quad.object.subject.value === entityIri && quad.subject.termType === 'NamedNode') {
            out.add(quad.subject.value);
        }
    }
    return out;
}

export async function publishEntity(handle: PublishHandle, input: PublishInput): Promise<PublishReport> {
    const from = input.from ?? handle.iri.graph('workspace');
    const to = input.to ?? handle.iri.graph('public');
    if (from === to) throw new Error('Quell- und Zielgraph sind identisch — nichts freizugeben.');

    const now = (input.now ?? new Date()).toISOString();
    const activityIri = handle.iri.entity('activity', `publish-${encodeURIComponent(input.entityIri)}-${now}`);

    const report = await handle.store.transaction(async tx => {
        const source = await dump(tx, from);
        const reifiers = reifiersOf(source, input.entityIri);
        const moving = source.filter(quad => belongsToEntity(quad, input.entityIri, reifiers));
        if (moving.length === 0) {
            throw new Error(`Über <${input.entityIri}> steht im Quellgraphen nichts — nichts freizugeben.`);
        }

        const targetGraph = namedNode(to);
        const existing = await dump(tx, to);
        const kept = existing.filter(quad => !belongsToEntity(quad, input.entityIri, reifiers));
        const activity = [
            factory.quad(namedNode(activityIri), namedNode(RDF.type), namedNode(PROV.Activity), targetGraph),
            factory.quad(namedNode(activityIri), namedNode(PROV.generatedAtTime), typedLiteral.dateTime(now), targetGraph),
            factory.quad(namedNode(activityIri), namedNode(PROV.wasAttributedTo), namedNode(handle.iri.principal('user', input.actor)), targetGraph),
            factory.quad(namedNode(input.entityIri), namedNode(PROV.wasGeneratedBy), namedNode(activityIri), targetGraph),
        ];
        await tx.load([...kept, ...moving, ...activity], targetGraph, { replace: true });

        if (input.mode === 'move') {
            const remaining = source.filter(quad => !belongsToEntity(quad, input.entityIri, reifiers));
            await tx.load(remaining, namedNode(from), { replace: true });
        }

        return {
            entityIri: input.entityIri,
            from,
            to,
            mode: input.mode,
            quads: moving.length,
            activityIri,
        } satisfies PublishReport;
    });
    return report;
}
