/** 轨道类型：普速铁路与高速铁路。 */

export type TrackKind = 'normal' | 'highspeed';

export interface TrackKindDef {
  kind: TrackKind;
  name: string;
  short: string;
  /** 相对普速铁路的造价倍率。 */
  costFactor: number;
  /** 地图上的线路主色。 */
  color: number;
  colorCss: string;
  description: string;
}

export const TRACK_KIND_DEFS: Record<TrackKind, TrackKindDef> = {
  normal: {
    kind: 'normal',
    name: '普速铁路',
    short: '普',
    costFactor: 1,
    color: 0xd9dee1,
    colorCss: '#d9dee1',
    description: '普通列车与动车组都能运行；动车组按快速列车速度行驶。',
  },
  highspeed: {
    kind: 'highspeed',
    name: '高速铁路',
    short: '高',
    costFactor: 3,
    color: 0x9e1b32,
    colorCss: '#9e1b32',
    description: '造价为普速铁路的 3 倍。只有动车组能进入并全速运行，普通列车禁止入内。',
  },
};

export const TRACK_KIND_LIST: TrackKindDef[] = [
  TRACK_KIND_DEFS.normal,
  TRACK_KIND_DEFS.highspeed,
];

export const DEFAULT_TRACK_KIND: TrackKind = 'normal';

export function trackKindName(kind: TrackKind): string {
  return TRACK_KIND_DEFS[kind].name;
}
