# Multi-User, Nutzergraphen und Zugriffssteuerung

Betriebs- und Architekturdoku zu [GRAPH_CORE_SPEC.md §17](../GRAPH_CORE_SPEC.md)
(Meilenstein M13). Gilt für die Runtime `server`; `local` und `ha-addon`
laufen mit einem impliziten Einzelnutzer **durch dieselbe Codebahn** — der
Übergang ist eine Konfigurationsfrage, keine Datenmigration.

## Das Modell in fünf Sätzen

1. Jeder Nutzer besitzt einen eigenen Graph-Satz `graph/u/<userId>/*`
   (`workspace`, `public`, `presentation`, `import/<connectorId>`,
   `inferred/<scope>`).
2. Geteilte Räume sind eigene Graphen `graph/shared/<spaceId>` mit einer
   `ow:Space`-Entität in `graph/meta`.
3. Rechte gelten **pro Named Graph** und liegen als Web-Access-Control-RDF
   in `graph/acl` — in derselben Welt wie die Daten.
4. Alle Lesepfade beziehen ihr Dataset über **einen** Resolver; das
   Ergebnis wird in die Query injiziert, nie nachgefiltert.
5. Ohne Regel ist nichts sichtbar. Auch nicht für den Eigentümer — dessen
   Recht steht als Tripel im Graphen, nicht als `if` im Code.

## Identität

Die Identitäts-Schicht (M12, `src/lib/platform/auth/`) liefert `userId`
und Gruppen; `OW_AUTH_MODE` wählt das Verfahren:

| Modus | Herkunft der Identität |
|---|---|
| `single-user` (Default) | keine — der Workspace gehört einem Nutzer |
| `ha-ingress` | Home-Assistant-Header (`x-remote-user-id`) |
| `proxy-header` | vorgelagerter oauth2-proxy (`x-forwarded-user`) |
| `oidc-bearer` | Bearer-Token der Anfrage, JWKS-geprüft |

**Wichtig**: Läuft ein Anmeldeverfahren und kommt eine Anfrage ohne
geprüfte Identität an, ist sie **anonym** — nicht der Einzelnutzer. Das
entscheidet `authzIdentity` in `src/lib/graph/server/context.ts`; ohne
diese Umsetzung wäre jeder fehlende Header ein Generalschlüssel.

## Rechte in `graph/acl`

```turtle
@prefix acl:  <http://www.w3.org/ns/auth/acl#> .
@prefix foaf: <http://xmlns.com/foaf/0.1/> .

<…/authorization/u-alice-workspace--user-bob>
    a              acl:Authorization ;
    acl:accessTo   <…/graph/u/alice/workspace> ;
    acl:agent      <…/user/bob> ;
    acl:mode       acl:Read .
```

Prinzipale: `acl:agent` (Nutzer), `acl:agentGroup` (`foaf:Group`),
`acl:agentClass acl:AuthenticatedAgent` (jeder Angemeldete),
`acl:agentClass foaf:Agent` (jeder, auch anonym).

Modi und ihre Implikation (in `authz/acl.ts` festgelegt, weil WAC sie
offenlässt):

| Modus | schließt ein | gedacht für |
|---|---|---|
| `acl:Control` | Read, Append, Write | Eigentümer, Verwalter |
| `acl:Write` | Read, Append | Mitarbeit |
| `acl:Append` | — | beitragen, ohne den Bestand zu sehen |
| `acl:Read` | — | lesen |

Rollen (`reader`, `contributor`, `editor`, `owner`) sind **benannte
Modus-Bündel** für die Oberfläche, keine zweite Rechte-Welt. Die
Mitgliederliste eines Raums ist genau die Menge der Regeln auf seinem
Graphen — es gibt keine zweite Liste.

### Standardregeln beim Start

`ensureDefaultAuthorizations` legt an, was fehlt (und ändert nie, was ein
Verwalter gesetzt hat):

| Graph | Standardregel |
|---|---|
| `graph/u/<id>/*` | Eigentümer `Control` |
| `graph/u/<id>/public` | zusätzlich `foaf:Agent` `Read` (§17.5) |
| `graph/shared/<id>` | Eigentümer des Raums `Control` |
| `graph/meta` | Verwalter `Control`, Angemeldete `Read` |
| `graph/vocab`, `graph/shapes` | Verwalter `Control`, öffentlich `Read` |
| `graph/acl` | **keine** — der Graph ist aus jedem Dataset ausgeschlossen |

