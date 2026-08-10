# AI-Plattform: Architektur

> Multi-Provider-Inference, Backend-Unabhängigkeit, Tools (API + MCP),
> Agenten (A2A) und Skills — Stand 2026-08-08.

## 1. Leitidee: Das Backend ist optional

Der Workspace behandelt sein eigenes Next.js-Backend als **optionalen
Verstärker, nicht als Voraussetzung**. Jede Funktion der AI-Schicht hat
zwei gleichwertige Ausführungspfade:

| Pfad | Wer führt aus | Wann |
|---|---|---|
| **Browser-Route** | Die Seite selbst (fetch direkt zum Endpunkt, Engine im Browser) | Lokale Endpunkte, Browser-Keys, WebLLM, Serverless-Betrieb |
| **Server-Route** | `/api/chat` + Relays | Server-verschlüsselte Keys, CORS-blockierte Endpunkte |

Die Entscheidung fällt **pro Provider zur Laufzeit** (`resolveRoute` in
`src/lib/ai/store.client.ts`):

1. `webllm` → immer Browser.
2. Explizite Einstellung (`connectionMode: browser|server`) gewinnt.
3. `auto`: Browser-Probe zuerst (nur der Browser kann jemals die Maschine
   des Nutzers erreichen), dann Server-Probe als Fallback. Cloud-Provider
   mit Server-Key bevorzugen den Server (der Key verlässt ihn nie).

**Damit ist das Kernproblem gelöst: App in der Cloud gehostet, Ollama
lokal.** Der Cloud-Server kann `http://localhost:11434` nicht erreichen —
der Browser des Nutzers schon. Die Route löst sich automatisch auf
„Browser (direkt)" auf; die UI zeigt den aktiven Pfad als Badge.

### Voraussetzungen für den Browser-Direktzugriff

- **CORS**: Der Endpunkt muss die App-Origin erlauben.
  - Ollama: `OLLAMA_ORIGINS=https://deine-app.example` (oder `*`)
  - LM Studio: Developer → „Enable CORS"
  - vLLM: `--allowed-origins`
  - Anthropic: offizieller Header `anthropic-dangerous-direct-browser-access`
    (wird automatisch gesetzt, wenn der Key im Browser liegt)
- **Mixed Content**: HTTPS-Seiten dürfen `http://localhost`/`127.0.0.1`
  ansprechen (Browser-Ausnahme für „potentially trustworthy origins").
  Andere HTTP-Adressen (LAN-IPs) blockiert der Browser — Diagnose meldet
  das mit Lösungsvorschlägen (HTTPS, SSH-Tunnel auf localhost).

Die Diagnose (`probeProvider` in `src/lib/ai/client.ts`) unterscheidet:
`online`, `auth` (401/403), `mixed-content` (vor dem Fetch erkannt),
`cors-or-offline` (TypeError im Browser), `offline`, `error` — jeweils mit
handlungsfähigem deutschem Hinweistext.

## 2. Serverloser Betrieb (kein Backend erreichbar)

`src/lib/platform/backend.ts` probt `/api/ai/config` (30s-Cache). Ist kein
Backend da (statisches Hosting, Backend down, offline PWA):

| Baustein | Serverloser Speicher |
|---|---|
| Provider/MCP-Konfiguration | `localStorage` (`ow.ai.local-config`) + Mirror der letzten Server-Konfiguration |
| API-Keys / MCP-Auth | `localStorage` (`ow.ai.provider-keys`, `ow.ai.mcp-auth`) — verlassen den Browser nie Richtung Workspace-Server |
| Chat-Konversationen | IndexedDB (`open-workspace/conversations`) |
| Skills | `localStorage` (`ow.skills.local`) + Mirror |
| Tools/Agenten | Read-only-Mirror der letzten Server-Daten |
| Inference | Browser-Route (lokale Endpunkte, Browser-Keys, WebLLM) |

Datensätze, die serverlos angelegt wurden, sind in der UI als „nur dieser
Browser" markiert (`origin: 'local'`). Workspace-Inhalte (Dokumente,
Aufgaben …) bleiben server-gebunden; der Service Worker liefert besuchte
Daten offline aus dem Cache (bestehendes Verhalten). Der `workspace_finder`
meldet serverlos ehrlich, dass er das Backend braucht.

