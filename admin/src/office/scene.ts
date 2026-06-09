// admin/src/office/scene.ts
// PixiJS renderer for the isometric office. Reads OfficeState, never fetches.
// V2 (Three.js) replaces THIS file only — the state core stays untouched.
import {
  Application,
  Assets,
  Container,
  Graphics,
  Sprite,
  Text,
  TextStyle,
  Texture,
} from 'pixi.js';
import {
  ZONES,
  isoToScreen,
  TILE_W,
  TILE_H,
  deskCoords,
  ENTRANCE,
  homeDeskFor,
  PERSISTENT_HOME,
} from './layout';
import type { ZoneDef } from './layout';
import { ENV_TEXTURES, PLACEHOLDER_MODE, roleColor, textureUrl } from './assets';
import type { OfficeAgent, OfficeEffect, OfficeState } from './types';

export interface OfficeSceneOptions {
  /** Called when the user taps a sprite. agentKey is `role#instanceId`. */
  onSelect?: (agentKey: string | null) => void;
}

/** All roles with character PNGs. */
const ALL_ROLES = [
  'sales-agent',
  'voice-operator',
  'maxance-operator',
  'supervisor',
  'human-router',
  'engagement-agent',
  'ads-manager-agent',
  'creative-agent',
  'lead-scorer',
] as const;

/** Plant placement: 2 tasteful spots so the floor doesn't read busy. */
const PLANT_POSITIONS: Array<{ col: number; row: number }> = [
  { col: 3, row: 0 }, // ads-wing inner edge
  { col: 11, row: 10 }, // reporter-office inner edge
];

export class OfficeScene {
  private app: Application;
  private world: Container;
  private floorLayer: Container;
  private propLayer: Container = new Container();
  private spriteLayer: Container = new Container();
  private labelLayer: Container = new Container();
  private sprites = new Map<string, Container>();
  private animState = new Map<string, { spriteState: string; bobPhase: number }>();
  private lastDeskByKey = new Map<string, string>();
  private walks = new Map<
    string,
    {
      from: { x: number; y: number };
      to: { x: number; y: number };
      t: number;
      dur: number;
      then?: () => void;
    }
  >();
  private pulseLayer: Container = new Container();
  private pulses: {
    g: Graphics;
    from: { x: number; y: number };
    to: { x: number; y: number };
    t: number;
    dur: number;
  }[] = [];
  private ready = false;

  constructor(private readonly opts: OfficeSceneOptions = {}) {
    this.app = new Application();
    this.world = new Container();
    this.floorLayer = new Container();
  }

  /** Async init — must be awaited before any draw call. */
  async mount(host: HTMLDivElement): Promise<void> {
    await this.app.init({
      resizeTo: host,
      antialias: true,
      backgroundColor: 0x0f172a,
      autoDensity: true,
      resolution: globalThis.devicePixelRatio ?? 1,
    });
    host.appendChild(this.app.canvas);
    this.app.stage.addChild(this.world);
    this.world.addChild(this.floorLayer);
    this.world.addChild(this.propLayer);
    this.world.addChild(this.spriteLayer);
    this.world.addChild(this.labelLayer); // labels render on top of props/sprites
    this.world.addChild(this.pulseLayer);
    this.world.eventMode = 'static';
    this.world.on('pointertap', () => this.opts.onSelect?.(null)); // background tap clears

    // Preload all textures best-effort — a missing file must not throw.
    const textureUrls = [...Object.values(ENV_TEXTURES), ...ALL_ROLES.map((r) => textureUrl(r))];
    await Promise.all(textureUrls.map((u) => Assets.load(u).catch(() => null)));

    this.ready = true;
    this.drawFloor();
    this.drawProps();
    this.drawZoneLabels();
    this.centerCamera(host);
    this.app.ticker.add((ticker) => this.tick(ticker.deltaMS));
  }

  private centerCamera(host: HTMLDivElement): void {
    // Center the 12x12 diamond in the viewport.
    const mid = isoToScreen(6, 6);
    this.world.position.set(host.clientWidth / 2 - mid.x, host.clientHeight / 2 - mid.y - 40);
    this.world.scale.set(1);
  }

