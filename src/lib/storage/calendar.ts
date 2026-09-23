/**
 * Kalender — Fassade über den Store-first-Schreibpfad (M15).
 *
 * Abonnierte Kalender und ihre Termine sind seit M15 Graph-Bürger:
 * Wahrheit ist der RDF-Store (`schema:DataFeed` + `schema:Event`),
 * `data/calendar/*.json` ist Projektion. Damit erben sie Nutzergraphen,
 * ACL, Export und Suche ohne eigenen Mechanismus — vorher lagen sie
 * instanzweit neben dem Graphen.
 *
 * Was hier BLEIBT, ist der Abruf selbst: ICS holen und parsen ist ein
 * Netz-Lauf, kein Store-Vorgang. Sein Ergebnis geht in EINER Mutation in
 * den Store (`replaceCalendarEvents`) — dieselbe replace-Semantik wie ein
 * Connector-Import (SPEC §6.2).
 */

import { getWorkspaceContext } from '@/lib/graph/server/instance';
import * as crud from '@/lib/graph/workspace/crud';
import { syncCalendar } from '@/lib/graph/workspace/calendar-sync';

export interface CalendarProvider {
    id: string;
    name: string;
    url: string;
    color: string;
    enabled: boolean;
    lastSync: string | null;
}

export interface CalendarEvent {
    id: string;
    providerId: string;
    title: string;
    description?: string;
    startDate: string; // ISO string
    endDate: string;   // ISO string
    allDay: boolean;
    location?: string;
}

// Provider Operations
export async function listProviders(): Promise<CalendarProvider[]> {
    return crud.listCalendars(await getWorkspaceContext());
}

export async function addProvider(name: string, url: string, color: string): Promise<CalendarProvider> {
    const provider = await crud.createCalendar(await getWorkspaceContext(), { name, url, color });

    // Sofort abrufen — ein leerer Kalender direkt nach dem Anlegen sähe
    // aus wie ein kaputter. Scheitert der Abruf, bleibt das Abonnement
    // bestehen und meldet es beim nächsten Sync.
    try {
        await syncProvider(provider.id);
    } catch (e) {
        console.error(`Failed to initial sync provider ${name}:`, e);
    }

    return provider;
}

export async function updateProvider(
    id: string,
    updates: Partial<Omit<CalendarProvider, 'id'>>,
): Promise<CalendarProvider | null> {
    return crud.updateCalendar(await getWorkspaceContext(), id, updates);
}

export async function deleteProvider(id: string): Promise<boolean> {
    return crud.deleteCalendar(await getWorkspaceContext(), id);
}

// Sync Operation — der Lauf selbst steht in graph/workspace/calendar-sync.ts.
export async function syncProvider(id: string): Promise<number> {
    const ctx = await getWorkspaceContext();
    try {
        return await syncCalendar(ctx, id);
    } catch (error) {
        console.error(`Sync error for calendar ${id}:`, error);
        throw error;
    }
}

export async function getEvents(start?: string, end?: string): Promise<CalendarEvent[]> {
    return crud.listEvents(await getWorkspaceContext(), { start, end });
}
