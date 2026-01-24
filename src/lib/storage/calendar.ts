import { promises as fs } from 'fs';
import path from 'path';
import { parseICS } from '@/lib/calendar/ical';

const DATA_DIR = path.join(process.cwd(), 'data', 'calendar');
const PROVIDERS_FILE = path.join(DATA_DIR, 'providers.json');
const EVENTS_FILE = path.join(DATA_DIR, 'events.json');

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

interface CalendarData {
    providers: CalendarProvider[];
}

interface EventsData {
    events: CalendarEvent[];
    updatedAt: string;
}

// Helpers
async function ensureDataFiles() {
    await fs.mkdir(DATA_DIR, { recursive: true });
    try { await fs.access(PROVIDERS_FILE); }
    catch { await fs.writeFile(PROVIDERS_FILE, JSON.stringify({ providers: [] })); }
    try { await fs.access(EVENTS_FILE); }
    catch { await fs.writeFile(EVENTS_FILE, JSON.stringify({ events: [], updatedAt: new Date().toISOString() })); }
}

async function readProviders(): Promise<CalendarProvider[]> {
    await ensureDataFiles();
    const data = JSON.parse(await fs.readFile(PROVIDERS_FILE, 'utf-8'));
    return data.providers;
}

async function writeProviders(providers: CalendarProvider[]) {
    await fs.writeFile(PROVIDERS_FILE, JSON.stringify({ providers }, null, 2));
}

async function readEvents(): Promise<CalendarEvent[]> {
    await ensureDataFiles();
    const data = JSON.parse(await fs.readFile(EVENTS_FILE, 'utf-8'));
    return data.events;
}

async function writeEvents(events: CalendarEvent[]) {
    const data: EventsData = { events, updatedAt: new Date().toISOString() };
    await fs.writeFile(EVENTS_FILE, JSON.stringify(data, null, 2));
}

// Provider Operations
export async function listProviders() {
    return await readProviders();
}

export async function addProvider(name: string, url: string, color: string) {
    const providers = await readProviders();
    const newProvider: CalendarProvider = {
        id: `cal-${Date.now()}`,
        name,
        url,
        color,
        enabled: true,
        lastSync: null
    };
    providers.push(newProvider);
    await writeProviders(providers);

    // Sync immediately
    try {
        await syncProvider(newProvider.id);
    } catch (e) {
        console.error(`Failed to initial sync provider ${name}:`, e);
    }

    return newProvider;
}

export async function updateProvider(id: string, updates: Partial<CalendarProvider>) {
    const providers = await readProviders();
    const index = providers.findIndex(p => p.id === id);
    if (index === -1) return null;

    providers[index] = { ...providers[index], ...updates };
    await writeProviders(providers);
    return providers[index];
}

export async function deleteProvider(id: string) {
    const providers = await readProviders();
    const newProviders = providers.filter(p => p.id !== id);
    if (newProviders.length === providers.length) return false;

    await writeProviders(newProviders);

    // Clean up events
    const events = await readEvents();
    const newEvents = events.filter(e => e.providerId !== id);
    await writeEvents(newEvents);

    return true;
}

// Sync Operation
export async function syncProvider(id: string) {
    const providers = await readProviders();
    const provider = providers.find(p => p.id === id);
    if (!provider) throw new Error('Provider not found');

    try {
        // 1. Fetch ICS data
        const response = await fetch(provider.url);
        if (!response.ok) throw new Error(`Fetch failed: ${response.statusText}`);
        const icsData = await response.text();

        // 2. Parse events
        const parsedEvents = await parseICS(icsData);

        // 3. Map to internal format
        const newEvents: CalendarEvent[] = parsedEvents.map(e => ({
            id: `evt-${provider.id}-${e.uid || Math.random().toString(36)}`,
            providerId: provider.id,
            title: e.summary || '(Ohne Titel)',
            description: e.description,
            startDate: e.start.toISOString(),
            endDate: e.end.toISOString(),
            allDay: e.allDay || false,
            location: e.location
        }));

        // 4. Update events store
        const allEvents = await readEvents();
        // Remove old events from this provider
        const otherEvents = allEvents.filter(e => e.providerId !== id);
        // Add new events
        await writeEvents([...otherEvents, ...newEvents]);

        // 5. Update provider lastSync
        await updateProvider(id, { lastSync: new Date().toISOString() });

        return newEvents.length;
    } catch (error) {
        console.error(`Sync error for ${provider.name}:`, error);
        throw error;
    }
}

export async function getEvents(start?: string, end?: string) {
    const events = await readEvents();
    // Filter by enabled providers
    const providers = await readProviders();
    const enabledIds = new Set(providers.filter(p => p.enabled).map(p => p.id));

    let validEvents = events.filter(e => enabledIds.has(e.providerId));

    if (start && end) {
        const startDate = new Date(start);
        const endDate = new Date(end);
        validEvents = validEvents.filter(e => {
            const eStart = new Date(e.startDate);
            const eEnd = new Date(e.endDate);
            return eStart < endDate && eEnd > startDate;
        });
    }

    return validEvents.sort((a, b) => new Date(a.startDate).getTime() - new Date(b.startDate).getTime());
}
