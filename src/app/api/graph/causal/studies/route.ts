/**
 * Studien: der Lauf und sein Ergebnis (CAUSAL_LAYER_SPEC §13, C4).
 *
 * GET  /api/graph/causal/studies → die Studien im Inferenz-Graphen
 * POST /api/graph/causal/studies → alle Fragen neu rechnen
 *
 * Ein Lauf rechnet **alle** Fragen und ersetzt den Inferenz-Graphen
 * vollständig (Invariante C4). Das ist kein Grobschnitt, sondern der
 * einzige Weg, mit dem ein Replace kein Verlust ist — die Fragen selbst
 * liegen in `graph/meta` und überleben ihn.
 *
 * Der Lauf rechnet, deshalb kann er dauern: Bootstrap und Refutation
 * gehen über dieselben Daten mehrfach. Das ist der Preis dafür, dass
 * jede Zahl ein Intervall und einen Falsifikationsversuch mitbringt
 * (Invarianten C5, C7).
 */

import { NextResponse } from 'next/server';
import { getRequestGraph } from '@/lib/graph/server/context';
import { persistServerGraphSnapshot } from '@/lib/graph/server/instance';
import { readCausalStudies } from '@/lib/graph/causal/study-graph';
import { readCausalArchive } from '@/lib/graph/causal/archive';
import { runCausalStudiesOnServer } from '@/lib/graph/causal/study-run.server';
import { createNodeRuntimeAdapter } from '@/lib/platform/runtime/server';

export const maxDuration = 120;

export async function GET(): Promise<Response> {
    try {
        const { store, iri } = await getRequestGraph();
        return NextResponse.json({ studies: await readCausalStudies({ store, iri }) });
    } catch (error) {
        console.error('Causal Studies Error:', error);
        return NextResponse.json({ error: 'Studien konnten nicht gelesen werden.' }, { status: 500 });
    }
}

export async function POST(): Promise<Response> {
    try {
        // Invariante C9: Was diese Runtime nicht rechnen kann, tut sie
        // auch nicht so, als könnte sie es.
        const tier = createNodeRuntimeAdapter().capabilities.causalTier;
        if (tier === 'none') {
            return NextResponse.json(
                { error: 'Diese Runtime rechnet keine Kausalstudien.' },
                { status: 501 },
            );
        }
        const { store, iri, identity } = await getRequestGraph();
        const summary = await runCausalStudiesOnServer({ store, iri }, {
            ...(identity.userId ? { actor: iri.principal('user', identity.userId) } : {}),
        });
        // Der Inferenz-Graph wird nie persistiert (§8.1) — die Chronik
        // schon: Ein Ereignis lässt sich nicht neu berechnen. Deshalb
        // schreibt ein Lauf, der etwas festgehalten hat, den Snapshot.
        if (summary.archived.length > 0) await persistServerGraphSnapshot();
        return NextResponse.json({
            scope: summary.scope,
            graph: summary.graph,
            generatedAt: summary.generatedAt,
            durationMs: summary.durationMs,
            counts: {
                total: summary.results.length,
                passed: summary.results.filter(result => result.verdict === 'passed').length,
                refuted: summary.results.filter(result => result.verdict === 'refuted').length,
                notEstimable: summary.results.filter(result => result.verdict === 'not-estimable').length,
                notIdentifiable: summary.results.filter(result => result.verdict === 'not-identifiable').length,
            },
            skipped: summary.skipped,
            // Was sich gegenüber dem letzten festgehaltenen Stand geändert
            // hat, ist in die Chronik gegangen (docs/spec-widersprueche.md,
            // Eintrag 3). Unverändertes nicht — zwanzig gleiche Läufe sind
            // keine Historie.
            archived: summary.archived,
            // Was die Signaturprüfung nicht bestanden hat, wurde nicht
            // geschrieben (Invariante C7) — gemeldet wird es trotzdem.
            rejected: summary.rejected.map(entry => ({
                estimandId: entry.estimandId,
                messages: entry.violations.map(violation => violation.message),
            })),
            studies: await readCausalStudies({ store, iri }),
            archive: await readCausalArchive({ store, iri }, { limit: 100 }),
        });
    } catch (error) {
        console.error('Causal Study Run Error:', error);
        const message = error instanceof Error ? error.message : 'Der Lauf ist fehlgeschlagen.';
        return NextResponse.json({ error: message }, { status: 500 });
    }
}
