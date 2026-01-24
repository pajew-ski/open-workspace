import { AppShell } from '@/components/layout';
import { DashboardGrid } from '@/components/dashboard';

export default function DashboardPage() {
  return (
    <AppShell title="Übersicht">
      <DashboardGrid />
    </AppShell>
  );
}