  private drawFloor(): void {
    for (const c of this.floorLayer.removeChildren()) c.destroy();
    // Draw each zone rug as a filled isometric rectangle of tiles.
    for (const zone of Object.values(ZONES)) {
      this.drawZone(zone);
    }
  }

  private drawZone(zone: ZoneDef): void {
    const g = new Graphics();
    const { col0, row0, col1, row1 } = zone.rect;
    for (let c = col0; c <= col1; c += 1) {
      for (let r = row0; r <= row1; r += 1) {
        const p = isoToScreen(c, r);
        // diamond tile
        g.moveTo(p.x, p.y - TILE_H / 2);
        g.lineTo(p.x + TILE_W / 2, p.y);
        g.lineTo(p.x, p.y + TILE_H / 2);
        g.lineTo(p.x - TILE_W / 2, p.y);
        g.closePath();
      }
    }
    g.fill({ color: zone.accent, alpha: 0.14 });
    g.stroke({ color: zone.accent, alpha: 0.5, width: 1 });
    this.floorLayer.addChild(g);
  }

  /** Zone labels live on a top layer so props/sprites never occlude them. */
  private drawZoneLabels(): void {
    for (const c of this.labelLayer.removeChildren()) c.destroy();
    const style = new TextStyle({ fill: 0xe2e8f0, fontSize: 12, fontWeight: '700' });
    for (const zone of Object.values(ZONES)) {
      const labelPos = isoToScreen(zone.rect.col0, zone.rect.row0);
      const label = new Text({ text: zone.label, style });
      // Raise higher above the zone so it sits clearly above the props.
      label.position.set(labelPos.x - TILE_W / 2, labelPos.y - TILE_H * 2);
      this.labelLayer.addChild(label);
    }
  }

  /** Populate the static props layer. Best-effort — EMPTY textures are skipped. */
  private drawProps(): void {
    this.propLayer.removeChildren();

    // No desks on the sales floor — sales agents stand on the open colored rug.
    // Desks only at persistent homes, except maxance-operator (gets the booth instead).
    for (const [role, home] of Object.entries(PERSISTENT_HOME)) {
      if (role === 'maxance-operator') {
        // Maxance booth replaces the desk here.
        this.addPropSprite(ENV_TEXTURES.maxanceBooth, home.col, home.row, 0.26, 6);
      } else {
        this.addPropSprite(ENV_TEXTURES.desk, home.col, home.row, 0.15, 8);
      }
    }

    // Door at ENTRANCE grid position (ENTRANCE is already a ScreenPoint, use grid row 11 col 6).
    // ENTRANCE = isoToScreen(6,11) — place door sprite directly at that screen point.
    const doorTex = Texture.from(ENV_TEXTURES.door);
    if (doorTex.label !== Texture.EMPTY.label) {
      const spr = new Sprite(doorTex);
      spr.anchor.set(0.5, 1);
      spr.scale.set(0.16);
      spr.position.set(ENTRANCE.x, ENTRANCE.y);
      this.propLayer.addChild(spr);
    }

    // Plants.
    for (const pos of PLANT_POSITIONS) {
      this.addPropSprite(ENV_TEXTURES.plant, pos.col, pos.row, 0.18, 4);
    }
  }

  /**
   * Helper: create a Sprite prop at the given grid coords.
   * liftPx = extra upward shift so the sprite sits on the tile surface.
   */
  private addPropSprite(
    url: string,
    col: number,
    row: number,
    scale: number,
    liftPx: number,
  ): void {
    const tex = Texture.from(url);
    if (tex.label === Texture.EMPTY.label) return;
    const spr = new Sprite(tex);
    spr.anchor.set(0.5, 1);
    spr.scale.set(scale);
    const p = isoToScreen(col, row);
    spr.position.set(p.x, p.y - liftPx);
    this.propLayer.addChild(spr);
  }

