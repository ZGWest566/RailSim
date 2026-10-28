/** 货运系统：工业区货站、货单与在铁轨上自动接单的货运列车。 */

/** 货运列车在两次货运之间会隐藏在地图外，只保留上一次的终点车站。 */
export type TruckState =
  | 'hidden'
  | 'toPickup'
  | 'loading'
  | 'toDropoff'
  | 'unloading';

/** 货运列车沿轨道折线行进的路径点。 */
export interface CargoPathPoint {
  x: number;
  y: number;
  /** 该点所在轨道地块的 key（q,r）。 */
  key: string;
}

export interface CargoOrder {
  id: number;
  originKey: string;
  originName: string;
  originX: number;
  originY: number;
  destKey: string;
  destName: string;
  destX: number;
  destY: number;
  /** 货物件数，1~3。 */
  amount: number;
  /** 送达后结算的运费。 */
  reward: number;
  createdAtDay: number;
  /** 已被某列货运列车接单时记录其 id。 */
  truckId: number | null;
}

/** 单节灰色货运列车；内部沿用 Truck 类型名。 */
export interface Truck {
  id: number;
  x: number;
  y: number;
  heading: number;
  /** 上一次送货的终点车站 key；新车还没有终点。 */
  lastStationKey: string | null;
  /** 当前所在的轨道节点 key（路径上一个已到达的点）。 */
  currentTileKey: string | null;
  state: TruckState;
  orderId: number | null;
  loaded: boolean;
  /** 装货 / 卸货剩余时间（秒）。 */
  timer: number;
  /** 当前沿轨道前往目标的折线路径。 */
  path: CargoPathPoint[];
  pathIndex: number;
  revenueToday: number;
  revenueTotal: number;
  deliveriesToday: number;
  deliveriesTotal: number;
  /** 今日 / 累计运行成本。 */
  opexToday: number;
  opexTotal: number;
}

export interface TruckOrderView {
  originName: string;
  destName: string;
  amount: number;
  reward: number;
}

export interface TruckInfoView {
  id: number;
  state: string;
  stateKey: TruckState;
  loaded: boolean;
  order: TruckOrderView | null;
  revenueToday: number;
  deliveriesToday: number;
  opexToday: number;
  opexTotal: number;
}

export interface CargoView {
  truckCost: number;
  truckCount: number;
  visibleTrucks: number;
  hiddenTrucks: number;
  waitingOrders: number;
  activeOrders: number;
  revenueToday: number;
  revenueTotal: number;
  deliveriesToday: number;
  deliveriesTotal: number;
  opexToday: number;
  opexTotal: number;
  trucks: TruckInfoView[];
}

/** 购入一列货运列车的价格。 */
export const TRUCK_COST = 28_000;
/** 货运列车在轨道上的行驶速度（世界像素 / 秒）。 */
export const TRUCK_SPEED = 42;
/** 装货 / 卸货时间（秒）。 */
export const TRUCK_LOAD_SECONDS = 1.2;
export const TRUCK_UNLOAD_SECONDS = 1.2;
/** 每个工业区每个游戏小时生成货单的概率。24 小时期望约 0.24 张。 */
export const CARGO_ORDER_CHANCE_PER_HOUR = 0.01;
/** 货单生成检查间隔（游戏分钟）。 */
export const CARGO_ORDER_CHECK_MINUTES = 60;
/** 全地图同时存在的货单上限。 */
export const CARGO_MAX_ORDERS = 48;
/** 每张货单的货物件数范围。 */
export const CARGO_AMOUNT_MIN = 1;
export const CARGO_AMOUNT_MAX = 3;
/** 每张货单的运费范围（与距离无关）。 */
export const CARGO_REWARD_MIN = 500;
export const CARGO_REWARD_MAX = 1000;

export const TRUCK_STATE_LABELS: Record<TruckState, string> = {
  hidden: '待命',
  toPickup: '前往取货',
  loading: '装货中',
  toDropoff: '送货中',
  unloading: '卸货中',
};

export function truckStateLabel(state: TruckState): string {
  return TRUCK_STATE_LABELS[state];
}
