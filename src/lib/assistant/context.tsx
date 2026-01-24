'use client';

import { createContext, useContext, useState, ReactNode, useCallback } from 'react';

interface AssistantContextType {
    viewState: Record<string, any>;
    setModuleState: (key: string, data: any) => void;
}

const AssistantContext = createContext<AssistantContextType>({
    viewState: {},
    setModuleState: () => { },
});

export function AssistantProvider({ children }: { children: ReactNode }) {
    const [viewState, setViewState] = useState<Record<string, any>>({});

    const setModuleState = useCallback((key: string, data: any) => {
        setViewState(prev => {
            // Deep compare not needed here if we rely on React's state merging or if calls are sparse.
            // But to be safe and avoid unnecessary re-renders of consumers:
            if (JSON.stringify(prev[key]) === JSON.stringify(data)) return prev;

            // If data is null, remove the key
            if (data === null) {
                const newState = { ...prev };
                delete newState[key];
                return newState;
            }

            return { ...prev, [key]: data };
        });
    }, []);

    return (
        <AssistantContext.Provider value={{ viewState, setModuleState }}>
            {children}
        </AssistantContext.Provider>
    );
}

export const useAssistantContext = () => useContext(AssistantContext);
