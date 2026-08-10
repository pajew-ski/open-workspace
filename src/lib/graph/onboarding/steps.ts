/**
 * Die Einführungsstrecke (GRAPH_CORE_SPEC §18, M14) — vier Schritte, die
 * den Graphen an sich selbst erklären.
 *
 * „Kein separates Tutorial-Format, sondern reale Aktionen im echten
 * Graphen mit Rückgängig-Möglichkeit" (§18): Jeder Schritt ist eine
 * Aktion, die das System auch sonst ausführt — abfragen, anlegen,
 * importieren, vergleichen. Es gibt keinen Übungsmodus und keine
 * Beispieldaten neben der Wahrheit.
 *
 * Diese Datei ist pur: Sie beschreibt die Strecke, führt sie aber nicht
 * aus (`run.ts`) und speichert nichts (`record.ts`).
 */

export const ONBOARDING_STEP_IDS = ['self-model', 'own-node', 'import', 'provenance'] as const;

export type OnboardingStepId = (typeof ONBOARDING_STEP_IDS)[number];

export interface OnboardingStepDefinition {
    id: OnboardingStepId;
    title: string;
    /** Was der Schritt erklärt — in du-Form, wie die ganze Oberfläche. */
    description: string;
    /** Was beim Ausführen wirklich passiert (keine Andeutung, Klartext). */
    effect: string;
    actionLabel: string;
    undoLabel: string;
}

export const ONBOARDING_STEPS: readonly OnboardingStepDefinition[] = [
    {
        id: 'self-model',
        title: 'Das System über sich selbst befragen',
        description:
            'Der Workspace beschreibt sich in seinem eigenen Graphen: Module, Entitätstypen, ' +
            'einbindbare Quellen und die Fähigkeiten dieser Laufzeitumgebung. Nichts davon ist ' +
            'im Code fest verdrahtet — es steht als RDF in graph/meta.',
        effect: 'Fragt graph/meta per SPARQL ab und hält den Blick als Aktivität im Graphen fest.',
        actionLabel: 'Selbstmodell abfragen',
        undoLabel: 'Schritt zurücknehmen',
    },
    {
        id: 'own-node',
        title: 'Einen eigenen Knoten anlegen',
        description:
            'Alles, was du anlegst, ist ein Knoten in deinem Workspace-Graphen — die Markdown-Datei ' +
            'unter data/docs ist nur seine Projektion. Dieser Schritt legt ein echtes Dokument an, ' +
            'kein Beispiel.',
        effect: 'Legt das Dokument „Mein erster Knoten" an (Store zuerst, Datei als Projektion).',
        actionLabel: 'Knoten anlegen',
        undoLabel: 'Knoten löschen',
    },
    {
        id: 'import',
        title: 'Eine externe Quelle importieren',
        description:
            'Externes Wissen kommt ausschließlich über Connectors und landet in einem eigenen ' +
            'Import-Graphen — nie vermischt mit deinem. prima-materia ist der Referenzfall: ein ' +
            'GitHub-Repo mit RDF-Dateien, commit-gepinnt.',
        effect: 'Legt einen github-rdf-Connector auf pajew-ski/prima-materia an und synchronisiert ihn einmal.',
        actionLabel: 'prima-materia importieren',
        undoLabel: 'Import entfernen',
    },
    {
        id: 'provenance',
        title: 'Nativ, importiert und inferiert unterscheiden',
        description:
            'Drei Herkünfte, drei Graphen: Was du selbst gesagt hast, was eine Quelle gesagt hat, ' +
            'und was der Reasoner daraus geschlossen hat. Inferiertes wird nie behauptet — es lebt ' +
            'in eigenen Graphen und entsteht bei jedem Start neu.',
        effect: 'Zählt die Aussagen je Herkunft in deinen Graphen und verlinkt in den Graph-Explorer.',
        actionLabel: 'Herkunft vergleichen',
        undoLabel: 'Schritt zurücknehmen',
    },
];

export function onboardingStep(id: string): OnboardingStepDefinition | null {
    return ONBOARDING_STEPS.find(step => step.id === id) ?? null;
}

/** Connector-Kennung und Quelle des Referenz-Imports (SPEC §16.2). */
export const PRIMA_MATERIA = {
    connectorId: 'prima-materia',
    name: 'prima-materia',
    repo: 'pajew-ski/prima-materia',
    path: 'ontology',
} as const;

/** Titel des Dokuments, das Schritt 2 anlegt. */
export const ONBOARDING_DOC_TITLE = 'Mein erster Knoten';
