/**
 * Einmaliger Migrator Bestand → data/graph/ (SPEC §12.2).
 *
 * Liest data/docs/*.md, data/tasks/*.json, data/canvas/*.json und erzeugt
 * den kanonischen Graph-Snapshot (workspace.nq + manifest.json).
 * Idempotent: wiederholte Läufe auf unverändertem Bestand erzeugen
 * byte-identische Dateien. Mit Vorher-Nachher-Bericht.
 *
 * Aufruf: `bun run migrate:graph`
 */

import path from 'node:path';
import { getServerGraph, readWorkspaceInput } from '../src/lib/graph/server/instance';
import { buildWorkspaceQuads } from '../src/lib/graph/migrate/from-files';
import { writeSnapshot } from '../src/lib/graph/serialize/snapshot';
import { createNodeFileSystem } from '../src/lib/platform/runtime/node-fs';

async function main(): Promise<void> {
    const input = await readWorkspaceInput();
    console.log('Bestand (Dateien):');
    console.log(`  Dokumente: ${input.docs.length}`);
    console.log(`  Aufgaben:  ${input.tasks.length}`);
    console.log(`  Projekte:  ${input.projects.length}`);
    console.log(`  Canvases:  ${input.canvases.length} (Karten: ${input.canvases.reduce((n, c) => n + c.cards.length, 0)})`);

    const { store, iri } = await getServerGraph();
    const { counts } = buildWorkspaceQuads(input, iri);

    console.log('\nGraph (nach Migration):');
    console.log(`  Dokumente: ${counts.docs}`);
    console.log(`  Aufgaben:  ${counts.tasks}`);
    console.log(`  Projekte:  ${counts.projects}`);
    console.log(`  Canvases:  ${counts.canvases} (Karten: ${counts.cards})`);
    console.log(`  Tags:      ${counts.tags}`);
    console.log(`  Kanten:    ${counts.links}`);
    console.log(`  Quads:     ${counts.quads}`);

    // Zähl-Assertions (M1-Abnahme): kein data/-Inhalt geht verloren.
    const assertEqual = (label: string, files: number, graph: number) => {
        if (files !== graph) {
            throw new Error(`Zähl-Assertion verletzt: ${label} Dateien=${files} Graph=${graph}`);
        }
    };
    assertEqual('Dokumente', input.docs.length, counts.docs);
    assertEqual('Aufgaben', input.tasks.length, counts.tasks);
    assertEqual('Projekte', input.projects.length, counts.projects);
    assertEqual('Canvases', input.canvases.length, counts.canvases);
    assertEqual('Karten', input.canvases.reduce((n, c) => n + c.cards.length, 0), counts.cards);

    const dir = path.join(process.cwd(), 'data', 'graph');
    const report = await writeSnapshot(store, createNodeFileSystem(), dir, iri.instanceBase);
    console.log('\nSnapshot geschrieben:');
    for (const file of report.written) {
        console.log(`  data/graph/${file.file} (${file.quads} Quads)`);
    }
    if (report.removedStale.length > 0) {
        console.log(`  Verwaiste Dateien entfernt: ${report.removedStale.join(', ')}`);
    }
    console.log('\n✓ Migration abgeschlossen. Zähl-Assertions erfüllt.');
}

main().catch(error => {
    console.error(`✗ Migration fehlgeschlagen: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
});
