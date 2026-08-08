'use client';

import { RefObject, useEffect } from 'react';

const FOCUSABLE_SELECTOR =
    'a[href], button:not([disabled]), input:not([disabled]), ' +
    'textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Tastatur-Verhalten für modale Dialoge (Drawer, Finder, …):
 * Fokus wandert beim Öffnen hinein, Tab kreist innerhalb des Containers,
 * Escape schließt, beim Schließen kehrt der Fokus zum vorherigen Element
 * zurück. Das Markup (role="dialog", aria-modal) bleibt beim Aufrufer.
 *
 * `onClose` muss referenzstabil sein (useCallback), sonst startet der
 * Effekt bei jedem Render neu und setzt den Fokus zurück.
 */
export function useDialogA11y(
    isOpen: boolean,
    containerRef: RefObject<HTMLElement | null>,
    onClose: () => void,
    initialFocusRef?: RefObject<HTMLElement | null>
): void {
    useEffect(() => {
        if (!isOpen) return;
        const container = containerRef.current;
        if (!container) return;

        const previouslyFocused =
            document.activeElement instanceof HTMLElement ? document.activeElement : null;

        // Initial-Fokus: synchron im Öffnungs-Click verweigert Chromium
        // programmatischen Fokus still (Style-Recalc steht noch aus).
        // Deshalb idempotente Nachversuche über die Öffnungs-Transition
        // hinweg — sobald der Fokus im Dialog liegt, passiert nichts mehr.
        // Bewusst setTimeout statt rAF: rAF feuert in Headless-Umgebungen
        // nicht zuverlässig.
        const tryInitialFocus = () => {
            if (container.contains(document.activeElement)) return;
            const initialTarget =
                initialFocusRef?.current ?? container.querySelector<HTMLElement>(FOCUSABLE_SELECTOR);
            initialTarget?.focus();
        };
        tryInitialFocus();
        const focusTimers = [30, 80, 180, 300].map((ms) => window.setTimeout(tryInitialFocus, ms));

        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Escape') {
                event.stopPropagation();
                onClose();
                return;
            }
            if (event.key !== 'Tab') return;

            const focusable = Array.from(
                container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)
            ).filter((el) => el.offsetParent !== null || el === document.activeElement);
            if (focusable.length === 0) {
                event.preventDefault();
                return;
            }

            const first = focusable[0];
            const last = focusable[focusable.length - 1];
            const active = document.activeElement;

            if (!container.contains(active)) {
                event.preventDefault();
                first.focus();
            } else if (event.shiftKey && active === first) {
                event.preventDefault();
                last.focus();
            } else if (!event.shiftKey && active === last) {
                event.preventDefault();
                first.focus();
            }
        };

        document.addEventListener('keydown', handleKeyDown, true);
        return () => {
            focusTimers.forEach((timer) => clearTimeout(timer));
            document.removeEventListener('keydown', handleKeyDown, true);
            previouslyFocused?.focus();
        };
    }, [isOpen, containerRef, onClose, initialFocusRef]);
}