**Die extremste Stufe: WebLLM.** `@mlc-ai/web-llm` lädt Modellgewichte
einmalig in den Browser-Cache und rechnet per WebGPU auf der GPU des
Nutzers. Kein Endpunkt, kein Key, nach dem Download offline — der
Assistent funktioniert damit vollständig ohne jede Infrastruktur.

Welche Modelle zur Wahl stehen, entscheidet der mitgelieferte Build
(aktuell ~165 Konfigurationen): `CURATED_WEBLLM_MODELS` ist die
Empfehlung — Hermes 3/2 Pro für Werkzeugaufrufe, Qwen 3, Phi 4 Mini,
Llama 3.1/3.2, Gemma 3 —, der Manager blendet auf Wunsch den vollen
Katalog ein. Größenangaben und die Tool-Calling-Markierung stammen aus
der Bibliothek selbst und werden gegen sie getestet; die Liste ist
Auswahl, keine zweite Wahrheit.

## 3. Provider-Modell

`AIProvider` (`src/lib/ai/types.ts`): `kind` (Katalog), `baseUrl`,
`connectionMode` (auto/browser/server), `keyLocation` (none/server/browser),
`defaultModel`, `pinnedModels`, `toolCalls` (auto/native/text), `enabled`.

- **Katalog** (`presets.ts`): Ollama, LM Studio, llama.cpp, vLLM, Jan,
  WebLLM, OpenAI, Anthropic, Google Gemini, Mistral, Groq, OpenRouter,
  Together, DeepSeek, xAI, eigener Endpunkt. Jeder Preset kennt Protokoll,
  Standard-URL, Key-Pflicht, CORS-Hinweise.
- **Protokoll-Adapter** (`protocols/`): `openai` (chat.completions, SSE),
  `anthropic` (Messages API, SSE, System-Hoisting, tool_use), `ollama`
  (natives NDJSON, /api/tags), `webllm` (In-Browser-Engine). Alle
  isomorph, alle streamen normalisierte `AdapterEvent`s (text/toolCall/
  progress/done).
- **Key-Speicherung**: Server-Keys AES-256-GCM-verschlüsselt in
  `data/ai/config.json` (bestehende `encryption.ts`; `ENV:VAR`-Referenzen
  möglich); der Client sieht nur `hasServerKey`. Browser-Keys in
  localStorage mit expliziter UI-Warnung.
- **Defaults**: Workspace-Standard (Provider + Modell) + globale aktive
  Auswahl im Chat (ModelPicker, `ow.ai.selection`).

## 4. Die isomorphe Engine

`src/lib/ai/engine.ts` — EIN Loop für beide Welten. `/api/chat` und der
Browser-Transport (`transport.ts`) injizieren nur unterschiedliche
Abhängigkeiten (`server/deps.ts` vs. `browser/deps.ts`).

Pro Runde (max. 4): Modell streamen → Tool-Calls einsammeln → ausführen →
Ergebnisse zurückspeisen. Zwei Aufrufwege parallel:

- **Nativ** (Function Calling): OpenAI-`tools`, Anthropic-`tool_use`,
  Ollama-`tools`. Ergebnisse als `role:"tool"`-Nachrichten. Lehnt ein
  Endpunkt `tools` ab (`does not support tools`), schaltet die Runde
  automatisch auf Text-Syntax um (`NativeToolsUnsupportedError`).
- **Text-Syntax** (universeller Fallback, funktioniert mit jedem Modell):
  `[[TOOL:name:{"arg":1}]]` und `[[AGENT:id:Auftrag]]`, chunk-grenzen-
  sicher geparst (`CallMarkerStreamFilter`), aus dem sichtbaren Stream
  entfernt, Ergebnisse als `[TOOL_RESULT]`/`[AGENT_RESULT]`-Nachrichten.

Tool-Quellen (`tools.shared.ts` baut einheitliche `EngineTool`s):

