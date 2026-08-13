/**
 * Zugang zur Core-API von Home Assistant.
 *
 * Zwei Betriebsarten, eine Schnittstelle:
 *  - **Add-on** (`ha-addon`): Basis `http://supervisor/core`, Token aus
 *    `SUPERVISOR_TOKEN`. Der Supervisor legt es in die Umgebung, sobald
 *    `homeassistant_api: true` im Add-on-Manifest steht.
 *  - **Extern** (`server`): frei konfigurierte Basis-URL plus
 *    Long-Lived Access Token aus einer Umgebungsvariablen. Der Token
 *    steht NIE in der Connector-Konfiguration — dort liegt nur der Name
 *    der Variablen, die ihn trägt (Muster wie `ENV:`-Referenzen bei den
 *    Verbindungen).
 *
 * Die Registry (Bereiche, Etagen, Geräte) ist über die REST-API nicht
 * direkt abrufbar — sie lebt hinter der WebSocket-API. Erreichbar ist sie
 * trotzdem, über `POST /api/template`: die Template-Funktionen
 * `area_id`, `area_name`, `floor_name`, `device_id`, `device_attr` lösen
 * genau diese Zuordnungen auf. Ein Aufruf liefert damit das vollständige
 * Inventar inklusive Topologie, ohne eine zweite Protokollschicht.
 *
 * **Was diese Datei nicht kann und nicht können soll**: schalten. Es gibt
 * keinen Service-Call, keinen Schreibpfad, keine Automations-Änderung.
 * Der Kausal-Layer liest (CAUSAL_LAYER_SPEC C10) — Interventionen wären
 * ein eigener, ausdrücklich freizugebender Meilenstein.
 */

import { readBodyLimited } from '../http';

/** Rohes Inventar einer Entität, quelltreu aus dem Template-Aufruf. */
export interface HaEntityRecord {
    entityId: string;
    name: string;
    domain: string;
    deviceClass?: string;
    stateClass?: string;
    unit?: string;
    areaId?: string;
    areaName?: string;
    floorName?: string;
    deviceId?: string;
    deviceName?: string;
}

export interface HaHistoryPoint {
    entityId: string;
    /** Millisekunden seit Epoch. */
    t: number;
    /** Roher Zustandstext, wie Home Assistant ihn führt. */
    state: string;
}

export type GuardedFetch = (url: string, init?: RequestInit) => Promise<Response>;

export interface HaAccess {
    baseUrl: string;
    token: string;
    /** Woher der Zugang kommt — für ehrliche Fehlermeldungen. */
    origin: 'supervisor' | 'configured';
}

export interface HaConnectionConfig {
    /** Leer im Add-on: dann entscheidet der Supervisor-Token. */
    url?: string;
    /** Name der Umgebungsvariablen mit dem Long-Lived Access Token. */
    tokenEnv?: string;
}

const DEFAULT_TOKEN_ENV = 'OW_HA_TOKEN';
const SUPERVISOR_BASE = 'http://supervisor/core';

/** Entfernt einen abschließenden Schrägstrich, damit Pfade eindeutig kleben. */
function trimBase(url: string): string {
    return url.replace(/\/+$/, '');
}

/**
 * Löst den Zugang auf. Wirft mit einer Meldung, die sagt, WAS zu tun ist
 * — ein „401" ohne Hinweis auf das fehlende Add-on-Recht hat schon zu
 * viele Stunden gekostet.
 */