`OW_ADMIN_USERS` (kommagetrennt, Default: der Einzelnutzer) ist der Seed
der Verwalter. Er wirkt **nur beim Anlegen fehlender Regeln**; danach ist
`graph/acl` die Wahrheit.

`graph/meta` ist instanzweit und ausdrücklich geteilt (Selbstmodell nach
§18: Module, Connectors, Skills, Räume, Nutzer). Nutzerprivate Inhalte
gehören nicht hinein.

## Durchsetzung

```
Identität ──► grantForIdentity (authz/resolve.ts)  ──► AccessGrant
                     │  liest graph/acl
                     ▼
   resolveDataset (SPARQL)     retrievalDataset (Retrieval)
                     │  injiziert FROM / FROM NAMED
                     ▼
                  Store-Query
```

* Der Grant kann **nur wegnehmen**. Ein Pfad, der ihn überspringt, bekommt
  kein größeres Dataset, sondern gar keines.
* Eine Query auf einen gesperrten Graphen liefert ein **leeres Ergebnis**,
  keinen 403 — ein 403 bestätigt die Existenz.
* `graph/acl` ist über kein Muster und keine Regel erreichbar, auch nicht
  für Verwalter. Regeln liest und schreibt ausschließlich
  `authz/acl-graph.ts`, und das verlangt `Control` auf dem betroffenen
  Graphen.
* `tests/graph/acl.test.ts` enthält einen **Architekturtest**: Jede Datei
  unter `src/lib/graph` und `src/app/api`, die `store.query(` aufruft, muss
  ihr Dataset nachweislich vom Resolver beziehen.

### SPARQL UPDATE

`writableGraphs` verengt zusätzlich: Ist die Liste gesetzt, ist alles
geschützt, was nicht darin steht — auch ein Graph, den es noch nicht gibt.
Der Update-Guard vergleicht Fingerabdrücke vor und nach der Transaktion und
rollt zurück; die Ablehnung unterscheidet nicht zwischen
„systemverwaltet", „fremd" und „existiert nicht".

### Graphen, die erst zur Laufzeit entstehen

Der Grant kommt ausschließlich aus `graph/acl`, und die Standardregeln
entstehen beim Start. Ein Graph, der DANACH angelegt wird — der
Import-Graph eines Connector-Laufs, ein Inferenz-Graph des Reasoners —
hätte deshalb keine Regel und wäre bis zum nächsten Neustart unsichtbar.
`ensureGraphAuthorizations` (aufgerufen im Anfrage-Kontext, vor der
Grant-Berechnung) zieht sie nach: derselbe Auffüller wie beim Start,
No-Op ohne neue Graphen, und niemals ein Zurücksetzer bestehender Regeln.

## Nebenkanäle (§17.4)

| Kanal | Umsetzung |
|---|---|
| Retrieval über Hops | Dataset-Klammer **vor** der Expansion; ein Knoten wird nur aufgenommen, wenn im erlaubten Dataset über ihn etwas ausgesagt ist |
| Inferenz | scope-partitioniert (M7); der Reasoner läuft je Nutzer über dessen Graphen und schreibt nach `graph/u/<id>/inferred/<scope>` |
| Volltext-/Vektorindex | pro Dataset gebaut (Cache-Schlüssel = sortierte Graph-IRIs), nicht global mit gefilterter Trefferliste |
| `owl:sameAs` über Scope-Grenzen | kein Reasoning über Scope-Grenzen — die Regelmenge sieht nur das Scope-Dataset |
| Ausgehende Föderation | Bound-Join schickt nur Bindungen aus dem erlaubten Dataset; Negativtest über den ausgehenden Query-Text |
| Fehlermeldungen/Timings | gesperrt und nicht existent liefern dieselbe Antwort (byte-gleich getestet für DESCRIBE, ASK, MCP `graph_describe`, Resource) |
| Export | `exportScopeFor` liefert nur die Verzeichnisse des Nutzers; instanzweite Bestände nur für Verwalter |
| Git-Sync | ein `git-backup` verlangt `Control` auf **jedem** Graphen des Snapshots — sonst 403 mit Begründung |

