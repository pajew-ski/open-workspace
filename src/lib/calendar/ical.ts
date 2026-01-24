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
    const lines = icsData.split(/\r\n|\n|\r/);
    let currentEvent: Partial<ParsedEvent> & { dtstart?: string; dtend?: string; dtstartParams?: string } = {};
    let inEvent = false;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        if (line.startsWith('BEGIN:VEVENT')) {
            inEvent = true;
            currentEvent = {};
            continue;
        }

        if (line.startsWith('END:VEVENT')) {
            inEvent = false;
            // Parse dates
            if (currentEvent.dtstart) {
                const isDateOnly = currentEvent.dtstartParams?.includes('VALUE=DATE') || currentEvent.dtstart.length === 8;
                const start = parseICALDate(currentEvent.dtstart);
                const end = currentEvent.dtend ? parseICALDate(currentEvent.dtend) : start;

                events.push({
                    uid: currentEvent.uid || Math.random().toString(36),
                    summary: currentEvent.summary || '',
                    description: currentEvent.description,
                    start,
                    end,
                    location: currentEvent.location,
                    allDay: isDateOnly
                });
            }
            continue;
        }

        if (!inEvent) continue;

        // Simple property parsing
        // Improvements needed: handle multiline (folding), params
        const [keyPart, ...valueParts] = line.split(':');
        let value = valueParts.join(':');

        // Handle parameters (DTSTART;VALUE=DATE:20230101)
        const [key, params] = keyPart.split(';');

        switch (key) {
            case 'UID': currentEvent.uid = value; break;
            case 'SUMMARY': currentEvent.summary = value; break;
            case 'DESCRIPTION': currentEvent.description = value.replace(/\\n/g, '\n').replace(/\\,/g, ','); break;
            case 'LOCATION': currentEvent.location = value.replace(/\\,/g, ','); break;
            case 'DTSTART':
                currentEvent.dtstart = value;
                currentEvent.dtstartParams = params;
                break;
            case 'DTEND': currentEvent.dtend = value; break;
        }
    }

    return events;
}

function parseICALDate(value: string): Date {
    // Format: 20230101 or 20230101T120000Z
    const year = parseInt(value.substring(0, 4));
    const month = parseInt(value.substring(4, 6)) - 1;
    const day = parseInt(value.substring(6, 8));

    if (value.length === 8) {
        return new Date(year, month, day);
    }

    const hour = parseInt(value.substring(9, 11));
    const minute = parseInt(value.substring(11, 13));
    const second = parseInt(value.substring(13, 15));

    if (value.endsWith('Z')) {
        return new Date(Date.UTC(year, month, day, hour, minute, second));
    }

    return new Date(year, month, day, hour, minute, second);
}
