/**
 * `home-assistant`-Connector: die STRUKTUR einer Home-Assistant-
 * Installation als Graph — Etagen, Bereiche, Geräte, Entitäten und die
 * von ihnen beobachteten Größen. Read-only, über den EINEN
 * Connector-Vertrag (Invariante 5).
 *
 * **Was dieser Connector bewusst NICHT tut**: Messwerte holen. Struktur
 * und Zeitreihen haben verschiedene Takte — die Registry ändert sich
 * selten, die Werte müssen alle paar Minuten nachgeladen werden, sonst
 * verwirft Home Assistant sie. Beides in einen Lauf zu legen, hieße
 * entweder die Struktur unnötig oft zu ersetzen oder die Erfassung zu
 * verschleppen. Die Werte holt deshalb die Erfassung
 * (`graph/observations/capture.ts`), die diesen Connector nur als
 * Zugangs- und Strukturquelle nutzt.
 *
 * Revision: SHA-256 über das normalisierte Inventar. Ändert sich in Home
 * Assistant nichts, ist der Lauf ein No-Op und der Import-Graph bleibt
 * unangetastet.
 */

import type { Quad } from '@rdfjs/types';
import { z } from 'zod';
import type { Connector, ConnectorContext, SourceRef } from '../types';
import { sha256Hex } from '../quads';
import { HomeAssistantClient, resolveHaAccess, type HaEntityRecord } from './api';
import { inventoryQuads } from './structure';

const configSchema = z.object({
    /**
     * Basis-URL der Installation. Leer lassen im Add-on — dann läuft der
     * Zugang über den Supervisor (`http://supervisor/core`).
     */
    url: z.string().trim().default(''),
    /** Name der Umgebungsvariablen mit dem Long-Lived Access Token. */
    tokenEnv: z.string().trim().default(''),
});

export type HomeAssistantConfig = z.infer<typeof configSchema>;

/**
 * Normalisierte Fassung für die Revision: nur die Felder, die die
 * Struktur bestimmen. Der aktuelle Zustandswert gehört ausdrücklich
 * NICHT dazu — sonst wäre die Revision bei jedem Sensorwechsel neu und
 * der Import-Graph würde minütlich ersetzt.
 */
function structuralFingerprint(entities: ReadonlyArray<HaEntityRecord>): string {
    return entities
        .map(entity => [
            entity.entityId, entity.name, entity.domain, entity.deviceClass ?? '',
            entity.stateClass ?? '', entity.unit ?? '', entity.areaId ?? '',
            entity.areaName ?? '', entity.floorName ?? '', entity.deviceId ?? '',
            entity.deviceName ?? '',
        ].join(''))
        .join('\n');
}

/** Baut den API-Client aus Connector-Konfiguration und Kontext-fetch. */
export function clientFor(config: HomeAssistantConfig, ctx: Pick<ConnectorContext, 'fetch'>): HomeAssistantClient {
    const access = resolveHaAccess({ url: config.url, tokenEnv: config.tokenEnv });
    return new HomeAssistantClient(access, ctx.fetch);
}

export const homeAssistantConnector: Connector<HomeAssistantConfig> = {
    kind: 'home-assistant',
    mode: 'materialize',
    capabilities: { read: true, write: false, watch: false, lossyExport: false },
    label: 'Home Assistant',
    description:
        'Struktur einer Home-Assistant-Installation: Etagen, Bereiche, Geräte, Entitäten und ' +
        'die beobachteten Größen (SOSA). Grundlage für die Erfassung von Zeitreihen — read-only, ' +
        'es wird nichts geschaltet.',

    configSchema: () => z.toJSONSchema(configSchema) as Record<string, unknown>,
    parseConfig: input => configSchema.parse(input),

    // Locator als kompakter, verlustfreier String: `url|tokenEnv`. Beide
    // Teile dürfen leer sein (Add-on-Fall).
    locatorFor: config => `${config.url}|${config.tokenEnv}`,
    configFromLocator: locator => {
        const separator = locator.indexOf('|');
        return separator < 0
            ? configSchema.parse({ url: locator, tokenEnv: '' })
            : configSchema.parse({ url: locator.slice(0, separator), tokenEnv: locator.slice(separator + 1) });
    },

    async probe(config, ctx): Promise<SourceRef> {
        const client = clientFor(config, ctx);
        await client.version();
        const { entities } = await client.inventory();
        return {
            id: '',
            kind: this.kind,
            locator: this.locatorFor(config),
            revision: `sha256:${await sha256Hex(structuralFingerprint(entities))}`,
            fetchedAt: new Date().toISOString(),
        };
    },

    async *pull(ref: SourceRef, ctx: ConnectorContext): AsyncIterable<Quad> {
        ctx.report({ done: 0, total: 1, note: 'Lade Inventar aus Home Assistant…' });
        const client = clientFor(this.configFromLocator(ref.locator), ctx);
        const { entities, skipped } = await client.inventory();
        if (skipped > 0) {
            ctx.quarantine({
                source: `${ref.locator}#inventar`,
                reason: `${skipped} Einträge ohne brauchbare entity_id — übersprungen.`,
            });
        }
        const { quads, counts } = inventoryQuads(ctx.iri, entities);
        ctx.report({
            done: 1,
            total: 1,
            note: `${counts.entities} Entitäten, ${counts.devices} Geräte, ${counts.areas} Bereiche, ${counts.floors} Etagen.`,
        });
        yield* quads;
    },
};