1. **Builtins**: `workspace_finder`, `use_skill`
2. **API-Tools** (Werkzeuge-Modul): Schema aus `{platzhaltern}` extrahiert;
   Browser-Engine delegiert an `POST /api/tools/execute` (Credentials,
   SSRF-Schutz), serverlos direkter Fetch ohne Credentials
3. **MCP-Tools**: pro aktivem Server entdeckt, namespaced
   (`mcp_<server>_<tool>`), Ergebnisse inkl. `ui://`-Ressourcen

Events der Engine: `text`, `status` (Tool-Fortschritt als Blockquote),
`ui-resource` (MCP-UI auf die Bühne), `progress` (WebLLM-Ladebalken).

## 5. MCP (Model Context Protocol)

`src/lib/ai/mcp/client.ts` auf `@modelcontextprotocol/sdk`: Streamable
HTTP mit SSE-Fallback, isomorph. stdio bewusst außen vor (bräuchte
Prozess-Spawning, nur serverseitig — HTTP hält beide Pfade gleichwertig).

- Browser verbindet direkt (funktioniert serverlos); scheitert CORS,
  springt das Relay `POST /api/ai/mcp/[id]` ein (nur konfigurierte Server,
  entschlüsselte Auth-Header, kein offener Proxy).
- **Tools** fließen in den Engine-Loop; **`ui://`-Ressourcen** in
  Ergebnissen rendert die bestehende `UIResource`-Komponente sandboxed auf
  der generativen Bühne (MCP-UI-Standard).
- **Prompts** sind als **Skills importierbar** (Werkzeuge-Seite).

## 6. A2A (Agent2Agent)

`src/lib/ai/a2a/client.ts`, ohne Zusatz-Dependency:

- **Discovery**: `/.well-known/agent-card.json` (Fallback `agent.json`,
  direkte Card-URLs), normalisiert Name/Beschreibung/Endpunkt/Skills.
- **Nachrichten**: JSON-RPC `message/send` (Fallback `tasks/send`),
  Task-Lifecycle via `tasks/get`-Polling bis Terminal-Status.
- Agenten-Dialog: URL eingeben → Card abrufen → prüfen → speichern.
  Auth über bestehende Verbindungen (Server) — Relay `POST /api/ai/a2a`.
- **Delegation im Chat**: aktivierte Agenten stehen im System-Prompt;
  `[[AGENT:id:…]]` ruft remote (A2A) oder lokal (Persona auf eigenem
  Provider/Modell, browser- wie serverseitig) und speist das Ergebnis
  zurück.

## 7. Skills

SKILL.md-Konvention (YAML-Frontmatter `name`/`description` + Markdown-
Anweisungen), `src/lib/skills/`:

- **Ladewege**: manuell, beliebige URL, GitHub-Repo (Datei, Ordner mit
  SKILL.md oder Sammlung von Skill-Ordnern — via api.github.com, CORS-
  freundlich, auch serverlos), MCP-Prompt-Import.
- **Progressive Disclosure**: aktivierte Skills stehen nur mit Name +
  Beschreibung im System-Prompt; den vollen Inhalt zieht das Modell bei
  Bedarf über das Builtin-Tool `use_skill`. `alwaysInject` bettet kleine,
  kritische Skills direkt ein.
- Speicher: `data/ai/skills.json` (Server) bzw. localStorage (serverlos).

## 8. Routen-Übersicht

