'use client';

import { useState, useEffect } from 'react';
import { AppShell } from '@/components/layout';
import { DashboardGrid, Widget } from '@/components/dashboard/DashboardGrid';
import { FloatingActionButton } from '@/components/ui';
import { Edit2, Save, X } from 'lucide-react';

export default function DashboardPage() {
  const [widgets, setWidgets] = useState<Widget[]>([]);
  const [isEditing, setIsEditing] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadDashboard();
  }, []);

  const loadDashboard = async () => {
    try {
      const res = await fetch('/api/dashboard');
      const data = await res.json();
      if (data.layout) {
        setWidgets(data.layout.sort((a: any, b: any) => a.order - b.order));
      }
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  };

  const saveDashboard = async () => {
    try {
      const updatedWidgets = widgets.map((w, i) => ({ ...w, order: i }));

      await fetch('/api/dashboard', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ layout: updatedWidgets })
      });
      setIsEditing(false);
    } catch (e) {
      console.error(e);
    }
  };

  if (loading) return null; // Or skeleton

  return (
    <AppShell
      title={isEditing ? "Übersicht bearbeiten" : "Übersicht"}
      actions={
        isEditing ? (
          <>
            <FloatingActionButton
              icon={<X size={24} />}
              onClick={() => { setIsEditing(false); loadDashboard(); }}
              label="Abbrechen"
              style={{ backgroundColor: 'var(--color-surface-elevated)', color: 'var(--color-text-primary)' }}
            />
            <FloatingActionButton
              icon={<Save size={24} />}
              onClick={saveDashboard}
              label="Speichern"
            />
          </>
        ) : (
          <FloatingActionButton
            icon={<Edit2 size={24} />}
            onClick={() => setIsEditing(true)}
            label="Layout bearbeiten"
          />
        )
      }
    >
      <DashboardGrid
        widgets={widgets}
        isEditing={isEditing}
        setWidgets={setWidgets}
      />
    </AppShell>
  );
}
