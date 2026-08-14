/**
 * Vokabular-Konstanten des Graph-Kerns.
 *
 * Die Vokabular-Base ist produktweit konstant (SPEC §3.2): Sie ist Teil des
 * Produkts und wandert mit dem Code, nicht mit dem Deployment. Sie ist
 * bewusst NICHT konfigurierbar — zwei Installationen, die unterschiedliche
 * Basen prägen würden, hätten für jeden RDF-Client zwei unverwandte
 * Vokabulare und könnten nicht föderieren.
 *
 * Deployment-spezifische Zusatzterme entstehen ausschließlich unter der
 * Erweiterungs-Base `<deploymentBase>/ns/ext#` (Prefix `owx:`), mit
 * rdfs:subClassOf/subPropertyOf auf den nächstliegenden ow:- oder
 * Standard-Term.
 *
 * `scripts/check-ontology.ts` erzwingt in CI, dass jeder hier exportierte
 * ow:-Term in `ontology/ow.ttl` definiert ist und umgekehrt.
 */

/** Produktweit konstante Vokabular-Base. Niemals pro Deployment ändern. */
export const OW_VOCAB_BASE = 'https://pajew-ski.github.io/open-workspace/ns/v1#' as const;

/** IRI der Ontologie selbst (ohne Fragment) — Ziel von rdfs:isDefinedBy. */
export const OW_ONTOLOGY_IRI = 'https://pajew-ski.github.io/open-workspace/ns/v1' as const;

/**
 * Frontmatter-Namespace (SPEC §10): Quelltreue-Träger für YAML-Frontmatter-
 * Keys aus Obsidian-Vaults. Bewusst NICHT unter /ns/v1# — die Properties
 * entstehen dynamisch aus Nutzerdaten (ein Term pro Key) und sind kein
 * Produktvokabular; der Ontologie-CI-Check prüft nur /ns/v1#. Bekannte
 * Keys werden ZUSÄTZLICH auf echte Terme gemappt (schema:name, dcterms:…);
 * der fm:-Träger garantiert den verlustfreien Round-Trip unbekannter Keys.
 */
export const OW_FRONTMATTER_BASE = 'https://pajew-ski.github.io/open-workspace/ns/frontmatter#' as const;

export const PREFIXES = {
    ow: OW_VOCAB_BASE,
    rdf: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#',
    rdfs: 'http://www.w3.org/2000/01/rdf-schema#',
    owl: 'http://www.w3.org/2002/07/owl#',
    schema: 'https://schema.org/',
    dcterms: 'http://purl.org/dc/terms/',
    prov: 'http://www.w3.org/ns/prov#',
    foaf: 'http://xmlns.com/foaf/0.1/',
    skos: 'http://www.w3.org/2004/02/skos/core#',
    sh: 'http://www.w3.org/ns/shacl#',
    void: 'http://rdfs.org/ns/void#',
    /** Web Access Control (SPEC §17.2): die Rechte leben im selben RDF wie die Daten. */
    acl: 'http://www.w3.org/ns/auth/acl#',
    /**
     * Sensors, Observations, Samples and Actuators (W3C/OGC). Der Standard
     * für Sensorik — Plattform, Sensor, Aktor, beobachtete Größe. Wird für
     * die Struktur externer Messquellen (Home Assistant) verwendet, damit
     * kein eigenes Geräte-Vokabular entsteht (Invariante 8).
     */
    sosa: 'http://www.w3.org/ns/sosa/',
    /**
     * OBO Relations Ontology (CAUSAL_LAYER_SPEC Invariante C8). Trägt die
     * kausale Kante selbst: `RO_0002411 causally upstream of` ist eine
     * OWL-Objekteigenschaft mit definierter Semantik — Ursache geht der
     * Wirkung zeitlich voraus — und damit genau die Relation, die ein DAG
     * behauptet. Deshalb kein eigener `ow:`-Term für die Kante.
     */
    obo: 'http://purl.obolibrary.org/obo/',
    xsd: 'http://www.w3.org/2001/XMLSchema#',
} as const;