  /** Reconcile the sprite set to a new state snapshot. */
  applySnapshot(state: OfficeState): void {
    if (!this.ready) return;
    // Remove sprites no longer present.
    for (const [key, node] of this.sprites) {
      if (!state.agents.has(key)) {
        node.destroy({ children: true });
        this.sprites.delete(key);
        this.lastDeskByKey.delete(key);
        this.animState.delete(key);
        this.walks.delete(key);
      }
    }
    // Add / update.
    for (const agent of state.agents.values()) {
      let node = this.sprites.get(agent.key);
      const wasNew = !this.lastDeskByKey.has(agent.key);
      if (!node) {
        node = this.makeSprite(agent);
        this.sprites.set(agent.key, node);
        this.spriteLayer.addChild(node);
      }
      this.positionSprite(node, agent);
      this.lastDeskByKey.set(agent.key, agent.deskId);
      if (wasNew && agent.role === 'sales-agent') this.walkIn(agent.key);
      this.styleSprite(node, agent);
    }
    // Depth-sort by screen Y so nearer desks overlap correctly.
    this.spriteLayer.children.sort((a, b) => a.y - b.y);
  }

  private makeSprite(agent: OfficeAgent): Container {
    const node = new Container();
    node.eventMode = 'static';
    node.cursor = 'pointer';
    node.on('pointertap', (e) => {
      e.stopPropagation();
      this.opts.onSelect?.(agent.key);
    });
    this.animState.set(agent.key, {
      spriteState: agent.spriteState,
      bobPhase: (agent.key.length % 10) * 0.6,
    });

    if (!PLACEHOLDER_MODE) {
      const tex = Texture.from(textureUrl(agent.role));
      if (tex.label !== Texture.EMPTY.label) {
        // Warm art sprite.
        const spr = new Sprite(tex);
        spr.label = 'body';
        spr.anchor.set(0.5, 1);
        spr.scale.set(0.38); // characters are the focus — taller than the desks
        node.addChild(spr);
        const badge = new Graphics();
        badge.label = 'badge';
        node.addChild(badge);
        return node;
      }
      // Texture loaded as EMPTY — fall through to placeholder so the scene never breaks.
    }

    // Placeholder (PLACEHOLDER_MODE=true OR texture missing).
    const body = new Graphics();
    body.label = 'body';
    node.addChild(body);
    const badge = new Graphics();
    badge.label = 'badge';
    node.addChild(badge);
    return node;
  }

  private positionSprite(node: Container, agent: OfficeAgent): void {
    const p = deskCoords(agent.deskId);
    node.position.set(p.x, p.y - 14); // lift so the sprite stands on the tile
  }

  private styleSprite(node: Container, agent: OfficeAgent): void {
    const a = this.animState.get(agent.key);
    if (a) a.spriteState = agent.spriteState;

    const badge = node.getChildByLabel('badge') as Graphics | null;
    const bodyChild = node.getChildByLabel('body');

    if (!PLACEHOLDER_MODE && bodyChild instanceof Sprite) {
      // Warm-art path: only update the badge.
      if (badge) {
        badge.clear();
        if (agent.spriteState === 'blocked') {
          badge.circle(10, -28, 5).fill({ color: 0xef4444 });
        } else if (agent.spriteState === 'talking') {
          badge.circle(11, -30, 4).fill({ color: 0x38bdf8 });
        }
      }
      return;
    }

    // Placeholder / fallback path.
    const body = bodyChild as Graphics | null;
    if (body) {
      body.clear();
      body.roundRect(-9, -22, 18, 26, 5).fill({ color: roleColor(agent.role) });
      body.circle(0, -26, 7).fill({ color: 0xffe8cf }); // head
      body.alpha = agent.spriteState === 'idle' ? 0.92 : 1;
    }
    if (badge) {
      badge.clear();
      if (agent.spriteState === 'blocked') {
        badge.circle(10, -28, 5).fill({ color: 0xef4444 });
      } else if (agent.spriteState === 'talking') {
        badge.circle(11, -30, 4).fill({ color: 0x38bdf8 });
      }
    }
  }

  applyEffects(effects: OfficeEffect[]): void {
    if (!this.ready) return;
    for (const e of effects) {
      if (e.kind === 'message') {
        const g = new Graphics();
        this.pulseLayer.addChild(g);
        const to = this.deskCoordsForRole(e.toRole);
        this.pulses.push({ g, from: { ...ENTRANCE }, to, t: 0, dur: 0.9 });
      } else if (e.kind === 'marquee-quote') {
        this.marqueeToMaxance();
      } else if (e.kind === 'attention') {
        const g = new Graphics();
        this.pulseLayer.addChild(g);
        const to = this.deskCoordsForRole('human-router');
        this.pulses.push({ g, from: { ...ENTRANCE }, to, t: 0, dur: 0.9 });
      }
    }
  }

