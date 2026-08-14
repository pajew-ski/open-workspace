/**
 * Der serverseitige Anschluss des Studien-Laufs (Meilenstein C4).
 *
 * Alles Rechnende liegt im puren Tier-1-Kern (`study.ts`, `estimate.ts`,
 * `refute.ts`) und alles Graph-Nahe in `study-graph.ts`. Hier steht nur,
 * was ohne Dateisystem nicht geht: Wo die Messreihen liegen (C3) und
 * welche Version gerechnet hat (Signatur, C7).
 *
 * Der Zuschnitt ist derselbe wie bei der Erfassung (`schedule.server.ts`):
 * eine dünne Schicht, die I/O hereinreicht — damit dieselbe Rechnung im
 * Browser läuft, wo es dieses Modul nicht gibt (Invariante C9).
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createNodeFileSystem } from '@/lib/platform/runtime/node-fs';
import { ObservationStore } from '../observations/store';
import { dataRoot } from '../observations/schedule.server';
import { listVariables } from '../observations/variables';
import type { GraphHandle } from './model';
import {
    runCausalStudies,
    type StudyRunSummary,
    type VariableMetadata,
} from './study-graph';

/** Version der Anwendung; ohne lesbare package.json ehrlich „unbekannt". */
function appVersion(): string {
    try {
        const raw = readFileSync(path.join(process.cwd(), 'package.json'), 'utf-8');
        const parsed: unknown = JSON.parse(raw);
        const version = (parsed as { version?: unknown }).version;
        return typeof version === 'string' && version !== '' ? version : 'unbekannt';
    } catch {
        return 'unbekannt';
    }
}

export interface ServerStudyRunOptions {
    actor?: string;
    now?: Date;
    bootstrapSamples?: number;
    maxRows?: number;
}

/**
 * Rechnet alle Fragen dieses Nutzers neu und ersetzt den Inferenz-Graphen
 * vollständig (Invariante C4). Messwerte kommen aus dem
 * Beobachtungs-Speicher, nie aus dem Store (Invariante C3).
 */
export async function runCausalStudiesOnServer(
    handle: GraphHandle,
    options: ServerStudyRunOptions = {},
): Promise<StudyRunSummary> {
    const observations = new ObservationStore({
        files: createNodeFileSystem(),
        root: dataRoot(),
        userId: handle.iri.userId,
    });
    const metadata: VariableMetadata[] = (await listVariables(handle)).map(view => ({
        iri: view.iri,
        id: view.id,
        name: view.name,
        kind: view.kind,
        aggregation: view.aggregation,
        intervalSeconds: view.intervalSeconds,
        ...(view.unit ? { unit: view.unit } : {}),
    }));
    return runCausalStudies(handle, metadata, {
        ...options,
        softwareVersion: appVersion(),
        readSeries: async (variableId, range) => (await observations.read(variableId, range)).observations,
    });
}
