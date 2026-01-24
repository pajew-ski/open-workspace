export interface A2UIComponent {
    [key: string]: any;
}

export interface A2UINode {
    id?: string;
    component: A2UIComponent;
}

export interface A2UISurface {
    surfaceId: string;
    components: A2UINode[];
}

export type ActionHandler = (actionId: string, payload?: any) => void;
