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
    // Vernetzung
    linksTo: ow('linksTo'),
    inFolder: ow('inFolder'),
    // Aufgaben
    blockedBy: ow('blockedBy'),
    blocks: ow('blocks'),
    subTaskOf: ow('subTaskOf'),
    inProject: ow('inProject'),
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
    // Connectors und Föderation
    connectorKind: ow('connectorKind'),
    locator: ow('locator'),
    revision: ow('revision'),
    syncState: ow('syncState'),
    targetGraph: ow('targetGraph'),
    sparqlEndpoint: ow('sparqlEndpoint'),
    trustLevel: ow('trustLevel'),
    // Präsentationsbezug
    rendersNode: ow('rendersNode'),
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
    Conversation: schemaOrg('Conversation'),
    Message: schemaOrg('Message'),
    SoftwareApplication: schemaOrg('SoftwareApplication'),
    name: schemaOrg('name'),
    author: schemaOrg('author'),
    text: schemaOrg('text'),
    description: schemaOrg('description'),
    about: schemaOrg('about'),
    mentions: schemaOrg('mentions'),
    inLanguage: schemaOrg('inLanguage'),
    actionStatus: schemaOrg('actionStatus'),
    startTime: schemaOrg('startTime'),
    endTime: schemaOrg('endTime'),
    hasPart: schemaOrg('hasPart'),
    isPartOf: schemaOrg('isPartOf'),
    keywords: schemaOrg('keywords'),
    ActiveActionStatus: schemaOrg('ActiveActionStatus'),
    CompletedActionStatus: schemaOrg('CompletedActionStatus'),
    PotentialActionStatus: schemaOrg('PotentialActionStatus'),
} as const;

export const RDF = {
    type: `${PREFIXES.rdf}type`,
    reifies: `${PREFIXES.rdf}reifies`,
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
    generatedAtTime: `${PREFIXES.prov}generatedAtTime`,
    Activity: `${PREFIXES.prov}Activity`,
} as const;

export const SKOS = {
    Concept: `${PREFIXES.skos}Concept`,
    prefLabel: `${PREFIXES.skos}prefLabel`,
    broader: `${PREFIXES.skos}broader`,
} as const;

export const XSD = {
    string: `${PREFIXES.xsd}string`,
    dateTime: `${PREFIXES.xsd}dateTime`,
    date: `${PREFIXES.xsd}date`,
    integer: `${PREFIXES.xsd}integer`,
    decimal: `${PREFIXES.xsd}decimal`,
    boolean: `${PREFIXES.xsd}boolean`,
    anyURI: `${PREFIXES.xsd}anyURI`,
} as const;

/** SPARQL-Prolog mit allen Standard-Prefixes, für lesbare Queries. */
export const SPARQL_PREFIXES = Object.entries(PREFIXES)
    .map(([prefix, iri]) => `PREFIX ${prefix}: <${iri}>`)
    .join('\n');