  private tick(deltaMs: number): void {
    const dt = deltaMs / 1000;
    for (const [key, node] of this.sprites) {
      const a = this.animState.get(key);
      if (!a) continue;
      a.bobPhase += dt * (a.spriteState === 'working' ? 4 : 2);
      const body = node.getChildByLabel('body');
      if (body) {
        const amp = a.spriteState === 'idle' ? 1.2 : a.spriteState === 'working' ? 2.2 : 1.6;
        body.y = Math.sin(a.bobPhase) * amp;
        if (a.spriteState === 'blocked') {
          body.x = Math.sin(a.bobPhase * 8) * 1.5;
        } else if (body.x !== 0) {
          body.x = 0;
        }
      }
    }
    this.advanceWalks(dt);
    this.advancePulses(dt);
  }

  private advanceWalks(dt: number): void {
    const completed: string[] = [];
    for (const [key, w] of this.walks) {
      w.t += dt;
      const k = Math.min(1, w.t / w.dur);
      const node = this.sprites.get(key);
      if (node) {
        node.position.set(
          w.from.x + (w.to.x - w.from.x) * k,
          w.from.y + (w.to.y - w.from.y) * k - 14,
        );
      }
      if (k >= 1) completed.push(key);
    }
    for (const key of completed) {
      const w = this.walks.get(key);
      this.walks.delete(key);
      w?.then?.();
    }
  }

  private advancePulses(dt: number): void {
    for (let i = this.pulses.length - 1; i >= 0; i -= 1) {
      const p = this.pulses[i];
      if (!p) continue;
      p.t += dt;
      const k = Math.min(1, p.t / p.dur);
      p.g.clear();
      const x = p.from.x + (p.to.x - p.from.x) * k;
      const y = p.from.y + (p.to.y - p.from.y) * k;
      p.g.circle(x, y - 14, 4).fill({ color: 0x7dd3fc, alpha: 1 - k });
      if (k >= 1) {
        p.g.destroy();
        this.pulses.splice(i, 1);
      }
    }
  }

  private walkIn(key: string): void {
    const node = this.sprites.get(key);
    if (!node) return;
    const dest = this.deskFor(key);
    this.walks.set(key, { from: { ...ENTRANCE }, to: dest, t: 0, dur: 1.2 });
  }

  private deskFor(key: string): { x: number; y: number } {
    const cached = this.lastDeskByKey.get(key);
    // defensive fallback; unreachable in normal flow (lastDeskByKey is set before deskFor is called)
    return cached ? deskCoords(cached) : { x: 0, y: 0 };
  }

  marqueeToMaxance(): void {
    const salesKey = [...this.sprites.keys()].reverse().find((k) => k.startsWith('sales-agent#'));
    if (!salesKey) return;
    const node = this.sprites.get(salesKey);
    if (!node) return;
    const home = this.deskFor(salesKey);
    const booth = deskCoords(homeDeskFor('maxance-operator').deskId);
    this.walks.set(salesKey, {
      from: home,
      to: booth,
      t: 0,
      dur: 1.0,
      then: () => {
        this.walks.set(salesKey, { from: booth, to: home, t: 0, dur: 1.0 });
      },
    });
  }

  private deskCoordsForRole(role: string): { x: number; y: number } {
    for (const [key, deskId] of this.lastDeskByKey) {
      if (key.startsWith(`${role}#`)) return deskCoords(deskId);
    }
    return deskCoords(homeDeskFor(role).deskId);
  }

  /** Re-center on container resize. */
  handleResize(host: HTMLDivElement): void {
    if (!this.ready) return;
    this.centerCamera(host);
  }

  pause(): void {
    if (this.ready) this.app.ticker.stop();
  }

  resume(): void {
    if (this.ready) this.app.ticker.start();
  }

  destroy(): void {
    // Pixi v8: destroy removes the canvas + frees GPU resources.
    // Guard against StrictMode dev cleanup firing before async mount() resolves
    // (the renderer would be undefined and destroy() would throw).
    if (!this.ready) return;
    this.app.destroy(true, { children: true, texture: true });
    this.ready = false;
  }
}
