import type { SkillMeta } from '@/lib/skills/types';
import { systemContextText, type SelfModelView } from '@/lib/graph/meta/self-model-view';

/**
 * System prompt builder for the personal assistant — shared by the
 * server route and the in-browser engine so both paths produce the same
 * behavior: context awareness, generative UI (A2UI), tools (native or
 * text syntax), agent delegation and skills (progressive disclosure).
 */

export interface PromptContext {
    module: string;
    moduleDescription: string;
    pathname: string;
    viewState?: Record<string, unknown>;
    /** Compact summary of the components currently on the generative surface */
    activeSurface?: Array<Record<string, unknown>>;
    /**
     * Selbstmodell der Installation (GRAPH_CORE_SPEC §18): Module, Routen,
     * verwaltete Entitätstypen, aktive Fähigkeiten der Runtime — per
     * SPARQL aus `graph/meta` abgefragt, nicht hier gepflegt. Fehlt es
     * (kein Backend erreichbar, kein Leserecht), behauptet der Prompt
     * nichts über das System: eine veraltete Liste wäre schlechter als
     * keine.
     */
    selfModel?: SelfModelView;
}

export interface PromptToolInfo {
    name: string;
    description: string;
    /** Short argument hint, e.g. `{"q":"suchbegriff"}`. */
    argsHint?: string;
    source: 'builtin' | 'api' | 'mcp';
}

export interface PromptAgentInfo {
    id: string;
    name: string;
    description: string;
    type: 'local' | 'remote_a2a';
}

export interface BuildPromptOptions {
    context: PromptContext;
    tools: PromptToolInfo[];
    agents: PromptAgentInfo[];
    skills: SkillMeta[];
    /** True when the request attempts native function calling. */
    nativeTools: boolean;
}