const ow = (local: string) => `${OW_VOCAB_BASE}${local}` as const;
const schemaOrg = (local: string) => `${PREFIXES.schema}${local}` as const;

/**
 * Eigene Terme (SPEC §4.3). Nur diese — jeder weitere Term braucht zuerst
 * den Nachweis in ontology/ow.ttl, dass kein Standard-Äquivalent existiert.
 */
export const OW = {
    // Klassen
    Document: ow('Document'),
    Project: ow('Project'),
    Task: ow('Task'),
    Canvas: ow('Canvas'),
    Skill: ow('Skill'),
    Agent: ow('Agent'),
    Tool: ow('Tool'),
    ToolProvider: ow('ToolProvider'),
    Connector: ow('Connector'),
    FederatedEndpoint: ow('FederatedEndpoint'),
    // AI-Schicht als Graph-Bürger (§18-Spiegel, M15)
    InferenceProvider: ow('InferenceProvider'),
    Model: ow('Model'),
    // Selbstmodell und Einführungsstrecke (SPEC §18 / M14)
    Module: ow('Module'),
    OnboardingStep: ow('OnboardingStep'),
    // Vernetzung
    linksTo: ow('linksTo'),
    inFolder: ow('inFolder'),
    embedded: ow('embedded'),
    // Aufgaben
    blockedBy: ow('blockedBy'),
    blocks: ow('blocks'),
    subTaskOf: ow('subTaskOf'),
    inProject: ow('inProject'),
    // Quelltreue nativer Entitäten (Abschluss SPEC §12.4): exakter
    // Zustand neben der gröberen Standard-Projektion (Muster wie fm: in M4)
    workflowStatus: ow('workflowStatus'),
    priority: ow('priority'),
    taskKind: ow('taskKind'),
    deferredUntil: ow('deferredUntil'),
    estimatedEffort: ow('estimatedEffort'),
    actualEffort: ow('actualEffort'),
    dependencyKind: ow('dependencyKind'),
    // Skills/Agenten/Werkzeuge
    trigger: ow('trigger'),
    skillSource: ow('skillSource'),
    providesSkill: ow('providesSkill'),
    agentCardUrl: ow('agentCardUrl'),
    endpoint: ow('endpoint'),
    securityScheme: ow('securityScheme'),
    transport: ow('transport'),
    inputSchema: ow('inputSchema'),
    providedBy: ow('providedBy'),
    requiresTool: ow('requiresTool'),
    // Connectors und Föderation
    connectorKind: ow('connectorKind'),
    locator: ow('locator'),
    revision: ow('revision'),
    syncState: ow('syncState'),
    targetGraph: ow('targetGraph'),
    sparqlEndpoint: ow('sparqlEndpoint'),
    trustLevel: ow('trustLevel'),
    // Kalender und Chats als Graph-Bürger (M15)
    enabled: ow('enabled'),
    allDay: ow('allDay'),
    messageRole: ow('messageRole'),
    // AI-Konfiguration (M15)
    providerKind: ow('providerKind'),
    toolCallMode: ow('toolCallMode'),
    defaultModel: ow('defaultModel'),
    // Präsentationsbezug
    rendersNode: ow('rendersNode'),
    // Präsentation der Chats (nur graph/presentation, Invariante 2)
    generativeSurface: ow('generativeSurface'),
    selected: ow('selected'),
    // Canvas-Layout (nur graph/presentation, SPEC §9 / M5)
    CanvasNode: ow('CanvasNode'),
    CanvasEdge: ow('CanvasEdge'),
    nodeKind: ow('nodeKind'),
    cardKind: ow('cardKind'),
    xPosition: ow('xPosition'),
    yPosition: ow('yPosition'),
    filePath: ow('filePath'),
    background: ow('background'),
    backgroundStyle: ow('backgroundStyle'),
    viewportX: ow('viewportX'),
    viewportY: ow('viewportY'),
    viewportZoom: ow('viewportZoom'),
    edgeFrom: ow('edgeFrom'),
    edgeTo: ow('edgeTo'),
    fromSide: ow('fromSide'),
    toSide: ow('toSide'),
    fromEnd: ow('fromEnd'),
    toEnd: ow('toEnd'),
    // Generierte Query-Views (SPEC §9 / M5)
    QueryView: ow('QueryView'),
    queryText: ow('queryText'),
    layoutMethod: ow('layoutMethod'),
    // Suche + Multi-Hop-Retrieval (SPEC §7.5/§7.7 / M8)
    RetrievalProfile: ow('RetrievalProfile'),
    retrievalConfig: ow('retrievalConfig'),
    weight: ow('weight'),
    // Multi-User (SPEC §17.1 / M13)
    Space: ow('Space'),
    spaceGraph: ow('spaceGraph'),
    // Selbstmodell (SPEC §18 / M14)
    route: ow('route'),
    entityType: ow('entityType'),
    capability: ow('capability'),
    runtime: ow('runtime'),
    availableConnectorKind: ow('availableConnectorKind'),
    // Beobachtungsgrößen und ihre Erfassung (Kausal-Layer, CAUSAL_LAYER_SPEC
    // §5/§6). Die Werte selbst stehen NIE im Store — hier liegt nur, was
    // erfasst wird, woraus, wie verdichtet und bis wann (Invariante C3).
    Variable: ow('Variable'),
    observationSource: ow('observationSource'),
    observationKind: ow('observationKind'),
    aggregation: ow('aggregation'),
    samplingInterval: ow('samplingInterval'),
    captureEnabled: ow('captureEnabled'),
    captureState: ow('captureState'),
    capturedFrom: ow('capturedFrom'),
    capturedThrough: ow('capturedThrough'),
    observationCount: ow('observationCount'),
    retentionDays: ow('retentionDays'),
    // Kausalmodell als Graph-Bürger (CAUSAL_LAYER_SPEC §5, C0). Die Kante
    // selbst ist fremd (RO.causallyUpstreamOf, Invariante C8); eigen ist
    // nur, was über sie ausgesagt wird — und das hängt als RDF-1.2-
    // Annotation am benannten Reifier, nicht in einer Nebentabelle (§5.3).
    CausalModel: ow('CausalModel'),
    edgeClass: ow('edgeClass'),
    temporalLag: ow('temporalLag'),
    evidenceLevel: ow('evidenceLevel'),
    // Schätzung und Refutation (CAUSAL_LAYER_SPEC §5.2/§13, C4). Was hier
    // entsteht, lebt ausschließlich in graph/<u>/inferred/causal/<scope>
    // (Invariante C4) — bis auf den Estimand, der die FRAGE ist und
    // deshalb wie ein Retrieval-Profil in graph/meta steht. Die Zahlen
    // hängen als Annotation am selben Reifier wie die Kante, nur in einem
    // anderen Named Graph: So bleibt die Annahme frei von Ergebnissen.
    CausalStudy: ow('CausalStudy'),
    Estimand: ow('Estimand'),
    AdjustmentSet: ow('AdjustmentSet'),
    Refutation: ow('Refutation'),
    treatment: ow('treatment'),
    outcome: ow('outcome'),
    controlOutcome: ow('controlOutcome'),
    interventionAt: ow('interventionAt'),
    identificationStrategy: ow('identificationStrategy'),
    estimator: ow('estimator'),
    adjustedFor: ow('adjustedFor'),
    modelRevision: ow('modelRevision'),
    seed: ow('seed'),
    studyVerdict: ow('studyVerdict'),
    effectSize: ow('effectSize'),
    standardError: ow('standardError'),
    ciLow: ow('ciLow'),
    ciHigh: ow('ciHigh'),
    refutationMethod: ow('refutationMethod'),
    refutationVerdict: ow('refutationVerdict'),
    refutationPassed: ow('refutationPassed'),
} as const;

