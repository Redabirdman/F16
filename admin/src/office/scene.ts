// admin/src/office/scene.ts
// PixiJS renderer for the isometric office. Reads OfficeState, never fetches.
// V2 (Three.js) replaces THIS file only — the state core stays untouched.
import { Application, Container, Graphics, Text, TextStyle } from 'pixi.js';
import { ZONES, isoToScreen, TILE_W, TILE_H, deskCoords } from './layout';
import type { ZoneDef } from './layout';
import { roleColor, PLACEHOLDER_MODE } from './assets';
import type { OfficeAgent, OfficeEffect, OfficeState } from './types';

export interface OfficeSceneOptions {
  /** Called when the user taps a sprite. agentKey is `role#instanceId`. */
  onSelect?: (agentKey: string | null) => void;
}

export class OfficeScene {
  private app: Application;
  private world: Container;
  private floorLayer: Container;
  private spriteLayer: Container = new Container();
  private sprites = new Map<string, Container>();
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
    this.world.addChild(this.spriteLayer);
    this.world.eventMode = 'static';
    this.world.on('pointertap', () => this.opts.onSelect?.(null)); // background tap clears
    this.ready = true;
    this.drawFloor();
    this.centerCamera(host);
  }

  private centerCamera(host: HTMLDivElement): void {
    // Center the 12x12 diamond in the viewport.
    const mid = isoToScreen(6, 6);
    this.world.position.set(host.clientWidth / 2 - mid.x, host.clientHeight / 2 - mid.y - 40);
    this.world.scale.set(1);
  }

  private drawFloor(): void {
    this.floorLayer.removeChildren();
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
    g.fill({ color: zone.accent, alpha: 0.16 });
    g.stroke({ color: zone.accent, alpha: 0.5, width: 1 });
    this.floorLayer.addChild(g);

    // Zone label at the top corner of its rect.
    const labelPos = isoToScreen(zone.rect.col0, zone.rect.row0);
    const style = new TextStyle({ fill: 0xe2e8f0, fontSize: 12, fontWeight: '700' });
    const label = new Text({ text: zone.label, style });
    label.position.set(labelPos.x - TILE_W / 2, labelPos.y - TILE_H);
    this.floorLayer.addChild(label);
  }

  /** Reconcile the sprite set to a new state snapshot. */
  applySnapshot(state: OfficeState): void {
    if (!this.ready) return;
    // Remove sprites no longer present.
    for (const [key, node] of this.sprites) {
      if (!state.agents.has(key)) {
        node.destroy({ children: true });
        this.sprites.delete(key);
      }
    }
    // Add / update.
    for (const agent of state.agents.values()) {
      let node = this.sprites.get(agent.key);
      if (!node) {
        node = this.makeSprite(agent);
        this.sprites.set(agent.key, node);
        this.spriteLayer.addChild(node);
      }
      this.positionSprite(node, agent);
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
    if (PLACEHOLDER_MODE) {
      const body = new Graphics();
      body.label = 'body';
      node.addChild(body);
      const badge = new Graphics();
      badge.label = 'badge';
      node.addChild(badge);
    }
    return node;
  }

  private positionSprite(node: Container, agent: OfficeAgent): void {
    const p = deskCoords(agent.deskId);
    node.position.set(p.x, p.y - 14); // lift so the sprite stands on the tile
  }

  private styleSprite(node: Container, agent: OfficeAgent): void {
    if (!PLACEHOLDER_MODE) return; // textures handled in P4
    const body = node.getChildByLabel('body') as Graphics | null;
    const badge = node.getChildByLabel('badge') as Graphics | null;
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

  /** No-op stub — implemented in Phase 3 (motion). */
  applyEffects(_effects: OfficeEffect[]): void {
    /* Implemented in Phase 3 (motion). */
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
