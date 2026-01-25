---
id: sys-doc-003
slug: module-canvas
title: "Modul: Canvas Visualisierung"
author: michael-pajewski
type: TechArticle
tags: [modules, visualization, creative-work]
createdAt: 2026-01-25T18:10:00Z
updatedAt: 2026-01-25T18:10:00Z
---

# Canvas Visualisierung

Der Canvas ist deine unendliche digitale Weißwandfläche. Hierarchische Listen reichen oft nicht aus, um komplexe Systeme zu verstehen – dafür gibt es den Canvas.

## 🎨 Anwendungsfälle

### 1. System-Architektur
Zeichne Server, Datenbanken und deren Verbindungen. Nutze **Card Nodes** für Komponenten und **Edges** für Datenflüsse.

### 2. Mind Mapping
Starte mit einem zentralen Thema in der Mitte. Erstelle Äste zu verwandten Ideen.
- *Tipp*: Nutze Farben, um Themenbereiche visuell zu gruppieren.

### 3. Prozess-Modellierung
Visualisiere Workflows: "Wenn X passiert -> dann tue Y".

## 🛠 Anleitung: Arbeiten mit dem Canvas

### Navigation
- **Pan**: Halte die Leertaste gedrückt und ziehe mit der Maus, um dich zu bewegen.
- **Zoom**: Nutze das Mausrad (oder Trackpad), um rein- und rauszuzoomen.

### Elemente Erstellen
1. **Doppelklick** auf eine leere Stelle erstellt eine neue Notiz-Karte.
2. Fahre über eine Karte, um die **Verbindungspunkte** (Handles) zu sehen.
3. Ziehe von einem Handle zu einer anderen Karte, um eine **Verbindung** zu schaffen.

### Integration
Der Canvas ist mit dem Rest des Systems vernetzt. Du kannst Links zu [[Modul: Aufgaben & Projekte]] oder Dokumenten einfügen, um direkt dorthin zu springen.

Semantisch wird jeder Canvas als `CreativeWork` (Typ: VisualArtwork/Diagram) exportiert, inklusive aller Knoten als "Teile" (`hasPart`) des Werks.
