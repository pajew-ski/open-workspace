/**
 * ICS-Abruf eines abonnierten Kalenders (M15). Ein Netz-Lauf, kein
 * Store-Vorgang: holen, parsen, dann in EINER Mutation ersetzen
 * (`replaceCalendarEvents`, dieselbe Replace-Semantik wie ein
 * Connector-Import, SPEC §6.2). Hier statt in der Storage-Fassade, damit
 * die Kalender-Aktion und die Fassade denselben Lauf benutzen.
 */

import { parseICS } from '@/lib/calendar/ical';
import type { CalendarEvent } from '@/lib/storage/calendar';
import * as crud from './crud';
import type { WorkspaceContext } from './crud';

export async function syncCalendar(ctx: WorkspaceContext, id: string): Promise<number> {
    const provider = (await crud.listCalendars(ctx)).find(entry => entry.id === id);
    if (!provider) throw new Error('Provider not found');

    const response = await fetch(provider.url);
    if (!response.ok) throw new Error(`Fetch failed: ${response.statusText}`);
    const icsData = await response.text();
    const parsedEvents = await parseICS(icsData);

    const events: CalendarEvent[] = parsedEvents.map(e => ({
        id: `evt-${provider.id}-${e.uid || Math.random().toString(36)}`,
        providerId: provider.id,
        title: e.summary || '(Ohne Titel)',
        description: e.description,
        startDate: e.start.toISOString(),
        endDate: e.end.toISOString(),
        allDay: e.allDay || false,
        location: e.location,
    }));

    const count = await crud.replaceCalendarEvents(ctx, provider.id, events, new Date().toISOString());
    if (count === null) throw new Error('Provider not found');
    return count;
}