export type OwTerm = (typeof OW)[keyof typeof OW];

/** Häufig verwendete Standard-Terme, damit kein Modul IRI-Strings tippt. */
export const SCHEMA = {
    DigitalDocument: schemaOrg('DigitalDocument'),
    TechArticle: schemaOrg('TechArticle'),
    BlogPosting: schemaOrg('BlogPosting'),
    HowTo: schemaOrg('HowTo'),
    CreativeWork: schemaOrg('CreativeWork'),
    DefinedTerm: schemaOrg('DefinedTerm'),
    Project: schemaOrg('Project'),
    Action: schemaOrg('Action'),
    Person: schemaOrg('Person'),
    Event: schemaOrg('Event'),
    /** Abonnierte Quelle gleichartiger Elemente — hier: ein ICS-Kalender. */
    DataFeed: schemaOrg('DataFeed'),
    Conversation: schemaOrg('Conversation'),
    Message: schemaOrg('Message'),
    SoftwareApplication: schemaOrg('SoftwareApplication'),
    WebPage: schemaOrg('WebPage'),
    /** Oberklasse föderierter Endpoints (ow:FederatedEndpoint ⊑ schema:Service, SPEC §7.4). */
    Service: schemaOrg('Service'),
    name: schemaOrg('name'),
    alternateName: schemaOrg('alternateName'),
    author: schemaOrg('author'),
    text: schemaOrg('text'),
    description: schemaOrg('description'),
    about: schemaOrg('about'),
    mentions: schemaOrg('mentions'),
    inLanguage: schemaOrg('inLanguage'),
    actionStatus: schemaOrg('actionStatus'),
    startTime: schemaOrg('startTime'),
    endTime: schemaOrg('endTime'),
    /** Termin-Zeitraum (schema:Event) — getrennt von startTime/endTime an schema:Action. */
    startDate: schemaOrg('startDate'),
    endDate: schemaOrg('endDate'),
    location: schemaOrg('location'),
    /** Versandzeitpunkt einer schema:Message. */
    dateSent: schemaOrg('dateSent'),
    /** Oberproperty von ow:providedBy — trägt Modell → Inference-Provider. */
    provider: schemaOrg('provider'),
    hasPart: schemaOrg('hasPart'),
    isPartOf: schemaOrg('isPartOf'),
    keywords: schemaOrg('keywords'),
    error: schemaOrg('error'),
    url: schemaOrg('url'),
    softwareVersion: schemaOrg('softwareVersion'),
    /** Schema-Version der Persistenz (Snapshot-Manifest, SPEC §8.1/§18). */
    schemaVersion: schemaOrg('schemaVersion'),
    /** Präsentationswerte (nur graph/presentation): Invariante 8 vor eigenem Term. */
    width: schemaOrg('width'),
    height: schemaOrg('height'),
    color: schemaOrg('color'),
    ActiveActionStatus: schemaOrg('ActiveActionStatus'),
    CompletedActionStatus: schemaOrg('CompletedActionStatus'),
    PotentialActionStatus: schemaOrg('PotentialActionStatus'),
    /** Ort einer Messquelle: Home-Assistant-Bereich und -Etage. */
    Place: schemaOrg('Place'),
    containedInPlace: schemaOrg('containedInPlace'),
    /** Grobe Einordnung einer Quelle (HA-Domain: sensor, light, climate, …). */
    category: schemaOrg('category'),
    /** Maßeinheit als Text, quelltreu aus `unit_of_measurement`. */
    unitText: schemaOrg('unitText'),
    /**
     * Revision eines Artefakts (Kausalmodell, C1). Fremdes Vokabular vor
     * eigenem (Invariante 8): Eine Studie beruft sich später auf genau
     * diese Zahl (Invariante C7), und `schema:version` sagt das bereits.
     */
    version: schemaOrg('version'),
    /**
     * Studien-Signatur (C7, C4). Fremdes Vokabular vor eigenem
     * (Invariante 8): Für Kennzahl, Rolle, Zeitraum und Umfang eines
     * Datensatzes gibt es schema.org-Terme, und ein eigener wäre nur eine
     * zweite Schreibweise desselben.
     */
    value: schemaOrg('value'),
    roleName: schemaOrg('roleName'),
    /** Zeitraum, für den ein Inhalt gilt — hier: das Fenster der Studie. */
    temporalCoverage: schemaOrg('temporalCoverage'),
    numberOfItems: schemaOrg('numberOfItems'),
} as const;

