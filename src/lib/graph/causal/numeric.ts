/**
 * Die Numerik des Tier-1-Kerns (CAUSAL_LAYER_SPEC §7, Meilenstein C4).
 *
 * Dieses Modul ist **pur** wie der übrige Tier-1-Kern: kein Store, kein
 * Netz, kein Dateisystem, keine Zufallsquelle aus der Umgebung. Es rechnet
 * mit Zahlen, sonst nichts — und läuft deshalb im Browser, im Server und
 * im Add-on gleich (Invariante C9).
 *
 * Drei Entscheidungen, die inhaltlich zählen:
 *
 * 1. **Zufall ist gesetzt, nie gezogen.** Jede Ziehung kommt aus einem
 *    Seed (`createRandom`). Der eingebaute Zufallsgenerator der Laufzeit
 *    würde eine Studie unreproduzierbar machen, und Reproduzierbarkeit
 *    ist keine Kür, sondern Invariante C7.
 * 2. **Konfidenz kommt aus dem Block-Bootstrap.** Beobachtungsreihen sind
 *    autokorreliert (§15.2): Der Wert um 8:05 weiß fast alles über den um
 *    8:00. Klassische Standardfehler wären deshalb zu klein — und ein zu
 *    schmales Intervall ist die gefährlichste Zahl von allen. Der Moving
 *    Block Bootstrap zieht **zusammenhängende Blöcke** und behält die
 *    Abhängigkeit innerhalb eines Blocks.
 * 3. **Kein Solver ohne Abbruch.** Jede Zerlegung, die singulär wird,
 *    gibt `null` zurück statt einer Zahl mit Rauschen darin. „Nicht
 *    schätzbar" ist ein Ergebnis (§7), eine erfundene Zahl nicht.
 */

