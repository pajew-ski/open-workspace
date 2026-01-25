
import { WithContext, TechArticle, BlogPosting, DefinedTerm, HowTo, CreativeWork, Person } from 'schema-dts';

export type SchemaOrgDoc = TechArticle | BlogPosting | DefinedTerm | HowTo | CreativeWork;

export interface OntologyConfig {
    baseUrl: string; // e.g. https://exocortex.local
    defaultLanguage: string;
    person: Person;
}

export const GLOBAL_ASK_PERSON: Person = {
    '@type': 'Person',
    '@id': 'https://exocortex.local/about#me',
    name: 'Michael Pajewski',
    url: 'https://github.com/pajew-ski', // Example
};
