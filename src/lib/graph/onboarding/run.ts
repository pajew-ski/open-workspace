/**
 * Ausführung der Einführungsstrecke (GRAPH_CORE_SPEC §18, M14).
 *
 * Jeder Schritt ist eine reale Aktion auf den regulären Pfaden — die
 * Store-first-CRUD für den eigenen Knoten, der EINE Connector-Vertrag für
 * den Import, der Dataset-Resolver für jede Abfrage. Es gibt keinen
 * Tutorial-Modus, keine Beispieldaten und keinen zweiten Schreibweg
 * (Invarianten 1, 5, 10).
 *
 * Alle Außenkontakte kommen als Abhängigkeiten herein (Store, Workspace,
 * Dateisystem, Runtime, fetch, Uhr), damit die Abnahme dieselbe Strecke
 * ohne Next.js und ohne Netz fahren kann.
 */

import type { DatasetAuthz } from '../sparql/protocol';
import { provenanceSummary, type ProvenanceSummary } from '../provenance';
import type { WorkspaceContext } from '../workspace/crud';
import { createDoc, deleteDoc, getDoc } from '../workspace/crud';
import { createConnector, deleteConnector, getConnector } from '../connectors/registry';
import { syncConnector, type SyncOptions } from '../connectors/sync';
import { githubRdfConnector } from '../connectors/github-rdf';
import { readSelfModel, type SelfModelView } from '../meta/self-model-query';
import {
    listOnboardingRecords,
    onboardingStepIri,
    recordOnboardingStep,
    removeOnboardingStep,
    type GraphHandle,
    type OnboardingRecord,
} from './record';
import {
    ONBOARDING_DOC_TITLE,
    ONBOARDING_STEPS,
    PRIMA_MATERIA,
    type OnboardingStepDefinition,
    type OnboardingStepId,
} from './steps';

export { provenanceSummary } from '../provenance';
export type { ProvenanceBucket, ProvenanceSummary } from '../provenance';

export interface OnboardingDeps {
    handle: GraphHandle;
    /** Store-first-CRUD des anfragenden Nutzers (Schritt „eigener Knoten"). */
    workspace: WorkspaceContext;
    /** Optionen des Sync-Runners (Dateien, Runtime, fetch, Uhr). */
    sync?: SyncOptions;
    /** Verengung des Datasets — wie überall nur wegnehmend (§17.3). */
    authz?: DatasetAuthz;
    /** Zeitquelle für die Schritt-Aufzeichnung. */
    now?: () => string;
    /** Persistenz nach einer Mutation (Snapshot). */
    persist?: () => Promise<void>;
    /**
     * Inferenz-Lauf nach einer Workspace-Mutation. Import und Löschen
     * bringen ihn selbst mit (Sync-Runner, Registry); der eigene Knoten
     * nicht — ohne diesen Aufruf zeigte Schritt 4 einen Inferenz-Stand
     * von vor dem Knoten.
     */
    reason?: () => Promise<void>;
}

export interface OnboardingStepState extends OnboardingStepDefinition {
    iri: string;
    done: boolean;
    completedAt: string | null;
    generated: string[];
    used: string[];
}

export interface OnboardingState {
    steps: OnboardingStepState[];
    /** Live abgefragt, nicht gespeichert — Grundlage von Schritt 1. */
    selfModel: SelfModelView;
    /** Live gezählt, nicht gespeichert — Grundlage von Schritt 4. */
    provenance: ProvenanceSummary;
}

/** Fehler, der dem Nutzer wörtlich angezeigt werden darf. */
export class OnboardingError extends Error { }

/** Zustand der Strecke: Definitionen + aufgezeichneter Fortschritt + Live-Daten. */
export async function onboardingState(deps: OnboardingDeps): Promise<OnboardingState> {
    const records = await listOnboardingRecords(deps.handle, deps.authz);
    const byId = new Map<string, OnboardingRecord>(records.map(record => [record.stepId, record]));
    const [selfModel, provenance] = await Promise.all([
        readSelfModel(deps.handle.store, deps.handle.iri, deps.authz),
        provenanceSummary(deps.handle, deps.authz),
    ]);
    return {
        steps: ONBOARDING_STEPS.map(step => {
            const record = byId.get(step.id);
            return {
                ...step,
                iri: onboardingStepIri(deps.handle.iri, step.id),
                done: Boolean(record),
                completedAt: record?.completedAt ?? null,
                generated: record?.generated ?? [],
                used: record?.used ?? [],
            };
        }),
        selfModel,
        provenance,
    };
}

const ONBOARDING_DOC_CONTENT = [
    '# Mein erster Knoten',
    '',
    'Dieses Dokument ist ein Knoten in deinem Workspace-Graphen.',
    'Die Markdown-Datei unter `data/docs/` ist seine Projektion — die Wahrheit',
    'steht als RDF in `graph/u/<du>/workspace`.',
    '',
    'Probiere es aus: Öffne den SPARQL-Editor und frage nach `ow:Document`.',
    '',
].join('\n');

