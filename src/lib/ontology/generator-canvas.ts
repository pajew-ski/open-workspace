
import { WithContext, CreativeWork, ItemList } from 'schema-dts';
import { OntologyConfig, GLOBAL_ASK_PERSON } from './types';

const CONFIG: OntologyConfig = {
    baseUrl: 'https://exocortex.local',
    defaultLanguage: 'de',
    person: GLOBAL_ASK_PERSON
};

interface CanvasItem {
    id: string;
    name: string;
    description?: string;
    cardCount: number;
    createdAt: string;
    updatedAt: string;
}

export function generateCanvasJsonLd(canvas: CanvasItem): WithContext<CreativeWork> {
    const url = `${CONFIG.baseUrl}/canvas/${canvas.id}`;
    return {
        '@context': 'https://schema.org' as const,
        '@type': 'CreativeWork', // Could be VisualArtwork
        '@id': url,
        url: url,
        name: canvas.name,
        description: canvas.description,
        author: CONFIG.person,
        dateCreated: canvas.createdAt,
        dateModified: canvas.updatedAt,
        learningResourceType: 'Diagram',
        interactivityType: 'active'
    };
}

export function generateCanvasListJsonLd(canvases: CanvasItem[]): WithContext<ItemList> {
    return {
        '@context': 'https://schema.org' as const,
        '@type': 'ItemList',
        name: 'Canvas Visualisierungen',
        url: `${CONFIG.baseUrl}/canvas`,
        itemListElement: canvases.map((c, index) => ({
            '@type': 'ListItem',
            position: index + 1,
            item: generateCanvasJsonLd(c)
        }))
    };
}