/**
 * SOSA (W3C/OGC Semantic Sensor Network). Trägt die Struktur externer
 * Messquellen: Plattform (Gerät) hostet Sensoren/Aktoren, ein Sensor
 * beobachtet eine Größe. Genau die Topologie, die ein Kausalmodell als
 * Vorannahme braucht — und ein etablierter Standard, also kein eigener
 * Term (Invariante 8).
 */
export const SOSA = {
    Platform: `${PREFIXES.sosa}Platform`,
    Sensor: `${PREFIXES.sosa}Sensor`,
    Actuator: `${PREFIXES.sosa}Actuator`,
    ObservableProperty: `${PREFIXES.sosa}ObservableProperty`,
    hosts: `${PREFIXES.sosa}hosts`,
    isHostedBy: `${PREFIXES.sosa}isHostedBy`,
    observes: `${PREFIXES.sosa}observes`,
} as const;

/**
 * OBO Relations Ontology — die kausale Kante (CAUSAL_LAYER_SPEC §5.3,
 * Invariante C8: fremdes Vokabular vor eigenem).
 *
 * Geprüfte Alternativen und warum sie es nicht sind:
 *  - `wdt:P828 has cause` / `wdt:P1542 has effect` (Wikidata) sind
 *    Aussagen ÜBER Wikidata-Items; P828 zeigt zudem von der Wirkung auf
 *    die Ursache. Als Prädikat außerhalb von Wikidata sind sie nicht
 *    definiert, und die umgekehrte Leserichtung machte jeden DAG-Export
 *    zur Fehlerquelle.
 *  - `prov:wasDerivedFrom` ist ausdrücklich KEINE Kausalität (C8) und
 *    darf nicht dafür missbraucht werden.
 *  - `RO_0002410 causally related to` ist die symmetrische Oberrelation
 *    und trägt keine Richtung — ein DAG braucht die Richtung.
 */
