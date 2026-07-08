// admin/src/pages/Office.tsx
// Bureau (redesign 2026-07-08): named agent personas, live "tâche en cours"
// from the SSE feed, French-language panel — a real-company feel.
import { useEffect, useRef, useState, type ReactElement, type ReactNode } from 'react';
import { OfficeScene } from '@/office/scene';
import { OfficeBridge } from '@/office/state-bridge';
import { intentLabel, personaFor } from '@/lib/personas';
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

const SPRITE_STATE_FR: Record<string, string> = {
  idle: 'Disponible',
  working: 'En plein travail',
  talking: 'En conversation',
  blocked: 'Bloqué — attention requise',
  walking: 'En déplacement',
};

const STATUS_FR: Record<string, string> = {
  running: 'en service',
  starting: 'démarrage…',
  stopping: 'arrêt en cours…',
  stopped: 'arrêté',
  crashed: 'en panne',
};

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

  const working = state
    ? [...state.agents.values()].filter(
        (a) => a.spriteState === 'working' || a.spriteState === 'talking',
      ).length
    : 0;

  return (
    <div className="relative h-[calc(100vh-49px)] w-full overflow-hidden bg-slate-900 lg:h-screen">
      <div ref={hostRef} className="absolute inset-0" />
      {!state && (
        <div className="absolute inset-0 flex items-center justify-center text-sm text-slate-400">
          Connexion au bureau en direct…
        </div>
      )}
      <div className="pointer-events-none absolute left-4 top-4 flex flex-col gap-1 rounded-xl bg-slate-900/75 px-4 py-2.5 text-slate-200 backdrop-blur">
        <span className="text-sm font-bold">Bureau Assuryal</span>
        <span className="text-xs text-slate-400">
          {state ? state.agents.size : 0} agents présents · {working} en activité
        </span>
      </div>
      {selected && <AgentPanel agent={selected} onClose={() => setSelectedKey(null)} />}
      <a href="/agents" className="sr-only">
        Vue accessible : registre des agents
      </a>
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

  const persona = personaFor(agent.role);
  const busy = agent.spriteState === 'working' || agent.spriteState === 'talking';
  const currentTask = busy && agent.lastIntent ? intentLabel(agent.lastIntent) : null;

  return (
    <div className="absolute right-0 top-0 h-full w-80 overflow-y-auto border-l border-slate-700 bg-slate-800/95 text-slate-100 shadow-xl backdrop-blur">
      {/* Persona header */}
      <div className="flex items-start gap-3 border-b border-slate-700 p-5">
        <div
          className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full text-base font-black text-slate-900"
          style={{ backgroundColor: persona.color }}
        >
          {persona.name.slice(0, 1)}
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="text-lg font-bold leading-tight">{persona.name}</h2>
          <p className="text-xs text-slate-400">{persona.title}</p>
          <span
            className={`mt-1.5 inline-block rounded-full px-2 py-0.5 text-[10px] font-semibold ${
              agent.spriteState === 'blocked'
                ? 'bg-rose-500/20 text-rose-300'
                : busy
                  ? 'bg-emerald-500/20 text-emerald-300'
                  : 'bg-slate-600/40 text-slate-300'
            }`}
          >
            {SPRITE_STATE_FR[agent.spriteState] ?? agent.spriteState}
          </span>
        </div>
        <button
          onClick={onClose}
          className="text-slate-400 hover:text-slate-100"
          aria-label="Fermer"
        >
          ✕
        </button>
      </div>

      {/* Current task */}
      <div className="border-b border-slate-700 p-5">
        <h3 className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-slate-500">
          Tâche en cours
        </h3>
        {currentTask ? (
          <p className="flex items-center gap-2 text-sm text-emerald-300">
            <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-emerald-400" />
            {currentTask}
          </p>
        ) : agent.lastIntent ? (
          <p className="text-sm text-slate-400">
            Dernière activité : {intentLabel(agent.lastIntent)}
          </p>
        ) : (
          <p className="text-sm text-slate-400">En veille — prêt à prendre un dossier.</p>
        )}
        {agent.error && <p className="mt-2 text-xs text-rose-300">⚠️ {agent.error}</p>}
      </div>

      {/* Technical details */}
      <dl className="space-y-2 p-5 text-sm">
        <Row label="Statut" value={STATUS_FR[agent.status] ?? agent.status} />
        <Row label="Rôle système" value={<span className="font-mono text-xs">{agent.role}</span>} />
        <Row label="Modèle IA" value={agent.model} />
        <Row label="Dernier signe de vie" value={relativeTime(agent.lastHeartbeatAt)} />
        <Row label="Priorité" value={agent.priority === null ? '—' : String(agent.priority)} />
      </dl>
      <div className="px-5 pb-6">
        <a href="/agents" className="text-sm text-sky-400 hover:underline">
          Voir dans le registre technique →
        </a>
      </div>
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
