"use client";

import { useEffect } from "react";

/**
 * Registriert den Service Worker (/public/sw.js) — nur im Production-Build
 * und nur in Browsern mit Service-Worker-Support. Rendert nichts.
 *
 * Update-Verhalten: Steht eine neue SW-Version bereit (waiting), wird sie
 * per {type: "SKIP_WAITING"} sofort aktiviert; beim darauffolgenden
 * controllerchange lädt die Seite genau einmal neu (Guard gegen
 * Reload-Schleifen; die Erstinstallation löst keinen Reload aus).
 */
export function ServiceWorkerRegistration() {
  useEffect(() => {
    if (process.env.NODE_ENV !== "production") return;
    if (!("serviceWorker" in navigator)) return;

    // Erstinstallation (noch kein Controller) soll nicht neu laden —
    // nur echte Versionswechsel einer bereits kontrollierten Seite.
    const hadController = Boolean(navigator.serviceWorker.controller);
    let reloaded = false;

    const onControllerChange = () => {
      if (!hadController || reloaded) return;
      reloaded = true;
      window.location.reload();
    };
    navigator.serviceWorker.addEventListener(
      "controllerchange",
      onControllerChange,
    );

    const activateWaiting = (worker: ServiceWorker | null) => {
      worker?.postMessage({ type: "SKIP_WAITING" });
    };

    navigator.serviceWorker
      .register("/sw.js")
      .then((registration) => {
        // Bereits wartende Version direkt aktivieren.
        activateWaiting(registration.waiting);

        // Später gefundene Updates aktivieren, sobald sie installiert sind.
        registration.addEventListener("updatefound", () => {
          const installing = registration.installing;
          if (!installing) return;
          installing.addEventListener("statechange", () => {
            if (
              installing.state === "installed" &&
              navigator.serviceWorker.controller
            ) {
              activateWaiting(installing);
            }
          });
        });
      })
      .catch((error: unknown) => {
        console.error("Service-Worker-Registrierung fehlgeschlagen:", error);
      });

    return () => {
      navigator.serviceWorker.removeEventListener(
        "controllerchange",
        onControllerChange,
      );
    };
  }, []);

  return null;
}
