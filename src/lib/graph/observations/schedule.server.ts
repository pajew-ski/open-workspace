/**
 * Zeitgeber der Erfassung — der Teil, der „früh materialisieren"
 * überhaupt erst wirksam macht.
 *
 * Ein Erfassungslauf auf Knopfdruck nützt nichts: Was Home Assistant
 * verwirft, ist weg, und niemand drückt zuverlässig alle zehn Minuten
 * einen Knopf. Deshalb läuft die Erfassung im Serverprozess auf einem
 * Intervall — solange die Installation läuft, wächst der Bestand.
 *
 * Bewusste Grenzen:
 *  - **Nur `server` und `ha-addon`.** Die Runtime `local` hat keinen
 *    dauerhaft laufenden Prozess; ein Browser-Tab, der zufällig offen
 *    ist, wäre kein Zeitgeber, sondern ein Zufallsgenerator. Dort gibt
 *    es die Erfassung ehrlich nicht (Invariante C9/10).
 *  - **Ein Lauf zur Zeit.** Überlappende Läufe würden dasselbe Fenster
 *    doppelt abfragen; das Wasserzeichen fängt Dubletten zwar ab, die
 *    Last bliebe aber.
 *  - **Kein Lauf ohne Grund.** Ohne aktive Größe endet der Lauf sofort,
 *    ohne Home Assistant überhaupt anzusprechen.
 *
 * Der Zeitgeber startet beim ersten Zugriff auf den Graphen (Bootstrap in
 * `server/instance.ts`) und hängt am Prozess, nicht an einer Anfrage.
 */

import path from 'node:path';
import { createNodeFileSystem } from '@/lib/platform/runtime/node-fs';
import type { IriFactory } from '../iri';
import type { GraphStore } from '../store/types';
import { captureObservations, type CaptureRunReport } from './capture';
import { listVariables } from './variables';

/** Default-Takt: alle 10 Minuten. Über `OW_CAPTURE_INTERVAL` änderbar. */
export const DEFAULT_CAPTURE_INTERVAL_SECONDS = 600;
const MIN_INTERVAL_SECONDS = 60;

interface ScheduleState {
    timer: ReturnType<typeof setInterval>;
    running: boolean;
    lastReport?: CaptureRunReport;
    lastError?: string;
}

const globalSchedule = globalThis as unknown as { __owCaptureSchedule?: ScheduleState };

/**
 * Intervall aus der Umgebung. `0` schaltet den Zeitgeber ab — für
 * Installationen, die die Erfassung von außen takten wollen (Cron, n8n).
 */
export function captureIntervalSeconds(env: NodeJS.ProcessEnv = process.env): number {
    const raw = env.OW_CAPTURE_INTERVAL;
    if (raw === undefined || raw.trim() === '') return DEFAULT_CAPTURE_INTERVAL_SECONDS;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_CAPTURE_INTERVAL_SECONDS;
    if (parsed === 0) return 0;
    return Math.max(MIN_INTERVAL_SECONDS, Math.floor(parsed));
}

/** Datenwurzel der Installation — dieselbe wie beim Graph-Snapshot. */
export function dataRoot(): string {
    return process.env.OW_DATA_DIR ?? path.join(process.cwd(), 'data');
}

/** Führt genau einen Lauf aus; überspringt, wenn schon einer läuft. */
export async function runCaptureOnce(
    handle: { store: GraphStore; iri: IriFactory },
    variableIds?: ReadonlyArray<string>,
): Promise<CaptureRunReport> {
    return captureObservations(handle, {
        files: createNodeFileSystem(),
        root: dataRoot(),
        ...(variableIds ? { variableIds } : {}),
    });
}

/**
 * Startet den Zeitgeber genau einmal pro Prozess. Idempotent — ein
 * zweiter Aufruf (Next erzeugt Module im Dev-Modus mehrfach) tut nichts.
 */
export function ensureCaptureSchedule(
    resolveHandle: () => Promise<{ store: GraphStore; iri: IriFactory }>,
): void {
    if (globalSchedule.__owCaptureSchedule) return;
    // Die Runtime `local` erreicht diese Datei nie: Sie ist server-only
    // (node:path, node:fs) und wird ausschließlich aus dem Bootstrap des
    // Serverprozesses aufgerufen.
    const intervalSeconds = captureIntervalSeconds();
    if (intervalSeconds === 0) return;

    const state: ScheduleState = {
        timer: setInterval(() => {
            void tick();
        }, intervalSeconds * 1000),
        running: false,
    };
    // Der Zeitgeber darf den Prozess nicht am Beenden hindern.
    state.timer.unref?.();
    globalSchedule.__owCaptureSchedule = state;

    async function tick(): Promise<void> {
        if (state.running) return;
        state.running = true;
        try {
            const handle = await resolveHandle();
            // Billiger Vorabtest: ohne aktive Größe wird Home Assistant
            // gar nicht erst angesprochen.
            const variables = await listVariables(handle);
            if (!variables.some(variable => variable.enabled)) return;
            state.lastReport = await runCaptureOnce(handle);
            state.lastError = undefined;
        } catch (error) {
            // Ein fehlgeschlagener Lauf beendet den Zeitgeber nicht — die
            // nächste Runde kann gelingen (Home Assistant startet neu, Netz
            // kommt wieder). Der Fehler steht im Status.
            state.lastError = error instanceof Error ? error.message : String(error);
        } finally {
            state.running = false;
        }
    }
}

/** Zustand des Zeitgebers für die Statusanzeige (ohne Geheimnisse). */
export function captureScheduleStatus(): {
    active: boolean;
    intervalSeconds: number;
    running: boolean;
    lastRunAt?: string;
    lastMessage?: string;
    lastError?: string;
} {
    const state = globalSchedule.__owCaptureSchedule;
    return {
        active: state !== undefined,
        intervalSeconds: captureIntervalSeconds(),
        running: state?.running ?? false,
        ...(state?.lastReport ? { lastRunAt: state.lastReport.finishedAt, lastMessage: state.lastReport.message } : {}),
        ...(state?.lastError ? { lastError: state.lastError } : {}),
    };
}
