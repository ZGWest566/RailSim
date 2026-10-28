/** 极简事件总线：把 Phaser 场景、生成器与 DOM HUD 解耦。 */
export class Emitter<Events extends Record<string, unknown>> {
  private readonly handlers = new Map<keyof Events, Set<(payload: never) => void>>();

  on<K extends keyof Events>(event: K, handler: (payload: Events[K]) => void): () => void {
    let set = this.handlers.get(event);
    if (!set) {
      set = new Set();
      this.handlers.set(event, set);
    }
    set.add(handler as (payload: never) => void);
    return () => this.off(event, handler);
  }

  off<K extends keyof Events>(event: K, handler: (payload: Events[K]) => void): void {
    this.handlers.get(event)?.delete(handler as (payload: never) => void);
  }

  emit<K extends keyof Events>(event: K, payload: Events[K]): void {
    const set = this.handlers.get(event);
    if (!set) return;
    for (const handler of set) {
      (handler as (p: Events[K]) => void)(payload);
    }
  }
}

export type BuildTool = 'inspect' | 'track' | 'station' | 'demolish' | 'segment';

export interface AppEvents extends Record<string, unknown> {
  'world:ready': import('../game/world').World;
  'tile:select': import('../game/world').Tile | null;
  'tile:hover': import('../game/world').Tile | null;
  'map:action': {
    tile: import('../game/world').Tile;
    tool: BuildTool;
    /** 路段工具使用：本次点击指向的相邻地块 */
    neighbor?: import('../game/world').Tile;
  };
  'line:pick': import('../game/world').Tile | null;
  'camera:zoom': number;
  'tool:change': BuildTool;
  'sim:tick': import('../game/operations').ClockView;
  'map:tooltip': import('../game/operations').MapTooltip | null;
}

export const bus = new Emitter<AppEvents>();