Die vollständige Matrix aus §17.6 liegt als
`tests/graph/multi-user.test.ts` vor, jede Zeile als eigener Negativtest.

## Öffentlicher Teilgraph (§17.5)

* `graph/u/<id>/public` ist anonym lesbar und föderierbar — über dieselbe
  ACL wie alles andere (`foaf:Agent` `Read` als Standardregel), nicht über
  eine Sonderregel im Code.
* `GET /.well-known/void` beschreibt **den Umfang des Anfragenden** als
  `void:Dataset` (Tripel, Entitäten, Klassen, Properties, Vokabulare).
* Entitäts-IRIs dereferenzieren unter `/u/<userId>/<type>/<id>` mit
  Content Negotiation (Turtle, JSON-LD, HTML mit eingebettetem JSON-LD).
  **Grenze**: Das funktioniert nur mit einer HTTP-Instanz-Base
  (`OW_INSTANCE_BASE=https://…/`). Der Default `urn:ow:<uuid>:` ist nicht
  dereferenzierbar — die Route sagt das ehrlich mit 404 statt es
  vorzuspielen.
* Anonyme Zugriffe laufen gegen ein Rate-Limit
  (`authz/public-limits.ts`, 60/min je Absender), die eingehende
  Föderation zusätzlich gegen Zeit- und Ergebnis-Limit.

## Datei-Projektion und Persistenz

* Der Einzelnutzer behält `data/docs`, `data/tasks`, `data/canvas`. Jeder
  weitere Nutzer bekommt `data/u/<userId>/…` — zwei Projektionen können
  sich damit nicht überschreiben.
* `graph/acl` wird als `data/graph/acl.nq` gesichert, **neben** dem
  Manifest. Damit überlebt es einen Neustart, wird aber von keinem
  manifest-getriebenen Pfad angefasst: kein `bidirectional`-Restore liest
  es als kanonischen Graphen zurück, kein Nutzer-Export enthält es.
  Ausnahme mit Ansage: Ein Git-Backup, dessen Zielverzeichnis `data/graph`
  selbst ist (die Empfehlung für Modus `backup`), committet die Datei als
  Teil des Arbeitsverzeichnisses. Das ist unbedenklich — ein Backup darf
  ohnehin nur anlegen, wer `control` auf jedem enthaltenen Graphen hat.

## Zugänge für Maschinen

`OW_MCP_TOKENS` bildet seit M13 nur noch **Token → Nutzer** ab:

```json
[
  { "id": "desktop", "token": "…mindestens-16-zeichen…", "user": "alice", "sparql": true },
  { "id": "readonly", "token": "…", "user": "alice", "scopes": ["public"] }
]
```

Die Rechte eines Zugangs sind die Rechte seines Nutzers aus `graph/acl`.
`scopes` ist optional und kann sie nur **weiter verengen** — ein Zugang
über die Rechte seines Nutzers hinaus ist nicht konfigurierbar.
`write: true` plus `writeScope` bleibt zusätzlich nötig, damit
`graph_write` überhaupt existiert.

## Was M13 nicht ist

* Kein Echtzeit-Collaborative-Editing (SPEC §15). Der Store bleibt
  single-writer pro Graph.
* Keine Tripel-Granularität. Wer feiner unterscheiden will, schneidet den
  Graphen feiner (§17.2).
* Kein eigenes Anmeldeverfahren: Den OIDC-Fluss führt weiterhin der
  vorgelagerte Proxy (`deploy/server/docker-compose.yml`), Home Assistant
  seinen Ingress. Diese Schicht liest die Identität, sie erzeugt sie nicht.
* Chats und Termine waren zum Zeitpunkt von M13 noch keine
  Graph-Bürger. Seit M15 sind sie es: Sie liegen in
  `graph/<u>/workspace` und erben damit Nutzerskalierung, ACL und Export
  ohne neuen Mechanismus. Die Einstellungen (Theme, Runtime, Speicherort)
  bleiben instanzweit — sie beschreiben die Installation, nicht das
  Wissen eines Nutzers.
