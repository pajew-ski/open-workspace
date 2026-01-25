// A2UI Core Types

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

// ============================================================
// Component Prop Types
// ============================================================

// Utility type for literal strings in A2UI protocol
export interface LiteralString {
    literalString: string;
}

export type TextValue = string | LiteralString;

// Action reference
export interface ActionRef {
    actionId: string;
}

// ------------------------------------------------------------
// Display Components
// ------------------------------------------------------------

export interface TextProps {
    text: TextValue;
    style?: React.CSSProperties;
}

export interface CardProps {
    title?: TextValue;
    style?: React.CSSProperties;
    children?: { explicitList: string[] };
}

export interface MarkdownProps {
    content: TextValue;
    style?: React.CSSProperties;
}

export interface CodeBlockProps {
    code: TextValue;
    language?: string;
}

export interface ImageProps {
    src: TextValue;
    alt?: TextValue;
    caption?: TextValue;
}

export interface LinkProps {
    text?: TextValue;
    href: TextValue;
    external?: boolean;
    onPress?: ActionRef;
}

export type AlertVariant = 'info' | 'success' | 'warning' | 'error';

export interface AlertProps {
    variant?: AlertVariant;
    title?: TextValue;
    message?: TextValue;
}

// ------------------------------------------------------------
// Layout Components
// ------------------------------------------------------------

export interface ColumnProps {
    gap?: string;
    style?: React.CSSProperties;
    children?: { explicitList: string[] };
}

export interface RowProps {
    gap?: string;
    align?: 'start' | 'center' | 'end' | 'stretch';
    style?: React.CSSProperties;
    children?: { explicitList: string[] };
}

// ------------------------------------------------------------
// Structure Components
// ------------------------------------------------------------

export type ListStyle = 'ordered' | 'unordered' | 'none';

export interface ListProps {
    ordered?: boolean;
    items?: string[];
    listStyle?: ListStyle;
    children?: { explicitList: string[] };
}

export interface ListItemProps {
    text?: TextValue;
}

export interface TableColumn {
    label: string;
    key: string;
}

export interface TableProps {
    columns: (string | TableColumn)[];
    rows: any[];
    striped?: boolean;
    compact?: boolean;
}

// ------------------------------------------------------------
// Status Components
// ------------------------------------------------------------

export interface ProgressProps {
    value?: number;
    max?: number;
    label?: TextValue;
    showPercent?: boolean;
    indeterminate?: boolean;
}

export type ChipVariant = 'default' | 'primary' | 'success' | 'warning' | 'error';

export interface ChipProps {
    label: TextValue;
    variant?: ChipVariant;
    icon?: string;
    removable?: boolean;
    onRemove?: ActionRef;
}

export type BadgeVariant = 'default' | 'success' | 'warning' | 'error';

export interface BadgeProps {
    count?: number;
    dot?: boolean;
    variant?: BadgeVariant;
    inline?: boolean;
}

// ------------------------------------------------------------
// Input Components
// ------------------------------------------------------------

export interface InputProps {
    label?: TextValue;
    placeholder?: TextValue;
    value?: TextValue;
    type?: 'text' | 'password' | 'email' | 'number';
    error?: TextValue;
    helper?: TextValue;
    onChange?: ActionRef;
}

export interface SelectOption {
    label: string;
    value: string;
}

export interface SelectProps {
    label?: TextValue;
    options: (string | SelectOption)[];
    value?: TextValue;
    placeholder?: TextValue;
    onSelect?: ActionRef;
}

export interface CheckboxProps {
    label?: TextValue;
    checked?: boolean;
    onChange?: ActionRef;
}

// ------------------------------------------------------------
// Interaction Components
// ------------------------------------------------------------

export interface ButtonProps {
    label: TextValue;
    onPress?: ActionRef;
    style?: React.CSSProperties;
}

// ============================================================
// Component Map Types (for type-safe component definitions)
// ============================================================

export type A2UIComponentMap = {
    Text: TextProps;
    Card: CardProps;
    Markdown: MarkdownProps;
    CodeBlock: CodeBlockProps;
    Image: ImageProps;
    Link: LinkProps;
    Alert: AlertProps;
    Column: ColumnProps;
    Row: RowProps;
    Divider: Record<string, never>;
    List: ListProps;
    ListItem: ListItemProps;
    Table: TableProps;
    Progress: ProgressProps;
    Chip: ChipProps;
    Badge: BadgeProps;
    Input: InputProps;
    Select: SelectProps;
    Checkbox: CheckboxProps;
    Button: ButtonProps;
};

export type A2UIComponentName = keyof A2UIComponentMap;
