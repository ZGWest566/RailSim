import { SQRT3, hexDistance, hexKey } from '../core/hex';
import { Rng } from '../core/rng';
import { HEX_SIZE, KM_PER_HEX } from '../config';
import { isDemandTile, PASSENGER_OPEX_PER_HEX, CARGO_OPEX_PER_HEX } from './economy';
import type { RailNetwork, Station } from './network';
import { STATION_DEFS, type StationType } from './stations';
import {
  CARGO_AMOUNT_MAX,
  CARGO_AMOUNT_MIN,
  CARGO_MAX_ORDERS,
  CARGO_ORDER_CHANCE_PER_HOUR,
  CARGO_ORDER_CHECK_MINUTES,
  CARGO_REWARD_MAX,
  CARGO_REWARD_MIN,
  TRUCK_COST,
  TRUCK_LOAD_SECONDS,
  TRUCK_SPEED,
  TRUCK_UNLOAD_SECONDS,
  truckStateLabel,
  type CargoOrder,
  type CargoPathPoint,
  type CargoView,
  type Truck,
  type TruckInfoView,
} from './cargo';
import { Terrain } from './terrain';
import type { Tile, World } from './world';
import { trainModel, type TrainModel } from './trains';

/* ------------------------------------------------------------------ */
/* 类型                                                                */
/* ------------------------------------------------------------------ */

export type LineStatus = 'OK' | 'BROKEN';

export interface LineStop {
  key: string;
  name: string;
  q: number;
  r: number;
}

export interface LineInput {
  name: string;
  color: number;
  colorCss: string;
  isLoop: boolean;
  stops: LineStop[];
}

/** HUD 提交给 App 的线路表单，id 为 null 表示新建。 */
export interface LineSavePayload extends LineInput {
  id: number | null;
}

export interface LineSave {
  id: number;
  name: string;
  color: number;
  colorCss: string;
  isLoop: boolean;
  stops: LineStop[];
  trainIds: number[];
}

export interface Line {
  id: number;
  name: string;
  color: number;
  colorCss: string;
  isLoop: boolean;
  stops: LineStop[];
  trainIds: number[];
  status: LineStatus;
  route: Tile[];
  points: { x: number; y: number }[];
  cumulative: number[];
  /** 每个停靠站在折线上的累计距离（世界像素），与 stops 一一对应。 */
  stopDistances: number[];
  length: number;
}

export type PassengerState = 'WAITING' | 'ON_TRAIN' | 'TRANSFERRING' | 'ARRIVED' | 'GAVE_UP';

export type PassengerKind = 'commuter' | 'tourist' | 'worker';

export interface PassengerKindDef {
  kind: PassengerKind;
  name: string;
  color: number;
  colorCss: string;
}

/** 乘客类型配色：通勤青、旅游金、务工蓝。 */
export const PASSENGER_KIND_DEFS: Record<PassengerKind, PassengerKindDef> = {
  commuter: { kind: 'commuter', name: '通勤', color: 0x6cc4d5, colorCss: '#6cc4d5' },
  tourist: { kind: 'tourist', name: '旅游', color: 0xe9b968, colorCss: '#e9b968' },
  worker: { kind: 'worker', name: '务工', color: 0x7f9cf5, colorCss: '#7f9cf5' },
};

export const PASSENGER_KIND_LIST: PassengerKindDef[] = [
  PASSENGER_KIND_DEFS.commuter,
  PASSENGER_KIND_DEFS.tourist,
  PASSENGER_KIND_DEFS.worker,
];

/** 乘客的一段乘车计划；多段之间在车站换乘。 */
export interface PassengerLeg {
  lineId: number;
  lineName: string;
  fromKey: string;
  fromName: string;
  toKey: string;
  toName: string;
  /** 该段沿线路的折线距离（世界像素） */
  distance: number;
  /** 预计乘车时间（游戏分钟） */
  minutes: number;
}

/**
 * 单个乘客对象。
 * 每个乘客独立持有目的地、预算与寻路结果；网络变化时 WAITING / TRANSFERRING 会重新寻路。
 */
export interface Passenger {
  id: number;
  state: PassengerState;
  kind: PassengerKind;
  originKey: string;
  originName: string;
  destKey: string;
  destName: string;
  /** 可接受的最大出行成本（游戏分钟）：基础预算 + 按直线距离折算的路程预算。 */
  budget: number;
  /** 生成时的预计总成本 */
  expectedCost: number;
  /** 步行到站时间（游戏分钟） */
  walkMinutes: number;
  /** 已上车各段累计票款，抵达终点时结算 */
  fare: number;
  route: PassengerLeg[];
  /** 当前准备乘坐 / 正在乘坐的段索引 */
  legIndex: number;
  /** ON_TRAIN 时所在车厢索引；-1 表示未上车 */
  carIndex: number;
  createdAtDay: number;
}

export interface TrainPathPoint {
  x: number;
  y: number;
}

/** 线路改线后的回送路径：先到旧图下一站，再沿轨道返回新图首站。 */
export interface TrainReposition {
  points: TrainPathPoint[];
  cumulative: number[];
  length: number;
  /** 已沿回送路径行驶的距离 */
  distance: number;
  /** 旧图上的下一站，经过时只下客 */
  nextStopKey: string | null;
  /** 下一站在回送路径上的距离 */
  nextStopDistance: number;
  passedNextStop: boolean;
  /** 下一站停站剩余时间（秒） */
  waitRemaining: number;
  targetStopKey: string;
}

export interface Train {
  id: number;
  modelId: string;
  cars: number;
  lineId: number | null;
  /** 沿线路折线的距离（世界像素），非环线在 0..length 之间往返 */
  distance: number;
  dir: 1 | -1;
  /** 当前速度（世界像素 / 秒），用于进出站加减速。 */
  speed: number;
  /** 停站剩余时间（秒）；大于 0 时列车不动。 */
  dwellRemaining: number;
  /** 改线回送中；完成后接回新线路首站 */
  reposition?: TrainReposition;
  onboard: Passenger[];
  revenueToday: number;
  revenueTotal: number;
  deliveredToday: number;
  deliveredTotal: number;
  /** 今日 / 累计运行成本。 */
  opexToday: number;
  opexTotal: number;
}

export interface TrainView {
  id: number;
  modelName: string;
  cars: number;
  lineId: number | null;
  lineName: string | null;
  onboard: number;
  capacity: number;
}

export interface ClockView {
  day: number;
  time: string;
  revenueToday: number;
  revenueTotal: number;
  deliveredToday: number;
  deliveredTotal: number;
  opexToday: number;
  opexTotal: number;
}

/** 乘客到站结算时产生的一笔票款，供地图层显示收入跳字。 */
export interface FareIncomeEvent {
  stationKey: string;
  stationName: string;
  x: number;
  y: number;
  amount: number;
  passengerId: number;
  kind: 'passenger' | 'cargo';
}

export interface StationFlowView {
  key: string;
  name: string;
  type: StationType;
  waiting: number;
  transferring: number;
  dailyDemand: number;
  /** 覆盖范围内有需求地块的平均经济带值 0–1。 */
  avgEcon: number;
  /** 由平均经济带换算出的客流系数。 */
  econFactor: number;
  /** 本站作为起点的待运货单数（货运站）。 */
  cargoWaiting: number;
  generatedToday: number;
  boardedToday: number;
  deliveredToday: number;
  gaveUpToday: number;
  generatedTotal: number;
  deliveredTotal: number;
  coverage: number;
  demandTiles: number;
  kinds: PassengerKindCount[];
  destinations: TrainDestinationView[];
  lines: { name: string; colorCss: string }[];
}

export interface TrainDestinationView {
  name: string;
  count: number;
}

export interface PassengerKindCount {
  kind: PassengerKind;
  name: string;
  colorCss: string;
  count: number;
}

export interface TrainInfoView {
  id: number;
  lineName: string | null;
  lineColorCss: string;
  modelName: string;
  cars: number;
  onboard: number;
  capacity: number;
  state: string;
  nextStopName: string | null;
  speed: number;
  revenueToday: number;
  deliveredToday: number;
  opexToday: number;
  opexTotal: number;
  carLoads: number[];
  kinds: PassengerKindCount[];
  destinations: TrainDestinationView[];
}

/** 地图悬停提示：车站或列车的实时客流信息。 */
export type MapTooltip =
  | { kind: 'station'; x: number; y: number; station: StationFlowView }
  | { kind: 'train'; x: number; y: number; train: TrainInfoView }
  | { kind: 'truck'; x: number; y: number; truck: TruckInfoView };

export interface LineView {
  id: number;
  name: string;
  color: number;
  colorCss: string;
  isLoop: boolean;
  status: LineStatus;
  stops: LineStop[];
  trains: TrainView[];
  trainCount: number;
}

export interface RailView {
  lines: LineView[];
  trains: TrainView[];
  inventory: TrainView[];
  credits: number;
  cargo: CargoView;
}

export interface OperationsSave {
  day: number;
  minuteOfDay: number;
  revenueToday: number;
  revenueTotal: number;
  deliveredToday: number;
  deliveredTotal: number;
  opexToday: number;
  opexTotal: number;
  cargoRevenueToday: number;
  cargoRevenueTotal: number;
  cargoDeliveredToday: number;
  cargoDeliveredTotal: number;
  nextLineId: number;
  nextTrainId: number;
  nextPassengerId: number;
  nextCargoOrderId: number;
  nextTruckId: number;
  rngState: number;
  lines: LineSave[];
  trains: Train[];
  flows: StationFlow[];
  waiting: { key: string; passengers: Passenger[] }[];
  cargoOrders: CargoOrder[];
  trucks: Truck[];
  cargoTimers: { blobId: number; minutes: number }[];
}

export interface OperationResult {
  ok: boolean;
  message: string;
}

export interface TrainSample {
  x: number;
  y: number;
  angle: number;
}

export interface LineColorOption {
  color: number;
  css: string;
  name: string;
}

export const LINE_COLORS: LineColorOption[] = [
  { color: 0xe05d5d, css: '#e05d5d', name: '赤' },
  { color: 0xe9b968, css: '#e9b968', name: '金' },
  { color: 0x6cc4d5, css: '#6cc4d5', name: '青' },
  { color: 0x7f9cf5, css: '#7f9cf5', name: '蓝' },
  { color: 0xb48ead, css: '#b48ead', name: '紫' },
  { color: 0x7ee0a8, css: '#7ee0a8', name: '绿' },
  { color: 0xf08a5d, css: '#f08a5d', name: '橙' },
  { color: 0xd8d8d8, css: '#d8d8d8', name: '银' },
];

/** 单节车厢定员。 */
export const PASSENGERS_PER_CAR = 4;

/** 列车起步加速度 / 进站制动减速度（世界像素 / 秒²）。 */
const TRAIN_ACCEL = 38;
const TRAIN_BRAKE = 28;
/** 每次停站的停站时间（秒）。 */
const DWELL_SECONDS = 1.8;
/** 判定“已到站”的距离容差（世界像素）。 */
const STOP_EPSILON = 0.05;

/* ------------------------------ 客流与经济 ------------------------------ */

/** 1 实在秒 = 30 游戏分钟（1 游戏日约 48 秒）。 */
const MINUTES_PER_SECOND = 30;
/** 1 游戏日 24 小时。 */
const MINUTES_PER_DAY = 24 * 60;
/** 票价：起步价 + 每公里价，再乘以车型速度系数。 */
const FARE_BASE = 24;
const FARE_PER_KM = 12;
/** 标准车型速度（通勤列车），用于计算速度系数。 */
const REFERENCE_SPEED = 46;
/** 世界像素 → 公里。 */
const KM_PER_PX = KM_PER_HEX / (SQRT3 * HEX_SIZE);
/** 单站最多滞留乘客，避免长时间无人服务时无限增长。 */
const MAX_WAITING = 160;

/** 乘客预算与路径成本使用“游戏分钟”为单位。 */
const WALK_MINUTES_PER_HEX = 6;
const INITIAL_WAIT_MINUTES = 8;
const TRANSFER_MINUTES = 18;
const PASSENGER_BUDGET: Record<PassengerKind, number> = {
  commuter: 150,
  tourist: 220,
  worker: 180,
};
/**
 * 按直线距离补充的路程预算。
 * 先按最慢列车的速度换算每格用时，再留出绕行余量：
 * 这样即使线路绕路或需要换乘，偏远车站也能产生乘客。
 */
const BUDGET_REFERENCE_SPEED = 36;
const DISTANCE_BUDGET_DETOUR = 1.5;
const DISTANCE_BUDGET_MINUTES_PER_HEX =
  ((SQRT3 * HEX_SIZE) / BUDGET_REFERENCE_SPEED) * MINUTES_PER_SECOND * DISTANCE_BUDGET_DETOUR;

/* ------------------------------ 经济带系数 ------------------------------ */

/**
 * 经济带系数：
 * - econ < 0.35：0（完全没有客流）
 * - econ 0.35 → 0.50：线性 0 → 2.0
 * - 继续按同一斜率增长，最高 2.5（econ 约 0.5375 后封顶）
 */
const ECON_ZERO_BELOW = 0.35;
const ECON_MID = 0.5;
const ECON_FACTOR_AT_MID = 2.0;
const ECON_FACTOR_MAX = 2.5;

