/** 车站类型定义：服务半径、造价、配色与说明。 */

export type StationType = 'light' | 'small' | 'large' | 'freight';

export interface StationDef {
  type: StationType;
  name: string;
  short: string;
  /** 服务半径（格）。货运站为 0，使用连片工业区覆盖。 */
  radius: number;
  /** 固定建造费（轨道费用另计） */
  cost: number;
  color: number;
  colorCss: string;
  description: string;
}

export const STATION_DEFS: Record<StationType, StationDef> = {
  light: {
    type: 'light',
    name: '轻轨站',
    short: '轻',
    radius: 1,
    cost: 15_000,
    color: 0x6cc4d5,
    colorCss: '#6cc4d5',
    description: '半径 1 格，适合城镇短途。',
  },
  small: {
    type: 'small',
    name: '小型站',
    short: '小',
    radius: 2,
    cost: 35_000,
    color: 0xe9b968,
    colorCss: '#e9b968',
    description: '半径 2 格，连接郊区与城镇。',
  },
  large: {
    type: 'large',
    name: '大型站',
    short: '大',
    radius: 3,
    cost: 70_000,
    color: 0xe8955f,
    colorCss: '#e8955f',
    description: '半径 3 格，适合作为枢纽。',
  },
  freight: {
    type: 'freight',
    name: '货运站',
    short: '货',
    radius: 0,
    cost: 50_000,
    color: 0x9bb7ca,
    colorCss: '#9bb7ca',
    description: '覆盖整片工业区，需建在工业区或紧邻处。',
  },
};

export const STATION_TYPE_LIST: StationDef[] = [
  STATION_DEFS.light,
  STATION_DEFS.small,
  STATION_DEFS.large,
  STATION_DEFS.freight,
];

export function stationRadiusLabel(type: StationType): string {
  const def = STATION_DEFS[type];
  return def.type === 'freight' ? '覆盖工业区' : `半径 ${def.radius} 格`;
}