export const RO = {
    /** `causally upstream of`: die Ursache geht der Wirkung voraus. */
    causallyUpstreamOf: `${PREFIXES.obo}RO_0002411`,
    /** Oberrelation ohne Richtung — nur für Alignment-Aussagen. */
    causallyRelatedTo: `${PREFIXES.obo}RO_0002410`,
} as const;

export const RDF = {
    type: `${PREFIXES.rdf}type`,
    reifies: `${PREFIXES.rdf}reifies`,
    /** RDF-1.2-Datentyp für strukturierte Literale (Listen/Maps aus YAML). */
    JSON: `${PREFIXES.rdf}JSON`,
} as const;

export const RDFS = {
    label: `${PREFIXES.rdfs}label`,
    comment: `${PREFIXES.rdfs}comment`,
    subClassOf: `${PREFIXES.rdfs}subClassOf`,
    subPropertyOf: `${PREFIXES.rdfs}subPropertyOf`,
    isDefinedBy: `${PREFIXES.rdfs}isDefinedBy`,
} as const;

export const OWL = {
    sameAs: `${PREFIXES.owl}sameAs`,
    inverseOf: `${PREFIXES.owl}inverseOf`,
    equivalentClass: `${PREFIXES.owl}equivalentClass`,
    equivalentProperty: `${PREFIXES.owl}equivalentProperty`,
    Class: `${PREFIXES.owl}Class`,
    ObjectProperty: `${PREFIXES.owl}ObjectProperty`,
    DatatypeProperty: `${PREFIXES.owl}DatatypeProperty`,
    Ontology: `${PREFIXES.owl}Ontology`,
} as const;

export const DCTERMS = {
    identifier: `${PREFIXES.dcterms}identifier`,
    created: `${PREFIXES.dcterms}created`,
    modified: `${PREFIXES.dcterms}modified`,
} as const;

