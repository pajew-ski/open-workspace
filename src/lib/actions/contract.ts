/**
 * Der Aktionsvertrag (ACTIONS_SPEC, docs/specs/actions.md).
 *
 * Eine **Aktion** ist die einzige Definition einer Fähigkeit des
 * Workspace. Alles, was eine Fähigkeit nach außen trägt — die
 * HTTP-Route, die Tool-Definition für das Sprachmodell, das Werkzeug des
 * MCP-Servers, der Tool-Knoten im Selbstmodell — wird aus dieser einen
 * Definition ABGELEITET, nie daneben geschrieben.
 *
 * Was hier steht, ist bewusst frei von Laufzeit-Weichen (Invariante 7):
 * Der Unterschied zwischen Server und Browser liegt in den Adaptern
 * (`route.ts`, `tools.ts`, `browser.ts`), nicht im Vertrag. Und er ist
 * frei von einer eigenen Rechteprüfung (§17): Ob eine Aktion für einen
 * Aufrufer erreichbar ist, entscheidet `authorize.ts` aus dem Grant, den
 * `graph/acl` hergibt — kein zweites Rechtesystem neben WAC.
 */

import type { z } from 'zod';
import type { AccessGrant } from '@/lib/graph/authz/grant';
import type { GraphHandle, RetrievalDeps } from '@/lib/graph/search/retrieval';
import type { WorkspaceContext } from '@/lib/graph/workspace/crud';
import type { FileSystemLike, RuntimeAdapter } from '@/lib/platform/runtime/types';
import type { ActivityType } from '@/lib/activity';

/**
 * Effektklasse — Teil des Vertrags, nicht Konvention. Sie entscheidet
 * über die Sichtbarkeit je Oberfläche (ACTIONS_SPEC §3):
 *
 *  - `read`: liest, verändert nichts.
 *  - `constructive`: legt an oder ändert. Braucht keine Bestätigung
 *    (AGENTS.md, Safety-Regeln).
 *  - `destructive`: löscht oder überschreibt unwiederbringlich. Erscheint
 *    auf KEINER Agenten-Oberfläche; die Oberfläche ruft sie erst nach dem
 *    Bestätigungsdialog auf.
 */
export type ActionEffect = 'read' | 'constructive' | 'destructive';

export const ACTION_EFFECTS: readonly ActionEffect[] = ['read', 'constructive', 'destructive'];

/** Tool-Name der Provider (OpenAI, Anthropic, MCP): stabil, englisch. */
export const ACTION_NAME_PATTERN = /^[a-z0-9_]{1,64}$/;

/**
 * Wie der Named Graph bestimmt wird, auf dem die Aktion liest oder
 * schreibt. Eine Aktion ohne bestimmbares Ziel ist ein Vertragsfehler —
 * denn nur aus dem Ziel lässt sich die Erlaubnis aus dem Grant ableiten.
 *
 *  - `dataset`: liest über das erlaubte Dataset des Aufrufers
 *    (`grant.readableGraphs`); die Klammer sitzt im Dataset-Resolver.
 *  - `graph`: ein bestimmter Named Graph, als Scope-Schlüssel (§3.3:
 *    `workspace`, `public`, `presentation`, `causal-hypotheses`,
 *    `causal/<id>`, `shared/<id>`, `import/<id>`, `inferred/<scope>`,
 *    `meta`) oder — wenn er von der Eingabe abhängt — als Funktion, die
 *    aus der Eingabe eine absolute Graph-IRI oder einen Schlüssel macht.
 *    `mode` sagt, welches Recht die Aktion dort braucht; ohne Angabe
 *    folgt es der Effektklasse (read → `read`, constructive → `append`
 *    oder `write`, destructive → `write`).
 *  - `grant-write`: der vom Zugang freigegebene Schreibgraph
 *    (`grant.writableGraph`, Muster des MCP-Tokens).
 *  - `sparql`: das erlaubte Dataset per rohem SPARQL — nur mit
 *    `grant.sparql`.
 *  - `surface`: die Oberfläche des Aufrufers (Chat-Widget). Ohne
 *    Oberfläche im Kontext gibt es die Aktion nicht (Invariante 10).
 *  - `instance`: instanzweite Konfiguration außerhalb des Graphen
 *    (AGENTS.md, „Noch keine Graph-Bürger"). Lesen verlangt Leserecht auf
 *    `graph/meta`, Ändern `control` darauf — dieselbe Schwelle wie für
 *    jede andere instanzweite Aussage (Gruppen, SPEC §17.1).
 */
