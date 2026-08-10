/**
 * ACL-Modell nach Web Access Control (SPEC §17.2, M13).
 *
 * Dieses Modul ist **pur**: keine Store-Bindung, keine Umgebung, kein
 * Netz. Es kennt nur Regeln (`AclAuthorization`), einen Prinzipal und
 * einen Graph-IRI — und beantwortet daraus, welche Modi gelten. Genau
 * dadurch ist die Rechte-Entscheidung einzeln testbar und hat keine
 * Nebenwege.
 *
 * Modell (SPEC §17.2, WAC-Vokabular, kein eigenes JSON-Format):
 *
 *     <auth> a acl:Authorization ;
 *            acl:accessTo   <…/graph/u/alice/workspace> ;
 *            acl:agent      <…/user/bob> ;
 *            acl:agentGroup <…/group/team> ;
 *            acl:agentClass acl:AuthenticatedAgent ;   # oder foaf:Agent
 *            acl:mode       acl:Read, acl:Append .
 *
 * Granularität ist **pro Named Graph** (§17.2) — `acl:accessTo` zeigt auf
 * die Graph-IRI, nicht auf einzelne Tripel. Wer feiner unterscheiden will,
 * schneidet den Graphen feiner.
 *
 * **Implikation der Modi** (hier festgelegt, weil WAC sie offenlässt):
 *
 *   control → read, write, append   Wer die Regeln eines Graphen ändern
 *                                   darf, kann sich jedes Recht ohnehin
 *                                   selbst geben; alles andere wäre eine
 *                                   Scheingrenze.
 *   write   → append, read          Ändern setzt Sehen voraus; „ändern
 *                                   ohne lesen" ist kein sinnvoller Fall.
 *   append  → (nichts)              Genau der Fall aus §17.2: beitragen,
 *                                   ohne den Bestand zu sehen oder zu
 *                                   löschen (Briefkasten-Semantik).
 *
 * **Nichts ist per Default sichtbar** (§17.2): ohne passende Regel sind
 * die Modi leer. Es gibt keinen impliziten Eigentümer-Bonus im Code — die
 * Eigentümer-Regel steht als Tripel in `graph/acl` (siehe `acl-graph.ts`),
 * damit Rechte prüfbar sind statt hartkodiert.
 */

import { ACL, FOAF } from '../vocab';

export const ACL_MODES = ['read', 'append', 'write', 'control'] as const;
export type AclMode = (typeof ACL_MODES)[number];

/** Modus-IRI (WAC) → interner Schlüssel. Unbekannte Modi zählen nicht. */
const MODE_BY_IRI: Record<string, AclMode> = {
    [ACL.Read]: 'read',
    [ACL.Append]: 'append',
    [ACL.Write]: 'write',
    [ACL.Control]: 'control',
};

const IRI_BY_MODE: Record<AclMode, string> = {
    read: ACL.Read,
    append: ACL.Append,
    write: ACL.Write,
    control: ACL.Control,
};

export function aclModeFromIri(iri: string): AclMode | null {
    return MODE_BY_IRI[iri] ?? null;
}

export function aclModeIri(mode: AclMode): string {
    return IRI_BY_MODE[mode];
}

export function isAclMode(value: string): value is AclMode {
    return (ACL_MODES as readonly string[]).includes(value);
}

/** Was ein Modus mit einschließt (siehe Modulkommentar). */
const IMPLIES: Record<AclMode, readonly AclMode[]> = {
    control: ['control', 'read', 'append', 'write'],
    write: ['write', 'read', 'append'],
    append: ['append'],
    read: ['read'],
};

/** Hülle der Modi unter der Implikation — die tatsächlich geltenden Rechte. */
export function expandModes(modes: Iterable<AclMode>): Set<AclMode> {
    const out = new Set<AclMode>();
    for (const mode of modes) {
        for (const implied of IMPLIES[mode]) out.add(implied);
    }
    return out;
}

/** Eine Regel aus `graph/acl`, bereits von RDF auf Werte abgebildet. */
export interface AclAuthorization {
    iri: string;
    /** Graph-IRIs, für die die Regel gilt. */
    accessTo: readonly string[];
    /** Konkrete Agenten (Nutzer-IRIs). */
    agents: readonly string[];
    /** Gruppen-IRIs (`foaf:Group`). */
    agentGroups: readonly string[];
    /** `foaf:Agent` (anonym erlaubt) bzw. `acl:AuthenticatedAgent`. */
    agentClasses: readonly string[];
    modes: readonly AclMode[];
}