/** Deterministische Zufallsquelle (mulberry32) — gleicher Seed, gleiche Folge. */
export function createRandom(seed: number): () => number {
    let state = (Math.trunc(seed) || 1) >>> 0;
    return () => {
        state = (state + 0x6d2b79f5) >>> 0;
        let t = state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/** Standardnormale Ziehung (Box-Muller) aus einer gesetzten Quelle. */
export function normalDraw(random: () => number): number {
    // Die untere Schranke hält den Logarithmus endlich; ohne sie käme bei
    // einer exakten 0 eine Unendlichkeit heraus.
    const u = Math.max(random(), Number.EPSILON);
    const v = random();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

export function mean(values: readonly number[]): number {
    if (values.length === 0) return Number.NaN;
    let sum = 0;
    for (const value of values) sum += value;
    return sum / values.length;
}

/** Stichprobenvarianz (n−1); bei weniger als zwei Werten `0`. */
export function variance(values: readonly number[]): number {
    if (values.length < 2) return 0;
    const m = mean(values);
    let sum = 0;
    for (const value of values) sum += (value - m) ** 2;
    return sum / (values.length - 1);
}

export function standardDeviation(values: readonly number[]): number {
    return Math.sqrt(variance(values));
}

/**
 * Empirisches Quantil (lineare Interpolation). Die Eingabe wird kopiert
 * und sortiert — der Aufrufer behält seine Reihenfolge, und die hängt bei
 * Zeitreihen an der Zeit.
 */
export function quantile(values: readonly number[], p: number): number {
    if (values.length === 0) return Number.NaN;
    const sorted = [...values].sort((a, b) => a - b);
    if (p <= 0) return sorted[0];
    if (p >= 1) return sorted[sorted.length - 1];
    const position = (sorted.length - 1) * p;
    const lower = Math.floor(position);
    const upper = Math.ceil(position);
    if (lower === upper) return sorted[lower];
    return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

/**
 * Löst `A x = b` (Gauß mit Spaltenpivotierung). `null`, wenn die Matrix
 * numerisch singulär ist — das ist der Normalfall bei kollinearen
 * Störgrößen und muss als solcher nach oben durchschlagen.
 */
export function solveLinearSystem(a: readonly (readonly number[])[], b: readonly number[]): number[] | null {
    const n = b.length;
    if (a.length !== n) return null;
    const matrix = a.map((row, index) => [...row, b[index]]);

    for (let column = 0; column < n; column += 1) {
        let pivot = column;
        for (let row = column + 1; row < n; row += 1) {
            if (Math.abs(matrix[row][column]) > Math.abs(matrix[pivot][column])) pivot = row;
        }
        if (!Number.isFinite(matrix[pivot][column]) || Math.abs(matrix[pivot][column]) < 1e-10) return null;
        [matrix[column], matrix[pivot]] = [matrix[pivot], matrix[column]];
        const diagonal = matrix[column][column];
        for (let row = column + 1; row < n; row += 1) {
            const factor = matrix[row][column] / diagonal;
            if (factor === 0) continue;
            for (let k = column; k <= n; k += 1) matrix[row][k] -= factor * matrix[column][k];
        }
    }

    const solution = new Array<number>(n).fill(0);
    for (let row = n - 1; row >= 0; row -= 1) {
        let sum = matrix[row][n];
        for (let column = row + 1; column < n; column += 1) sum -= matrix[row][column] * solution[column];
        solution[row] = sum / matrix[row][row];
        if (!Number.isFinite(solution[row])) return null;
    }
    return solution;
}

export interface OlsResult {
    /** Koeffizienten in Spaltenreihenfolge von `design`. */
    coefficients: number[];
    residuals: number[];
    /** Residuenquadratsumme. */
    rss: number;
}

/**
 * Kleinste Quadrate über die Normalgleichungen. Für die Spaltenzahl
 * dieses Layers (eine Behandlung plus eine Handvoll Störgrößen) ist das
 * genau genug und braucht keine QR-Zerlegung; die Alternative wäre eine
 * Abhängigkeit, die in allen drei Runtimes laufen müsste.
 */
export function ols(design: readonly (readonly number[])[], y: readonly number[]): OlsResult | null {
    const n = design.length;
    if (n === 0 || y.length !== n) return null;
    const p = design[0].length;
    if (p === 0 || n <= p) return null;

    const xtx: number[][] = Array.from({ length: p }, () => new Array<number>(p).fill(0));
    const xty = new Array<number>(p).fill(0);
    for (let row = 0; row < n; row += 1) {
        const values = design[row];
        if (values.length !== p) return null;
        for (let i = 0; i < p; i += 1) {
            xty[i] += values[i] * y[row];
            for (let j = i; j < p; j += 1) xtx[i][j] += values[i] * values[j];
        }
    }
    for (let i = 0; i < p; i += 1) {
        for (let j = 0; j < i; j += 1) xtx[i][j] = xtx[j][i];
    }

    const coefficients = solveLinearSystem(xtx, xty);
    if (!coefficients) return null;

    const residuals = new Array<number>(n).fill(0);
    let rss = 0;
    for (let row = 0; row < n; row += 1) {
        let fitted = 0;
        for (let i = 0; i < p; i += 1) fitted += design[row][i] * coefficients[i];
        residuals[row] = y[row] - fitted;
        rss += residuals[row] ** 2;
    }
    return { coefficients, residuals, rss };
}

/**
 * Logistische Regression (IRLS) für die Propensity in der IPW-Schätzung.
 * Der kleine Ridge-Term auf der Diagonalen ist kein Modellierungstrick,
 * sondern die Bremse gegen perfekte Trennung: Ohne ihn laufen die
 * Koeffizienten ins Unendliche, sobald eine Störgröße die Behandlung
 * exakt vorhersagt — und genau das ist der Fall ohne Overlap, der
 * ohnehin als Positivitätsverletzung gemeldet wird (§15.3).
 */
export function logisticFit(
    design: readonly (readonly number[])[],
    y: readonly number[],
    options: { maxIterations?: number; tolerance?: number; ridge?: number } = {},
): number[] | null {
    const n = design.length;
    if (n === 0 || y.length !== n) return null;
    const p = design[0].length;
    if (p === 0) return null;
    const maxIterations = options.maxIterations ?? 40;
    const tolerance = options.tolerance ?? 1e-8;
    const ridge = options.ridge ?? 1e-6;

    let beta = new Array<number>(p).fill(0);
    for (let iteration = 0; iteration < maxIterations; iteration += 1) {
        const xtwx: number[][] = Array.from({ length: p }, () => new Array<number>(p).fill(0));
        const xtwz = new Array<number>(p).fill(0);
        for (let row = 0; row < n; row += 1) {
            const values = design[row];
            let eta = 0;
            for (let i = 0; i < p; i += 1) eta += values[i] * beta[i];
            const mu = 1 / (1 + Math.exp(-eta));
            const weight = Math.max(mu * (1 - mu), 1e-6);
            const working = eta + (y[row] - mu) / weight;
            for (let i = 0; i < p; i += 1) {
                xtwz[i] += weight * values[i] * working;
                for (let j = i; j < p; j += 1) xtwx[i][j] += weight * values[i] * values[j];
            }
        }
        for (let i = 0; i < p; i += 1) {
            xtwx[i][i] += ridge;
            for (let j = 0; j < i; j += 1) xtwx[i][j] = xtwx[j][i];
        }
        const next = solveLinearSystem(xtwx, xtwz);
        if (!next) return null;
        let shift = 0;
        for (let i = 0; i < p; i += 1) shift = Math.max(shift, Math.abs(next[i] - beta[i]));
        beta = next;
        if (shift < tolerance) break;
    }
    return beta.every(Number.isFinite) ? beta : null;
}

export function logistic(values: readonly number[], beta: readonly number[]): number {
    let eta = 0;
    for (let i = 0; i < beta.length; i += 1) eta += values[i] * beta[i];
    return 1 / (1 + Math.exp(-eta));
}

/**
 * Blocklänge für den Moving Block Bootstrap: `n^(1/3)`, aufgerundet und
 * bei 2 beginnend. Die Faustregel der Literatur für schwach abhängige
 * Reihen; sie ist keine Feinjustierung, sondern eine Voreinstellung, die
 * dokumentiert und über die Studien-Signatur (C7) nachvollziehbar ist.
 */
export function defaultBlockLength(n: number): number {
    return Math.max(2, Math.min(n, Math.ceil(Math.cbrt(Math.max(n, 1)))));
}

/**
 * Eine Bootstrap-Ziehung: zusammenhängende Blöcke, bis `n` Zeilen
 * beisammen sind. Zurückgegeben werden Zeilenindizes — der Aufrufer
 * entscheidet, was er damit rechnet.
 */
export function movingBlockSample(n: number, blockLength: number, random: () => number): number[] {
    if (n <= 0) return [];
    const length = Math.max(1, Math.min(blockLength, n));
    const sample: number[] = [];
    while (sample.length < n) {
        const start = Math.floor(random() * (n - length + 1));
        for (let offset = 0; offset < length && sample.length < n; offset += 1) {
            sample.push(start + offset);
        }
    }
    return sample;
}

export interface BootstrapResult {
    /** Standardfehler = Streuung der Bootstrap-Verteilung. */
    standardError: number;
    ciLow: number;
    ciHigh: number;
    /** Wie viele Ziehungen ein Ergebnis geliefert haben. */
    samples: number;
}

/**
 * Konfidenzintervall über den Moving Block Bootstrap (Perzentil-Methode).
 * Ziehungen, die kein Ergebnis liefern (singuläre Auslegung, keine
 * Varianz in der Behandlung), werden **verworfen und gezählt**, nicht
 * durch Null ersetzt — eine Null wäre eine Aussage, die niemand gemacht
 * hat.
 */
export function blockBootstrap(
    rows: number,
    estimate: (sample: readonly number[]) => number | null,
    options: { seed: number; samples?: number; blockLength?: number; level?: number },
): BootstrapResult | null {
    const draws = options.samples ?? 200;
    const blockLength = options.blockLength ?? defaultBlockLength(rows);
    const level = options.level ?? 0.95;
    const random = createRandom(options.seed);
    const values: number[] = [];
    for (let draw = 0; draw < draws; draw += 1) {
        const sample = movingBlockSample(rows, blockLength, random);
        const value = estimate(sample);
        if (value !== null && Number.isFinite(value)) values.push(value);
    }
    // Unter einem Viertel verwertbarer Ziehungen ist die Verteilung keine
    // Verteilung mehr, sondern ein Zufallsfund.
    if (values.length < Math.max(20, draws / 4)) return null;
    const alpha = (1 - level) / 2;
    return {
        standardError: standardDeviation(values),
        ciLow: quantile(values, alpha),
        ciHigh: quantile(values, 1 - alpha),
        samples: values.length,
    };
}

/** Fehlerfunktion, Näherung nach Abramowitz-Stegun 7.1.26. */
function erf(x: number): number {
    const sign = x < 0 ? -1 : 1;
    const z = Math.abs(x);
    const t = 1 / (1 + 0.3275911 * z);
    const series = ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t
        + 0.254829592) * t;
    return sign * (1 - series * Math.exp(-z * z));
}

/** Verteilungsfunktion der Standardnormalen. */
export function normalCdf(x: number): number {
    return 0.5 * (1 + erf(x / Math.SQRT2));
}

/**
 * Partielle Korrelation von `x` und `y` gegeben `z` — über die Residuen
 * zweier Regressionen. `null`, wenn eine der Regressionen singulär ist
 * oder ein Residuum keine Varianz mehr hat.
 */
export function partialCorrelation(
    x: readonly number[],
    y: readonly number[],
    z: readonly (readonly number[])[],
): number | null {
    const n = x.length;
    if (n < 3 || y.length !== n) return null;
    const design = Array.from({ length: n }, (_, row) => [1, ...z.map(column => column[row])]);
    const fitX = ols(design, x);
    const fitY = ols(design, y);
    if (!fitX || !fitY) return null;
    return correlation(fitX.residuals, fitY.residuals);
}

export function correlation(a: readonly number[], b: readonly number[]): number | null {
    if (a.length !== b.length || a.length < 2) return null;
    const meanA = mean(a);
    const meanB = mean(b);
    let covariance = 0;
    let varianceA = 0;
    let varianceB = 0;
    for (let index = 0; index < a.length; index += 1) {
        const da = a[index] - meanA;
        const db = b[index] - meanB;
        covariance += da * db;
        varianceA += da * da;
        varianceB += db * db;
    }
    if (varianceA <= 1e-12 || varianceB <= 1e-12) return null;
    return covariance / Math.sqrt(varianceA * varianceB);
}

/**
 * Fishers z-Test auf „partielle Korrelation ist null" — der Test hinter
 * der Modell-Refutation (§13.2). Gibt den p-Wert zurück; je kleiner, desto
 * deutlicher widerspricht die Datenlage der vom DAG behaupteten
 * Unabhängigkeit.
 */
export function fisherZTest(r: number, n: number, conditioning: number): number | null {
    const degreesOfFreedom = n - conditioning - 3;
    if (degreesOfFreedom <= 0) return null;
    const bounded = Math.max(-0.999999, Math.min(0.999999, r));
    const z = 0.5 * Math.log((1 + bounded) / (1 - bounded)) * Math.sqrt(degreesOfFreedom);
    return 2 * (1 - normalCdf(Math.abs(z)));
}
