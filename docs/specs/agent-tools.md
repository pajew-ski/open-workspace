# Agent2Agent Tools Specification

The Open Workspace provides standardized tools for agents (including the Personal Assistant) to interact with the system.

## Workspace-Fähigkeiten sind Aktionen

> Übergeordnet: [ACTIONS_SPEC](./actions.md). Was der Assistent im
> Workspace tun kann (suchen, Aufgaben, Projekte, Dokumente, Pinnwände,
> Graph, …), ist eine **Aktion** aus der Registry (`src/lib/actions/`),
> nicht mehr ein hier beschriebenes Builtin. Die Tool-Definition (Name,
> Beschreibung, JSON-Schema) wird aus der Aktion erzeugt; die Liste ist
> `GET /api/actions` und im Selbstmodell als `ow:Tool` abfragbar.

Die drei Namen aus der Zeit vor dem Vertrag bleiben — Skills referenzieren
sie über `[[TOOL:…]]`:

- **`workspace_finder`** — `q` (Pflicht), `type` aus
  `task|doc|project|chat|calendar`, `limit`. Liefert `{ results }` mit
  `type`, `id`, `title`, `subtitle`, `url`, `matchScore`. Seit M8 auf dem
  Graph-Index (Fuzzy-Verhalten inklusive), seit M15 auch Termine und
  Chats.
- **`workspace_create_task`** — legt eine Aufgabe an (Pflicht: `title`).
- **`workspace_update_task`** — ändert eine Aufgabe (Pflicht: `taskId`
  plus mindestens ein Feld; die ID kommt aus dem Finder).

Ausführung: auf dem Server im Prozess mit der Identität des
Chat-Requests, im Browser über `POST /api/actions/<name>`. Ohne Backend
gibt es die Aktionen nicht, und dann erscheinen sie auch nicht als
Werkzeug (Invariante 10). Löschen ist `destructive` und deshalb auf keiner
Agenten-Oberfläche (ACTIONS_SPEC §3).

## Tool: use_skill

- **Name**: `use_skill`
- **Description**: Loads the full content of an enabled skill (progressive
  disclosure — skills are listed in the system prompt with name +
  description only).
- **Parameters**: `id` (string, required): Skill id from the prompt listing.

## API-Tools (Werkzeuge-Modul)

User-defined REST tools. Argument schema is derived from `{placeholder}`
names in URL/body templates, so models with native function calling get a
typed signature. Execution: server-side (`src/lib/tools/executor.ts`,
SSRF-protected, connection credentials) — the in-browser engine delegates
to `POST /api/tools/execute` when a backend is reachable and falls back to
a direct browser fetch (CORS permitting, no stored credentials) without one.

## MCP-Tools

Tools of connected MCP servers (see `/tools`) join the loop automatically,
namespaced as `mcp_<server>_<toolname>`. Results may carry `ui://`
resources (MCP-UI) which render on the generative stage. Native function
calling is used where the provider supports it; the text syntax
`[[TOOL:name:{...}]]` remains the universal fallback.

## Agent delegation

`[[AGENT:agent_id:task in natural language]]` delegates to an enabled
agent (local persona on its own provider/model, or remote via A2A
`message/send`) and returns the reply as an `[AGENT_RESULT]` message.
