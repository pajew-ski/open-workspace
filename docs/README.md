# Dokumentation

Diese Übersicht sagt, **welches Dokument in welcher Frage gilt** — die
wichtigste Auskunft, wenn zwei sich zu widersprechen scheinen.

## Die vier Dokumente in der Wurzel

| Datei | Rolle |
|---|---|
| [README.md](../README.md) | Was das Projekt ist und kann — der Einstieg für Menschen |
| [AGENTS.md](../AGENTS.md) | Arbeitsprotokoll für Agenten und Menschen: „Hier weitermachen", Architektur im Überblick, Code-Konventionen, Safety-Regeln |
| [TODO.md](../TODO.md) | Der abhakbare Stand: erledigt, offen, priorisiert |
| [LICENSE](../LICENSE) | GPL v3 |

## Spezifikationen (`docs/specs/`)

**Verbindlich.** Bei Widerspruch gewinnt die Spec gegen Analyse und TODO;
für Code-Konventionen, Mobile-First, Safety-Regeln und das E2E-Gate gilt
weiterhin AGENTS.md.

| Spec | Kürzel im Text | Inhalt |
|---|---|---|
| [specs/graph-core.md](./specs/graph-core.md) | `GRAPH_CORE_SPEC` | Der Graph-Kern: Invarianten 1–10, Meilensteine M0–M14 (vollständig) |
| [specs/causal-layer.md](./specs/causal-layer.md) | `CAUSAL_LAYER_SPEC` | Kausal-Layer: Invarianten C1–C10, Meilensteine C0–C6 (verbindlich, vollständig), C7/C8 opt-in |
| [specs/chat-widget.md](./specs/chat-widget.md) | `CHAT_WIDGET_SPEC` | Verhalten des Assistenten-Widgets (Scroll, Persistenz, Kontext) |
| [specs/agent-tools.md](./specs/agent-tools.md) | — | Die eingebauten Werkzeuge des Tool-Loops und ihr Aufrufformat |

Die Kürzel bleiben, wie sie sind: Sie stehen in hunderten Code-Kommentaren
und in den TTL-Dateien als Referenz auf einen Paragraphen (`§7.5`), nicht
als Dateiname. Der Dateiname darf sich ändern, der Paragraph nicht.

## Architektur- und Betriebsdoku

| Dokument | Frage, die es beantwortet |
|---|---|
| [ai-platform.md](./ai-platform.md) | Wie laufen Inference, Tools, Agenten und Skills — und warum ohne Backend weiter? |
| [kausalmodell.md](./kausalmodell.md) | Wie wird aus einer Annahme über Wirkung eine prüfbare Zahl (C0–C6)? |
| [beobachtungen.md](./beobachtungen.md) | Wie kommen Messreihen in den Bestand, bevor die Quelle sie verwirft? |
| [multi-user.md](./multi-user.md) | Wer darf was sehen (Identität, Nutzergraphen, ACL)? |
| [selbstmodell.md](./selbstmodell.md) | Wie beschreibt sich der Workspace in seinem eigenen Graphen? |
| [obsidian-kompatibilitaet.md](./obsidian-kompatibilitaet.md) | Was geht beim Round-Trip mit einem Vault verloren — und was nicht? |
| [deployment.md](./deployment.md) | Ein Image, drei Runtimes: wie wird betrieben? |

## Entscheidungen und Widersprüche

| Dokument | Rolle |
|---|---|
| [decisions/](./decisions/) | ADRs: begründete Technik-Entscheidungen mit Messwerten (Store, SHACL-Bibliothek) |
| [spec-widersprueche.md](./spec-widersprueche.md) | Wo eine Spec sich selbst widerspricht: festgehalten, vorgelegt, entschieden. Eine Session verhandelt die Spec nicht neu — sie trägt hier ein |
| [analyse-2026-08.md](./analyse-2026-08.md) | **Historisch**: Bestandsaufnahme des Prototyps (2026-08-08) und die Roadmap §5, deren Nummerierung TODO.md bis heute benutzt. Die Abschnitte 1–4 und 7 werden bewusst nicht fortgeschrieben |