| Route | Zweck |
|---|---|
| `GET /api/ai/config` | Client-sichere Gesamtkonfiguration (+ Backend-Probe) |
| `POST/PUT/DELETE /api/ai/providers[/[id]]` | Provider-CRUD (Server-Keys verschlüsselt) |
| `GET /api/ai/providers/[id]/health` | Server-seitige Probe (Routing-Frage „wer erreicht das?") |
| `PUT /api/ai/defaults` | Workspace-Standard |
| `POST/PUT/DELETE /api/ai/mcp-servers[/[id]]` | MCP-Server-CRUD |
| `POST /api/ai/mcp/[id]` | MCP-Relay (probe/listTools/callTool/listPrompts/getPrompt) |
| `POST /api/ai/a2a` | A2A-Relay (discover/send) |
| `GET/POST/PUT/DELETE /api/skills[/[id]]` | Skills-CRUD |
| `POST /api/tools/execute` | API-Tool-Ausführung für die Browser-Engine |
| `POST /api/chat` | Server-Pfad der Engine (providerId/model im Body; NDJSON abwärtskompatibel + `type:"ui-resource"`) |
| `GET /api/chat/health` | Status des Standard-Providers + Inventar |

Migration: Beim ersten Laden ohne `data/ai/config.json` wird die
Alt-Konfiguration (`data/settings.json` / `LLM_*`-Env) automatisch in
einen Provider überführt — bestehende Installationen laufen unverändert.

## 9. UI-Oberflächen

- **/ai — AI-Hub**: Provider-Karten (Status, Routen-Badge, Modelle,
  Latenz), Preset-Galerie, Key-Speicherort-Wahl, Diagnose-Panel
  („Cloud-App + lokale Inference"), Defaults, WebLLM-Modell-Manager
  (WebGPU-Check, Download mit Fortschritt, Cache-Status/-Eviction,
  kuratierte Empfehlung + durchsuchbarer Voll-Katalog des Builds mit
  Tool-Calling-Filter).
- **ModelPicker** (Chat-Widget + /assistant): aktive Auswahl mit
  Status-Punkt, Provider→Modelle-Popover, Routen-Badges, Serverlos-Chip.
- **/skills**: Karten mit Quelle-Badges, Aktiv/Immer-aktiv-Toggles,
  Editor, Add-Flows (manuell/URL/Repo).
- **/tools**: MCP-Server-Verwaltung (Status, entdeckte Tools, Prompts →
  Skills) + bestehende API-Tools/Verbindungen.
- **/agents**: A2A-Discovery-Dialog, Capabilities-Chips, Test-Nachricht,
  Aktiv-Toggles; lokale Agenten mit Provider/Modell-Override.

## 10. Sicherheitsentscheidungen

- Server-Keys werden **nie** an den Client serialisiert (nur `hasServerKey`).
- Browser-Keys werden **nie** an den Workspace-Server gesendet — sie
  hängen nur an Direkt-Requests des Browsers an den Inference-Endpunkt.
- MCP-/A2A-Relays arbeiten ausschließlich gegen **konfigurierte** Server
  (kein offener Proxy, SSRF-Schutz der Tool-Ausführung bleibt bestehen).
- `data/ai/` ist gitignored (enthält verschlüsselte Secrets).

## 11. Bewusste Grenzen (ehrlich dokumentiert)

- Workspace-**Inhalte** (Docs/Tasks/Canvas/Kalender) sind weiterhin
  server-gebunden; serverlos gibt es den SW-Cache-Lesepfad. Der volle
  IndexedDB-Spiegel + Background-Sync bleibt Roadmap (P1.9).
- MCP über stdio (lokale Prozesse) ist nicht implementiert — HTTP/SSE
  decken Remote- und lokale HTTP-Server ab.
- A2A: Streaming (`message/stream`) und Push-Notifications sind nicht
  implementiert; `message/send` + Polling decken den Kern ab.
- WebLLM-Tool-Calls laufen über die Text-Syntax, nicht über den nativen
  `tools`-Parameter. Begründet, nicht vergessen (geprüft in
  `tests/ai/webllm-models.test.ts`): der mitgelieferte Build schaltet
  `tools` nur für eine Handvoll Hermes-Modelle frei
  (`functionCallingModelIds`), verbietet dabei eine System-Nachricht (die
  dieser Workspace immer sendet — Modul-Kontext aus dem Selbstmodell) und
  zwingt die Antwort in ein Tool-Call-Array, womit gewöhnliche
  Gesprächsrunden unmöglich werden. Die Modell-Liste markiert diese
  Modelle trotzdem: Sie sind auf Funktionsaufrufe trainiert und folgen
  der Text-Syntax am zuverlässigsten.