export interface StationFlow {
  key: string;
  dailyDemand: number;
  /** 生成乘客的整数取整余量。 */
  carry: number;
  generatedToday: number;
  generatedTotal: number;
  boardedToday: number;
  boardedTotal: number;
  deliveredToday: number;
  deliveredTotal: number;
  transferredToday: number;
  transferredTotal: number;
  gaveUpToday: number;
  gaveUpTotal: number;
}


/* ------------------------------------------------------------------ */
/* 运营层：线路、列车、车库                                             */
/* ------------------------------------------------------------------ */

/**
 * 线路与车队。
 *
 * - 线路只保存停靠站顺序；站间路径由 RailNetwork.findPath（A*）在启用的轨道连接上计算。
 * - 轨道/车站被改动后调用 recomputeRoutes()：路径断开则线路标 BROKEN，列车暂停。
 * - 列车沿线路折线移动；环线循环，往返线在两端折返。
 */
export class RailOperations {
  readonly world: World;
  readonly network: RailNetwork;

  private readonly lineMap = new Map<number, Line>();
  private readonly trainMap = new Map<number, Train>();
  private readonly flowMap = new Map<string, StationFlow>();
  /** 每个车站的候车 / 换乘乘客对象。 */
  private readonly waitingByStation = new Map<string, Passenger[]>();
  private readonly incomeEvents: FareIncomeEvent[] = [];
  private readonly cargoOrders = new Map<number, CargoOrder>();
  private readonly truckMap = new Map<number, Truck>();
  private readonly cargoTimers = new Map<number, number>();
  private readonly rng: Rng;
  private cargoDispatchCooldown = 0;
  private nextLineId = 1;
  private nextTrainId = 1;
  private nextPassengerId = 1;
  private nextCargoOrderId = 1;
  private nextTruckId = 1;

  /** 游戏时钟：第 day 日 00:00 起的分钟数。开局为第 1 日 08:00。 */
  private day = 1;
  private minuteOfDay = 8 * 60;
  private revenueToday = 0;
  private revenueTotal = 0;
  private deliveredToday = 0;
  private deliveredTotal = 0;
  private opexToday = 0;
  private opexTotal = 0;
  private cargoRevenueToday = 0;
  private cargoRevenueTotal = 0;
  private cargoDeliveredToday = 0;
  private cargoDeliveredTotal = 0;

  constructor(world: World, network: RailNetwork) {
    this.world = world;
    this.network = network;
    this.rng = new Rng(world.seed ^ 0x51ed270b);
  }

  get lines(): Line[] {
    return [...this.lineMap.values()].sort((a, b) => a.id - b.id);
  }

  get trains(): Train[] {
    return [...this.trainMap.values()].sort((a, b) => a.id - b.id);
  }

  get trucks(): Truck[] {
    return [...this.truckMap.values()].sort((a, b) => a.id - b.id);
  }

  get inventory(): Train[] {
    return this.trains.filter((train) => train.lineId === null);
  }

  lineById(id: number): Line | null {
    return this.lineMap.get(id) ?? null;
  }

  trainById(id: number): Train | null {
    return this.trainMap.get(id) ?? null;
  }

  /* ------------------------------ 线路 ------------------------------ */

  createLine(input: LineInput): OperationResult {
    const prepared = this.prepareLine(input);
    if (!prepared.ok) return { ok: false, message: prepared.message };

    const line: Line = {
      id: this.nextLineId++,
      name: prepared.name,
      color: prepared.color,
      colorCss: prepared.colorCss,
      isLoop: prepared.isLoop,
      stops: prepared.stops,
      trainIds: [],
      status: 'OK',
      route: [],
      points: [],
      cumulative: [],
      stopDistances: [],
      length: 0,
    };
    this.applyRoute(line, prepared.route, prepared.stopDistances);
    this.lineMap.set(line.id, line);

    return {
      ok: true,
      message: `已创建 ${line.name} · ${line.stops.map((stop) => stop.name).join(' → ')}`,
    };
  }

  updateLine(id: number, input: LineInput): OperationResult {
    const line = this.lineMap.get(id);
    if (!line) return { ok: false, message: '线路不存在' };

    const prepared = this.prepareLine(input);
    if (!prepared.ok) return { ok: false, message: prepared.message };

    const newFirst = prepared.stops[0];
    if (!newFirst) return { ok: false, message: '线路至少需要 2 个停靠站' };

    const stopsChanged =
      line.isLoop !== prepared.isLoop ||
      line.stops.length !== prepared.stops.length ||
      line.stops.some((stop, index) => stop.key !== prepared.stops[index]?.key);

    // 改线前先为每列车规划回送路径：旧图下一站 → 新图首站
    const transitions = new Map<number, TrainReposition | null>();
    if (stopsChanged) {
      for (const trainId of line.trainIds) {
        const train = this.trainMap.get(trainId);
        if (!train) continue;
        transitions.set(trainId, this.buildReposition(line, train, newFirst));
      }
    }

    line.name = prepared.name;
    line.color = prepared.color;
    line.colorCss = prepared.colorCss;
    line.isLoop = prepared.isLoop;
    line.stops = prepared.stops;
    this.applyRoute(line, prepared.route, prepared.stopDistances);

    if (stopsChanged) {
      for (const trainId of line.trainIds) {
        const train = this.trainMap.get(trainId);
        if (!train) continue;
        const reposition = transitions.get(trainId) ?? null;
        train.dwellRemaining = 0;
        train.dir = 1;
        train.distance = 0;
        // 无缝衔接：有回送路径时保留当前速度，避免保存瞬间急停
        if (!reposition) train.speed = 0;
        train.reposition = reposition ?? undefined;

        // 找不到轨道回送路径时，直接在首站接回；乘客仍然保留
        if (!reposition) {
          this.alightDestinationsAt(train, newFirst.key);
          this.rebaseOnboard(train, newFirst.key);
          train.dwellRemaining = DWELL_SECONDS;
        }
      }
    } else {
      // 只改名称 / 颜色或原样保存：保持列车当前运行状态
      this.clampTrainDistances(line);
    }
    this.recomputeWaitingRoutes();

    return { ok: true, message: `已更新 ${line.name}` };
  }

  deleteLine(id: number): OperationResult {
    const line = this.lineMap.get(id);
    if (!line) return { ok: false, message: '线路不存在' };

    const trainIds = [...line.trainIds];
    this.lineMap.delete(id);
    for (const trainId of trainIds) {
      const train = this.trainMap.get(trainId);
      if (!train) continue;
      this.returnOnboard(train);
      train.reposition = undefined;
      train.lineId = null;
      train.distance = 0;
      train.dir = 1;
      train.speed = 0;
      train.dwellRemaining = 0;
    }
    this.recomputeWaitingRoutes();

    return {
      ok: true,
      message: `已删除 ${line.name} · ${trainIds.length} 列车回库`,
    };
  }

  /** 轨道 / 车站 / 连接段变化后重算所有线路。 */
  recomputeRoutes(): void {
    // 车站被拆除后清掉对应客流，避免幽灵候车数据
    const valid = new Set(this.network.stationList.map((station) => hexKey(station.q, station.r)));
    for (const key of [...this.flowMap.keys()]) {
      if (!valid.has(key)) this.flowMap.delete(key);
    }
    for (const key of [...this.waitingByStation.keys()]) {
      if (!valid.has(key)) this.waitingByStation.delete(key);
    }
    for (const station of this.network.stationList) {
      this.flowFor(station).dailyDemand = this.dailyDemandFor(station);
    }

    for (const line of this.lineMap.values()) {
      // 站名可能被重新建站更新，这里同步一次
      for (const stop of line.stops) {
        const tile = this.world.get(stop.q, stop.r);
        const station = tile ? this.network.stationAt(tile) : null;
        if (station) stop.name = station.name;
      }

      const built = this.buildRoute(line.stops, line.isLoop);
      if (!built.ok) {
        this.markBroken(line);
        continue;
      }
      this.applyRoute(line, built.route, built.stopDistances);
      this.clampTrainDistances(line);
    }

    this.recomputeWaitingRoutes();
    this.pruneCargo();
    this.revalidateCargoTrains();
    this.dispatchCargo();
  }

  /* ------------------------------ 列车 / 车库 ------------------------------ */

  purchaseTrain(modelId: string): OperationResult {
    const model = trainModel(modelId);
    if (!model) return { ok: false, message: '未知车型' };
    if (this.network.credits < model.cost) {
      return { ok: false, message: `资金不足（需要 ¥${model.cost.toLocaleString('en-US')}）` };
    }

    this.network.credits -= model.cost;
    const train: Train = {
      id: this.nextTrainId++,
      modelId: model.id,
      cars: model.cars,
      lineId: null,
      distance: 0,
      dir: 1,
      speed: 0,
      dwellRemaining: 0,
      onboard: [],
      revenueToday: 0,
      revenueTotal: 0,
      deliveredToday: 0,
      deliveredTotal: 0,
      opexToday: 0,
      opexTotal: 0,
    };
    this.trainMap.set(train.id, train);

    return {
      ok: true,
      message: `已购入 ${model.name} · ¥${model.cost.toLocaleString('en-US')}`,
    };
  }

  /** 购入一列沿轨道自动接单的货运列车。货运列车不属于任何线路。 */
  purchaseTruck(): OperationResult {
    if (this.network.credits < TRUCK_COST) {
      return { ok: false, message: `资金不足（需要 ¥${TRUCK_COST.toLocaleString('en-US')}）` };
    }

    this.network.credits -= TRUCK_COST;
    const truck: Truck = {
      id: this.nextTruckId++,
      x: 0,
      y: 0,
      heading: 0,
      lastStationKey: null,
      currentTileKey: null,
      state: 'hidden',
      orderId: null,
      loaded: false,
      timer: 0,
      path: [],
      pathIndex: 0,
      revenueToday: 0,
      revenueTotal: 0,
      deliveriesToday: 0,
      deliveriesTotal: 0,
      opexToday: 0,
      opexTotal: 0,
    };
    this.truckMap.set(truck.id, truck);
    this.cargoDispatchCooldown = 0;
    this.dispatchCargo();

    return {
      ok: true,
      message: `已购入货运列车 #${truck.id} · ¥${TRUCK_COST.toLocaleString('en-US')}`,
    };
  }

  assignTrain(trainId: number, lineId: number): OperationResult {
    const train = this.trainMap.get(trainId);
    if (!train) return { ok: false, message: '列车不存在' };
    const line = this.lineMap.get(lineId);
    if (!line) return { ok: false, message: '线路不存在' };
    if (line.status !== 'OK' || line.length <= 0) {
      return { ok: false, message: '线路当前断开，无法配车' };
    }
    if (train.lineId === lineId) return { ok: false, message: '列车已在该线路上' };

    if (train.lineId !== null) {
      const previous = this.lineMap.get(train.lineId);
      if (previous) {
        previous.trainIds = previous.trainIds.filter((id) => id !== train.id);
      }
    }

    const existing = line.trainIds.length;
    line.trainIds.push(train.id);
    train.lineId = line.id;
    train.reposition = undefined;
    train.dir = 1;
    train.speed = 0;
    train.dwellRemaining = existing > 0 ? 0.6 : 1.2;
    train.distance = line.length * (existing / (existing + 1));
    this.recomputeWaitingRoutes();

    return {
      ok: true,
      message: `列车 ${train.id} 已配到 ${line.name}`,
    };
  }

  unassignTrain(trainId: number): OperationResult {
    const train = this.trainMap.get(trainId);
    if (!train) return { ok: false, message: '列车不存在' };
    if (train.lineId === null) return { ok: false, message: '列车已在库存' };

    const line = this.lineMap.get(train.lineId);
    if (line) line.trainIds = line.trainIds.filter((id) => id !== train.id);
    this.returnOnboard(train);
    train.reposition = undefined;
    train.lineId = null;
    train.distance = 0;
    train.dir = 1;
    train.speed = 0;
    train.dwellRemaining = 0;
    this.recomputeWaitingRoutes();

    return { ok: true, message: `列车 ${train.id} 已回库` };
  }

  /* ------------------------------ 运行 ------------------------------ */

