/**
 * Modul-Registry der Anwendung (GRAPH_CORE_SPEC §18, M14).
 *
 * Diese Liste ist die EINE Code-Quelle dafür, welche Module und Seiten
 * diese Installation hat. Aus ihr entstehen:
 *
 *  1. die Hauptnavigation (`components/layout/Sidebar.tsx` — Icons bleiben
 *     dort, weil sie Darstellung sind, nicht Wissen),
 *  2. das Selbstmodell in `graph/meta` (`graph/meta/self-model.ts`), aus
 *     dem der Assistent seinen Systemkontext per SPARQL bezieht.
 *
 * Damit ist die frühere handgepflegte `MODULE_CONTEXT`-Liste im
 * Assistenten (und ihre Kopie im CopilotKit-Provider) verschwunden: Ein
 * Modul registriert sich hier einmal und ist danach in Navigation,
 * Selbstmodell und Assistenten-Kontext bekannt (§18). Dass keine Seite
 * fehlt, erzwingt ein Test (`tests/graph/self-model.test.ts`): jede
 * `src/app/**\/page.tsx` ohne dynamisches Segment braucht einen Eintrag.
 *
 * Die Datei ist bewusst frei von React und Server-Abhängigkeiten — sie
 * wird von Client-Komponenten UND vom Store-Bootstrap importiert.
 */

import { OW, SCHEMA, SKOS } from '@/lib/graph/vocab';

/** Fähigkeit der Runtime, ohne die ein Modul nichts anzubieten hätte. */
export type ModuleCapability =
    | 'sparqlEndpoint'
    | 'mcpServer'
    | 'federationOutbound'
    | 'federationInbound'
    | 'multiUser';

export interface AppModule {
    /** Stabile Kennung; zugleich das IRI-Segment des Modul-Knotens. */
    id: string;
    /** Anwendungspfad — installationsunabhängig (Base-Path ist Packaging). */
    route: string;
    label: string;
    /** Ein Satz, der sagt, wofür das Modul zuständig ist. */
    description: string;
    /** Klassen (Vokabular-IRIs), deren Entitäten dieses Modul verwaltet. */
    entityTypes: readonly string[];
    /** Übergeordnetes Modul für Unterseiten (`/graph/sparql` → `graph`). */
    partOf?: string;
    /** Platz in der Navigation: Hauptmenü, Fußbereich, gar nicht verlinkt. */
    navigation: 'primary' | 'secondary' | 'none';
    /**
     * Ohne diese Runtime-Fähigkeit gibt es das Modul in dieser Installation
     * nicht — es erscheint dann auch nicht im Selbstmodell (Invariante 10:
     * das System behauptet nichts, was es nicht kann).
     */
    requiresCapability?: ModuleCapability;
}

/**
 * Reihenfolge = Reihenfolge im Hauptmenü. Unterseiten stehen direkt hinter
 * ihrem Modul, damit die Liste auch als Inhaltsverzeichnis lesbar ist.
 */