/** Führt einen Schritt aus. Wirft `OnboardingError` mit anzeigbarem Text. */
export async function performOnboardingStep(
    deps: OnboardingDeps,
    stepId: OnboardingStepId,
): Promise<OnboardingState> {
    const now = deps.now?.() ?? new Date().toISOString();
    switch (stepId) {
        case 'self-model': {
            const view = await readSelfModel(deps.handle.store, deps.handle.iri, deps.authz);
            if (!view.app) {
                throw new OnboardingError(
                    'In graph/meta ist kein Selbstmodell sichtbar. Es entsteht beim Start der Instanz; ' +
                    'ohne Leserecht auf graph/meta bleibt es leer.',
                );
            }
            await recordOnboardingStep(deps.handle, { stepId, used: [view.app.iri], now });
            break;
        }
        case 'own-node': {
            const existing = await existingDocIri(deps);
            if (!existing) {
                const doc = await createDoc(deps.workspace, {
                    title: ONBOARDING_DOC_TITLE,
                    content: ONBOARDING_DOC_CONTENT,
                    tags: ['einführung'],
                });
                await recordOnboardingStep(deps.handle, {
                    stepId,
                    generated: [deps.workspace.iri.entity('doc', doc.id)],
                    now,
                });
            } else {
                await recordOnboardingStep(deps.handle, { stepId, generated: [existing], now });
            }
            await deps.reason?.();
            break;
        }
        case 'import': {
            const connector = (await getConnector(deps.handle, PRIMA_MATERIA.connectorId))
                ?? await createConnector(deps.handle, {
                    id: PRIMA_MATERIA.connectorId,
                    name: PRIMA_MATERIA.name,
                    kind: githubRdfConnector.kind,
                    locator: githubRdfConnector.locatorFor(githubRdfConnector.parseConfig({
                        repo: PRIMA_MATERIA.repo,
                        path: PRIMA_MATERIA.path,
                    })),
                });
            const result = await syncConnector(deps.handle, connector.id, deps.sync ?? {});
            if (result.status === 'failed') {
                // Der Connector bleibt bestehen: Ein zweiter Versuch ist ein
                // Klick, und der Fehlschlag steht ehrlich am Lauf-Knoten.
                throw new OnboardingError(
                    `Der Import ist fehlgeschlagen: ${result.message}`,
                );
            }
            await recordOnboardingStep(deps.handle, { stepId, generated: [connector.iri], now });
            break;
        }
        case 'provenance': {
            const summary = await provenanceSummary(deps.handle, deps.authz);
            const graphs = [...summary.native, ...summary.imported, ...summary.inferred].map(b => b.graph);
            if (graphs.length === 0) {
                throw new OnboardingError(
                    'Es gibt noch nichts zu vergleichen — leg zuerst einen eigenen Knoten an.',
                );
            }
            await recordOnboardingStep(deps.handle, { stepId, used: graphs, now });
            break;
        }
    }
    await deps.persist?.();
    return onboardingState(deps);
}

/**
 * Nimmt einen Schritt zurück: erst das, was er erzeugt hat, dann seine
 * Aufzeichnung. Ein Schritt, der nichts erzeugt hat (Abfragen),
 * hinterlässt entsprechend nichts.
 */
export async function undoOnboardingStep(
    deps: OnboardingDeps,
    stepId: OnboardingStepId,
): Promise<OnboardingState> {
    switch (stepId) {
        case 'own-node': {
            const docIri = await existingDocIri(deps);
            if (docIri) {
                const id = entityId(deps.workspace.iri.entity('doc', ''), docIri);
                if (id) await deleteDoc(deps.workspace, id);
            }
            await deps.reason?.();
            break;
        }
        case 'import': {
            await deleteConnector(deps.handle, PRIMA_MATERIA.connectorId);
            break;
        }
        default:
            break;
    }
    await removeOnboardingStep(deps.handle, stepId);
    await deps.persist?.();
    return onboardingState(deps);
}

/** IRI des Einführungs-Dokuments, sofern es (noch) existiert. */
async function existingDocIri(deps: OnboardingDeps): Promise<string | null> {
    const records = await listOnboardingRecords(deps.handle, deps.authz);
    const record = records.find(entry => entry.stepId === 'own-node');
    for (const candidate of record?.generated ?? []) {
        const id = entityId(deps.workspace.iri.entity('doc', ''), candidate);
        if (!id) continue;
        if (await getDoc(deps.workspace, id)) return candidate;
    }
    return null;
}

/** Stabile ID aus einer Entitäts-IRI mit bekanntem Präfix. */
function entityId(prefix: string, iri: string): string | null {
    if (!iri.startsWith(prefix)) return null;
    const rest = iri.slice(prefix.length);
    return rest === '' ? null : decodeURIComponent(rest);
}