export function resolveHaAccess(
    config: HaConnectionConfig,
    env: Record<string, string | undefined> = typeof process !== 'undefined' ? process.env : {},
): HaAccess {
    const configuredUrl = config.url?.trim();
    if (!configuredUrl) {
        const supervisorToken = env.SUPERVISOR_TOKEN;
        if (!supervisorToken) {
            throw new Error(
                'Kein Zugang zu Home Assistant: Ohne URL wird der Supervisor-Token erwartet ' +
                '(SUPERVISOR_TOKEN). Im Add-on entsteht er nur mit "homeassistant_api: true" ' +
                'im Add-on-Manifest; außerhalb des Add-ons trage eine URL und eine ' +
                'Token-Variable ein.',
            );
        }
        return { baseUrl: SUPERVISOR_BASE, token: supervisorToken, origin: 'supervisor' };
    }
    const tokenEnv = config.tokenEnv?.trim() || DEFAULT_TOKEN_ENV;
    const token = env[tokenEnv];
    if (!token) {
        throw new Error(
            `Kein Token für Home Assistant: Die Umgebungsvariable "${tokenEnv}" ist nicht gesetzt. ` +
            'Lege in Home Assistant unter Profil → Sicherheit einen Long-Lived Access Token an ' +
            'und hinterlege ihn dort.',
        );
    }
    return { baseUrl: trimBase(configuredUrl), token, origin: 'configured' };
}

/**
 * Template, das das gesamte Inventar samt Topologie als JSON liefert.
 *
 * Bewusst defensiv: `device_attr` wirft bei fehlender Geräte-ID, deshalb
 * die Vorprüfung. `name_by_user` schlägt den technischen Gerätenamen —
 * das ist der Name, den der Mensch vergeben hat.
 */
export const INVENTORY_TEMPLATE = `
[
{%- for s in states -%}
{%- set dev = device_id(s.entity_id) -%}
{{ {
  "entityId": s.entity_id,
  "name": s.name,
  "domain": s.domain,
  "deviceClass": s.attributes.get('device_class'),
  "stateClass": s.attributes.get('state_class'),
  "unit": s.attributes.get('unit_of_measurement'),
  "areaId": area_id(s.entity_id),
  "areaName": area_name(s.entity_id),
  "floorName": floor_name(s.entity_id),
  "deviceId": dev,
  "deviceName": (device_attr(dev, 'name_by_user') or device_attr(dev, 'name')) if dev else None
} | tojson }}{{ "," if not loop.last else "" }}
{%- endfor -%}
]
`.trim();

function asOptionalString(value: unknown): string | undefined {
    if (typeof value !== 'string') return undefined;
    const trimmed = value.trim();
    if (trimmed === '' || trimmed === 'None' || trimmed === 'unknown') return undefined;
    return trimmed;
}

/** Wandelt eine Template-Zeile in einen Inventar-Eintrag; null bei Unbrauchbarem. */
export function parseEntityRecord(raw: unknown): HaEntityRecord | null {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const record = raw as Record<string, unknown>;
    const entityId = asOptionalString(record.entityId);
    if (!entityId || !entityId.includes('.')) return null;
    return {
        entityId,
        name: asOptionalString(record.name) ?? entityId,
        domain: asOptionalString(record.domain) ?? entityId.split('.')[0],
        deviceClass: asOptionalString(record.deviceClass),
        stateClass: asOptionalString(record.stateClass),
        unit: asOptionalString(record.unit),
        areaId: asOptionalString(record.areaId),
        areaName: asOptionalString(record.areaName),
        floorName: asOptionalString(record.floorName),
        deviceId: asOptionalString(record.deviceId),
        deviceName: asOptionalString(record.deviceName),
    };
}

export class HomeAssistantClient {
    constructor(
        private readonly access: HaAccess,
        private readonly fetchImpl: GuardedFetch,
    ) {}

    private async request(path: string, init: RequestInit = {}): Promise<string> {
        const response = await this.fetchImpl(`${this.access.baseUrl}${path}`, {
            ...init,
            headers: {
                Authorization: `Bearer ${this.access.token}`,
                'Content-Type': 'application/json',
                ...(init.headers ?? {}),
            },
        });
        if (response.status === 401 || response.status === 403) {
            throw new Error(
                this.access.origin === 'supervisor'
                    ? 'Home Assistant weist den Supervisor-Token ab (401/403). Fehlt "homeassistant_api: true" ' +
                      'im Add-on-Manifest, wurde das Add-on danach nicht neu gestartet?'
                    : 'Home Assistant weist den Token ab (401/403). Ist der Long-Lived Access Token gültig?',
            );
        }
        if (!response.ok) {
            const body = await readBodyLimited(response).catch(() => '');
            throw new Error(`Home Assistant antwortete mit HTTP ${response.status}${body ? `: ${body.slice(0, 200)}` : ''}.`);
        }
        return readBodyLimited(response);
    }

