/**
 * `solar-position` — die gerechnete Messquelle (CAUSAL_LAYER_SPEC §10,
 * entschieden am 2026-08-14: **eine berechnete Größe ist eine
 * Beobachtung**, docs/spec-widersprueche.md, Eintrag 4).
 *
 * **Warum das durch den Connector-Vertrag läuft und nicht daneben.**
 * Die Alternative wäre eine zweite Erfassungspipeline für gerechnete
 * Reihen — und damit genau der Sonderweg, den Invariante 5 verbietet.
 * Der Vertrag verlangt nirgends ein Netz: `obsidian-vault` liest Dateien,
 * `git-backup` ein Repo, und diese Quelle rechnet. Was sie mit den
 * anderen teilt, ist alles, worauf es ankommt — sie materialisiert ihre
 * Angebotsseite in einen Import-Graphen, trägt eine Revision, erscheint
 * in derselben Kandidatenliste und liefert ihre Werte über denselben
 * Erfassungslauf in denselben Beobachtungs-Speicher.
 *
 * **Ehrlich bleibt sie durch das Verfahren im Graphen**: Der Sensor
 * verweist per `ssn:implements` auf einen `sosa:Procedure`-Knoten. Wer
 * eine Reihe adjustiert, sieht damit, dass sie aus Ort und Zeit entstand
 * und nicht aus einem Gerät — ohne dass die UI es dazuerzählen müsste.
 *
 * **Die Revision ändert sich nie von selbst.** Sie hängt am Ort und am
 * Reihen-Inventar; die Bahn der Erde ist keine Quelländerung. Ein
 * erneuter Sync ist deshalb immer ein No-Op — richtig so, denn die
 * Struktur ist wirklich unverändert.
 */

import type { Quad } from '@rdfjs/types';
import { z } from 'zod';
import type { Connector, ConnectorContext, SourceRef } from '../types';
import { sha256Hex } from '../quads';
import {
    sourceStructureQuads,
    type SourceDescriptor,
    type SourceSeriesDescriptor,
} from '../../observations/source-structure';

const configSchema = z.object({
    latitude: z.string().trim().min(1),
    longitude: z.string().trim().min(1),
    placeName: z.string().trim().default(''),
});

export type SolarPositionConfig = z.infer<typeof configSchema>;

/** Kennung des Rechenverfahrens — sie steht als sosa:Procedure im Graphen. */
export const SOLAR_PROCEDURE_ID = 'solar-position-noaa';

export const SOLAR_SERIES: readonly SourceSeriesDescriptor[] = [
    {
        key: 'elevation',
        name: 'Sonnenhöhe',
        kind: 'numeric',
        unit: '°',
        observable: 'solar-elevation',
        role: 'Störgröße für Verschattung, PV-Ertrag und Innentemperatur — exogen und lückenlos',
    },
    {
        key: 'azimuth',
        name: 'Sonnenazimut',
        kind: 'numeric',
        unit: '°',
        observable: 'solar-azimuth',
        role: 'Richtung der Einstrahlung: erklärt, welche Fassade wann getroffen wird',
    },
    {
        key: 'daylight',
        name: 'Sonne über dem Horizont',
        kind: 'binary',
        observable: 'daylight',
        role: 'Tag/Nacht ohne Uhrzeit-Willkür — der saubere Zeitgeber für Beleuchtungsfragen',
    },
    {
        key: 'extraterrestrial-irradiance',
        name: 'Einstrahlung außerhalb der Atmosphäre',
        kind: 'numeric',
        unit: 'W/m²',
        observable: 'irradiance',
        role: 'Der geometrische Anteil der Einstrahlung — was davon ankommt, sagt das Wetter',
    },
];

export function coordinateOf(value: string): number {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) {
        throw new Error(`"${value}" ist keine Koordinate.`);
    }
    return parsed;
}

