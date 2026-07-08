import { lazy, Suspense, type ReactElement } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';

import { AppShell } from '@/components/app-shell';

import LeadsPage from '@/pages/Leads';
import LeadDetailPage from '@/pages/LeadDetail';
import HumanActionsPage from '@/pages/HumanActions';
import AuditPage from '@/pages/Audit';
import DashboardPage from '@/pages/Dashboard';
import CostsPage from '@/pages/Costs';
import IntegrationsPage from '@/pages/Integrations';
import AgentsPage from '@/pages/Agents';
import AdsPage from '@/pages/Ads';
import KnowledgePage from '@/pages/Knowledge';
import PromptsPage from '@/pages/Prompts';
import TeamChatPage from '@/pages/TeamChat';
import SimulationPage from '@/pages/Simulation';
import { useRealtime } from '@/lib/use-realtime';

const OfficePage = lazy(() => import('@/pages/Office'));

export default function App(): ReactElement {
  // Open the SSE channel once for the whole admin session. The hook is
  // idempotent across mount/unmount and quietly no-ops when no token is set.
  useRealtime();
  return (
    <AppShell>
      <Routes>
        <Route path="/" element={<Navigate to="/dashboard" replace />} />
        <Route path="/dashboard" element={<DashboardPage />} />
        <Route
          path="/office"
          element={
            <Suspense
              fallback={
                <div className="p-6 text-sm text-muted-foreground">Chargement du bureau…</div>
              }
            >
              <OfficePage />
            </Suspense>
          }
        />
        <Route path="/leads" element={<LeadsPage />} />
        <Route path="/leads/:id" element={<LeadDetailPage />} />
        <Route path="/queue" element={<HumanActionsPage />} />
        <Route path="/costs" element={<CostsPage />} />
        <Route path="/agents" element={<AgentsPage />} />
        <Route path="/prompts" element={<PromptsPage />} />
        <Route path="/team-chat" element={<TeamChatPage />} />
        <Route path="/ads" element={<AdsPage />} />
        <Route path="/knowledge" element={<KnowledgePage />} />
        <Route path="/integrations" element={<IntegrationsPage />} />
        <Route path="/audit" element={<AuditPage />} />
        <Route path="/sim" element={<SimulationPage />} />
      </Routes>
    </AppShell>
  );
}