    /** Version der Installation — zugleich der billigste Erreichbarkeitstest. */
    async version(): Promise<string> {
        const body = await this.request('/api/config');
        const parsed: unknown = JSON.parse(body);
        const version = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>).version : undefined;
        return typeof version === 'string' ? version : 'unbekannt';
    }

    /** Rendert ein Jinja-Template serverseitig in Home Assistant. */
    async renderTemplate(template: string): Promise<string> {
        return this.request('/api/template', { method: 'POST', body: JSON.stringify({ template }) });
    }

    /**
     * Vollständiges Inventar mit Topologie. Einträge, die das Template
     * nicht brauchbar liefert, werden einzeln gemeldet statt den ganzen
     * Abruf zu verwerfen (Fehlertoleranz-Regel des Connector-Vertrags).
     */
    async inventory(): Promise<{ entities: HaEntityRecord[]; skipped: number }> {
        const rendered = await this.renderTemplate(INVENTORY_TEMPLATE);
        let parsed: unknown;
        try {
            parsed = JSON.parse(rendered);
        } catch {
            throw new Error(
                'Die Inventar-Antwort von Home Assistant ist kein JSON. Erlaubt die Installation ' +
                'die Template-API (POST /api/template)?',
            );
        }
        if (!Array.isArray(parsed)) {
            throw new Error('Die Inventar-Antwort von Home Assistant ist keine Liste.');
        }
        const entities: HaEntityRecord[] = [];
        let skipped = 0;
        for (const raw of parsed) {
            const record = parseEntityRecord(raw);
            if (record) entities.push(record);
            else skipped += 1;
        }
        entities.sort((a, b) => a.entityId.localeCompare(b.entityId));
        return { entities, skipped };
    }

    /**
     * Rohe Zustandshistorie im Zeitfenster. `minimal_response` und
     * `no_attributes` sind gesetzt: Attribute vervielfachen die
     * Antwortgröße um ein Vielfaches und tragen für Zeitreihen nichts bei.
     *
     * Achtung, Eigenart der API: Mit `minimal_response` trägt nur der
     * ERSTE Eintrag je Gruppe die `entity_id`; alle folgenden erben sie.
     */
    async history(
        entityIds: ReadonlyArray<string>,
        startIso: string,
        endIso: string,
    ): Promise<HaHistoryPoint[]> {
        if (entityIds.length === 0) return [];
        const params = new URLSearchParams({
            filter_entity_id: entityIds.join(','),
            end_time: endIso,
            minimal_response: '',
            no_attributes: '',
        });
        const body = await this.request(`/api/history/period/${encodeURIComponent(startIso)}?${params.toString()}`);
        let parsed: unknown;
        try {
            parsed = JSON.parse(body);
        } catch {
            throw new Error('Die Historien-Antwort von Home Assistant ist kein JSON.');
        }
        if (!Array.isArray(parsed)) return [];
        const points: HaHistoryPoint[] = [];
        for (const group of parsed) {
            if (!Array.isArray(group)) continue;
            let currentEntity = '';
            for (const entry of group) {
                if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
                const record = entry as Record<string, unknown>;
                const entityId = asOptionalString(record.entity_id);
                if (entityId) currentEntity = entityId;
                if (!currentEntity) continue;
                const state = typeof record.state === 'string' ? record.state : null;
                const stamp = asOptionalString(record.last_changed) ?? asOptionalString(record.last_updated);
                if (state === null || !stamp) continue;
                const t = Date.parse(stamp);
                if (!Number.isFinite(t)) continue;
                points.push({ entityId: currentEntity, t, state });
            }
        }
        points.sort((a, b) => a.t - b.t);
        return points;
    }
}
