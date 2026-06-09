// admin/src/pages/Office.tsx
import { useEffect, useRef, useState, type ReactElement, type ReactNode } from 'react';
import { OfficeScene } from '@/office/scene';
import { OfficeBridge } from '@/office/state-bridge';
import { roleColor } from '@/office/assets';
import type { OfficeAgent, OfficeState } from '@/office/types';

function relativeTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const min = Math.floor(ms / 60_000);
  if (min < 1) return "à l'instant";
  if (min < 60) return `il y a ${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `il y a ${h} h`;
  return `il y a ${Math.floor(h / 24)} j`;
}

export default function OfficePage(): ReactElement {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [state, setState] = useState<OfficeState | null>(null);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return undefined;

    let disposed = false;
    const scene = new OfficeScene({ onSelect: (k) => setSelectedKey(k) });
    const bridge = new OfficeBridge();

    const unsub = bridge.subscribe((snap) => {
      setState(snap.state);
      scene.applySnapshot(snap.state);
      scene.applyEffects(snap.effects);
    });

    void scene.mount(host).then(() => {
      if (disposed) {
        scene.destroy();
        return;
      }
      scene.applySnapshot(bridge.getSnapshot());
      bridge.start();
    });

    const onResize = (): void => scene.handleResize(host);
    const onVisibility = (): void => {
      if (document.hidden) scene.pause();
      else scene.resume();
    };
    globalThis.addEventListener('resize', onResize);
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      disposed = true;
      globalThis.removeEventListener('resize', onResize);
      document.removeEventListener('visibilitychange', onVisibility);
      unsub();
      bridge.dispose();
      scene.destroy();
    };
  }, []);

  const selected: OfficeAgent | null =
    selectedKey && state ? (state.agents.get(selectedKey) ?? null) : null;

  return (
    <div className="relative h-[calc(100vh-57px)] w-full overflow-hidden bg-slate-900">
      <div ref={hostRef} className="absolute inset-0" />
      <div className="pointer-events-none absolute left-4 top-4 rounded-md bg-slate-900/70 px-3 py-1.5 text-xs font-medium text-slate-200">
        Bureau F16 — {state ? state.agents.size : 0} agents
      </div>
      {selected && <AgentPanel agent={selected} onClose={() => setSelectedKey(null)} />}
    </div>
  );
}

function AgentPanel({ agent, onClose }: { agent: OfficeAgent; onClose: () => void }): ReactElement {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="absolute right-0 top-0 h-full w-80 overflow-y-auto border-l border-slate-700 bg-slate-800/95 p-5 text-slate-100 shadow-xl">
      <div className="flex items-center justify-between">
        <span
          className="rounded-full px-2 py-0.5 text-xs font-bold text-slate-900"
          style={{ backgroundColor: `#${roleColor(agent.role).toString(16).padStart(6, '0')}` }}
        >
          {agent.role}
        </span>
        <button
          onClick={onClose}
          className="text-slate-400 hover:text-slate-100"
          aria-label="Fermer"
        >
          ✕
        </button>
      </div>
      <dl className="mt-4 space-y-2 text-sm">
        <Row
          label="Instance"
          value={<span className="font-mono text-xs">{agent.instanceId}</span>}
        />
        <Row label="État" value={agent.spriteState} />
        <Row label="Statut" value={agent.status} />
        <Row label="Modèle" value={agent.model} />
        <Row label="Queue" value={agent.queue} />
        <Row label="Priorité" value={agent.priority === null ? '—' : String(agent.priority)} />
        <Row label="Heartbeat" value={relativeTime(agent.lastHeartbeatAt)} />
        {agent.error && (
          <Row label="Erreur" value={<span className="text-rose-300">{agent.error}</span>} />
        )}
      </dl>
      <a href="/agents" className="mt-5 inline-block text-sm text-sky-400 hover:underline">
        Voir dans le registre Agents →
      </a>
    </div>
  );
}

function Row({ label, value }: { label: string; value: ReactNode }): ReactElement {
  return (
    <div className="flex justify-between gap-3">
      <dt className="text-slate-400">{label}</dt>
      <dd className="text-right text-slate-100">{value}</dd>
    </div>
  );
}
