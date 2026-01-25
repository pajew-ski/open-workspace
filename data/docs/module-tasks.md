---
id: "sys-doc-002"
slug: "module-tasks"
title: "Modul: Aufgaben & Projekte"
author: "michael-pajewski"
type: "TechArticle"
tags: ["modules", "documentation", "architecture"]
createdAt: "2026-01-25T18:05:00Z"
updatedAt: "2026-01-25T18:51:55.661Z"
---

# Aufgaben & Projekte

Das Task-Management-System ist darauf ausgelegt, Fokus zu schaffen und Fortschritt sichtbar zu machen.

## Features & Konzepte

### Projekte
Ein Projekt ist ein Container für Aufgaben. Es hat einen **Titel**, eine **Farbe** und einen **Status**.
- *Best Practice*: Nutze Projekte für größere Ziele (z.B. "Website Relaunch", "Q1 Marketing").
- *Prefix*: Jedes Projekt hat ein kurzes Kürzel (z.B. "WEB"), das vor den Aufgaben-IDs steht.

### Kanban Board
Die Aufgaben werden in Spalten organisiert, die den Fortschritt darstellen:
1.  **Backlog**: Ideen und zukünftige Aufgaben.
2.  **Zu erledigen**: Bereit zur Bearbeitung.
3.  **Wird bearbeitet**: Aktuell im Fokus (Limit: Halte diese Spalte klein!).
4.  **Review**: Warten auf Feedback oder Überprüfung.
5.  **Erledigt**: Abschluss.

## Anleitung: Projektmanagement

### Neues Projekt anlegen
1. Klicke auf `/tasks` oben rechts auf den **"P"** Button (Floating Action Button).
2. Wähle einen aussagekräftigen Namen und eine Farbe zur Wiedererkennung.

### Aufgaben erstellen
1. Klicke auf das **"+"** Symbol.
2. Wähle das zugehörige Projekt.
3. Beschreibe die Aufgabe kurz und prägnant.

### Semantische Integration
Aufgaben sind nicht nur Text. Das System generiert automatisch `schema.org/Project` und `schema.org/Action` Daten für jede Seite. Das bedeutet, dass ein AI-Agent die Aufgaben versteht:
- "Was ist der Status von Projekt X?"
- "Welche Schritte (Actions) sind dafür notwendig?"

Siehe auch: [[HowTo: Open Workspace nutzen]] für den Überblick.