  /** dtSeconds 使用真实秒；单帧过大时截断，避免切后台回来列车瞬移。 */
  update(dtSeconds: number): void {
    const dt = Math.min(Math.max(dtSeconds, 0), 0.1);
    if (dt <= 0) return;

    this.advanceTime(dt);

    for (const line of this.lineMap.values()) {
      if (line.status !== 'OK' || line.length <= 0) continue;
      for (const trainId of line.trainIds) {
        const train = this.trainMap.get(trainId);
        if (!train) continue;
        const model = trainModel(train.modelId);
        if (!model) continue;

        // 改线回送：先到旧图下一站，再前往新图首站，不上下客（只下目的地乘客）
        if (train.reposition) {
          this.advanceReposition(train, model, dt);
          continue;
        }

        // 停站读秒：速度归零，结束后再起步并上客
        if (train.dwellRemaining > 0) {
          train.dwellRemaining = Math.max(0, train.dwellRemaining - dt);
          train.speed = 0;
          if (train.dwellRemaining === 0) this.boardAtStop(line, train, model);
          continue;
        }

        const next = this.nextStopAhead(line, train);
        if (!next) {
          // 往返线在端点没有“前方车站”时掉头，下一帧重新寻找
          if (!line.isLoop) train.dir = train.dir > 0 ? -1 : 1;
          continue;
        }

        const gap = train.dir > 0 ? next.distance - train.distance : train.distance - next.distance;
        if (gap <= STOP_EPSILON) {
          this.arriveAtStop(line, train, next.distance, next.index);
          continue;
        }

        // 目标速度 = min(巡航速度, 制动曲线给出的进站限速)
        const brakeLimit = Math.sqrt(2 * TRAIN_BRAKE * gap);
        const desired = Math.min(model.speed, brakeLimit);
        if (train.speed < desired) {
          train.speed = Math.min(desired, train.speed + TRAIN_ACCEL * dt);
        } else {
          train.speed = Math.max(desired, train.speed - TRAIN_BRAKE * dt);
        }

        const step = Math.min(train.speed * dt, gap);
        if (step > 0) {
          const cost = this.chargeOperatingCost(step, PASSENGER_OPEX_PER_HEX);
          train.opexToday += cost;
          train.opexTotal += cost;
        }
        train.distance += step * train.dir;

        if (gap - step <= STOP_EPSILON) {
          this.arriveAtStop(line, train, next.distance, next.index);
        } else if (line.isLoop) {
          train.distance = ((train.distance % line.length) + line.length) % line.length;
        }
      }
    }

    this.updateTrucks(dt);
    this.cargoDispatchCooldown -= dt;
    if (this.cargoDispatchCooldown <= 0) {
      this.cargoDispatchCooldown = 0.5;
      this.dispatchCargo();
    }
  }

  /** 找到列车行驶方向上的下一站（返回未取模的折线距离）。 */
  private nextStopAhead(line: Line, train: Train): { distance: number; index: number } | null {
    const count = line.stopDistances.length;
    if (count === 0) return null;

    if (line.isLoop) {
      for (let i = 0; i < count; i++) {
        const distance = line.stopDistances[i]!;
        if (distance > train.distance + STOP_EPSILON) return { distance, index: i };
      }
      return { distance: line.stopDistances[0]! + line.length, index: 0 };
    }

    if (train.dir > 0) {
      for (let i = 0; i < count; i++) {
        const distance = line.stopDistances[i]!;
        if (distance > train.distance + STOP_EPSILON) return { distance, index: i };
      }
      return null;
    }

    for (let i = count - 1; i >= 0; i--) {
      const distance = line.stopDistances[i]!;
      if (distance < train.distance - STOP_EPSILON) return { distance, index: i };
    }
    return null;
  }

  /** 到站：贴齐站台、下客、清零速度并开始停站读秒。 */
  private arriveAtStop(line: Line, train: Train, rawDistance: number, stopIndex: number): void {
    train.speed = 0;
    train.dwellRemaining = DWELL_SECONDS;
    if (line.isLoop) {
      train.distance = ((rawDistance % line.length) + line.length) % line.length;
      train.dir = 1;
    } else {
      train.distance = Math.max(0, Math.min(line.length, rawDistance));
    }
    this.alightAtStop(line, train, stopIndex);
  }

  /* ------------------------------ 改线回送 ------------------------------ */

  /**
   * 生成改线回送路径：
   * 1. 沿旧线路运行到下一站（或当前停靠站）；
   * 2. 从该站沿现有轨道前往新运行图的首站；
   * 3. 到达后接回新线路，乘客全程留在车上。
   */
  private buildReposition(
    line: Line,
    train: Train,
    newFirst: LineStop,
  ): TrainReposition | null {
    const target = this.world.get(newFirst.q, newFirst.r);
    if (!target) return null;

    // 已经在回送途中又改了一次线：直接从当前位置重新回送
    if (train.reposition) {
      const current = this.samplePath(train.reposition, train.reposition.distance);
      if (!current) return null;
      return this.buildDirectReposition(train, current, target, newFirst.key);
    }

    let nextIndex: number | null = null;
    if (train.dwellRemaining > 0) {
      const currentStop = this.currentStopIndex(line, train);
      if (currentStop >= 0) nextIndex = currentStop;
    }
    if (nextIndex === null) {
      const next = this.nextStopAhead(line, train);
      if (next) nextIndex = next.index;
    }
    if (nextIndex === null) {
      // 端点没有“下一站”，取最近的停靠站
      let bestIndex = -1;
      let bestDelta = Infinity;
      for (let i = 0; i < line.stopDistances.length; i++) {
        const delta = Math.abs(line.stopDistances[i]! - train.distance);
        if (delta < bestDelta) {
          bestDelta = delta;
          bestIndex = i;
        }
      }
      if (bestIndex < 0) return null;
      nextIndex = bestIndex;
    }

    const nextStop = line.stops[nextIndex];
    if (!nextStop) return null;
    const nextDistance = line.stopDistances[nextIndex] ?? train.distance;
    const fromTile = this.world.get(nextStop.q, nextStop.r);
    if (!fromTile) return null;

    const leg1 = this.buildLineLeg(line, train.distance, nextDistance);
    const tiles = this.network.findPath(fromTile, target);
    if (!tiles) return null;
    const leg2 = tiles.map((tile) => ({ x: tile.x, y: tile.y }));

    // 把车头后方的旧线路也接进回送路径，保证改线瞬间车厢不向前挤成一团
    const tailBudget = Math.max(0, (train.cars - 1) * 80);
    const tail =
      tailBudget > 0.5
        ? this.buildLineLeg(line, train.distance - train.dir * tailBudget, train.distance)
        : [];

    const points: TrainPathPoint[] = [];
    const pushPoint = (point: TrainPathPoint): void => {
      const last = points[points.length - 1];
      if (!last || Math.hypot(last.x - point.x, last.y - point.y) > 0.5) {
        points.push({ x: point.x, y: point.y });
      }
    };
    for (const point of tail) pushPoint(point);
    const headOffset = this.pathLength(points);
    for (const point of leg1) pushPoint(point);
    const nextStopDistance = this.pathLength(points);
    for (const point of leg2) pushPoint(point);
    if (points.length < 2) return null;

    return {
      points,
      cumulative: this.pathCumulative(points),
      length: this.pathLength(points),
      distance: headOffset,
      nextStopKey: nextStop.key,
      nextStopDistance,
      passedNextStop: false,
      waitRemaining: 0,
      targetStopKey: newFirst.key,
    };
  }

  /** 回送途中再次改线：从当前位置直接寻路到新首站。 */
  private buildDirectReposition(
    train: Train,
    current: TrainSample,
    target: Tile,
    targetStopKey: string,
  ): TrainReposition | null {
    const start = this.nearestTrackTile(current);
    if (!start) return null;
    const tiles = this.network.findPath(start, target);
    if (!tiles) return null;

    const tailBudget = Math.max(0, (train.cars - 1) * 80);
    const old = train.reposition;
    const tail =
      old && tailBudget > 0.5
        ? this.buildPathLeg(old, old.distance - tailBudget, old.distance)
        : [];

    const points: TrainPathPoint[] = [];
    const pushPoint = (point: TrainPathPoint): void => {
      const last = points[points.length - 1];
      if (!last || Math.hypot(last.x - point.x, last.y - point.y) > 0.5) {
        points.push({ x: point.x, y: point.y });
      }
    };
    for (const point of tail) pushPoint(point);
    pushPoint({ x: current.x, y: current.y });
    const headOffset = this.pathLength(points);

    for (const tile of tiles) {
      pushPoint({ x: tile.x, y: tile.y });
    }
    if (points.length < 2) return null;

    return {
      points,
      cumulative: this.pathCumulative(points),
      length: this.pathLength(points),
      distance: headOffset,
      nextStopKey: null,
      nextStopDistance: 0,
      passedNextStop: true,
      waitRemaining: 0,
      targetStopKey,
    };
  }

  /** 沿已有回送路径采样一段，用于二次改线时保留车尾。 */
  private buildPathLeg(
    path: NonNullable<Train['reposition']>,
    from: number,
    to: number,
  ): TrainPathPoint[] {
    const span = Math.abs(to - from);
    const steps = Math.max(1, Math.min(600, Math.ceil(span / 12)));
    const points: TrainPathPoint[] = [];
    for (let i = 0; i <= steps; i++) {
      const distance = from + (to - from) * (i / steps);
      const sample = this.samplePath(path, distance);
      if (sample) points.push({ x: sample.x, y: sample.y });
    }
    return points;
  }

  /** 沿旧线路折线采样一段，用于回送路径的前半段。 */
  private buildLineLeg(line: Line, from: number, to: number): TrainPathPoint[] {
    const span = Math.abs(to - from);
    const steps = Math.max(1, Math.min(600, Math.ceil(span / 12)));
    const points: TrainPathPoint[] = [];
    for (let i = 0; i <= steps; i++) {
      const distance = from + (to - from) * (i / steps);
      const sample = this.sampleLine(line, distance);
      if (sample) points.push({ x: sample.x, y: sample.y });
    }
    return points;
  }

