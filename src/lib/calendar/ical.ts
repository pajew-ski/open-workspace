export interface ParsedEvent {
    uid: string;
    summary: string;
    description?: string;
    start: Date;
    end: Date;
    location?: string;
    allDay?: boolean;
}

export async function parseICS(icsData: string): Promise<ParsedEvent[]> {
    const events: ParsedEvent[] = [];

    // Unfold lines (lines starting with space connect to previous line)
    const rawLines = icsData.split(/\r\n|\n|\r/);
    const lines: string[] = [];
    for (const line of rawLines) {
        if (line.startsWith(' ')) {
            if (lines.length > 0) {
                lines[lines.length - 1] += line.substring(1);
            }
        } else {
            lines.push(line);
        }
    }

    console.log(`[ICS] Unfolded ${lines.length} lines`);

    let currentEvent: Partial<ParsedEvent> & { dtstart?: string; dtend?: string; dtstartParams?: string } = {};
    let inEvent = false;
    let eventCount = 0;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        if (line.startsWith('BEGIN:VEVENT')) {
            inEvent = true;
            currentEvent = {};
            continue;
        }

        if (line.startsWith('END:VEVENT')) {
            inEvent = false;
            eventCount++;
            // Parse dates only if we have DTSTART
            if (currentEvent.dtstart) {
                try {
                    const isDateOnly = currentEvent.dtstartParams?.includes('VALUE=DATE') || currentEvent.dtstart.length === 8;
                    const start = parseICALDate(currentEvent.dtstart);
                    const end = currentEvent.dtend ? parseICALDate(currentEvent.dtend) : (isDateOnly ? start : new Date(start.getTime() + 3600000));

                    events.push({
                        uid: currentEvent.uid || Math.random().toString(36),
                        summary: currentEvent.summary || '',
                        description: currentEvent.description,
                        start,
                        end,
                        location: currentEvent.location,
                        allDay: isDateOnly
                    });
                } catch (e) {
                    console.error('[ICS] Error parsing event date:', e, currentEvent);
                }
            } else {
                console.warn('[ICS] Skipped event without DTSTART', currentEvent);
            }
            continue;
        }

        if (!inEvent) continue;

        // Find the first colon to separate key and value
        const colonIndex = line.indexOf(':');
        if (colonIndex === -1) continue;

        const keyPart = line.substring(0, colonIndex);
        let value = line.substring(colonIndex + 1);

        // Handle parameters (DTSTART;VALUE=DATE:20230101)
        // Key might look like "DTSTART;TZID=Europe/Berlin"
        const semicolonIndex = keyPart.indexOf(';');
        let key = keyPart;
        let params = '';

        if (semicolonIndex !== -1) {
            key = keyPart.substring(0, semicolonIndex);
            params = keyPart.substring(semicolonIndex + 1);
        }

        switch (key) {
            case 'UID': currentEvent.uid = value; break;
            case 'SUMMARY': currentEvent.summary = unescapeICS(value); break;
            case 'DESCRIPTION': currentEvent.description = unescapeICS(value); break;
            case 'LOCATION': currentEvent.location = unescapeICS(value); break;
            case 'DTSTART':
                currentEvent.dtstart = value;
                currentEvent.dtstartParams = params;
                break;
            case 'DTEND': currentEvent.dtend = value; break;
        }
    }

    return events;
}

function unescapeICS(value: string): string {
    return value
        .replace(/\\n/g, '\n')
        .replace(/\\N/g, '\n')
        .replace(/\\;/g, ';')
        .replace(/\\,/g, ',')
        .replace(/\\\\/g, '\\');
}

function parseICALDate(value: string): Date {
    // Basic cleaning
    value = value.trim();

    // Format: 20230101 or 20230101T120000Z or 20230101T120000
    if (value.length < 8) return new Date(); // Invalid

    const year = parseInt(value.substring(0, 4));
    const month = parseInt(value.substring(4, 6)) - 1;
    const day = parseInt(value.substring(6, 8));

    // Date only
    if (value.length === 8) {
        return new Date(year, month, day);
    }

    // Date-Time
    if (value.length >= 15) {
        const hour = parseInt(value.substring(9, 11));
        const minute = parseInt(value.substring(11, 13));
        const second = parseInt(value.substring(13, 15));

        if (value.endsWith('Z')) {
            return new Date(Date.UTC(year, month, day, hour, minute, second));
        }

        // Local time (or Floating) - treating as local for now
        return new Date(year, month, day, hour, minute, second);
    }

    return new Date(year, month, day);
}
