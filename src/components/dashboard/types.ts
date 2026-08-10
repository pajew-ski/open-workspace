/**
 * Gemeinsame Typen der Dashboard-Widgets.
 *
 * Eigene Datei, damit die Widgets ihre Props typisieren können, ohne aus
 * `DashboardGrid` zu importieren, das sie selbst rendert — der Zirkel
 * wäre sonst nur durch `any` zu umgehen gewesen.
 */

export type WidgetType = 'welcome' | 'stats' | 'activity' | 'image' | 'quick-access';

export interface Widget {
    id: string;
    type: WidgetType;
    order: number;
    content?: string;
    url?: string;
    /** Widget-eigene Felder — unbekannt, nicht beliebig: Leser müssen prüfen. */
    [key: string]: unknown;
}

/** Was jedes Widget von der Grid-Ebene bekommt. */
export interface BaseWidgetProps {
    id: string;
    title?: string;
    isEditing: boolean;
    onDelete: (id: string) => void;
}

/** Zusätzlich für Widgets, die ihren eigenen Zustand zurückschreiben. */
export interface EditableWidgetProps extends BaseWidgetProps {
    onUpdate: (id: string, updates: Partial<Widget>) => void;
}