  private nearestTrackTile(point: { x: number; y: number }): Tile | null {
    let best: Tile | null = null;
    let bestDistance = Infinity;
    for (const track of this.network.trackList) {
      const distance = Math.hypot(track.tile.x - point.x, track.tile.y - point.y);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = track.tile;
      }
    }
    return best;
  }

  private pathLength(points: TrainPathPoint[]): number {
    let total = 0;
    for (let i = 1; i < points.length; i++) {
      total += Math.hypot(
        points[i]!.x - points[i - 1]!.x,
        points[i]!.y - points[i - 1]!.y,
      );
    }
    return total;
  }

  private pathCumulative(points: TrainPathPoint[]): number[] {
    const cumulative = [0];
    let total = 0;
    for (let i = 1; i < points.length; i++) {
      total += Math.hypot(
        points[i]!.x - points[i - 1]!.x,
        points[i]!.y - points[i - 1]!.y,
      );
      cumulative.push(total);
    }
    return cumulative;
  }

  private samplePath(
    path: { points: TrainPathPoint[]; cumulative: number[]; length: number },
    distance: number,
  ): TrainSample | null {
    if (path.points.length < 2 || path.length <= 0) return null;
    const d = Math.max(0, Math.min(path.length, distance));
    let index = 0;
    while (index < path.points.length - 2 && (path.cumulative[index + 1] ?? 0) < d) {
      index++;
    }
    const start = path.points[index]!;
    const end = path.points[index + 1]!;
    const segStart = path.cumulative[index] ?? 0;
    const segEnd = path.cumulative[index + 1] ?? path.length;
    const t = (d - segStart) / Math.max(0.0001, segEnd - segStart);
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    return {
      x: start.x + dx * t,
      y: start.y + dy * t,
      angle: Math.atan2(dy, dx),
    };
  }

  /** 推进回送列车；到下一站短暂停靠，到新首站后恢复正常运行。 */
  private advanceReposition(train: Train, model: TrainModel, dt: number): void {
    const reposition = train.reposition;
    if (!reposition) return;

    if (reposition.waitRemaining > 0) {
      reposition.waitRemaining = Math.max(0, reposition.waitRemaining - dt);
      train.speed = 0;
      return;
    }

    const limit = reposition.passedNextStop ? reposition.length : reposition.nextStopDistance;
    const gap = limit - reposition.distance;
    if (gap <= STOP_EPSILON) {
      if (!reposition.passedNextStop) {
        reposition.passedNextStop = true;
        train.speed = 0;
        if (reposition.nextStopKey) this.alightDestinationsAt(train, reposition.nextStopKey);
        reposition.waitRemaining = DWELL_SECONDS;
        return;
      }
      this.finishReposition(train);
      return;
    }

    const brakeLimit = Math.sqrt(2 * TRAIN_BRAKE * gap);
    const desired = Math.min(model.speed, brakeLimit);
    if (train.speed < desired) {
      train.speed = Math.min(desired, train.speed + TRAIN_ACCEL * dt);
    } else {
      train.speed = Math.max(desired, train.speed - TRAIN_BRAKE * dt);
    }

    const step = Math.min(train.speed * dt, gap);
    if (step > 0) {
      const cost = this.chargeOperatingCost(step, PASSENGER_OPEX_PER_HEX);
      train.opexToday += cost;
      train.opexTotal += cost;
    }
    reposition.distance += step;
  }

  private finishReposition(train: Train): void {
    train.reposition = undefined;
    train.distance = 0;
    train.dir = 1;
    train.speed = 0;

    const line = train.lineId === null ? null : this.lineMap.get(train.lineId);
    const first = line?.stops[0];
    train.dwellRemaining = DWELL_SECONDS;
    if (!first) return;

    this.alightDestinationsAt(train, first.key);
    this.rebaseOnboard(train, first.key);
  }

  /** 回送途中只下客，不办理上客 / 换乘。 */
  private alightDestinationsAt(train: Train, stationKey: string): void {
    if (train.onboard.length === 0) return;
    const remaining: Passenger[] = [];
    for (const passenger of train.onboard) {
      if (passenger.destKey === stationKey) {
        this.arrivePassenger(train, passenger, stationKey);
      } else {
        remaining.push(passenger);
      }
    }
    train.onboard = remaining;
  }

  /** 接回新线路时重算车上乘客的剩余路线；无法继续的乘客留在首站候车。 */
  private rebaseOnboard(train: Train, stationKey: string): void {
    if (train.onboard.length === 0) return;
    const remaining: Passenger[] = [];
    for (const passenger of train.onboard) {
      const route = this.findPassengerRoute(stationKey, passenger.destKey);
      if (!route) {
        passenger.state = 'WAITING';
        passenger.route = [];
        passenger.legIndex = 0;
        passenger.carIndex = -1;
        this.waitingAt(stationKey).push(passenger);
        continue;
      }

      passenger.route = route.legs;
      passenger.legIndex = 0;
      const first = route.legs[0];
      if (first && first.lineId === train.lineId) {
        passenger.state = 'ON_TRAIN';
        if (passenger.carIndex < 0 || passenger.carIndex >= train.cars) {
          passenger.carIndex = 0;
        }
        remaining.push(passenger);
      } else {
        passenger.state = 'TRANSFERRING';
        passenger.carIndex = -1;
        this.waitingAt(stationKey).push(passenger);
      }
    }
    train.onboard = remaining;
  }

  /* ------------------------------ 客流 ------------------------------ */

  /** 推进游戏时钟，并按日均需求生成独立乘客对象。 */
  private advanceTime(dt: number): void {
    const minutes = dt * MINUTES_PER_SECOND;
    this.minuteOfDay += minutes;
    while (this.minuteOfDay >= MINUTES_PER_DAY) {
      this.minuteOfDay -= MINUTES_PER_DAY;
      this.day += 1;
      this.resetDaily();
    }

    const days = minutes / MINUTES_PER_DAY;
    for (const station of this.network.stationList) {
      if (STATION_DEFS[station.type].dailyDemand <= 0) continue;
      const flow = this.flowFor(station);
      const key = hexKey(station.q, station.r);
      if (flow.dailyDemand <= 0) continue;
      if (this.waitingAt(key).length >= MAX_WAITING) continue;

      flow.carry += flow.dailyDemand * days;
      const whole = Math.floor(flow.carry);
      if (whole <= 0) continue;
      flow.carry -= whole;

      let accepted = 0;
      for (let i = 0; i < whole; i++) {
        if (this.waitingAt(key).length >= MAX_WAITING) break;
        const passenger = this.spawnPassenger(station, flow);
        if (!passenger) continue;
        this.waitingAt(key).push(passenger);
        accepted += 1;
      }
      flow.generatedToday += accepted;
      flow.generatedTotal += accepted;
    }

    this.advanceCargo(minutes);
  }

  private resetDaily(): void {
    this.revenueToday = 0;
    this.deliveredToday = 0;
    this.opexToday = 0;
    this.cargoRevenueToday = 0;
    this.cargoDeliveredToday = 0;
    for (const flow of this.flowMap.values()) {
      flow.generatedToday = 0;
      flow.boardedToday = 0;
      flow.deliveredToday = 0;
      flow.transferredToday = 0;
      flow.gaveUpToday = 0;
    }
    for (const train of this.trainMap.values()) {
      train.revenueToday = 0;
      train.deliveredToday = 0;
      train.opexToday = 0;
    }
    for (const truck of this.truckMap.values()) {
      truck.revenueToday = 0;
      truck.deliveriesToday = 0;
      truck.opexToday = 0;
    }
  }

  private flowFor(station: { q: number; r: number; type: StationType; coverage: Tile[] }): StationFlow {
    const key = hexKey(station.q, station.r);
    let flow = this.flowMap.get(key);
    if (!flow) {
      flow = {
        key,
        dailyDemand: this.dailyDemandFor(station),
        carry: 0,
        generatedToday: 0,
        generatedTotal: 0,
        boardedToday: 0,
        boardedTotal: 0,
        deliveredToday: 0,
        deliveredTotal: 0,
        transferredToday: 0,
        transferredTotal: 0,
        gaveUpToday: 0,
        gaveUpTotal: 0,
      };
      this.flowMap.set(key, flow);
    }
    return flow;
  }

  private waitingAt(key: string): Passenger[] {
    let list = this.waitingByStation.get(key);
    if (!list) {
      list = [];
      this.waitingByStation.set(key, list);
    }
    return list;
  }

  /** 地图层用：车站当前候车 / 换乘人数。 */
  stationWaitingCount(tile: Tile): number {
    const station = this.network.stationAt(tile);
    if (!station) return 0;
    return this.waitingByStation.get(hexKey(station.q, station.r))?.length ?? 0;
  }

  /** 地图层用：车站当前候车 / 换乘乘客对象（只读，用于绘制圆点）。 */
  stationWaitingPassengers(tile: Tile): readonly Passenger[] {
    const station = this.network.stationAt(tile);
    if (!station) return [];
    return this.waitingByStation.get(hexKey(station.q, station.r)) ?? [];
  }

  /**
   * 生成一个独立乘客：选择目的地、按覆盖地块估算步行时间、做预算过滤，
   * 并立刻在服务图上做一次独立寻路。
   */
  private spawnPassenger(station: Station, flow: StationFlow): Passenger | null {
    const originKey = hexKey(station.q, station.r);
    const destinations = this.network.stationList.filter(
      (item) =>
        (item.q !== station.q || item.r !== station.r) && this.dailyDemandFor(item) > 0,
    );
    if (destinations.length === 0) return null;

    const weights = destinations.map((item) => Math.max(1, this.dailyDemandFor(item)));
    const destinationPool = destinations.map((item, index) => ({ item, weight: weights[index] ?? 1 }));
    let dest: Station | null = null;
    let destKey = '';
    let route: { legs: PassengerLeg[]; cost: number } | null = null;

    // 最多尝试 3 个目的站；站点不可达则换下一个
    for (let attempt = 0; attempt < 3 && destinationPool.length > 0; attempt++) {
      const pick = this.rng.weightedIndex(destinationPool.map((entry) => entry.weight));
      const candidate = destinationPool[pick]!;
      destinationPool.splice(pick, 1);

      const candidateKey = hexKey(candidate.item.q, candidate.item.r);
      const candidateRoute = this.findPassengerRoute(originKey, candidateKey);
      if (!candidateRoute) continue;
      dest = candidate.item;
      destKey = candidateKey;
      route = candidateRoute;
      break;
    }

    if (!dest || !route) {
      flow.gaveUpToday += 1;
      flow.gaveUpTotal += 1;
      return null;
    }

    const homes = station.coverage.filter((tile) => isDemandTile(tile));
    const home = homes.length > 0 ? homes[this.rng.int(homes.length)]! : station.tile;
    const walkMinutes = hexDistance(home, station.tile) * WALK_MINUTES_PER_HEX;
    const kind = passengerKindFor(home.terrain);
    // 基础预算保留个人差异；路程预算按起终点直线距离补充，不随随机系数缩水
    const distanceBudget = hexDistance(station.tile, dest.tile) * DISTANCE_BUDGET_MINUTES_PER_HEX;
    const budget = Math.round(
      PASSENGER_BUDGET[kind] * this.rng.range(0.8, 1.4) + distanceBudget,
    );
    const expectedCost = walkMinutes + route.cost;
    if (expectedCost > budget) {
      flow.gaveUpToday += 1;
      flow.gaveUpTotal += 1;
      return null;
    }

    return {
      id: this.nextPassengerId++,
      state: 'WAITING',
      kind,
      originKey,
      originName: station.name,
      destKey,
      destName: dest.name,
      budget,
      expectedCost,
      walkMinutes,
      fare: 0,
      route: route.legs,
      legIndex: 0,
      carIndex: -1,
      createdAtDay: this.day,
    };
  }

  /** 网络变化后，为所有候车 / 换乘乘客重新做独立寻路。 */
  private recomputeWaitingRoutes(): void {
    for (const [key, list] of this.waitingByStation) {
      if (list.length === 0) continue;
      const remaining: Passenger[] = [];
      for (const passenger of list) {
        // 目的站被拆除：行程无法完成，放弃
        if (!this.stationAtKey(passenger.destKey)) {
          this.giveUpPassenger(passenger);
          continue;
        }
        const route = this.findPassengerRoute(key, passenger.destKey);
        if (!route) {
          // 暂时没有可用路线（例如某段被剪断）：留在站内等待，网络恢复后会再次寻路
          passenger.route = [];
          passenger.legIndex = 0;
          passenger.expectedCost = passenger.walkMinutes;
          passenger.state = passenger.state === 'TRANSFERRING' ? 'TRANSFERRING' : 'WAITING';
          remaining.push(passenger);
          continue;
        }
        passenger.route = route.legs;
        passenger.legIndex = 0;
        passenger.expectedCost = passenger.walkMinutes + route.cost;
        passenger.state = passenger.state === 'TRANSFERRING' ? 'TRANSFERRING' : 'WAITING';
        remaining.push(passenger);
      }
      this.waitingByStation.set(key, remaining);
    }
  }

  private stationAtKey(key: string): Station | null {
    const [q, r] = key.split(',').map(Number);
    if (!Number.isFinite(q) || !Number.isFinite(r)) return null;
    const tile = this.world.get(q!, r!);
    return tile ? this.network.stationAt(tile) : null;
  }

  private giveUpPassenger(passenger: Passenger): void {
    passenger.state = 'GAVE_UP';
    const flow = this.flowForStop(passenger.originKey);
    if (!flow) return;
    flow.gaveUpToday += 1;
    flow.gaveUpTotal += 1;
  }


  private flowForStop(key: string): StationFlow | null {
    const [q, r] = key.split(',').map(Number);
    if (!Number.isFinite(q) || !Number.isFinite(r)) return null;
    const tile = this.world.get(q!, r!);
    const station = tile ? this.network.stationAt(tile) : null;
    return station ? this.flowFor(station) : null;
  }

  /** 日均乘客：车站基础量 × 区域平均经济带系数；低经济区直接为 0。 */
  private dailyDemandFor(station: { type: StationType; coverage: Tile[] }): number {
    const base = STATION_DEFS[station.type].dailyDemand;
    if (base <= 0) return 0;
    const factor = this.econFactorFor(station);
    if (factor <= 0) return 0;
    return Math.max(1, Math.round(base * factor));
  }

  /** 区域平均经济带换算出的客流系数；0.35 以下为 0，0.50 时为 2.0，上限 2.5。 */
  private econFactorFor(station: { coverage: Tile[] }): number {
    const avgEcon = this.averageEconFor(station);
    if (avgEcon < ECON_ZERO_BELOW) return 0;
    const slope = ECON_FACTOR_AT_MID / (ECON_MID - ECON_ZERO_BELOW);
    return Math.min(ECON_FACTOR_MAX, (avgEcon - ECON_ZERO_BELOW) * slope);
  }

  /** 区域平均经济带值（只统计有需求的覆盖地块），用于检视 / 说明。 */
  private averageEconFor(station: { coverage: Tile[] }): number {
    const demandTiles = station.coverage.filter((tile) => isDemandTile(tile));
    const sample = demandTiles.length > 0 ? demandTiles : station.coverage;
    if (sample.length === 0) return 0;
    return sample.reduce((sum, tile) => sum + tile.econ, 0) / sample.length;
  }

  /** 到站下客：终点乘客结算票款，换乘乘客进入站内候车。 */
  private alightAtStop(line: Line, train: Train, stopIndex: number): void {
    const stop = line.stops[stopIndex];
    if (!stop) return;

    const remaining: Passenger[] = [];
    for (const passenger of train.onboard) {
      if (passenger.destKey === stop.key) {
        this.arrivePassenger(train, passenger, stop.key);
        continue;
      }

      const leg = passenger.route[passenger.legIndex];
      if (leg && leg.toKey === stop.key) {
        passenger.state = 'TRANSFERRING';
        passenger.legIndex += 1;
        passenger.carIndex = -1;
        this.waitingAt(stop.key).push(passenger);
        const flow = this.flowForStop(stop.key);
        if (flow) {
          flow.transferredToday += 1;
          flow.transferredTotal += 1;
        }
        continue;
      }

      remaining.push(passenger);
    }
    train.onboard = remaining;
  }

  /** 终点到达：结算乘客累计票款。 */
  private arrivePassenger(train: Train, passenger: Passenger, stationKey: string): void {
    passenger.state = 'ARRIVED';
    passenger.carIndex = -1;
    const fare = Math.max(0, passenger.fare);

    this.network.credits += fare;
    this.revenueToday += fare;
    this.revenueTotal += fare;
    this.deliveredToday += 1;
    this.deliveredTotal += 1;
    train.revenueToday += fare;
    train.revenueTotal += fare;
    train.deliveredToday += 1;
    train.deliveredTotal += 1;

    const flow = this.flowForStop(stationKey);
    if (flow) {
      flow.deliveredToday += 1;
      flow.deliveredTotal += 1;
    }

    if (fare > 0) {
      const station = this.stationAtKey(stationKey);
      if (station) {
        this.incomeEvents.push({
          stationKey,
          stationName: station.name,
          x: station.tile.x,
          y: station.tile.y,
          amount: fare,
          passengerId: passenger.id,
          kind: 'passenger',
        });
        // 若场景暂时没有消费（例如纯逻辑运行），避免队列无限增长
        if (this.incomeEvents.length > 160) this.incomeEvents.shift();
      }
    }
  }

  /** 地图层每帧消费：取出本帧产生的到站票款事件。 */
  drainIncomeEvents(): FareIncomeEvent[] {
    if (this.incomeEvents.length === 0) return [];
    return this.incomeEvents.splice(0);
  }

  /** 停站结束后确定发车方向，并按每个乘客自己的路线 / 车厢空位上客。 */
  private boardAtStop(line: Line, train: Train, model: TrainModel): void {
    // 先处理折返，保证在终点站也能向返程方向上客
    if (!line.isLoop) {
      if (train.dir > 0 && train.distance >= line.length - 0.5) train.dir = -1;
      else if (train.dir < 0 && train.distance <= 0.5) train.dir = 1;
    }

    const currentIndex = this.currentStopIndex(line, train);
    if (currentIndex < 0) return;
    const stop = line.stops[currentIndex];
    if (!stop) return;

    const list = this.waitingAt(stop.key);
    if (list.length === 0) return;

    const capacity = this.trainCapacity(train);
    if (this.onboardCount(train) >= capacity) return;

    const carLoads = this.carLoads(train);
    const boarded = new Set<number>();

    for (const passenger of list) {
      if (this.onboardCount(train) >= capacity) break;

      const leg = passenger.route[passenger.legIndex];
      if (!leg) {
        // 当前没有可用路线：留在站内等待，等网络变化后重新寻路
        continue;
      }
      if (leg.fromKey !== stop.key) continue;
      if (leg.lineId !== line.id) continue;

      const toIndex = line.stops.findIndex((item) => item.key === leg.toKey);
      if (!this.directionServes(line, train, currentIndex, toIndex)) continue;

      const carIndex = this.leastLoadedCar(carLoads, train.cars);
      if (carIndex < 0) break;

      passenger.state = 'ON_TRAIN';
      passenger.carIndex = carIndex;
      passenger.fare += this.fareFor(leg.distance, model.speed);
      carLoads[carIndex] = (carLoads[carIndex] ?? 0) + 1;
      train.onboard.push(passenger);
      boarded.add(passenger.id);

      const flow = this.flowForStop(stop.key);
      if (flow) {
        flow.boardedToday += 1;
        flow.boardedTotal += 1;
      }
    }

    if (boarded.size > 0) {
      this.waitingByStation.set(
        stop.key,
        list.filter((passenger) => !boarded.has(passenger.id)),
      );
    }
  }

  /** 该方向的列车是否会经过目标站。环线只向前运行。 */
  private directionServes(
    line: Line,
    train: Train,
    fromIndex: number,
    toIndex: number,
  ): boolean {
    if (toIndex < 0 || toIndex === fromIndex) return false;
    if (line.isLoop) return true;
    return train.dir > 0 ? toIndex > fromIndex : toIndex < fromIndex;
  }

  private carLoads(train: Train): number[] {
    const loads = new Array<number>(train.cars).fill(0);
    for (const passenger of train.onboard) {
      if (passenger.carIndex >= 0 && passenger.carIndex < train.cars) {
        loads[passenger.carIndex] = (loads[passenger.carIndex] ?? 0) + 1;
      }
    }
    return loads;
  }

  /** 找到第一个未满 4 人的车厢；全部满员返回 -1。 */
  private leastLoadedCar(loads: number[], cars: number): number {
    let best = -1;
    let bestCount = PASSENGERS_PER_CAR;
    for (let i = 0; i < cars; i++) {
      const count = loads[i] ?? 0;
      if (count < bestCount) {
        best = i;
        bestCount = count;
      }
    }
    return best;
  }

  private currentStopIndex(line: Line, train: Train): number {
    let best = -1;
    let bestDelta = 0.6;
    for (let i = 0; i < line.stopDistances.length; i++) {
      const delta = Math.abs(line.stopDistances[i]! - train.distance);
      if (delta < bestDelta) {
        bestDelta = delta;
        best = i;
      }
    }
    return best;
  }

  /** 票价 = (起步价 + 里程价) × 速度系数；速度快的车型票价更高。 */
  private fareFor(distancePx: number, speed: number): number {
    const km = distancePx * KM_PER_PX;
    const speedFactor = speed / REFERENCE_SPEED;
    return Math.max(15, Math.round((FARE_BASE + km * FARE_PER_KM) * speedFactor));
  }

  private onboardCount(train: Train): number {
    return train.onboard.length;
  }

  private trainCapacity(train: Train): number {
    return train.cars * PASSENGERS_PER_CAR;
  }

  /** 列车被删除 / 改线 / 回库时，把车上乘客送回出发站重新寻路。 */
  private returnOnboard(train: Train): void {
    if (train.onboard.length === 0) return;
    const returning = train.onboard;
    train.onboard = [];

    for (const passenger of returning) {
      passenger.carIndex = -1;
      passenger.fare = 0;
      passenger.legIndex = 0;
      passenger.state = 'WAITING';

      const route = this.findPassengerRoute(passenger.originKey, passenger.destKey);
      if (!route) {
        passenger.route = [];
        passenger.expectedCost = passenger.walkMinutes;
        this.waitingAt(passenger.originKey).push(passenger);
        continue;
      }
      passenger.route = route.legs;
      passenger.expectedCost = passenger.walkMinutes + route.cost;
      this.waitingAt(passenger.originKey).push(passenger);
    }
  }

  /* ------------------------------ 乘客独立寻路 ------------------------------ */

  /**
   * 在“线路 × 车站”服务图上做 Dijkstra / A*。
   * 节点 = (lineId, station)，乘车边权重 = 预计游戏分钟，换乘边 = 固定惩罚。
   * 只考虑已配车且线路正常的线路。
   */
  private findPassengerRoute(
    fromKey: string,
    toKey: string,
  ): { legs: PassengerLeg[]; cost: number } | null {
    if (fromKey === toKey) return null;

    const usable = this.lines.filter(
      (line) =>
        line.status === 'OK' &&
        line.stopDistances.length >= 2 &&
        this.lineHasService(line),
    );
    if (usable.length === 0) return null;

    const linesAt = new Map<string, Line[]>();
    for (const line of usable) {
      for (const stop of line.stops) {
        const list = linesAt.get(stop.key);
        if (list) list.push(line);
        else linesAt.set(stop.key, [line]);
      }
    }

    const starts = linesAt.get(fromKey) ?? [];
    if (starts.length === 0) return null;

    const stateKey = (lineId: number, stationKey: string): string => `${lineId}|${stationKey}`;
    const best = new Map<string, number>();
    const info = new Map<string, { lineId: number; stationKey: string }>();
    const prev = new Map<string, { key: string; via: 'ride' | 'transfer' }>();
    const closed = new Set<string>();
    const open: string[] = [];

    const push = (lineId: number, stationKey: string, cost: number): void => {
      const key = stateKey(lineId, stationKey);
      if (cost >= (best.get(key) ?? Infinity)) return;
      best.set(key, cost);
      info.set(key, { lineId, stationKey });
      open.push(key);
    };

    for (const line of starts) push(line.id, fromKey, INITIAL_WAIT_MINUTES);

    while (open.length > 0) {
      let bestIndex = 0;
      let bestCost = Infinity;
      for (let i = 0; i < open.length; i++) {
        const cost = best.get(open[i]!) ?? Infinity;
        if (cost < bestCost) {
          bestCost = cost;
          bestIndex = i;
        }
      }

      const key = open.splice(bestIndex, 1)[0]!;
      if (closed.has(key)) continue;
      closed.add(key);

      const current = info.get(key);
      if (!current) continue;
      if (current.stationKey === toKey) {
        return this.reconstructPassengerRoute(toKey, key, info, prev, bestCost);
      }

      const line = this.lineMap.get(current.lineId);
      if (!line) continue;
      const speed = this.lineSpeed(line);
      if (speed <= 0) continue;
      const index = line.stops.findIndex((stop) => stop.key === current.stationKey);
      if (index < 0) continue;

      // 乘车边
      for (const nextIndex of this.rideNeighborIndexes(line, index)) {
        const distance = this.segmentDistance(line, index, nextIndex);
        if (distance <= 0) continue;
        const nextStop = line.stops[nextIndex];
        if (!nextStop) continue;
        const minutes = (distance / speed) * MINUTES_PER_SECOND;
        const nextKey = stateKey(line.id, nextStop.key);
        const nextCost = bestCost + minutes;
        if (nextCost < (best.get(nextKey) ?? Infinity)) {
          prev.set(nextKey, { key, via: 'ride' });
          push(line.id, nextStop.key, nextCost);
        }
      }

      // 换乘边
      for (const other of linesAt.get(current.stationKey) ?? []) {
        if (other.id === current.lineId) continue;
        const nextKey = stateKey(other.id, current.stationKey);
        const nextCost = bestCost + TRANSFER_MINUTES;
        if (nextCost < (best.get(nextKey) ?? Infinity)) {
          prev.set(nextKey, { key, via: 'transfer' });
          push(other.id, current.stationKey, nextCost);
        }
      }
    }

    return null;
  }

  private reconstructPassengerRoute(
    toKey: string,
    goalKey: string,
    info: Map<string, { lineId: number; stationKey: string }>,
    prev: Map<string, { key: string; via: 'ride' | 'transfer' }>,
    cost: number,
  ): { legs: PassengerLeg[]; cost: number } | null {
    const states: string[] = [goalKey];
    let cursor = goalKey;
    while (prev.has(cursor)) {
      cursor = prev.get(cursor)!.key;
      states.push(cursor);
      if (states.length > 512) return null;
    }
    states.reverse();

    const legs: PassengerLeg[] = [];
    let current: PassengerLeg | null = null;

    for (let i = 1; i < states.length; i++) {
      const fromState = states[i - 1]!;
      const toState = states[i]!;
      const edge = prev.get(toState);
      const fromInfo = info.get(fromState);
      const toInfo = info.get(toState);
      if (!edge || !fromInfo || !toInfo) continue;

      if (edge.via === 'transfer') {
        if (current) {
          legs.push(current);
          current = null;
        }
        continue;
      }

      const line = this.lineMap.get(toInfo.lineId);
      if (!line) continue;
      const fromStop = line.stops.find((stop) => stop.key === fromInfo.stationKey);
      const toStop = line.stops.find((stop) => stop.key === toInfo.stationKey);
      if (!fromStop || !toStop) continue;

      const distance = this.segmentDistanceByKeys(line, fromStop.key, toStop.key);
      if (!current) {
        current = {
          lineId: line.id,
          lineName: line.name,
          fromKey: fromStop.key,
          fromName: fromStop.name,
          toKey: toStop.key,
          toName: toStop.name,
          distance: 0,
          minutes: 0,
        };
      }
      current.toKey = toStop.key;
      current.toName = toStop.name;
      current.distance += distance;
      current.minutes += (distance / Math.max(0.001, this.lineSpeed(line))) * MINUTES_PER_SECOND;
    }

    if (current) legs.push(current);
    if (legs.length === 0) return null;
    if (legs[legs.length - 1]!.toKey !== toKey) return null;
    return { legs, cost };
  }

  private rideNeighborIndexes(line: Line, index: number): number[] {
    const count = line.stops.length;
    if (count < 2) return [];
    if (line.isLoop) return [(index + 1) % count];
    const result: number[] = [];
    if (index > 0) result.push(index - 1);
    if (index < count - 1) result.push(index + 1);
    return result;
  }

  private segmentDistance(line: Line, fromIndex: number, toIndex: number): number {
    const count = line.stopDistances.length;
    if (fromIndex < 0 || toIndex < 0 || fromIndex >= count || toIndex >= count) return 0;
    if (line.isLoop && fromIndex === count - 1 && toIndex === 0) {
      return Math.max(0, line.length - (line.stopDistances[fromIndex] ?? 0));
    }
    return Math.abs((line.stopDistances[toIndex] ?? 0) - (line.stopDistances[fromIndex] ?? 0));
  }

  private segmentDistanceByKeys(line: Line, fromKey: string, toKey: string): number {
    const fromIndex = line.stops.findIndex((stop) => stop.key === fromKey);
    const toIndex = line.stops.findIndex((stop) => stop.key === toKey);
    if (fromIndex < 0 || toIndex < 0) return 0;
    return this.segmentDistance(line, fromIndex, toIndex);
  }

  private lineHasService(line: Line): boolean {
    return this.lineSpeed(line) > 0;
  }

  private lineSpeed(line: Line): number {
    let fastest = 0;
    for (const trainId of line.trainIds) {
      const train = this.trainMap.get(trainId);
      if (!train) continue;
      const model = trainModel(train.modelId);
      if (model) fastest = Math.max(fastest, model.speed);
    }
    return fastest;
  }

  /* ------------------------------ 货运 ------------------------------ */

  /** 找到货运站所属（或紧邻）的工业区。 */
  private industryBlobForStation(station: Station): { id: number; name: string } | null {
    const own =
      station.tile.blobId === null ? null : this.world.blobById.get(station.tile.blobId);
    if (own && own.kind === 'industry') return { id: own.id, name: own.name };

    for (const neighbor of this.world.neighbors(station.tile)) {
      if (neighbor.blobId === null) continue;
      const blob = this.world.blobById.get(neighbor.blobId);
      if (blob && blob.kind === 'industry') return { id: blob.id, name: blob.name };
    }
    return null;
  }

  /** 每个工业区每个游戏小时检查一次货单；目的地是另一个工业区。 */
  private advanceCargo(minutes: number): void {
    const groups = new Map<number, { name: string; stations: Station[] }>();
    for (const station of this.network.stationList) {
      if (station.type !== 'freight') continue;
      const blob = this.industryBlobForStation(station);
      if (!blob) continue;
      const group = groups.get(blob.id);
      if (group) group.stations.push(station);
      else groups.set(blob.id, { name: blob.name, stations: [station] });
    }

    for (const blobId of [...this.cargoTimers.keys()]) {
      if (!groups.has(blobId)) this.cargoTimers.delete(blobId);
    }

    for (const [blobId] of groups) {
      let timer = this.cargoTimers.get(blobId);
      if (timer === undefined) {
        // 首次启用：随机相位到下一个整点检查
        this.cargoTimers.set(blobId, this.rng.range(0, CARGO_ORDER_CHECK_MINUTES));
        continue;
      }

      timer -= minutes;
      while (timer <= 0) {
        timer += CARGO_ORDER_CHECK_MINUTES;
        this.tryCreateCargoOrder(blobId, groups);
      }
      this.cargoTimers.set(blobId, timer);
    }
  }

  /** 每个工业区每小时检查一次：5% 概率生成一张货单。 */
  private tryCreateCargoOrder(
    blobId: number,
    groups: Map<number, { name: string; stations: Station[] }>,
  ): void {
    if (groups.size < 2 || this.cargoOrders.size >= CARGO_MAX_ORDERS) return;
    if (!this.rng.chance(CARGO_ORDER_CHANCE_PER_HOUR)) return;

    const group = groups.get(blobId);
    if (!group) return;
    const others = [...groups.keys()].filter((id) => id !== blobId);
    const destBlobId = others[this.rng.int(others.length)];
    if (destBlobId === undefined) return;
    const destGroup = groups.get(destBlobId);
    if (!destGroup) return;

    const originStation = group.stations[this.rng.int(group.stations.length)];
    const destStation = destGroup.stations[this.rng.int(destGroup.stations.length)];
    if (!originStation || !destStation || originStation.tile === destStation.tile) return;

    const amount = this.rng.intBetween(CARGO_AMOUNT_MIN, CARGO_AMOUNT_MAX);
    const reward = this.rng.intBetween(CARGO_REWARD_MIN, CARGO_REWARD_MAX);
    const order: CargoOrder = {
      id: this.nextCargoOrderId++,
      originKey: hexKey(originStation.q, originStation.r),
      originName: originStation.name,
      originX: originStation.tile.x,
      originY: originStation.tile.y,
      destKey: hexKey(destStation.q, destStation.r),
      destName: destStation.name,
      destX: destStation.tile.x,
      destY: destStation.tile.y,
      amount,
      reward,
      createdAtDay: this.day,
      truckId: null,
    };
    this.cargoOrders.set(order.id, order);
    this.cargoDispatchCooldown = 0;
  }

  /** 货运列车沿轨道移动、装货、卸货与送达。 */
  private updateTrucks(dt: number): void {
    for (const truck of this.truckMap.values()) {
      if (truck.orderId === null) {
        truck.state = 'hidden';
        truck.path = [];
        truck.pathIndex = 0;
        continue;
      }

      const order = this.cargoOrders.get(truck.orderId);
      if (!order) {
        this.abortCargoTrain(truck);
        continue;
      }

      switch (truck.state) {
        case 'toPickup': {
          if (this.advanceCargoTrain(truck, dt)) {
            const origin = this.stationAtKey(order.originKey);
            if (origin) {
              truck.x = origin.tile.x;
              truck.y = origin.tile.y;
            }
            truck.currentTileKey = order.originKey;
            truck.state = 'loading';
            truck.timer = TRUCK_LOAD_SECONDS;
            truck.loaded = false;
            truck.path = [];
            truck.pathIndex = 0;
          }
          break;
        }
        case 'loading': {
          truck.timer = Math.max(0, truck.timer - dt);
          if (truck.timer === 0) {
            const path = this.cargoPath(order.originKey, order.destKey);
            if (!path) {
              // 装货后才发现没有到达目的地的轨道：订单退回，列车隐藏
              this.abortCargoTrain(truck, order.originKey);
              break;
            }
            truck.loaded = true;
            truck.state = 'toDropoff';
            truck.path = path;
            truck.pathIndex = path.length > 1 ? 1 : path.length;
            if (path.length <= 1) {
              truck.state = 'unloading';
              truck.timer = TRUCK_UNLOAD_SECONDS;
              truck.path = [];
              truck.pathIndex = 0;
            }
          }
          break;
        }
        case 'toDropoff': {
          if (this.advanceCargoTrain(truck, dt)) {
            truck.x = order.destX;
            truck.y = order.destY;
            truck.currentTileKey = order.destKey;
            truck.state = 'unloading';
            truck.timer = TRUCK_UNLOAD_SECONDS;
            truck.path = [];
            truck.pathIndex = 0;
          }
          break;
        }
        case 'unloading': {
          truck.timer = Math.max(0, truck.timer - dt);
          if (truck.timer === 0) this.deliverCargo(truck, order);
          break;
        }
        case 'hidden':
          break;
      }
    }
  }

  /** 按实际行驶像素收取运行成本；返回本次扣款金额。 */
  private chargeOperatingCost(distancePx: number, perHex: number): number {
    if (distancePx <= 0) return 0;
    const cost = (distancePx / (SQRT3 * HEX_SIZE)) * perHex;
    if (cost <= 0) return 0;
    this.network.credits -= cost;
    this.opexToday += cost;
    this.opexTotal += cost;
    return cost;
  }

  /** 沿当前轨道折线路径前进；返回是否已到达路径终点。 */
  private advanceCargoTrain(truck: Truck, dt: number): boolean {
    if (truck.pathIndex >= truck.path.length) return true;

    let remaining = TRUCK_SPEED * dt;
    let moved = 0;
    while (remaining > 0 && truck.pathIndex < truck.path.length) {
      const target = truck.path[truck.pathIndex]!;
      const dx = target.x - truck.x;
      const dy = target.y - truck.y;
      const distance = Math.hypot(dx, dy);

      if (distance <= remaining) {
        truck.x = target.x;
        truck.y = target.y;
        truck.currentTileKey = target.key;
        truck.pathIndex += 1;
        remaining -= distance;
        moved += distance;
        if (distance > 0.001) truck.heading = Math.atan2(dy, dx);
      } else {
        truck.heading = Math.atan2(dy, dx);
        truck.x += (dx / distance) * remaining;
        truck.y += (dy / distance) * remaining;
        moved += remaining;
        remaining = 0;
      }
    }

    if (moved > 0) {
      const cost = this.chargeOperatingCost(moved, CARGO_OPEX_PER_HEX);
      truck.opexToday += cost;
      truck.opexTotal += cost;
    }

    if (truck.pathIndex >= truck.path.length) {
      truck.path = [];
      truck.pathIndex = 0;
      return true;
    }
    return false;
  }

  private tileForKey(key: string): Tile | null {
    const [q, r] = key.split(',').map(Number);
    if (!Number.isFinite(q) || !Number.isFinite(r)) return null;
    return this.world.get(q!, r!) ?? null;
  }

  /** 在轨道图上为货运列车找一条路径（只走启用连接）。 */
  private cargoPath(fromKey: string, toKey: string): CargoPathPoint[] | null {
    const from = this.stationAtKey(fromKey);
    const to = this.stationAtKey(toKey);
    if (!from || !to) return null;
    const tiles = this.network.findPath(from.tile, to.tile);
    if (!tiles) return null;
    return tiles.map((tile) => ({
      x: tile.x,
      y: tile.y,
      key: hexKey(tile.q, tile.r),
    }));
  }

  private cargoPathLength(path: CargoPathPoint[]): number {
    let total = 0;
    for (let i = 1; i < path.length; i++) {
      const a = path[i - 1]!;
      const b = path[i]!;
      total += Math.hypot(b.x - a.x, b.y - a.y);
    }
    return total;
  }

  /** 当前剩余路径是否仍然完整（未被剪断 / 拆除）。 */
  private cargoPathValid(truck: Truck): boolean {
    if (truck.path.length === 0 || truck.pathIndex >= truck.path.length) return true;
    for (let i = Math.max(0, truck.pathIndex - 1); i < truck.path.length - 1; i++) {
      const a = this.tileForKey(truck.path[i]!.key);
      const b = this.tileForKey(truck.path[i + 1]!.key);
      if (!a || !b || !this.network.isLinkEnabled(a, b)) return false;
    }
    return true;
  }

  private deliverCargo(truck: Truck, order: CargoOrder): void {
    this.cargoOrders.delete(order.id);
    const reward = order.reward;

    this.network.credits += reward;
    this.revenueToday += reward;
    this.revenueTotal += reward;
    this.cargoRevenueToday += reward;
    this.cargoRevenueTotal += reward;
    this.cargoDeliveredToday += 1;
    this.cargoDeliveredTotal += 1;

    truck.revenueToday += reward;
    truck.revenueTotal += reward;
    truck.deliveriesToday += 1;
    truck.deliveriesTotal += 1;
    truck.loaded = false;
    truck.orderId = null;
    truck.timer = 0;
    truck.x = order.destX;
    truck.y = order.destY;
    truck.currentTileKey = order.destKey;
    truck.lastStationKey = order.destKey;
    truck.path = [];
    truck.pathIndex = 0;
    truck.state = 'hidden';
    this.cargoDispatchCooldown = 0;

    this.incomeEvents.push({
      stationKey: order.destKey,
      stationName: order.destName,
      x: order.destX,
      y: order.destY,
      amount: reward,
      passengerId: 0,
      kind: 'cargo',
    });
    if (this.incomeEvents.length > 160) this.incomeEvents.shift();
  }

  /** 取消当前货单，把列车隐藏起来；订单退回等待队列。 */
  private abortCargoTrain(truck: Truck, stationKey?: string): void {
    if (truck.orderId !== null) {
      const order = this.cargoOrders.get(truck.orderId);
      if (order) order.truckId = null;
    }
    truck.orderId = null;
    truck.loaded = false;
    truck.timer = 0;
    truck.state = 'hidden';
    truck.path = [];
    truck.pathIndex = 0;
    this.cargoDispatchCooldown = 0;

    if (stationKey) {
      const station = this.stationAtKey(stationKey);
      if (station) {
        truck.lastStationKey = stationKey;
        truck.currentTileKey = stationKey;
        truck.x = station.tile.x;
        truck.y = station.tile.y;
      }
    }
  }

  /** 给空闲的货运列车分配最近的、轨道可达的货单。 */
  private dispatchCargo(): void {
    let waiting = [...this.cargoOrders.values()].filter((order) => order.truckId === null);
    if (waiting.length === 0) {
      for (const truck of this.truckMap.values()) {
        if (truck.orderId === null) truck.state = 'hidden';
      }
      return;
    }

    const available = this.trucks.filter(
      (truck) => truck.orderId === null && truck.state === 'hidden',
    );
    if (available.length === 0) return;

    for (const truck of available) {
      if (waiting.length === 0) break;

      let startKey = truck.lastStationKey;
      if (startKey && !this.stationAtKey(startKey)) {
        startKey = null;
        truck.lastStationKey = null;
        truck.currentTileKey = null;
      }
      const startStation = startKey ? this.stationAtKey(startKey) : null;

      let chosen: CargoOrder | null = null;
      let chosenPath: CargoPathPoint[] | null = null;
      let bestScore = Infinity;

      for (const order of waiting) {
        const origin = this.stationAtKey(order.originKey);
        const dest = this.stationAtKey(order.destKey);
        if (!origin || !dest) continue;

        let toPickup: CargoPathPoint[] | null = null;
        if (startKey && startStation) {
          toPickup = this.cargoPath(startKey, order.originKey);
          if (!toPickup) continue;
        }
        const toDest = this.cargoPath(order.originKey, order.destKey);
        if (!toDest) continue;

        const score = toPickup ? this.cargoPathLength(toPickup) : 0;
        if (score < bestScore) {
          bestScore = score;
          chosen = order;
          chosenPath = toPickup;
        }
      }

      if (!chosen) continue;
      waiting = waiting.filter((order) => order.id !== chosen!.id);

      chosen.truckId = truck.id;
      truck.orderId = chosen.id;
      truck.loaded = false;
      truck.timer = 0;
      truck.path = [];
      truck.pathIndex = 0;

      if (startKey && startStation) {
        // 有货单时在“上一次的终点”重新出现
        truck.x = startStation.tile.x;
        truck.y = startStation.tile.y;
        truck.currentTileKey = startKey;
        if (chosenPath && chosenPath.length > 1) {
          truck.path = chosenPath;
          truck.pathIndex = 1;
          truck.heading = Math.atan2(
            chosenPath[1]!.y - truck.y,
            chosenPath[1]!.x - truck.x,
          );
          truck.state = 'toPickup';
        } else {
          // 上一次终点就是取货站，直接装货
          truck.state = 'loading';
          truck.timer = TRUCK_LOAD_SECONDS;
          truck.currentTileKey = chosen.originKey;
          const origin = this.stationAtKey(chosen.originKey);
          if (origin) {
            truck.x = origin.tile.x;
            truck.y = origin.tile.y;
          }
        }
      } else {
        // 新车第一次接单：直接在货单起点生成并装货
        const origin = this.stationAtKey(chosen.originKey);
        if (!origin) continue;
        truck.x = origin.tile.x;
        truck.y = origin.tile.y;
        truck.currentTileKey = chosen.originKey;
        truck.state = 'loading';
        truck.timer = TRUCK_LOAD_SECONDS;
      }
    }
  }

  /** 轨道网络变化后，检查在途货运列车的剩余路径是否仍然可走。 */
  private revalidateCargoTrains(): void {
    for (const truck of this.truckMap.values()) {
      if (truck.orderId === null) continue;
      const order = this.cargoOrders.get(truck.orderId);
      if (!order) {
        this.abortCargoTrain(truck);
        continue;
      }
      if (truck.state !== 'toPickup' && truck.state !== 'toDropoff') continue;
      if (this.cargoPathValid(truck)) continue;

      const targetKey = truck.state === 'toPickup' ? order.originKey : order.destKey;
      const startKey = truck.currentTileKey;
      if (!startKey) {
        this.abortCargoTrain(truck);
        continue;
      }
      const path = this.cargoPath(startKey, targetKey);
      if (!path) {
        this.abortCargoTrain(truck);
        continue;
      }

      const startTile = this.tileForKey(startKey);
      if (startTile) {
        truck.x = startTile.x;
        truck.y = startTile.y;
      }
      truck.currentTileKey = startKey;
      truck.path = path;
      truck.pathIndex = path.length > 1 ? 1 : path.length;
      if (path.length <= 1) {
        truck.path = [];
        truck.pathIndex = 0;
        if (truck.state === 'toPickup') {
          truck.state = 'loading';
          truck.timer = TRUCK_LOAD_SECONDS;
          truck.loaded = false;
        } else {
          truck.state = 'unloading';
          truck.timer = TRUCK_UNLOAD_SECONDS;
        }
      }
    }
  }

  /** 车站被拆除后清理相关货单、工业区计时器与失效的终点。 */
  private pruneCargo(): void {
    const keys = new Set(
      this.network.stationList.map((station) => hexKey(station.q, station.r)),
    );
    const activeBlobs = new Set<number>();
    for (const station of this.network.stationList) {
      if (station.type !== 'freight') continue;
      const blob = this.industryBlobForStation(station);
      if (blob) activeBlobs.add(blob.id);
    }
    for (const blobId of [...this.cargoTimers.keys()]) {
      if (!activeBlobs.has(blobId)) this.cargoTimers.delete(blobId);
    }

    for (const order of [...this.cargoOrders.values()]) {
      if (keys.has(order.originKey) && keys.has(order.destKey)) continue;
      if (order.truckId !== null) {
        const truck = this.truckMap.get(order.truckId);
        if (truck) {
          truck.orderId = null;
          truck.loaded = false;
          truck.timer = 0;
          truck.path = [];
          truck.pathIndex = 0;
          truck.state = 'hidden';
        }
      }
      this.cargoOrders.delete(order.id);
    }

    for (const truck of this.truckMap.values()) {
      if (truck.lastStationKey && !keys.has(truck.lastStationKey)) {
        truck.lastStationKey = null;
        if (truck.orderId === null) truck.currentTileKey = null;
      }
    }
  }

  /** 某货站当前等待接单的货单数。 */
  cargoWaitingAt(key: string): number {
    let count = 0;
    for (const order of this.cargoOrders.values()) {
      if (order.truckId === null && order.originKey === key) count += 1;
    }
    return count;
  }

  cargoView(): CargoView {
    let waitingOrders = 0;
    let activeOrders = 0;
    for (const order of this.cargoOrders.values()) {
      if (order.truckId === null) waitingOrders += 1;
      else activeOrders += 1;
    }
    const trucks = this.trucks;
    const cargoOpexToday = trucks.reduce((sum, truck) => sum + truck.opexToday, 0);
    const cargoOpexTotal = trucks.reduce((sum, truck) => sum + truck.opexTotal, 0);
    return {
      truckCost: TRUCK_COST,
      truckCount: trucks.length,
      visibleTrucks: trucks.filter((truck) => truck.state !== 'hidden').length,
      hiddenTrucks: trucks.filter((truck) => truck.state === 'hidden').length,
      waitingOrders,
      activeOrders,
      revenueToday: this.cargoRevenueToday,
      revenueTotal: this.cargoRevenueTotal,
      deliveriesToday: this.cargoDeliveredToday,
      deliveriesTotal: this.cargoDeliveredTotal,
      opexToday: cargoOpexToday,
      opexTotal: cargoOpexTotal,
      trucks: trucks.map((truck) => this.truckInfo(truck)),
    };
  }

  truckInfo(truck: Truck): TruckInfoView {
    const order = truck.orderId === null ? null : this.cargoOrders.get(truck.orderId) ?? null;
    return {
      id: truck.id,
      state: truckStateLabel(truck.state),
      stateKey: truck.state,
      loaded: truck.loaded,
      order: order
        ? {
            originName: order.originName,
            destName: order.destName,
            amount: order.amount,
            reward: order.reward,
          }
        : null,
      revenueToday: truck.revenueToday,
      deliveriesToday: truck.deliveriesToday,
      opexToday: truck.opexToday,
      opexTotal: truck.opexTotal,
    };
  }

  /* ------------------------------ 存档 ------------------------------ */

  private clonePassenger(passenger: Passenger): Passenger {
    return {
      ...passenger,
      route: (passenger.route ?? []).map((leg) => ({ ...leg })),
    };
  }

  serialize(): OperationsSave {
    return {
      day: this.day,
      minuteOfDay: this.minuteOfDay,
      revenueToday: this.revenueToday,
      revenueTotal: this.revenueTotal,
      deliveredToday: this.deliveredToday,
      deliveredTotal: this.deliveredTotal,
      opexToday: this.opexToday,
      opexTotal: this.opexTotal,
      cargoRevenueToday: this.cargoRevenueToday,
      cargoRevenueTotal: this.cargoRevenueTotal,
      cargoDeliveredToday: this.cargoDeliveredToday,
      cargoDeliveredTotal: this.cargoDeliveredTotal,
      nextLineId: this.nextLineId,
      nextTrainId: this.nextTrainId,
      nextPassengerId: this.nextPassengerId,
      nextCargoOrderId: this.nextCargoOrderId,
      nextTruckId: this.nextTruckId,
      rngState: this.rng.getState(),
      lines: this.lines.map((line) => ({
        id: line.id,
        name: line.name,
        color: line.color,
        colorCss: line.colorCss,
        isLoop: line.isLoop,
        stops: line.stops.map((stop) => ({ ...stop })),
        trainIds: [...line.trainIds],
      })),
      trains: this.trains.map((train) => ({
        ...train,
        onboard: train.onboard.map((passenger) => this.clonePassenger(passenger)),
      })),
      flows: [...this.flowMap.values()].map((flow) => ({ ...flow })),
      waiting: [...this.waitingByStation.entries()]
        .filter(([, passengers]) => passengers.length > 0)
        .map(([key, passengers]) => ({
          key,
          passengers: passengers.map((passenger) => this.clonePassenger(passenger)),
        })),
      cargoOrders: [...this.cargoOrders.values()].map((order) => ({ ...order })),
      trucks: this.trucks.map((truck) => ({
        ...truck,
        path: truck.path.map((point) => ({ ...point })),
      })),
      cargoTimers: [...this.cargoTimers.entries()].map(([blobId, minutes]) => ({
        blobId,
        minutes,
      })),
    };
  }

  /** 恢复运营层；线路路径、连通性和在途路径会重新校验。 */
  restore(save: OperationsSave): void {
    this.day = Math.max(1, Math.floor(save.day || 1));
    this.minuteOfDay =
      ((Number.isFinite(save.minuteOfDay) ? save.minuteOfDay : 8 * 60) % MINUTES_PER_DAY +
        MINUTES_PER_DAY) %
      MINUTES_PER_DAY;
    this.revenueToday = Number.isFinite(save.revenueToday) ? save.revenueToday : 0;
    this.revenueTotal = Number.isFinite(save.revenueTotal) ? save.revenueTotal : 0;
    this.deliveredToday = Number.isFinite(save.deliveredToday) ? save.deliveredToday : 0;
    this.deliveredTotal = Number.isFinite(save.deliveredTotal) ? save.deliveredTotal : 0;
    this.opexToday = Number.isFinite(save.opexToday) ? save.opexToday : 0;
    this.opexTotal = Number.isFinite(save.opexTotal) ? save.opexTotal : 0;
    this.cargoRevenueToday = Number.isFinite(save.cargoRevenueToday)
      ? save.cargoRevenueToday
      : 0;
    this.cargoRevenueTotal = Number.isFinite(save.cargoRevenueTotal)
      ? save.cargoRevenueTotal
      : 0;
    this.cargoDeliveredToday = Number.isFinite(save.cargoDeliveredToday)
      ? save.cargoDeliveredToday
      : 0;
    this.cargoDeliveredTotal = Number.isFinite(save.cargoDeliveredTotal)
      ? save.cargoDeliveredTotal
      : 0;

    if (Number.isFinite(save.rngState)) this.rng.setState(save.rngState);

    this.lineMap.clear();
    this.trainMap.clear();
    this.flowMap.clear();
    this.waitingByStation.clear();
    this.cargoOrders.clear();
    this.truckMap.clear();
    this.cargoTimers.clear();
    this.incomeEvents.length = 0;

    for (const saved of save.lines ?? []) {
      if (!saved || !Number.isFinite(saved.id)) continue;
      const line: Line = {
        id: saved.id,
        name: saved.name || `线路 ${saved.id}`,
        color: saved.color ?? 0xe9b968,
        colorCss: saved.colorCss ?? '#e9b968',
        isLoop: Boolean(saved.isLoop),
        stops: (saved.stops ?? []).map((stop) => ({ ...stop })),
        trainIds: [...(saved.trainIds ?? [])],
        status: 'OK',
        route: [],
        points: [],
        cumulative: [],
        stopDistances: [],
        length: 0,
      };
      this.lineMap.set(line.id, line);
    }

    for (const saved of save.trains ?? []) {
      if (!saved || !Number.isFinite(saved.id)) continue;
      const lineId =
        saved.lineId !== null && this.lineMap.has(saved.lineId) ? saved.lineId : null;
      const train: Train = {
        id: saved.id,
        modelId: saved.modelId,
        cars: Math.max(1, Math.floor(saved.cars)),
        lineId,
        distance: Number.isFinite(saved.distance) ? saved.distance : 0,
        dir: saved.dir === -1 ? -1 : 1,
        speed: Number.isFinite(saved.speed) ? saved.speed : 0,
        dwellRemaining: Number.isFinite(saved.dwellRemaining) ? saved.dwellRemaining : 0,
        reposition:
          lineId !== null &&
          saved.reposition &&
          Array.isArray(saved.reposition.points) &&
          saved.reposition.points.length >= 2 &&
          Array.isArray(saved.reposition.cumulative) &&
          Number.isFinite(saved.reposition.length)
            ? {
                points: saved.reposition.points.map((point) => ({ x: point.x, y: point.y })),
                cumulative: saved.reposition.cumulative.map((value) => Number(value) || 0),
                length: saved.reposition.length,
                distance: Number.isFinite(saved.reposition.distance)
                  ? saved.reposition.distance
                  : 0,
                nextStopKey: saved.reposition.nextStopKey ?? null,
                nextStopDistance: Number.isFinite(saved.reposition.nextStopDistance)
                  ? saved.reposition.nextStopDistance
                  : 0,
                passedNextStop: Boolean(saved.reposition.passedNextStop),
                waitRemaining: Number.isFinite(saved.reposition.waitRemaining)
                  ? saved.reposition.waitRemaining
                  : 0,
                targetStopKey: saved.reposition.targetStopKey ?? '',
              }
            : undefined,
        onboard: (saved.onboard ?? []).map((passenger) => this.clonePassenger(passenger)),
        revenueToday: Number.isFinite(saved.revenueToday) ? saved.revenueToday : 0,
        revenueTotal: Number.isFinite(saved.revenueTotal) ? saved.revenueTotal : 0,
        deliveredToday: Number.isFinite(saved.deliveredToday) ? saved.deliveredToday : 0,
        deliveredTotal: Number.isFinite(saved.deliveredTotal) ? saved.deliveredTotal : 0,
        opexToday: Number.isFinite(saved.opexToday) ? saved.opexToday : 0,
        opexTotal: Number.isFinite(saved.opexTotal) ? saved.opexTotal : 0,
      };
      this.trainMap.set(train.id, train);
    }

    // 同步线路与列车归属，避免存档损坏造成悬空引用
    for (const line of this.lineMap.values()) {
      line.trainIds = line.trainIds.filter((id) => this.trainMap.has(id));
      for (const trainId of line.trainIds) {
        const train = this.trainMap.get(trainId);
        if (train) train.lineId = line.id;
      }
    }
    for (const train of this.trainMap.values()) {
      if (train.lineId === null) continue;
      const line = this.lineMap.get(train.lineId);
      if (line && !line.trainIds.includes(train.id)) line.trainIds.push(train.id);
    }

    for (const saved of save.flows ?? []) {
      if (!saved || !saved.key) continue;
      this.flowMap.set(saved.key, { ...saved });
    }

    for (const entry of save.waiting ?? []) {
      if (!entry || !entry.key) continue;
      this.waitingByStation.set(
        entry.key,
        (entry.passengers ?? []).map((passenger) => this.clonePassenger(passenger)),
      );
    }

    for (const saved of save.cargoOrders ?? []) {
      if (!saved || !Number.isFinite(saved.id)) continue;
      this.cargoOrders.set(saved.id, { ...saved });
    }

    for (const saved of save.trucks ?? []) {
      if (!saved || !Number.isFinite(saved.id)) continue;
      this.truckMap.set(saved.id, {
        ...saved,
        path: (saved.path ?? []).map((point) => ({ ...point })),
        pathIndex: Number.isFinite(saved.pathIndex) ? saved.pathIndex : 0,
        opexToday: Number.isFinite(saved.opexToday) ? saved.opexToday : 0,
        opexTotal: Number.isFinite(saved.opexTotal) ? saved.opexTotal : 0,
      });
    }

    for (const entry of save.cargoTimers ?? []) {
      if (!entry || !Number.isFinite(entry.blobId) || !Number.isFinite(entry.minutes)) {
        continue;
      }
      // 兼容旧存档的 6–8 天计时器：迁移为“下一次整点检查”
      this.cargoTimers.set(
        entry.blobId,
        Math.max(0, Math.min(CARGO_ORDER_CHECK_MINUTES, entry.minutes)),
      );
    }

    const maxLineId = Math.max(0, ...this.lines.map((line) => line.id));
    const maxTrainId = Math.max(0, ...this.trainMap.keys());
    const maxPassengerId = Math.max(
      0,
      ...[...this.waitingByStation.values()].flatMap((list) => list.map((p) => p.id)),
      ...this.trains.flatMap((train) => train.onboard.map((p) => p.id)),
    );
    const maxOrderId = Math.max(0, ...this.cargoOrders.keys());
    const maxTruckId = Math.max(0, ...this.truckMap.keys());
    this.nextLineId = Math.max(save.nextLineId || 1, maxLineId + 1);
    this.nextTrainId = Math.max(save.nextTrainId || 1, maxTrainId + 1);
    this.nextPassengerId = Math.max(save.nextPassengerId || 1, maxPassengerId + 1);
    this.nextCargoOrderId = Math.max(save.nextCargoOrderId || 1, maxOrderId + 1);
    this.nextTruckId = Math.max(save.nextTruckId || 1, maxTruckId + 1);
    this.cargoDispatchCooldown = 0;

    // 重建线路路径、站点统计、候车寻路与货运列车路径
    this.recomputeRoutes();
  }

  /* ------------------------------ 信息视图 ------------------------------ */

  clockView(): ClockView {
    return {
      day: this.day,
      time: clockLabel(this.minuteOfDay),
      revenueToday: this.revenueToday,
      revenueTotal: this.revenueTotal,
      deliveredToday: this.deliveredToday,
      deliveredTotal: this.deliveredTotal,
      opexToday: this.opexToday,
      opexTotal: this.opexTotal,
    };
  }

  private kindCounts(passengers: readonly Passenger[]): PassengerKindCount[] {
    const counts = new Map<PassengerKind, number>();
    for (const passenger of passengers) {
      counts.set(passenger.kind, (counts.get(passenger.kind) ?? 0) + 1);
    }
    return PASSENGER_KIND_LIST.map((def) => ({
      kind: def.kind,
      name: def.name,
      colorCss: def.colorCss,
      count: counts.get(def.kind) ?? 0,
    })).filter((item) => item.count > 0);
  }

  stationInfo(tile: Tile): StationFlowView | null {
    const station = this.network.stationAt(tile);
    if (!station) return null;
    const flow = this.flowFor(station);
    const key = hexKey(station.q, station.r);
    const waiting = this.waitingAt(key);
    const transferring = waiting.filter((passenger) => passenger.state === 'TRANSFERRING').length;
    const destMap = new Map<string, number>();
    for (const passenger of waiting) {
      destMap.set(passenger.destName, (destMap.get(passenger.destName) ?? 0) + 1);
    }
    const destinations = [...destMap.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count);
    const lines = this.lines
      .filter((line) => line.stops.some((stop) => stop.key === key))
      .map((line) => ({ name: line.name, colorCss: line.colorCss }));
    return {
      key,
      name: station.name,
      type: station.type,
      waiting: waiting.length,
      transferring,
      dailyDemand: flow.dailyDemand,
      avgEcon: this.averageEconFor(station),
      econFactor: this.econFactorFor(station),
      cargoWaiting: this.cargoWaitingAt(key),
      generatedToday: flow.generatedToday,
      boardedToday: flow.boardedToday,
      deliveredToday: flow.deliveredToday,
      gaveUpToday: flow.gaveUpToday,
      generatedTotal: flow.generatedTotal,
      deliveredTotal: flow.deliveredTotal,
      coverage: station.coverage.length,
      demandTiles: station.demandTiles,
      kinds: this.kindCounts(waiting),
      destinations,
      lines,
    };
  }

  trainInfo(train: Train): TrainInfoView {
    const model = trainModel(train.modelId);
    const line = train.lineId === null ? null : this.lineMap.get(train.lineId);
    const onboard = this.onboardCount(train);

    let state = '库存';
    let nextStopName: string | null = null;
    if (line) {
      if (line.status !== 'OK') {
        state = '线路断开';
      } else if (train.reposition) {
        state = '回送中';
        nextStopName = line.stops[0]?.name ?? null;
      } else if (train.dwellRemaining > 0) {
        state = '停站中';
        const index = this.currentStopIndex(line, train);
        nextStopName = index >= 0 ? line.stops[index]?.name ?? null : null;
      } else {
        state = '运行中';
        const next = this.nextStopAhead(line, train);
        nextStopName = next ? line.stops[next.index]?.name ?? null : null;
      }
    }

    const destMap = new Map<string, number>();
    for (const passenger of train.onboard) {
      destMap.set(passenger.destName, (destMap.get(passenger.destName) ?? 0) + 1);
    }
    const destinations = [...destMap.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count);

    return {
      id: train.id,
      lineName: line?.name ?? null,
      lineColorCss: line?.colorCss ?? '#8a97a0',
      modelName: model?.name ?? '未知车型',
      cars: train.cars,
      onboard,
      capacity: this.trainCapacity(train),
      state,
      nextStopName,
      speed: Math.round(train.speed),
      revenueToday: train.revenueToday,
      deliveredToday: train.deliveredToday,
      opexToday: train.opexToday,
      opexTotal: train.opexTotal,
      carLoads: this.carLoads(train),
      kinds: this.kindCounts(train.onboard),
      destinations,
    };
  }

  sampleLine(line: Line, distance: number): TrainSample | null {
    if (line.length <= 0 || line.points.length < 2) return null;

    let d = distance;
    if (line.isLoop) {
      d = ((d % line.length) + line.length) % line.length;
    } else {
      d = Math.max(0, Math.min(line.length, d));
    }

    let index = 0;
    while (index < line.points.length - 2 && (line.cumulative[index + 1] ?? 0) < d) {
      index++;
    }

    const start = line.points[index]!;
    const end = line.points[index + 1]!;
    const segStart = line.cumulative[index] ?? 0;
    const segEnd = line.cumulative[index + 1] ?? line.length;
    const t = (d - segStart) / Math.max(0.0001, segEnd - segStart);
    const dx = end.x - start.x;
    const dy = end.y - start.y;

    return {
      x: start.x + dx * t,
      y: start.y + dy * t,
      angle: Math.atan2(dy, dx),
    };
  }

  /* ------------------------------ 视图 ------------------------------ */

  view(): RailView {
    const trainView = (train: Train): TrainView => {
      const model = trainModel(train.modelId);
      const line = train.lineId === null ? null : this.lineMap.get(train.lineId);
      return {
        id: train.id,
        modelName: model?.name ?? '未知车型',
        cars: train.cars,
        lineId: train.lineId,
        lineName: line?.name ?? null,
        onboard: this.onboardCount(train),
        capacity: this.trainCapacity(train),
      };
    };

    const lines = this.lines.map((line) => {
      const trains = line.trainIds
        .map((id) => this.trainMap.get(id))
        .filter((train): train is Train => Boolean(train))
        .map(trainView);
      return {
        id: line.id,
        name: line.name,
        color: line.color,
        colorCss: line.colorCss,
        isLoop: line.isLoop,
        status: line.status,
        stops: line.stops.map((stop) => ({ ...stop })),
        trains,
        trainCount: trains.length,
      };
    });

    const allTrains = this.trains.map(trainView);
    return {
      lines,
      trains: allTrains,
      inventory: allTrains.filter((train) => train.lineId === null),
      credits: this.network.credits,
      cargo: this.cargoView(),
    };
  }

  /* ------------------------------ 内部 ------------------------------ */

  private prepareLine(
    input: LineInput,
  ):
    | {
        ok: true;
        name: string;
        color: number;
        colorCss: string;
        isLoop: boolean;
        stops: LineStop[];
        route: Tile[];
        stopDistances: number[];
      }
    | { ok: false; message: string } {
    const name = input.name.trim();
    if (!name) return { ok: false, message: '请填写线路名称' };
    if (input.stops.length < 2) return { ok: false, message: '线路至少需要 2 个停靠站' };

    const stops: LineStop[] = [];
    const seen = new Set<string>();
    for (const stop of input.stops) {
      const tile = this.world.get(stop.q, stop.r);
      const station = tile ? this.network.stationAt(tile) : null;
      if (!tile || !station) {
        return { ok: false, message: `停靠站「${stop.name}」尚未建成` };
      }
      const key = hexKey(tile.q, tile.r);
      if (seen.has(key)) return { ok: false, message: '同一车站不能重复作为停靠站' };
      seen.add(key);
      stops.push({ key, name: station.name, q: tile.q, r: tile.r });
    }

    const built = this.buildRoute(stops, input.isLoop);
    if (!built.ok) return { ok: false, message: built.message };

    return {
      ok: true,
      name,
      color: input.color,
      colorCss: input.colorCss,
      isLoop: input.isLoop,
      stops,
      route: built.route,
      stopDistances: built.stopDistances,
    };
  }

  private buildRoute(
    stops: LineStop[],
    isLoop: boolean,
  ): { ok: true; route: Tile[]; stopDistances: number[] } | { ok: false; message: string } {
    if (stops.length < 2) return { ok: false, message: '线路至少需要 2 个停靠站' };

    const tiles: Tile[] = [];
    for (const stop of stops) {
      const tile = this.world.get(stop.q, stop.r);
      if (!tile || !this.network.stationAt(tile)) {
        return { ok: false, message: `停靠站「${stop.name}」已不存在` };
      }
      tiles.push(tile);
    }

    const route: Tile[] = [];
    const stopDistances: number[] = [0];
    let total = 0;
    const pairs = stops.length - 1 + (isLoop ? 1 : 0);

    for (let i = 0; i < pairs; i++) {
      const from = tiles[i]!;
      const to = tiles[(i + 1) % tiles.length]!;
      const fromName = stops[i]!.name;
      const toName = stops[(i + 1) % stops.length]!.name;
      const path = this.network.findPath(from, to);
      if (!path) {
        return { ok: false, message: `${fromName} → ${toName} 之间没有连通轨道` };
      }
      if (route.length === 0) route.push(...path);
      else route.push(...path.slice(1));

      for (let j = 1; j < path.length; j++) {
        const a = path[j - 1]!;
        const b = path[j]!;
        total += Math.hypot(b.x - a.x, b.y - a.y);
      }
      // 环线的最后一段回到 0 号站，不重复记录停靠站
      if (i < stops.length - 1) stopDistances.push(total);
    }

    if (route.length < 2) return { ok: false, message: '线路路径为空' };
    return { ok: true, route, stopDistances };
  }

  private applyRoute(line: Line, route: Tile[], stopDistances: number[]): void {
    line.route = route;
    line.points = route.map((tile) => ({ x: tile.x, y: tile.y }));
    line.cumulative = [0];
    let total = 0;
    for (let i = 1; i < line.points.length; i++) {
      const a = line.points[i - 1]!;
      const b = line.points[i]!;
      total += Math.hypot(b.x - a.x, b.y - a.y);
      line.cumulative.push(total);
    }
    line.length = total;
    line.stopDistances = stopDistances.map((distance) =>
      Math.max(0, Math.min(line.length, distance)),
    );
    line.status = 'OK';
  }

  private markBroken(line: Line): void {
    line.status = 'BROKEN';
    line.route = [];
    line.points = [];
    line.cumulative = [];
    line.stopDistances = [];
    line.length = 0;
    for (const trainId of line.trainIds) {
      const train = this.trainMap.get(trainId);
      if (!train) continue;
      train.speed = 0;
      // 线路断开后不让乘客滞留在车上：回到出发站重新寻路
      this.returnOnboard(train);
    }
    // 保留列车距离：线路修复后可以大致从原位置继续
  }

  private clampTrainDistances(line: Line): void {
    for (const trainId of line.trainIds) {
      const train = this.trainMap.get(trainId);
      if (!train) continue;
      if (line.isLoop && line.length > 0) {
        train.distance = ((train.distance % line.length) + line.length) % line.length;
      } else {
        train.distance = Math.max(0, Math.min(line.length, train.distance));
      }
    }
  }
}

/** 给 UI 用的车型列表也行，这里保留一个辅助类型导出。 */
export type { TrainModel };

function clockLabel(minuteOfDay: number): string {
  const total = Math.max(0, Math.floor(minuteOfDay)) % MINUTES_PER_DAY;
  const hours = Math.floor(total / 60);
  const minutes = total % 60;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

function passengerKindFor(terrain: Terrain): PassengerKind {
  if (terrain === Terrain.Farmland) return 'tourist';
  if (terrain === Terrain.Industry) return 'worker';
  return 'commuter';
}
