export type DocType = 'TechArticle' | 'CreativeWork' | 'BlogPosting' | 'DefinedTerm' | 'HowTo';

export interface Doc {
    id: string;
    slug: string;
    title: string;
    content: string;
    category?: string;
    tags: string[];
    author?: string; // Reference to Person ID
    type?: DocType;
    inLanguage?: string;
    createdAt: string;
    updatedAt: string;
}

export interface DocFrontmatter {
    id: string;
    slug: string;
    title: string;
    category?: string;
    tags: string[];
    author?: string;
    type?: DocType;
    inLanguage?: string;
    createdAt: string;
    updatedAt: string;
}
