/**
 * Minimale Typdeklaration für rdf-canonize (liefert keine eigenen Typen).
 * Wir nutzen ausschließlich den N-Quads-String-Eingang und -Ausgang.
 */
declare module 'rdf-canonize' {
    export interface CanonizeOptions {
        algorithm: 'RDFC-1.0';
        inputFormat?: 'application/n-quads';
        format?: 'application/n-quads';
        /** Begrenzung der N-Degree-Iterationen gegen Poison-Graphen. */
        maxWorkFactor?: number;
        signal?: AbortSignal;
        /** Wird mit dem Blank-Node-Mapping befüllt, falls übergeben. */
        canonicalIdMap?: Map<string, string>;
    }
    export function canonize(input: string, options: CanonizeOptions): Promise<string>;
}
