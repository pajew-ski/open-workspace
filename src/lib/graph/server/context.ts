/**
 * Anfrage-Kontext des Graphen (SPEC §17.3, M13).
 *
 * Jede Anfrage bekommt hier drei Dinge, immer zusammen und immer in
 * dieser Reihenfolge:
 *
 *   1. **Identität** — aus den Headern der laufenden Anfrage
 *      (`platform/auth/identity.ts`, `OW_AUTH_MODE`). Ohne Anfrage
 *      (Start, Migration, Skripte) ist es der Einzelnutzer.
 *   2. **Nutzer-skalierte IRI-Fabrik** — `graph/u/<userId>/…`. Damit
 *      schreibt und liest jede Feature-Datei automatisch im Graphen ihres
 *      Nutzers, ohne die Identität selbst zu kennen.
 *   3. **Grant** — das erlaubte Dataset aus `graph/acl`
 *      (`authz/resolve.ts`). Er wird an `resolveDataset`/`retrievalDataset`
 *      weitergereicht und kann dort nur wegnehmen.
 *
 * Warum `next/headers` statt eines Parameters: Der Lesepfad der App führt
 * über Server-Komponenten UND Route-Handler, und beide erreichen die
 * Header darüber. Ein durchgereichter Parameter hätte an fünfzig Stellen
 * vergessen werden können — hier ist Vergessen unmöglich, weil es keine
 * zweite Quelle gibt.
 *
 * **Neue Graphen**: `graph/acl` ist die einzige Quelle des Grants, und die
 * Standardregeln entstehen beim Start. Ein Import- oder Inferenz-Graph, der
 * danach angelegt wird, bekommt seine Regel deshalb hier — vor der
 * Grant-Berechnung, idempotent und ohne Schreibvorgang, wenn nichts neu ist.
 *
 * **Erstkontakt**: Meldet sich eine Identität zum ersten Mal an, entstehen
 * ihr Nutzerknoten in `graph/meta` und die Standard-ACL-Regeln für ihre
 * Graphen (§17.2: nur der Eigentümer, `control`). Das passiert genau
 * einmal pro Prozess und Nutzer, in der Mutations-Kette.
 */

import { headers } from 'next/headers';
import { createIriFactory, DEFAULT_USER_ID, type IriFactory } from '../iri';
import { resolveIdentity, type ResolvedIdentity } from '@/lib/platform/auth/identity';
import type { AccessGrant } from '../authz/grant';
import { ANONYMOUS_IDENTITY, grantForIdentity, type AuthzIdentity } from '../authz/resolve';
import { getServerGraph, ensureGraphAuthorizations, ensureUserBootstrap } from './instance';
import type { OxigraphStore } from '../store/oxigraph';

export interface RequestGraph {
    store: OxigraphStore;
    /** IRI-Fabrik des ANFRAGENDEN Nutzers. */
    iri: IriFactory;
    identity: ResolvedIdentity;
    grant: AccessGrant;
}

/**
 * Identität der laufenden Anfrage. Außerhalb eines Anfrage-Kontexts wirft
 * `headers()` — dort gibt es keine Identität, und der Einzelnutzer ist die
 * ehrliche Antwort (Start, `bun run migrate:graph`, Tests).
 */
export async function currentIdentity(): Promise<ResolvedIdentity> {
    try {
        return await resolveIdentity(await headers());
    } catch {
        return resolveIdentity();
    }
}

/**
 * Identität in der Form, die die Rechte-Auflösung erwartet.
 *
 * **Der wichtigste Satz dieser Datei**: Läuft die Installation mit einem
 * Anmeldeverfahren (`ha-ingress`, `proxy-header`, `oidc-bearer`) und
 * kommt eine Anfrage OHNE geprüfte Identität an, ist sie anonym — und
 * nicht etwa der Einzelnutzer. `resolveIdentity` liefert in diesem Fall
 * den Einzelnutzer als Platzhalter mit `authenticated: false`; wer das
 * ungefiltert in die Rechte-Auflösung gäbe, machte jeden fehlenden Header
 * zum Generalschlüssel. Nur in `single-user` IST der Einzelnutzer die
 * Identität — dort gibt es kein Anmeldeverfahren, das jemand umgehen
 * könnte.
 */
export function authzIdentity(identity: ResolvedIdentity): AuthzIdentity {
    if (identity.mode !== 'single-user' && !identity.authenticated) return ANONYMOUS_IDENTITY;
    return { userId: identity.userId, groups: identity.groups, authenticated: identity.authenticated };
}

/**
 * Store + nutzerskalierte IRI-Fabrik + Grant der laufenden Anfrage.
 * Der EINE Einstieg für alles, was im Namen eines Nutzers auf den Graphen
 * zugreift.
 */
export async function getRequestGraph(options: { sparql?: boolean } = {}): Promise<RequestGraph> {
    const { store, iri: instanceIri } = await getServerGraph();
    const identity = await currentIdentity();
    const authz = authzIdentity(identity);
    // Anonyme Anfragen bekommen die IRI-Fabrik des Einzelnutzers als
    // Namensraum-Anker, aber KEINE seiner Rechte (siehe authzIdentity).
    const userId = authz.userId || DEFAULT_USER_ID;
    const iri = userId === instanceIri.userId
        ? instanceIri
        : createIriFactory(instanceIri.instanceBase, userId);
    if (authz.userId) await ensureUserBootstrap(authz.userId, identity.displayName);
    // Graphen, die erst zur Laufzeit entstehen (Connector-Import,
    // Inferenz), bekommen ihre Standardregeln nachgezogen — sonst wäre
    // frisch Importiertes bis zum nächsten Neustart unsichtbar, weil der
    // Grant ausschließlich aus `graph/acl` kommt (§17.2/§17.3).
    await ensureGraphAuthorizations();
    const grant = await grantForIdentity({ store, iri }, authz, {
        // Die eingeloggte Oberfläche darf rohes SPARQL stellen — was sie
        // dabei sieht, klammert derselbe Grant. Ein Extra-Recht ist das
        // nicht, nur ein anderer Weg zu denselben Daten.
        sparql: options.sparql ?? true,
    });
    return { store, iri, identity, grant };
}

/** Kurzform für Lesepfade, die nur Store + Fabrik brauchen. */
export async function getUserGraph(): Promise<{ store: OxigraphStore; iri: IriFactory }> {
    const { store, iri } = await getRequestGraph();
    return { store, iri };
}
