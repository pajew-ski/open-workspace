# Agent2Agent Tools Specification

The Open Workspace provides standardized tools for agents (including the Personal Assistant) to interact with the system.

## Tool: Global Finder

This tool allows agents to fuzzy-search across the entire workspace or specific modules.

### Definition

- **Name**: `workspace_finder`
- **Description**: Search for tasks, notes, projects, chats, and calendar events.
- **Endpoint**: `GET /api/finder`
- **Parameters**:
    - `q` (string, required): The search query.
    - `type` (string, optional): One of [`task`, `note`, `project`, `chat`, `calendar`]. If omitted, searches all.

### Response Format

```json
{
  "results": [
    {
      "type": "task",
      "id": "task-123",
      "title": "Fix Login Bug",
      "subtitle": "Aufgabe • TODO • Frontend",
      "url": "/tasks?id=task-123",
      "matchScore": 2
    }
  ]
}
```

### Usage for Assistant

When the user asks to find something, you should:
1.  Identify if they mean a specific type (e.g., "Find task X").
2.  Emit `[[TOOL:workspace_finder:{"q":"query","type":"task"}]]` — the chat
    backend executes the search and feeds the results back as a
    `[TOOL_RESULT]` message (see AGENTS.md, Tool Protocol).
3.  Present the results to the user.

*(Implemented: `workspace_finder` is a built-in tool of the engine tool
loop — no configuration required. It runs server-side in `/api/chat` AND
in the in-browser engine when a backend is reachable; without one it
reports honestly that workspace search needs the backend.)*

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
