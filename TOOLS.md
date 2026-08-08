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

*(Implemented: `workspace_finder` is a built-in tool of the chat tool loop
in `/api/chat` — no configuration required. User-defined API tools from the
Werkzeuge module are available through the same mechanism. Native function
calling for models that support it is on the roadmap, see ANALYSE.md P1.)*