export type ActionTarget =
    | { kind: 'dataset' }
    | {
        kind: 'graph';
        scope: string | ((input: unknown, ctx: ActionContext) => string | null | Promise<string | null>);
        mode?: 'read' | 'append' | 'write' | 'control';
    }
    | { kind: 'grant-write' }
    | { kind: 'sparql' }
    | { kind: 'surface' }
    | { kind: 'instance' };

/**
 * Was eine Aktion aus ihrem Kontext braucht, um überhaupt zu laufen. Ein
 * Kontext, dem etwas fehlt, macht die Aktion dort UNSICHTBAR statt
 * scheiternd (Invariante 10): Der MCP-Server hat keine Oberfläche, ein
 * Test-Kontext hat keinen Dateibaum.
 */
export type ActionDependency = 'workspace' | 'platform' | 'surface';

/** Wer ruft — für PROV, Aktivitätslog und Eigentümer-Fragen. */
export interface ActionIdentity {
    /** Nutzer-ID; leer bei anonymen Aufrufen. */
    userId: string;
    authenticated: boolean;
    /** Anzeigename, wenn die Identität einen mitbringt. */
    displayName?: string;
    /** Bezeichnung in PROV/Logs (Token-ID statt Nutzer-ID beim MCP-Zugang). */
    label: string;
}

/**
 * Was die Oberfläche des Aufrufers über sich sagt (A3). Getter statt
 * Werte: Im Browser-Loop liest `view_screen` damit den JETZIGEN Zustand,
 * nicht den vom Anfang des Turns.
 */
export interface ActionSurface {
    pathname(): string;
    viewState(): Record<string, unknown>;
    module(): { label: string; description: string } | null;
    activeSurface(): Array<Record<string, unknown>>;
}

/** Nachbereitung von Schreibvorgängen — vom Server bereitgestellt, in Tests weglassbar. */
export interface ActionPersistence {
    /** Snapshot nach `data/graph/` (SPEC §8.1). */
    snapshot(): Promise<void>;
    /** `graph/acl` neben den Snapshot (M13). */
    acl(): Promise<void>;
    /** Inferenz-Lauf nach einer Mutation, die einen Inferenz-Stand veralten lässt. */
    reasoning(): Promise<void>;
    /** Datei-Projektionen neu aus dem Store (nach Restore). */
    reproject(): Promise<void>;
    /** AI-Spiegel in `graph/meta` erneuern (M9). */
    aiMirror(context: string): Promise<void>;
}

/**
 * Der Kontext, in dem eine Aktion läuft: Identität und Grant des
 * Aufrufers plus die Bausteine, die der jeweilige Adapter bereitstellen
 * kann. Ausgeführt wird IM PROZESS — nie über einen HTTP-Aufruf an die
 * eigene Route, denn ein Selbstaufruf verlöre die Identität
 * (docs/specs/agent-tools.md).
 */
export interface ActionContext {
    identity: ActionIdentity;
    grant: AccessGrant;
    /** Store + nutzerskalierte IRI-Fabrik des Aufrufers. */
    graph: GraphHandle;
    /** Store-first-CRUD des Aufrufers (Aufgaben, Dokumente, Pinnwände, …). */
    workspace?: () => Promise<WorkspaceContext>;
    /** Seed-Quellen des Retrievals über ein Dataset (Index-Cache des Servers). */
    retrieval?: (dataset: readonly string[]) => Promise<RetrievalDeps>;
    /** Dateibaum und Runtime-Adapter (Connector-Läufe, Beobachtungen). */
    platform?: { files: FileSystemLike; runtime: RuntimeAdapter };
    persist?: ActionPersistence;
    /** Aktivitätslog der Installation (Dashboard). */
    activity?: (type: ActivityType, entityId: string, title: string) => Promise<void>;
    surface?: ActionSurface;
    /** Origin der laufenden Anfrage (für absolute URLs in Antworten). */
    origin?: string;
    /** Uhr (Tests: deterministisch). */
    now?: () => Date;
}

/**
 * Was der Aufrufer neben dem Ergebnis erfährt: Änderungsereignisse für die
 * Invalidierung (A3) und Navigationsabsichten, die das Widget ausführt.
 */
export type ActionSignal =
    | { type: 'changes'; entityTypes: readonly string[] }
    | { type: 'navigate'; pathname: string; search?: string };