/**
 * Der Anfragende, wie ihn die Rechte-Entscheidung sieht. `agent` ist die
 * Nutzer-IRI (nicht die Nutzer-ID): Regeln zeigen auf Knoten, nicht auf
 * Strings.
 */
export interface AclPrincipal {
    agent: string | null;
    groups: readonly string[];
    /** true, wenn die Identität aus einer geprüften Quelle stammt (§17.2). */
    authenticated: boolean;
}

/** Anonymer Zugriff — der Default, solange keine Identität feststeht. */
export const ANONYMOUS: AclPrincipal = { agent: null, groups: [], authenticated: false };

function matchesPrincipal(auth: AclAuthorization, principal: AclPrincipal): boolean {
    // `foaf:Agent` ist die Klasse ALLER Agenten — auch anonymer.
    if (auth.agentClasses.includes(FOAF.Agent)) return true;
    if (principal.authenticated && auth.agentClasses.includes(ACL.AuthenticatedAgent)) return true;
    if (principal.agent !== null && auth.agents.includes(principal.agent)) return true;
    return auth.agentGroups.some(group => principal.groups.includes(group));
}

/**
 * Alle Modi, die `principal` auf `graph` hat. Leer heißt: kein Zugriff —
 * und zwar ohne Unterschied zu „Graph existiert nicht" (§17.3).
 */
export function modesFor(
    authorizations: readonly AclAuthorization[],
    principal: AclPrincipal,
    graph: string,
): Set<AclMode> {
    const granted: AclMode[] = [];
    for (const auth of authorizations) {
        if (!auth.accessTo.includes(graph)) continue;
        if (!matchesPrincipal(auth, principal)) continue;
        granted.push(...auth.modes);
    }
    return expandModes(granted);
}

/** Kurzform für die häufigste Frage. */
export function hasMode(
    authorizations: readonly AclAuthorization[],
    principal: AclPrincipal,
    graph: string,
    mode: AclMode,
): boolean {
    return modesFor(authorizations, principal, graph).has(mode);
}

/**
 * Modi je Graph über eine Graph-Menge. Ein Aufruf statt N — die
 * Dataset-Auflösung fragt genau einmal und filtert danach.
 */
export function modesByGraph(
    authorizations: readonly AclAuthorization[],
    principal: AclPrincipal,
    graphs: readonly string[],
): Map<string, Set<AclMode>> {
    const out = new Map<string, Set<AclMode>>();
    for (const graph of graphs) {
        const modes = modesFor(authorizations, principal, graph);
        if (modes.size > 0) out.set(graph, modes);
    }
    return out;
}

// --- Rollen (SPEC §17.1: „Mitgliedschaftsrollen") -------------------------

/**
 * Rollen sind benannte Modus-Bündel, keine zweite Rechte-Welt: Die
 * Mitgliederliste eines Raums IST die Menge der ACL-Regeln auf seinem
 * Graphen. Eine Rolle ist nur die menschenlesbare Verpackung davon.
 */
export const SPACE_ROLES = ['reader', 'contributor', 'editor', 'owner'] as const;
export type SpaceRole = (typeof SPACE_ROLES)[number];

export const ROLE_MODES: Record<SpaceRole, readonly AclMode[]> = {
    reader: ['read'],
    contributor: ['read', 'append'],
    editor: ['write'],
    owner: ['control'],
};

export const ROLE_LABELS: Record<SpaceRole, string> = {
    reader: 'Lesen',
    contributor: 'Beitragen (anhängen, nichts löschen)',
    editor: 'Bearbeiten',
    owner: 'Verwalten (inkl. Freigaben)',
};

export function isSpaceRole(value: string): value is SpaceRole {
    return (SPACE_ROLES as readonly string[]).includes(value);
}

/**
 * Größte Rolle, die von den vorhandenen Modi vollständig gedeckt ist —
 * für die Anzeige. Deckt keine Rolle, ist es `null` (die Modi selbst
 * bleiben die Wahrheit).
 */
export function roleFromModes(modes: Iterable<AclMode>): SpaceRole | null {
    const held = expandModes(modes);
    for (const role of [...SPACE_ROLES].reverse()) {
        if (ROLE_MODES[role].every(mode => held.has(mode))) return role;
    }
    return null;
}
