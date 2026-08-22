# Open Workspace als Home-Assistant-Add-on

Der Workspace läuft als Add-on im selben Container-Image wie die
Server-Variante (SPEC §5.2). Home Assistant liefert die Oberfläche über
**Ingress** aus — also ohne eigenen Port, ohne eigenes Zertifikat und mit
der Anmeldung von Home Assistant.

## Installation

1. In Home Assistant unter **Einstellungen → Add-ons → Add-on-Store →
   ⋮ → Repositories** dieses Repository hinzufügen.
2. „Open Workspace" installieren und starten.
3. Über den Seitenleisten-Eintrag **Workspace** öffnen.

## Optionen

| Option | Bedeutung |
|---|---|
| `log_level` | Protokolltiefe des Add-ons |
| `instance_base` | Feste Instanz-Basis für IRIs (`OW_INSTANCE_BASE`). Nur setzen, wenn der Graph mit einer anderen Installation zusammenwachsen soll — sonst vergibt der Workspace sie einmalig selbst. |
| `vault_roots` | Zusätzliche erlaubte Wurzeln für Obsidian-Vaults, z. B. `/share/vaults` |
| `git_roots` | Zusätzliche erlaubte Wurzeln für `git-backup`, z. B. `/share/backup` |

`/share` ist schreibbar eingebunden — dort liegen Vaults und Git-Ziele, die
auch andere Add-ons sehen sollen. Alles andere gehört nach `/data` und wird
vom Add-on verwaltet.

## Daten

Der Bestand liegt in `/data` (persistent über Add-on-Updates hinweg). Bei
jedem Start ergänzt das Add-on fehlende Auslieferungsdateien aus dem
mitgelieferten `seed/`; was dort schon liegt, fasst es nicht an. Der
RDF-Snapshot liegt unter `/data/graph` — er ist die kanonische Ablage
(SPEC §8.1) und lässt sich mit dem Connector `git-backup` versionieren.

Für das Backup ein eigenes Ziel wählen, etwa unter `/share` (per Option
`git_roots` freigeben): `/data/graph` ist der Live-Snapshot, den die App
nach jeder Mutation neu schreibt, und ein Backup-Ziel innerhalb eines
fremden Git-Working-Tree lehnt der Connector ab.

## Ingress und Links

Der Supervisor liefert die App unter `/api/hassio_ingress/<token>/` aus und
entfernt dieses Präfix, bevor er die Anfrage weiterreicht. Das Add-on setzt
es beim Start in den Build ein und stellt einen schlanken Proxy davor, der
es wieder ergänzt — deshalb stimmen Links, Assets, Service-Worker-Scope und
PWA-Manifest auch unter Ingress.

Ändert Home Assistant den Ingress-Token, antwortet das Add-on einmal mit
einem Hinweis und startet neu; danach stimmen die Links wieder.

## Zugriff auf Home Assistant

Das Add-on-Manifest setzt `homeassistant_api: true`. Der Supervisor legt
daraufhin `SUPERVISOR_TOKEN` in die Umgebung, und damit ist
`http://supervisor/core/api` erreichbar.

**Was damit möglich wird** — der Grund für die Rechteerweiterung:

- der Connector **Home Assistant** materialisiert die Struktur der
  Installation als Graph: Etagen, Bereiche, Geräte, Entitäten und die von
  ihnen beobachteten Größen (SOSA);
- die **Beobachtungs-Erfassung** (`/graph/observations`) legt ausgewählte
  Messreihen dauerhaft ab, bevor der Recorder sie nach `purge_keep_days`
  verwirft — siehe [docs/beobachtungen.md](../../docs/beobachtungen.md).

**Was das Add-on damit nicht tut**: schalten. `homeassistant_api` erlaubt
technisch auch Service-Calls; der Workspace macht davon keinen Gebrauch. Es
gibt keinen Schreibpfad zu Home Assistant, keinen Service-Call im Code und
keine Oberfläche dafür. Wer das prüfen will: `tests/graph/home-assistant.test.ts`
hält fest, dass der Connector `write: false` trägt und kein `push` besitzt.

Ohne dieses Recht startet das Add-on normal — es sieht von Home Assistant
dann nur nichts, und beide Funktionen melden das mit einem Hinweis auf
genau diese Zeile im Manifest statt mit einem nackten 401.

## Was in dieser Runtime nicht geht

- **Multi-User**: Das Add-on ist Einzelnutzer-Betrieb (SPEC §5.2). Die
  Identität kommt aus den Ingress-Headern von Home Assistant.
- **Direkter Port**: Es gibt bewusst keinen offenen Port neben Ingress.
  MCP-Server und Föderations-Endpoint sind über den Ingress-Pfad erreichbar
  und brauchen weiterhin ein Token (`OW_MCP_TOKENS`).