export interface ActionDefinition<Input extends z.ZodType, Output> {
    /** Stabil, englisch, `^[a-z0-9_]{1,64}$`. Bestehende Tool-Namen bleiben. */
    name: string;
    /** Agentenwirksam, deutsch wie die bestehenden Tool-Beschreibungen. */
    description: string;
    /** Kurzer Titel für Oberflächen (MCP `title`). */
    title?: string;
    /** Zod-Schema. Das JSON-Schema für Function Calling und MCP wird daraus erzeugt. */
    input: Input;
    effect: ActionEffect;
    target: ActionTarget;
    requires?: readonly ActionDependency[];
    /**
     * Entitätstypen (IRIs), die eine Aktion verändert — Grundlage der
     * Invalidierung (A3). Pflicht für `constructive` und `destructive`.
     */
    changes?: readonly string[];
    run(input: z.output<Input>, ctx: ActionContext): Promise<Output>;
    /** Zusätzliche Signale aus dem Ergebnis (z. B. eine Navigationsabsicht). */
    signals?(output: Output, input: z.output<Input>): ActionSignal[];
}

/**
 * Eine registrierte Aktion — die Eingabe-Typen sind nach außen gelöscht.
 * `run` ist als Methode deklariert, damit eine konkret typisierte
 * Definition hier hineinpasst (Bivarianz der Methodenparameter).
 */
export type Action = ActionDefinition<z.ZodType, unknown>;

/**
 * Vertragsfehler beim Definieren: Name, Effekt oder Ziel stimmen nicht.
 * Wird beim Laden des Moduls geworfen — eine kaputte Aktion soll den
 * Start kosten, nicht den ersten Aufruf.
 */
export class ActionContractError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'ActionContractError';
    }
}

/**
 * Fehler mit HTTP-Bedeutung, den eine Aktion selbst wirft: 404 für ein
 * fehlendes Ziel, 409 für einen Konflikt, 422 für eine abgelehnte
 * Eingabe. Der Route-Adapter bildet ihn auf den Status ab, der
 * Tool-Adapter gibt den Text an das Modell zurück.
 */
export class ActionError extends Error {
    constructor(readonly status: number, message: string, readonly details?: unknown) {
        super(message);
        this.name = 'ActionError';
    }
}

export function notFound(message: string): ActionError {
    return new ActionError(404, message);
}

/** Der Grant reicht für das Ziel nicht (aus `authorize.ts`). */
export class ActionDeniedError extends ActionError {
    constructor(message: string, details?: unknown) {
        super(403, message, details);
        this.name = 'ActionDeniedError';
    }
}

/** Dem Kontext fehlt, was die Aktion braucht — sie hätte nicht gelistet werden dürfen. */
export class ActionUnavailableError extends ActionError {
    constructor(name: string, missing: string) {
        super(501, `Die Aktion "${name}" ist in dieser Umgebung nicht verfügbar (fehlt: ${missing}).`);
        this.name = 'ActionUnavailableError';
    }
}

/**
 * Prüft den Vertrag beim Definieren. Gibt die Definition unverändert
 * zurück — der Wert liegt in der Typisierung und im frühen Scheitern.
 */
export function defineAction<Input extends z.ZodType, Output>(
    definition: ActionDefinition<Input, Output>,
): ActionDefinition<Input, Output> {
    if (!ACTION_NAME_PATTERN.test(definition.name)) {
        throw new ActionContractError(
            `Aktionsname "${definition.name}" verletzt ${ACTION_NAME_PATTERN} (ACTIONS_SPEC §2).`,
        );
    }
    if (!ACTION_EFFECTS.includes(definition.effect)) {
        throw new ActionContractError(`Aktion "${definition.name}" hat keine gültige Effektklasse.`);
    }
    if (definition.description.trim() === '') {
        throw new ActionContractError(`Aktion "${definition.name}" hat keine Beschreibung.`);
    }
    if (!definition.target || typeof definition.target !== 'object' || !('kind' in definition.target)) {
        throw new ActionContractError(`Aktion "${definition.name}" hat kein bestimmbares Ziel (ACTIONS_SPEC §2).`);
    }
    if (definition.effect !== 'read' && (!definition.changes || definition.changes.length === 0)) {
        throw new ActionContractError(
            `Aktion "${definition.name}" ist ${definition.effect}, nennt aber keine Entitätstypen unter "changes" (A3).`,
        );
    }
    if (definition.target.kind === 'surface' && !(definition.requires ?? []).includes('surface')) {
        throw new ActionContractError(`Aktion "${definition.name}" zielt auf die Oberfläche, verlangt sie aber nicht.`);
    }
    return definition;
}
