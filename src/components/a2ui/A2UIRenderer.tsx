'use client';

import React from 'react';
import { A2UINode, ActionHandler } from './types';
import { ComponentRegistry } from './components';

interface A2UIRendererProps {
    components: A2UINode[];
    onAction: ActionHandler;
}

const RenderNode = ({ node, onAction, componentMap }: { node: A2UINode, onAction: ActionHandler, componentMap: Record<string, A2UINode> }) => {
    const componentName = Object.keys(node.component)[0];
    const props = node.component[componentName] || {};
    const Component = ComponentRegistry[componentName];

    if (!Component) {
        console.warn(`A2UI: Unknown component ${componentName}`, node);
        return <div style={{ color: 'red', fontSize: '10px' }}>Unknown: {componentName}</div>;
    }

    // Handle children
    let children: React.ReactNode = null;
    if (props.children && props.children.explicitList) {
        children = props.children.explicitList.map((childId: string) => {
            const childNode = componentMap[childId];
            if (childNode) {
                return (
                    <RenderNode
                        key={childId}
                        node={childNode}
                        onAction={onAction}
                        componentMap={componentMap}
                    />
                );
            }
            return null;
        });
    }

    return (
        <Component props={props} onAction={onAction}>
            {children}
        </Component>
    );
};

export function A2UIRenderer({ components, onAction }: A2UIRendererProps) {
    // 1. Build a map for quick lookup by ID
    const componentMap = React.useMemo(() => {
        const map: Record<string, A2UINode> = {};
        components.forEach(c => {
            if (c.id) map[c.id] = c;
        });
        return map;
    }, [components]);

    // 2. Find root nodes (nodes that are not children of any other node)
    // For standard A2UI, the stream explicitly tells us what the root is via 'beginRendering'.
    // If we only have the list, we might need to assume the first one is root or check connectivity.
    // However, usually the 'surfaceUpdate' contains ALL components for that surface.
    // We will render ALL components that are NOT referenced as children by others, OR just allow passing a root ID.
    // For simplicity given the stream format: usually the list is flat. We need to find the root.
    // Let's assume the first component in the list is the intended root if no hierarchy is explicit, 
    // OR we render all nodes that don't have parents. 
    // Actually, A2UI structure: The 'beginRendering' message specifies the root. 
    // But here we might just receive the updated list.
    // Let's try to infer roots:

    const rootNodes = React.useMemo(() => {
        const childIds = new Set<string>();
        components.forEach(c => {
            const type = Object.keys(c.component)[0];
            const props = c.component[type];
            if (props.children && props.children.explicitList) {
                props.children.explicitList.forEach((id: string) => childIds.add(id));
            }
        });
        return components.filter(c => c.id && !childIds.has(c.id));
    }, [components]);

    if (!components || components.length === 0) return null;

    return (
        <div className="a2ui-surface">
            {rootNodes.map(node => (
                <RenderNode
                    key={node.id}
                    node={node}
                    onAction={onAction}
                    componentMap={componentMap}
                />
            ))}
        </div>
    );
}
