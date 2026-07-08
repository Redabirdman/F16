/**
 * App shell (redesign 2026-07-08) — left sidebar navigation.
 *
 * Nav is organized by DAILY USE (Ridaa: "not all sections are daily"):
 *   Pilotage  — Dashboard / Leads / Actions humaines / Bureau / Coûts
 *   Réglages  — Prompts / Connaissances / Intégrations / Publicités /
 *               Équipe / Agents / Audit (ACPR export) / Simulation
 *
 * The "Actions humaines" item carries a live pending-count badge (30 s
 * poll + SSE invalidation via useRealtime in App.tsx).
 *
 * Mobile: the sidebar collapses behind a hamburger in a slim top bar.
 */
import { useState, type ReactElement } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  Activity,
  Building2,
  FileText,
  FlaskConical,
  Inbox,
  LayoutDashboard,
  Library,
  Megaphone,
  Menu,
  MessagesSquare,
  Plug,
  ScrollText,
  Users,
  Wallet,
  X,
} from 'lucide-react';

import { listPendingHumanActions } from '@/lib/api';

interface NavItem {
  to: string;
  label: string;
  icon: ReactElement;
  badge?: number;
}

function NavGroup({
  title,
  items,
  onNavigate,
}: {
  title: string;
  items: NavItem[];
  onNavigate: () => void;
}): ReactElement {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="px-3 pb-1.5 pt-4 text-[11px] font-semibold uppercase tracking-wider text-slate-400">
        {title}
      </span>
      {items.map((item) => (
        <NavLink
          key={item.to}
          to={item.to}
          onClick={onNavigate}
          className={({ isActive }) =>
            [
              'flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors',
              isActive
                ? 'bg-primary text-primary-foreground shadow-sm'
                : 'text-slate-600 hover:bg-accent hover:text-accent-foreground',
            ].join(' ')
          }
        >
          <span className="[&>svg]:h-4 [&>svg]:w-4">{item.icon}</span>
          <span className="flex-1">{item.label}</span>
          {item.badge !== undefined && item.badge > 0 && (
            <span className="rounded-full bg-rose-500 px-1.5 py-0.5 text-[10px] font-bold leading-none text-white">
              {item.badge}
            </span>
          )}
        </NavLink>
      ))}
    </div>
  );
}

export function AppShell({ children }: { children: ReactElement }): ReactElement {
  const [open, setOpen] = useState(false);
  const location = useLocation();

  const { data: pending } = useQuery({
    queryKey: ['admin', 'human-actions', 'badge'],
    queryFn: () => listPendingHumanActions({ limit: 50 }),
    refetchInterval: 30_000,
  });
  const pendingCount = pending?.rows.length ?? 0;

  const primary: NavItem[] = [
    { to: '/dashboard', label: 'Tableau de bord', icon: <LayoutDashboard /> },
    { to: '/leads', label: 'Leads', icon: <Users /> },
    { to: '/queue', label: 'Actions humaines', icon: <Inbox />, badge: pendingCount },
    { to: '/office', label: 'Bureau', icon: <Building2 /> },
    { to: '/costs', label: 'Coûts', icon: <Wallet /> },
  ];
  const secondary: NavItem[] = [
    { to: '/prompts', label: 'Prompts', icon: <FileText /> },
    { to: '/knowledge', label: 'Connaissances', icon: <Library /> },
    { to: '/integrations', label: 'Intégrations', icon: <Plug /> },
    { to: '/ads', label: 'Publicités', icon: <Megaphone /> },
    { to: '/team-chat', label: 'Équipe', icon: <MessagesSquare /> },
    { to: '/agents', label: 'Agents', icon: <Activity /> },
    { to: '/audit', label: 'Audit (ACPR)', icon: <ScrollText /> },
    { to: '/sim', label: 'Simulation', icon: <FlaskConical /> },
  ];

  const close = (): void => setOpen(false);

  const sidebar = (
    <div className="flex h-full flex-col overflow-y-auto px-3 pb-4">
      <div className="flex items-center gap-2.5 px-3 pb-2 pt-5">
        <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-indigo-500 to-violet-600 text-sm font-black text-white shadow-md">
          A
        </div>
        <div className="flex flex-col leading-tight">
          <span className="text-sm font-bold text-slate-900">Assuryal</span>
          <span className="text-[11px] text-slate-500">Pilotage F16</span>
        </div>
      </div>
      <NavGroup title="Pilotage" items={primary} onNavigate={close} />
      <NavGroup title="Réglages" items={secondary} onNavigate={close} />
      <div className="mt-auto px-3 pt-6 text-[11px] text-slate-400">
        {`Bureau digital Assuryal — ${new Date().getFullYear()}`}
      </div>
    </div>
  );

  return (
    <div className="min-h-screen bg-background text-foreground">
      {/* Desktop sidebar */}
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-60 border-r border-border bg-white lg:block">
        {sidebar}
      </aside>

      {/* Mobile top bar */}
      <header className="sticky top-0 z-30 flex items-center gap-3 border-b border-border bg-white px-4 py-2.5 lg:hidden">
        <button
          aria-label="Menu"
          onClick={() => setOpen(true)}
          className="rounded-md p-1.5 text-slate-600 hover:bg-accent"
        >
          <Menu className="h-5 w-5" />
        </button>
        <span className="text-sm font-bold text-slate-900">Assuryal — F16</span>
      </header>

      {/* Mobile drawer */}
      {open && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div className="absolute inset-0 bg-slate-900/40" onClick={close} />
          <aside className="absolute inset-y-0 left-0 w-64 bg-white shadow-xl">
            <button
              aria-label="Fermer"
              onClick={close}
              className="absolute right-3 top-4 rounded-md p-1 text-slate-500 hover:bg-accent"
            >
              <X className="h-5 w-5" />
            </button>
            {sidebar}
          </aside>
        </div>
      )}

      {/* /office fills the viewport edge-to-edge; everything else is padded. */}
      <main className={location.pathname === '/office' ? 'lg:pl-60' : 'lg:pl-60'}>{children}</main>
    </div>
  );
}
