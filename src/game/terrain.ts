/**
 * 地块定义：名称、配色、建造成本系数、需求特征。
 */

export const Terrain = {
  Wasteland: 'WASTELAND',
  Farmland: 'FARMLAND',
  Suburb: 'SUBURB',
  Industry: 'INDUSTRY',
  Mountain: 'MOUNTAIN',
  Town: 'TOWN',
  Water: 'WATER',
} as const;

export type Terrain = (typeof Terrain)[keyof typeof Terrain];

export interface TerrainDef {
  id: Terrain;
  name: string;
  /** 基础填充色（渲染时会叠加海拔明暗） */
  color: number;
  colorCss: string;
  /** 深色版本，用于描边/图标 */
  edge: number;
  /** 建造成本系数 */
  costFactor: number;
  /** 需求侧标签 */
  demand: string;
  /** 需求说明 */
  description: string;
  /** 图例排序，数值越小越靠前 */
  order: number;
  buildable: boolean;
}

export const TERRAIN_DEFS: Record<Terrain, TerrainDef> = {
  [Terrain.Wasteland]: {
    id: Terrain.Wasteland,
    name: '荒地',
    color: 0x857b63,
    colorCss: '#857b63',
    edge: 0x615947,
    costFactor: 1.0,
    demand: '无客流',
    description: '无需求的空地，只作通道。',
    order: 0,
    buildable: true,
  },
  [Terrain.Farmland]: {
    id: Terrain.Farmland,
    name: '农田',
    color: 0x96ac4f,
    colorCss: '#96ac4f',
    edge: 0x73853a,
    costFactor: 1.5,
    demand: '少量游客 / 通勤',
    description: '零散农庄，少量游客与通勤。',
    order: 1,
    buildable: true,
  },
  [Terrain.Suburb]: {
    id: Terrain.Suburb,
    name: '郊区',
    color: 0xa7aa8b,
    colorCss: '#a7aa8b',
    edge: 0x84876c,
    costFactor: 2.0,
    demand: '通勤客主要来源',
    description: '城镇外围住宅区，通勤客流集中。',
    order: 2,
    buildable: true,
  },
  [Terrain.Industry]: {
    id: Terrain.Industry,
    name: '工业区',
    color: 0x7b8695,
    colorCss: '#7b8695',
    edge: 0x5b6472,
    costFactor: 2.5,
    demand: '货单 + 商务客',
    description: '厂房与仓储，产生货单与商务客流。',
    order: 3,
    buildable: true,
  },
  [Terrain.Mountain]: {
    id: Terrain.Mountain,
    name: '山地',
    color: 0x6e6457,
    colorCss: '#6e6457',
    edge: 0x4f463c,
    costFactor: 5.0,
    demand: '屏障',
    description: '高海拔，造价极高。',
    order: 5,
    buildable: true,
  },
  [Terrain.Town]: {
    id: Terrain.Town,
    name: '城镇',
    color: 0xdfa95f,
    colorCss: '#dfa95f',
    edge: 0xb5833e,
    costFactor: 4.0,
    demand: '客流核心',
    description: '城镇建成区，客流核心。',
    order: 4,
    buildable: true,
  },
  [Terrain.Water]: {
    id: Terrain.Water,
    name: '水域',
    color: 0x2f6f8f,
    colorCss: '#2f6f8f',
    edge: 0x245973,
    costFactor: 6.0,
    demand: '需桥梁 / 隧道',
    description: '河流、湖泊与海岸，建桥造价更高。',
    order: 6,
    buildable: true,
  },
};

export const TERRAIN_LIST: TerrainDef[] = Object.values(TERRAIN_DEFS).sort((a, b) => a.order - b.order);

export function isWater(terrain: Terrain): boolean {
  return terrain === Terrain.Water;
}

export function isLand(terrain: Terrain): boolean {
  return terrain !== Terrain.Water;
}