export function solarSourceDescriptor(config: SolarPositionConfig): SourceDescriptor {
    const latitude = coordinateOf(config.latitude);
    const longitude = coordinateOf(config.longitude);
    if (latitude < -90 || latitude > 90) {
        throw new Error(`Breitengrad ${latitude} liegt außerhalb von −90 bis 90.`);
    }
    if (longitude < -180 || longitude > 180) {
        throw new Error(`Längengrad ${longitude} liegt außerhalb von −180 bis 180.`);
    }
    return {
        label: 'Sonnenstand (gerechnet)',
        locatorKind: 'url',
        attribution:
            'Gerechnet aus Ort und Zeit nach dem Verfahren niedriger Genauigkeit des '
            + 'Astronomical Almanac (NOAA-Fassung). Keine externe Quelle.',
        place: {
            name: config.placeName.trim() || 'Standort',
            latitude,
            longitude,
        },
        procedure: {
            id: SOLAR_PROCEDURE_ID,
            name: 'Sonnenstand nach Astronomical Almanac (NOAA)',
            description:
                'Geometrische Sonnenposition aus Ort und Zeitpunkt: Höhe, Azimut und die '
                + 'extraterrestrische Bestrahlungsstärke auf die Horizontale. Ohne Refraktion '
                + 'und ohne Atmosphärenmodell — was von der Einstrahlung ankommt, sagt das '
                + 'Wetter, nicht dieses Verfahren. Gültig 1950–2050 mit einem Fehler unter 0,01°.',
        },
        series: SOLAR_SERIES,
    };
}

export const solarPositionConnector: Connector<SolarPositionConfig> = {
    kind: 'solar-position',
    mode: 'materialize',
    capabilities: { read: true, write: false, watch: false, lossyExport: false },
    label: 'Sonnenstand (gerechnet)',
    description:
        'Sonnenhöhe, Azimut, Tag/Nacht und die extraterrestrische Einstrahlung für einen Ort — '
        + 'aus Ort und Zeit gerechnet statt abgerufen. Lückenlos, exakt und ohne Netz; das '
        + 'Verfahren steht als sosa:Procedure im Graphen.',

    configSchema: () => z.toJSONSchema(configSchema) as Record<string, unknown>,
    parseConfig: input => {
        const config = configSchema.parse(input);
        // Früh scheitern: Eine unmögliche Koordinate ergäbe eine Reihe, die
        // niemand deuten kann.
        solarSourceDescriptor(config);
        return config;
    },

    locatorFor: config => `${config.latitude}|${config.longitude}|${config.placeName}`,
    configFromLocator: locator => {
        const [latitude = '', longitude = '', ...rest] = locator.split('|');
        return configSchema.parse({ latitude, longitude, placeName: rest.join('|') });
    },

    async probe(config): Promise<SourceRef> {
        const descriptor = solarSourceDescriptor(config);
        // Kein Netz, keine Erreichbarkeitsfrage: Was diese Quelle liefern
        // kann, hängt allein am Ort und am Inventar. Genau daran hängt
        // deshalb die Revision.
        const fingerprint = [
            descriptor.place?.latitude ?? '',
            descriptor.place?.longitude ?? '',
            descriptor.place?.name ?? '',
            SOLAR_PROCEDURE_ID,
            ...SOLAR_SERIES.map(entry => `${entry.key}~${entry.name}~${entry.kind}~${entry.unit ?? ''}`),
        ].join('\n');
        return {
            id: '',
            kind: this.kind,
            locator: this.locatorFor(config),
            revision: `sha256:${await sha256Hex(fingerprint)}`,
            fetchedAt: new Date().toISOString(),
        };
    },

    async *pull(ref: SourceRef, ctx: ConnectorContext): AsyncIterable<Quad> {
        const descriptor = solarSourceDescriptor(this.configFromLocator(ref.locator));
        const { quads, counts } = sourceStructureQuads(
            ctx.iri,
            ref.id,
            descriptor,
            SOLAR_SERIES.map(entry => entry.key),
        );
        ctx.report({
            done: 1,
            total: 1,
            note: `${counts.series} gerechnete Reihen für ${descriptor.place?.name ?? 'den Standort'}. `
                + 'Die Werte entstehen bei der Erfassung unter Graph → Beobachtungen.',
        });
        yield* quads;
    },
};
