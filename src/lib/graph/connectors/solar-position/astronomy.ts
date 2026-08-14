/**
 * Sonnenstand aus Ort und Zeit — rein, ohne Netz, ohne Store
 * (CAUSAL_LAYER_SPEC §10, entschieden am 2026-08-14:
 * docs/spec-widersprueche.md, Eintrag 4).
 *
 * **Warum das eine Beobachtung ist und keine Attrappe.** §10 nennt
 * Sonnenstand als Störgröße, aber es gibt dafür keine offene
 * Zeitreihen-API — und es braucht auch keine: Azimut und Elevation sind
 * eine Funktion von Ort und Zeit, exakt bestimmt, ohne Messfehler und
 * ohne Ausfall. Eine gerechnete Reihe ist damit **verlässlicher** als
 * eine gemessene, nicht schwächer. Sie muss nur als gerechnet erkennbar
 * bleiben — deshalb steht das Verfahren als `sosa:Procedure` im Graphen
 * (SOSA lässt ausdrücklich zu, dass ein Sensor ein Rechenverfahren ist).
 *
 * **Verfahren**: der Algorithmus niedriger Genauigkeit aus dem
 * Astronomical Almanac (NOAA-Fassung). Er gilt für 1950–2050 mit einem
 * Fehler unter 0,01° in Deklination und Rektaszension — mehrere
 * Größenordnungen genauer, als jede Frage dieses Layers braucht, und
 * ohne Tabellen oder Bibliothek.
 *
 * **Was bewusst fehlt**: Refraktion an der Atmosphäre (sie hebt die
 * scheinbare Sonne nahe dem Horizont um bis zu 0,6°) und die
 * Parallaxe. Beides ist für eine Störgröße im Kausalmodell ohne Belang,
 * und beides wäre eine Näherung mehr, die jemand für Genauigkeit halten
 * könnte. Ausgegeben wird die **geometrische** Position.
 */

const DEG = Math.PI / 180;

/** Solarkonstante (W/m²), mittlere extraterrestrische Bestrahlungsstärke. */
export const SOLAR_CONSTANT = 1361;

export interface SolarPosition {
    /** Höhe über dem Horizont in Grad; negativ heißt: unter dem Horizont. */
    elevation: number;
    /** Azimut in Grad, von Nord über Ost gezählt (0 = N, 90 = O, 180 = S). */
    azimuth: number;
    /** Deklination der Sonne in Grad. */
    declination: number;
    /**
     * Bestrahlungsstärke auf die Horizontale **außerhalb der Atmosphäre**
     * (W/m²), also rein geometrisch: Solarkonstante × Exzentrizitäts-
     * korrektur × sin(Höhe), unter dem Horizont 0. Kein Clear-Sky-Modell —
     * Bewölkung und Trübung kommen aus dem Wetter, nicht von hier.
     */
    extraterrestrialIrradiance: number;
}

function normalizeDegrees(value: number): number {
    const wrapped = value % 360;
    return wrapped < 0 ? wrapped + 360 : wrapped;
}

/** Julianisches Datum aus Millisekunden seit Epoch (UTC). */
export function julianDay(timestampMs: number): number {
    return timestampMs / 86_400_000 + 2_440_587.5;
}

/**
 * Sonnenstand für einen Zeitpunkt und einen Ort. Breitengrad positiv nach
 * Norden, Längengrad positiv nach Osten.
 */
export function solarPosition(timestampMs: number, latitude: number, longitude: number): SolarPosition {
    // Tage seit J2000.0 (2000-01-01 12:00 UT).
    const n = julianDay(timestampMs) - 2_451_545.0;

    // Mittlere Länge und mittlere Anomalie der Sonne.
    const meanLongitude = normalizeDegrees(280.460 + 0.9856474 * n);
    const meanAnomaly = normalizeDegrees(357.528 + 0.9856003 * n) * DEG;

    // Ekliptikale Länge: die Mittelpunktsgleichung bringt die Ellipsenbahn
    // hinein, ohne die es im Frühjahr und Herbst um Minuten danebenläge.
    const eclipticLongitude = (meanLongitude
        + 1.915 * Math.sin(meanAnomaly)
        + 0.020 * Math.sin(2 * meanAnomaly)) * DEG;
    const obliquity = (23.439 - 0.0000004 * n) * DEG;

    const rightAscension = Math.atan2(
        Math.cos(obliquity) * Math.sin(eclipticLongitude),
        Math.cos(eclipticLongitude),
    );
    const declination = Math.asin(Math.sin(obliquity) * Math.sin(eclipticLongitude));

    // Sternzeit in Greenwich, daraus die lokale Sternzeit und der
    // Stundenwinkel.
    const gmstHours = 18.697374558 + 24.06570982441908 * n;
    const localSiderealDeg = normalizeDegrees(gmstHours * 15 + longitude);
    let hourAngle = (localSiderealDeg - rightAscension / DEG) % 360;
    if (hourAngle > 180) hourAngle -= 360;
    if (hourAngle < -180) hourAngle += 360;
    const h = hourAngle * DEG;

    const lat = latitude * DEG;
    const sinElevation = Math.sin(lat) * Math.sin(declination)
        + Math.cos(lat) * Math.cos(declination) * Math.cos(h);
    const elevation = Math.asin(Math.max(-1, Math.min(1, sinElevation)));

    // Azimut von Nord über Ost. Die Form mit atan2 ist der klassischen
    // acos-Formel vorzuziehen: Sie ist über den ganzen Tag stetig und
    // braucht keine Fallunterscheidung am Mittag.
    const azimuth = normalizeDegrees(Math.atan2(
        -Math.sin(h),
        Math.tan(declination) * Math.cos(lat) - Math.sin(lat) * Math.cos(h),
    ) / DEG);

    // Exzentrizitätskorrektur: Die Erde ist im Januar sonnennäher, und das
    // macht rund 3,4 % in der Bestrahlungsstärke aus.
    const dayOfYear = (julianDay(timestampMs) - 2_451_544.5) % 365.25;
    const eccentricity = 1 + 0.033 * Math.cos(2 * Math.PI * dayOfYear / 365.25);

    return {
        elevation: elevation / DEG,
        azimuth,
        declination: declination / DEG,
        extraterrestrialIrradiance: sinElevation > 0
            ? SOLAR_CONSTANT * eccentricity * sinElevation
            : 0,
    };
}