export const APP_MODULES: readonly AppModule[] = [
    {
        id: 'dashboard',
        route: '/',
        label: 'Übersicht',
        description: 'Dashboard mit Widgets, Kennzahlen und Aktivitäts-Feed.',
        entityTypes: [],
        navigation: 'primary',
    },
    {
        id: 'assistant',
        route: '/assistant',
        label: 'Assistent',
        description: 'Ganzseitige Assistent-Ansicht: Dialog links, generative Bühne rechts.',
        entityTypes: [SCHEMA.Conversation, SCHEMA.Message],
        navigation: 'primary',
    },
    {
        id: 'tasks',
        route: '/tasks',
        label: 'Aufgaben',
        description: 'Aufgaben und Projekte als Kanban, mit Prioritäten, Fälligkeiten und Abhängigkeiten.',
        entityTypes: [OW.Task, OW.Project],
        navigation: 'primary',
    },
    {
        id: 'calendar',
        route: '/calendar',
        label: 'Kalender',
        description: 'Termine aus ICS-Providern in Monats- und Wochenansicht.',
        entityTypes: [SCHEMA.Event, SCHEMA.DataFeed],
        navigation: 'primary',
    },
    {
        id: 'docs',
        route: '/docs',
        label: 'Dokumente',
        description: 'Wissensbasis aus Markdown-Dokumenten mit Wikilinks und Tags.',
        entityTypes: [OW.Document, SKOS.Concept],
        navigation: 'primary',
    },
    {
        id: 'canvas',
        route: '/canvas',
        label: 'Pinnwand',
        description: 'Visuelle Planung auf Pinnwänden; das Layout lebt in der Präsentationsschicht.',
        entityTypes: [OW.Canvas],
        navigation: 'primary',
    },
    {
        id: 'communication',
        route: '/communication',
        label: 'Kommunikation',
        description: 'Matrix-Chat; die Seite kennzeichnet ihren Planungsstand ehrlich.',
        entityTypes: [],
        navigation: 'primary',
    },
    {
        id: 'agents',
        route: '/agents',
        label: 'Agenten',
        description: 'A2A-Agenten entdecken, konfigurieren und delegieren.',
        entityTypes: [OW.Agent],
        navigation: 'primary',
    },
    {
        id: 'ai',
        route: '/ai',
        label: 'AI-Hub',
        description: 'Inference-Provider, Modelle, Routing und Diagnose.',
        entityTypes: [OW.InferenceProvider, OW.Model],
        navigation: 'primary',
    },
    {
        id: 'skills',
        route: '/skills',
        label: 'Skills',
        description: 'Skills nach der SKILL.md-Konvention verwalten und laden.',
        entityTypes: [OW.Skill],
        navigation: 'primary',
    },
    {
        id: 'tools',
        route: '/tools',
        label: 'Werkzeuge',
        description: 'API-Werkzeuge, sichere Verbindungen und MCP-Server.',
        entityTypes: [OW.Tool, OW.ToolProvider],
        navigation: 'primary',
    },
    {
        id: 'graph',
        route: '/graph',
        label: 'Graph',
        description: 'Graph-Explorer über den RDF-Wissensgraphen: Filter, Nachbarschaft, Provenienz.',
        entityTypes: [],
        navigation: 'primary',
    },
    {
        id: 'graph-connectors',
        route: '/graph/connectors',
        label: 'Connectors',
        description: 'Externe Quellen anbinden, synchronisieren und ihre Berichte lesen.',
        entityTypes: [OW.Connector],
        partOf: 'graph',
        navigation: 'none',
    },
    {
        id: 'graph-sparql',
        route: '/graph/sparql',
        label: 'SPARQL',
        description: 'SPARQL-Editor mit Ergebnistabelle, Graph-Ansicht und gespeicherten Queries.',
        entityTypes: [OW.QueryView],
        partOf: 'graph',
        navigation: 'none',
        requiresCapability: 'sparqlEndpoint',
    },
    {
        id: 'graph-federation',
        route: '/graph/federation',
        label: 'Föderation',
        description: 'Fremde SPARQL-Endpoints registrieren, ihre Vertrauensstufe setzen und sie abfragen.',
        entityTypes: [OW.FederatedEndpoint],
        partOf: 'graph',
        navigation: 'none',
        requiresCapability: 'federationOutbound',
    },
    {
        id: 'graph-access',
        route: '/graph/access',
        label: 'Zugriff',
        description: 'Sichtbare Graphen, geteilte Räume und Freigaben nach Web Access Control.',
        entityTypes: [OW.Space],
        partOf: 'graph',
        navigation: 'none',
        requiresCapability: 'multiUser',
    },
    {
        id: 'onboarding',
        route: '/onboarding',
        label: 'Einführung',
        description: 'Geführte Einführung, die den Graphen an sich selbst erklärt — reale Schritte mit Rückgängig.',
        entityTypes: [],
        navigation: 'secondary',
    },
    {
        id: 'settings',
        route: '/settings',
        label: 'Einstellungen',
        description: 'Theme, Kalender, Speicher, Laufzeitumgebung und Datenexport.',
        entityTypes: [],
        navigation: 'secondary',
    },
];

/** Module eines Navigationsbereichs, in Registry-Reihenfolge. */
export function navigationModules(area: AppModule['navigation']): AppModule[] {
    return APP_MODULES.filter(module => module.navigation === area);
}