export function buildSystemPrompt(options: BuildPromptOptions): string {
    const { context, tools, agents, skills, nativeTools } = options;

    let viewStateContext = '';
    if (context.viewState && Object.keys(context.viewState).length > 0) {
        viewStateContext = `\nAKTUELLE ANSICHT (Was der Nutzer sieht):\n${JSON.stringify(context.viewState, null, 2)}`;
    }

    // The surface is a function of the conversation: the model needs to
    // know what is currently rendered to be able to change or dismiss it.
    let surfaceContext = '';
    if (context.activeSurface && context.activeSurface.length > 0) {
        surfaceContext = `\nAKTIVE BÜHNE (aktuell gerenderte UI-Komponenten):\n${JSON.stringify(context.activeSurface, null, 1)}\nDein nächster a2ui-Block ERSETZT diese Bühne vollständig. Um sie zu leeren ("blende X aus"), sende einen a2ui-Block mit leerem components-Array oder ohne die betreffende Komponente.`;
    }

    const sourceLabel: Record<PromptToolInfo['source'], string> = {
        builtin: 'Workspace',
        api: 'API-Tool',
        mcp: 'MCP',
    };
    const toolLines = tools.map(t =>
        `- ${t.name} [${sourceLabel[t.source]}]: ${t.description}${t.argsHint ? ` Argumente: ${t.argsHint}` : ''}`
    );

    const toolInstruction = nativeTools
        ? 'Dir stehen diese Tools als native Function Calls zur Verfügung — rufe sie direkt auf. Falls Function Calling in dieser Umgebung nicht verfügbar ist, nutze exakt die Syntax [[TOOL:tool_name:{"arg":"wert"}]].'
        : 'Um ein Tool zu nutzen, schreibe exakt: [[TOOL:tool_name:{"arg":"wert"}]] — das Tool wird automatisch ausgeführt und du erhältst das Ergebnis als [TOOL_RESULT]-Nachricht. Beantworte danach die Frage des Nutzers auf Basis des Ergebnisses.';

    const toolsContext = tools.length > 0
        ? `\nVERFÜGBARE TOOLS:\n${toolLines.join('\n')}\n\n${toolInstruction}`
        : '';

    let agentsContext = '';
    if (agents.length > 0) {
        const agentLines = agents.map(a =>
            `- ${a.name} (ID: ${a.id})${a.type === 'remote_a2a' ? ' [Remote/A2A]' : ' [Lokal]'}: ${a.description}`
        );
        agentsContext = `\nVERFÜGBARE AGENTEN (delegierbar):\n${agentLines.join('\n')}\n\nUm eine Teilaufgabe zu delegieren, schreibe exakt: [[AGENT:agent_id:Auftrag in natürlicher Sprache]]\nDu erhältst die Antwort als [AGENT_RESULT]-Nachricht und fasst sie für den Nutzer zusammen.`;
    }

    let skillsContext = '';
    if (skills.length > 0) {
        const listed = skills.filter(s => !s.alwaysInject);
        const injected = skills.filter(s => s.alwaysInject && s.content);
        const parts: string[] = [];
        if (listed.length > 0) {
            parts.push(
                `VERFÜGBARE SKILLS (Anleitungen — lade sie bei Bedarf):\n${listed.map(s => `- ${s.name} (ID: ${s.id}): ${s.description}`).join('\n')}\n` +
                `Wenn eine Aufgabe zu einem Skill passt, lade ZUERST dessen Inhalt über das Tool use_skill (Argument {"id":"skill_id"}) und folge dann den Anweisungen darin.`
            );
        }
        for (const skill of injected) {
            parts.push(`AKTIVER SKILL „${skill.name}":\n${skill.content}`);
        }
        skillsContext = `\n${parts.join('\n\n')}`;
    }

    // §18: Der Systemkontext kommt aus dem Selbstmodell des Graphen. Ein
    // Modul, das sich dort registriert, ist dem Assistenten damit ohne
    // Prompt-Pflege bekannt.
    const systemModel = context.selfModel ? systemContextText(context.selfModel, context.pathname) : '';
    const systemContext = systemModel ? `\n\n${systemModel}` : '';

    return `Du bist der Persönliche Assistent im Open Workspace. Deine Aufgaben:

KONTEXT:
- Der Nutzer befindet sich gerade im Modul: ${context.module}
- Modul-Beschreibung: ${context.moduleDescription}
- Aktuelle Seite: ${context.pathname}${systemContext}${viewStateContext}${surfaceContext}${toolsContext}${agentsContext}${skillsContext}

DEINE EIGENSCHAFTEN:
- Du sprichst den Nutzer immer mit "du" an (informell, nie "Sie")
- Du bist freundlich, hilfsbereit und präzise
- Du hast Zugriff auf alle Module des Workspaces
- Du kannst Aufgaben delegieren und koordinieren

GENERATIVE UI — GRUNDPRINZIP:
Der Dialog ist der primäre Kanal. UI materialisiert sich nur, wenn die
Aufgabe es erfordert (Liste, Termine, Formular) — nicht als Dekoration.
Deine UI-Ausgabe ist die "Bühne" der Konversation:
- Ein a2ui-Block in deiner Antwort ERSETZT die aktive Bühne vollständig.
- "Zeig mir X" -> rendere die passende Komponente.
- "Blende X aus" / "verstecke die Liste" -> neuer a2ui-Block ohne X
  (oder mit leerem components-Array, um alles auszublenden).
- Beziehe dich auf die AKTIVE BÜHNE im Kontext, um gezielt zu ändern.

**Dynamische UI rendern (Agent2UI)**:
Nutze einen Markdown Code-Block mit \`a2ui\` als Sprache:
\`\`\`a2ui
{
    "components": [
        { "id": "c1", "component": { "Card": { "title": "Titel", "children": { "explicitList": ["t1", "b1"] } } } },
        { "id": "t1", "component": { "Text": { "text": "Inhalt" } } },
        { "id": "b1", "component": { "Button": { "label": "Aktion", "onPress": { "actionId": "clicked" } } } }
    ]
}
\`\`\`

NATIVE WORKSPACE-WIDGETS (selbst-ladend, immer aktuelle Live-Daten — bevorzuge sie
gegenüber selbst abgeschriebenen Listen):
- **WorkspaceTasks**: \`status\` ('todo'|'in-progress'|'done', optional), \`projectId\`, \`limit\`, \`title\` — Live-Aufgabenliste
- **WorkspaceCalendar**: \`days\` (Zahl, Standard 7), \`title\` — kommende Termine
- **WorkspaceDocs**: \`query\` (optionale Suche), \`limit\`, \`title\` — Wissensbasis-Dokumente
- **WorkspaceStats**: \`title\` — Workspace-Kennzahlen
Beispiel: { "id": "w1", "component": { "WorkspaceTasks": { "status": "todo", "limit": 5 } } }

EINGEBETTETE UI-RESSOURCEN (MCP-UI-Standard):
- **UIResource**: \`resource\` ({ uri: "ui://...", mimeType: "text/html"|"text/uri-list", text: "..." }), \`height\`
  Rendert Tool-/Server-gelieferte UI sandboxed. Nur verwenden, wenn ein Tool eine UI-Ressource geliefert hat.

WEITERE A2UI-KOMPONENTEN & Props:
- **Text**: \`text\`, \`style\` | **Markdown**: \`content\` | **CodeBlock**: \`code\`, \`language\`
- **Card**: \`title\`, \`children\` ({ explicitList: string[] }) | **Column**/**Row**: \`gap\`, \`children\`
- **Image**: \`src\`, \`alt\`, \`caption\` | **Link**: \`text\`, \`href\`
- **Alert**: \`title\`, \`message\`, \`variant\` ('info'|'warning'|'error'|'success')
- **List**: \`items\` | **Table**: \`columns\`, \`rows\` | **Progress**, **Chip**, **Badge**
- **Button**: \`label\`, \`onPress\` ({ actionId }) | **Input**: \`label\`, \`placeholder\`, \`onChange\` ({ actionId })
- **Select**: \`label\`, \`options\`, \`onSelect\` | **Checkbox**: \`label\`, \`onChange\`

Antworte immer auf Deutsch, es sei denn der Nutzer schreibt auf Englisch.
Halte deine Antworten präzise und hilfreich.`;
}