export const PROV = {
    wasDerivedFrom: `${PREFIXES.prov}wasDerivedFrom`,
    wasAttributedTo: `${PREFIXES.prov}wasAttributedTo`,
    wasGeneratedBy: `${PREFIXES.prov}wasGeneratedBy`,
    /** Umkehrung von wasGeneratedBy — was eine Aktivität erzeugt hat (§18). */
    generated: `${PREFIXES.prov}generated`,
    /** Was eine Aktivität verwendet/betrachtet hat (§18). */
    used: `${PREFIXES.prov}used`,
    generatedAtTime: `${PREFIXES.prov}generatedAtTime`,
    /** Abschluss-Zeitpunkt (completedAt einer Aufgabe — schema:endTime trägt bereits die Fälligkeit, SPEC §4.2). */
    endedAtTime: `${PREFIXES.prov}endedAtTime`,
    Activity: `${PREFIXES.prov}Activity`,
    /** Was in einen Lauf eingegangen ist — die eingefrorene Eingabe (C7). */
    Entity: `${PREFIXES.prov}Entity`,
    SoftwareAgent: `${PREFIXES.prov}SoftwareAgent`,
} as const;

export const SKOS = {
    Concept: `${PREFIXES.skos}Concept`,
    prefLabel: `${PREFIXES.skos}prefLabel`,
    broader: `${PREFIXES.skos}broader`,
} as const;

export const FOAF = {
    Agent: `${PREFIXES.foaf}Agent`,
    Person: `${PREFIXES.foaf}Person`,
    Group: `${PREFIXES.foaf}Group`,
    /** Mitgliedschaft einer Gruppe (foaf:Group → foaf:Agent), SPEC §17.1. */
    member: `${PREFIXES.foaf}member`,
} as const;

/**
 * Web Access Control (SPEC §17.2). Bewusst das Standard-Vokabular und kein
 * eigenes: „die Rechte gehören in dieselbe Welt wie die Daten". Ein
 * fremder RDF-Client liest `graph/acl` damit ohne unser Produktvokabular.
 */
export const ACL = {
    Authorization: `${PREFIXES.acl}Authorization`,
    /** Prinzipal-Klasse „jeder angemeldete Nutzer". */
    AuthenticatedAgent: `${PREFIXES.acl}AuthenticatedAgent`,
    accessTo: `${PREFIXES.acl}accessTo`,
    agent: `${PREFIXES.acl}agent`,
    agentGroup: `${PREFIXES.acl}agentGroup`,
    agentClass: `${PREFIXES.acl}agentClass`,
    mode: `${PREFIXES.acl}mode`,
    owner: `${PREFIXES.acl}owner`,
    Read: `${PREFIXES.acl}Read`,
    Append: `${PREFIXES.acl}Append`,
    Write: `${PREFIXES.acl}Write`,
    Control: `${PREFIXES.acl}Control`,
} as const;

/** VoID (SPEC §17.5): Selbstbeschreibung des öffentlichen Teilgraphen. */
export const VOID = {
    Dataset: `${PREFIXES.void}Dataset`,
    sparqlEndpoint: `${PREFIXES.void}sparqlEndpoint`,
    triples: `${PREFIXES.void}triples`,
    entities: `${PREFIXES.void}entities`,
    classes: `${PREFIXES.void}classes`,
    properties: `${PREFIXES.void}properties`,
    vocabulary: `${PREFIXES.void}vocabulary`,
    uriSpace: `${PREFIXES.void}uriSpace`,
    class: `${PREFIXES.void}class`,
    classPartition: `${PREFIXES.void}classPartition`,
    rootResource: `${PREFIXES.void}rootResource`,
} as const;

export const XSD = {
    string: `${PREFIXES.xsd}string`,
    dateTime: `${PREFIXES.xsd}dateTime`,
    date: `${PREFIXES.xsd}date`,
    integer: `${PREFIXES.xsd}integer`,
    decimal: `${PREFIXES.xsd}decimal`,
    boolean: `${PREFIXES.xsd}boolean`,
    anyURI: `${PREFIXES.xsd}anyURI`,
    /** Abtastabstand einer Messreihe (ow:samplingInterval), ISO-8601-Dauer. */
    duration: `${PREFIXES.xsd}duration`,
} as const;

/** SPARQL-Prolog mit allen Standard-Prefixes, für lesbare Queries. */
export const SPARQL_PREFIXES = Object.entries(PREFIXES)
    .map(([prefix, iri]) => `PREFIX ${prefix}: <${iri}>`)
    .join('\n');
