/** AI 玩家：全局状态快照、动作协议与系统提示词。 */

import type { NetworkStats, RailNetwork } from './network';
import type { RailOperations } from './operations';
import type { World, RegionCoord } from './world';
import type { StationType } from './stations';
import { STATION_TYPE_LIST } from './stations';
import { TERRAIN_LIST, Terrain } from './terrain';
import type { TrackKind } from './tracks';
import { TRAIN_MODEL_LIST } from './trains';
import { expansionCost } from './economy';
import { expansionCandidates } from './mapgen';

export type AiAction =
  | { type: 'build_track'; q: number; r: number; kind?: TrackKind }
  | { type: 'build_station'; q: number; r: number; station?: StationType }
  | { type: 'remove'; q: number; r: number }
  | {
      type: 'connect';
      from: { q: number; r: number };
      to: { q: number; r: number };
      /** 可选途经点：用于绕开山地 / 水域。 */
      via?: { q: number; r: number }[];
      /** 轨道类型：普速或高速铁路。 */
      kind?: TrackKind;
    }
  | {
      type: 'create_line';
      name?: string;
      color?: string;
      isLoop?: boolean;
      evenHeadway?: boolean;
      stops: { q: number; r: number }[];
    }
  | {
      type: 'update_line';
      lineId: number;
      name?: string;
      color?: string;
      isLoop?: boolean;
      evenHeadway?: boolean;
      stops?: { q: number; r: number }[];
    }
  | { type: 'delete_line'; lineId: number }
  | { type: 'purchase_train'; model: string; lineId?: number }
  | { type: 'assign_train'; trainId: number; lineId: number }
  | { type: 'unassign_train'; trainId: number }
  | { type: 'purchase_truck' }
  | { type: 'expand_region'; q: number; r: number }
  | { type: 'set_speed'; speed: number };

export interface AiActionResult {
  action: AiAction;
  ok: boolean;
  message: string;
}

export interface AiStationState {
  id: number;
  name: string;
  type: StationType;
  q: number;
  r: number;
  coverage: number;
  demandTiles: number;
  waiting: number;
  transferring: number;
  networkBonus: number;
  lines: string[];
}

export interface AiLineState {
  id: number;
  name: string;
  color: string;
  isLoop: boolean;
  evenHeadway: boolean;
  usesHighSpeed: boolean;
  status: string;
  trainCount: number;
  stops: { name: string; q: number; r: number }[];
}

export interface AiTrainState {
  id: number;
  model: string;
  lineId: number | null;
  lineName: string | null;
  state: string;
  onboard: number;
  capacity: number;
  cars: number;
  nextStopName: string | null;
}

export interface AiGameState {
  day: number;
  time: string;
  credits: number;
  /** 当前游戏速度：0 暂停，1 为 1×，2 为 2×。 */
  speed: number;
  network: NetworkStats;
  /** 已建成的高速铁路地块。 */
  highSpeedTracks: { q: number; r: number }[];
  map: {
    regions: number;
    tiles: number;
    water: number;
    towns: number;
    industries: number;
    expansionCandidates: RegionCoord[];
    nextExpansionCost: number;
  };
  terrain: {
    legend: {
      id: string;
      name: string;
      costFactor: number;
      demand: string;
    }[];
    counts: Record<string, number>;
    /** 山地 / 水域：铺轨最贵，规划线路时应尽量绕开。 */
    blockers: { q: number; r: number; t: string }[];
  };
  stationTypes: {
    type: StationType;
    name: string;
    cost: number;
    radius: number;
    description: string;
  }[];
  trainModels: {
    id: string;
    name: string;
    cost: number;
    cars: number;
    capacity: number;
    speedLabel: string;
  }[];
  areas: { kind: string; name: string; q: number; r: number; size: number }[];
  stations: AiStationState[];
  lines: AiLineState[];
  trains: AiTrainState[];
  inventory: { id: number; model: string; cars: number; capacity: number }[];
  cargo: {
    waitingOrders: number;
    activeOrders: number;
    truckCount: number;
    deliveriesToday: number;
    revenueToday: number;
  };
}

export function buildAiState(
  world: World,
  network: RailNetwork,
  operations: RailOperations,
  simSpeed = 1,
): AiGameState {
  const clock = operations.clockView();
  const rail = operations.view();

  const stations: AiStationState[] = [];
  for (const station of network.stationList) {
    const info = operations.stationInfo(station.tile);
    stations.push({
      id: station.id,
      name: station.name,
      type: station.type,
      q: station.q,
      r: station.r,
      coverage: station.coverage.length,
      demandTiles: station.demandTiles,
      waiting: info?.waiting ?? 0,
      transferring: info?.transferring ?? 0,
      networkBonus: info?.networkBonus ?? 1,
      lines: info?.lines.map((line) => line.name) ?? [],
    });
  }

  const trains: AiTrainState[] = operations.trains
    .filter((train) => train.lineId !== null)
    .map((train) => {
      const info = operations.trainInfo(train);
      return {
        id: train.id,
        model: info.modelName,
        lineId: train.lineId,
        lineName: info.lineName,
        state: info.state,
        onboard: info.onboard,
        capacity: info.capacity,
        cars: info.cars,
        nextStopName: info.nextStopName,
      };
    });

  return {
    day: clock.day,
    time: clock.time,
    credits: network.credits,
    speed: simSpeed,
    network: network.stats,
    highSpeedTracks: network.trackList
      .filter((track) => track.kind === 'highspeed')
      .map((track) => ({ q: track.tile.q, r: track.tile.r })),
    map: {
      regions: world.regions.length,
      tiles: world.stats.total,
      water: world.stats.water,
      towns: world.stats.townBlobs,
      industries: world.stats.industryBlobs,
      expansionCandidates: expansionCandidates(world),
      nextExpansionCost: expansionCost(Math.max(0, world.regions.length - 1)),
    },
    terrain: {
      legend: TERRAIN_LIST.map((def) => ({
        id: def.id,
        name: def.name,
        costFactor: def.costFactor,
        demand: def.demand,
      })),
      counts: { ...world.stats.counts },
      blockers: world.list
        .filter(
          (tile) =>
            tile.terrain === Terrain.Mountain || tile.terrain === Terrain.Water,
        )
        .map((tile) => ({
          q: tile.q,
          r: tile.r,
          t: tile.terrain,
        })),
    },
    stationTypes: STATION_TYPE_LIST.map((def) => ({
      type: def.type,
      name: def.name,
      cost: def.cost,
      radius: def.radius,
      description: def.description,
    })),
    trainModels: TRAIN_MODEL_LIST.map((model) => ({
      id: model.id,
      name: model.name,
      cost: model.cost,
      cars: model.cars,
      capacity: model.capacity,
      speedLabel: model.speedLabel,
    })),
    areas: world.blobs.map((blob) => ({
      kind: blob.kind,
      name: blob.name,
      q: blob.center.q,
      r: blob.center.r,
      size: blob.size,
    })),
    stations,
    lines: rail.lines.map((line) => ({
      id: line.id,
      name: line.name,
      color: line.colorCss,
      isLoop: line.isLoop,
      evenHeadway: line.evenHeadway,
      usesHighSpeed: line.usesHighSpeed,
      status: line.status,
      trainCount: line.trainCount,
      stops: line.stops.map((stop) => ({
        name: stop.name,
        q: stop.q,
        r: stop.r,
      })),
    })),
    trains,
    inventory: rail.inventory.map((train) => ({
      id: train.id,
      model: train.modelName,
      cars: train.cars,
      capacity: train.capacity,
    })),
    cargo: {
      waitingOrders: rail.cargo.waitingOrders,
      activeOrders: rail.cargo.activeOrders,
      truckCount: rail.cargo.truckCount,
      deliveriesToday: rail.cargo.deliveriesToday,
      revenueToday: rail.cargo.revenueToday,
    },
  };
}

/** AI 每回合必须返回的 JSON 结构。 */
export const AI_RESPONSE_SCHEMA = `{
  "message": "给玩家看的中文简短说明",
  "actions": [
    { "type": "connect", "from": { "q": 0, "r": 0 }, "to": { "q": 6, "r": -3 } },
    { "type": "build_station", "q": 0, "r": 0, "station": "small" },
    { "type": "create_line", "name": "新线", "color": "#e9b968", "isLoop": false, "evenHeadway": true, "stops": [{ "q": 0, "r": 0 }, { "q": 6, "r": -3 }] },
    { "type": "purchase_train", "model": "commuter" },
    { "type": "assign_train", "trainId": 1, "lineId": 1 }
  ]
}`;

/**
 * 系统提示词。每次请求都会附带一份最新的全局状态 JSON。
 * AI 只返回结构化动作，真正的执行由主程序完成。
 */
export const AI_SYSTEM_PROMPT = `你是一个自动游玩 RailSim 的铁路规划 AI。

RailSim 是一款六边形地图铁路经营游戏。你的目标是持续盈利、扩大线网、提高客流与送达量，并在资金允许时开拓新区域。

【输出格式】
只返回一个 JSON 对象，不要 Markdown、不要代码围栏、不要额外解释：
${AI_RESPONSE_SCHEMA}
- message 用中文，简短说明本回合做了什么或当前计划。
- actions 是动作数组，可以为空；每次最多 20 个动作。
- 不要输出 JSON 以外的内容。

【全局状态字段】
- credits：当前资金。day / time：游戏日期与时间。speed：当前速度（0 暂停 / 1 为 1× / 2 为 2×）。
- network：轨道数、车站数、连通车站数、连通分量等。highSpeedTracks：已建成的高铁地块坐标。
- map：区域数量、总地块数、水域数、城镇 / 工业区数量、可开拓候选 expansionCandidates、下次开拓费用 nextExpansionCost。
- terrain：地形图例 legend、数量 counts、山地 / 水域坐标 blockers。blockers 中 t 为 MOUNTAIN 或 WATER。
- areas：城镇 / 工业区团块，给出中心 (q,r)、规模与名称。建站和连接优先使用这些中心。
- stations：已有车站、服务格数、候车人数、换乘人数、覆盖加成、所属线路。
- lines：线路 id、名称、是否有车、是否平均发车、状态、停靠站坐标。
- trains：列车 id、车型、所在线路、状态、载客 / 定员、载重、下一站。
- inventory：库存列车。cargo：货单与货运列车概况。
- trainModels / stationTypes：车型与车站的造价、容量、速度等信息。

【坐标系】
所有坐标都是六边形轴向坐标 (q, r)。areas、stations、lines.stops、map.expansionCandidates 和 terrain.blockers 中的坐标都可以直接用于动作。

【地形与造价】
铺轨成本 = 6,000 × 地形系数：
- 荒地 1.0（¥6,000）
- 农田 1.5（¥9,000）
- 郊区 2.0（¥12,000）
- 工业区 2.5（¥15,000）
- 城镇 4.0（¥24,000）
- 山地 5.0（¥30,000）
- 水域 6.0（¥36,000，需要桥梁 / 隧道）
必要时绕开山地和水域减少支出。跨湖、穿山或穿过大城镇之前先估算成本；可以通过 connect 的 via 途经点把直线拆成多段，沿着荒地 / 农田 / 郊区绕行。只有在确实能显著缩短线路或连接关键区域时才穿越昂贵地形。

【车站规则】
- light 轻轨站：半径 1 格，¥15,000，适合城镇内部短线。
- small 小型站：半径 2 格，¥35,000，最常用的城镇站。
- large 大型站：半径 3 格，¥70,000，适合枢纽或高密度区域。
- freight 货运站：¥50,000，必须位于工业区或紧邻工业区，自动产生货单。
- 车站会覆盖周围地块，覆盖内的需求地块产生客流；车站本身不直接生成客流。
- 在无轨道地块建站会自动补一格轨道；跨地形铺轨仍按地形系数收费。
- 货运站不能加入客运线路。

【线路与列车】
- 创建线路至少需要 2 个客运站，且车站之间必须有连通轨道；否则线路状态会断开。
- 线路有往返 / 环线两种。环线只沿一个方向循环；往返线在两端折返。
- evenHeadway（平均发车）开启后，多列车会尽量保持均匀间隔，过近时在站等待。列车较多时建议开启。
- 列车每节车厢定员 4 人。commuter 2 节 / 8 人 / ¥60,000；express 3 节 / 12 人 / ¥95,000；heavy 4 节 / 16 人 / ¥140,000；emu 3 节 / 12 人 / ¥220,000。
- 高速铁路造价是普通铁路的 3 倍，只有 emu（动车组）能进入并全速运行；普通列车不能跑高铁。
- 线路只要经过任意一段高速铁路，lines 里的 usesHighSpeed 就会为 true，这时只能给该线路配 emu。
- 已有普通轨道不能直接升级为高铁：需要先 remove 拆除，再用 kind=highspeed 重新铺设。拆除会返还部分费用，但改造成本较高，规划前要确认线路值得升级。
- 高铁适合连接相距较远、客流较大的城镇；短途或资金紧张时优先普通铁路。
- 列车运行时按实际行驶格数扣运行成本；停站不扣。车票在乘客到达目的站时结算。
- 候车人数持续偏高时，增加列车、改用大容量车型或缩短发车间隔。

【客流规则】
- 城镇地块客流最高，工业区以商务客为主，郊区以通勤客为主，农田客流很少。
- 旅游乘客只接受直线距离至少 8 格的目的站；线网太短时不会产生旅游乘客。
- 通勤偏好较近的目的站，旅游偏好较远的目的站，商务偏好城镇 / 工业区覆盖较多的目的站。
- 车票收入 =（¥24 起步价 + ¥12/公里）× 车型速度系数；长途和高速车型单票更高。
- 线路越长、站点越多，单列车周转越慢；不要盲目把线路拉得过长。

【货运规则】
- 货运站必须靠工业区；至少两个有货运站的工业区之间才会产生货单。
- 货运列车沿铁轨自动接单、装货、运输、卸货，不需要线路。
- 货单收益可观，但需要额外购买货运列车；资金紧张时优先保证客运线盈利。

【开拓规则】
- 开拓新区域会生成约 1260 格的新地形、城镇与工业区，可能带来新的客流和货单。
- 第一次开拓 ¥1,000,000，之后每次翻倍；只能选择 map.expansionCandidates 中的坐标。
- 开拓前确认资金充足，并预留铺轨、建站和买车的钱。

【可用动作】
1. connect: 在 from 到 to 之间铺轨，可附加 via 途经点数组与 kind（normal / highspeed）；路径按顺序取直线段。已存在的轨道会自动跳过。用于绕开山地 / 水域、连接多个城镇或铺设高铁。
2. build_track: 在单格 (q,r) 铺轨，kind 可选 normal / highspeed。
3. build_station: 在 (q,r) 建站，station 可选 light / small / large / freight。
4. create_line: 创建客运线路；stops 必须是有车站的坐标；至少 2 站。
5. update_line: 修改线路；只需提供要改的字段，stops 若提供则整体替换。
6. delete_line: 删除线路，列车退回库存。
7. purchase_train: model 使用 trainModels 里的 id；可附带 lineId，购买后立即配到该线路。
8. assign_train: 把库存列车配到线路；trainId 和 lineId 来自全局状态。
9. unassign_train: 列车退回库存。
10. purchase_truck: 购买货运列车。
11. remove: 拆除 (q,r) 的轨道或车站。
12. expand_region: 开拓新区域，坐标必须来自 map.expansionCandidates。
13. set_speed: 设置游戏速度，speed 为 0（暂停）、1（1×）、2（2×）。

【经营建议】
- 优先把 2~4 个相近的城镇用 connect 连起来，在城镇中心建 small 站，再创建线路。
- 规划连接前先查看 terrain.blockers；必要时用 via 途经点绕开山地和水域，减少铺轨支出。
- 线路创建后购买列车并配车；短线用 commuter，长线可考虑 express。
- 需要规划高铁时：先用 connect(kind=highspeed) 修建站间高速轨道，再建站 / 创建线路；线路 usesHighSpeed=true 后只能购买 emu 并配车。不要在已有普通轨道上直接铺高铁，必须先 remove。
- 车站候车人数过多时，增加列车或升级车站。
- 资金不足时不要进行大额建设；先让现有线路运营赚钱，并保留至少一次小额建设的缓冲资金。
- 每次只推进少量关键操作，避免一次花光资金。
- 开拓费用每次翻倍，必须谨慎；优先在现有线网盈利后再考虑。
- 如果当前没有可做的操作，actions 返回空数组，并在 message 里说明原因。

【重要】
- 全局状态是唯一事实来源；不要臆造不存在的车站、线路、列车、地形或坐标。
- 执行动作后，系统会再次向你汇报最新全局状态。`;

/** 把玩家 / AI 的历史消息整理成请求所需的简短上下文。 */
export interface AiChatMessage {
  role: 'user' | 'assistant';
  content: string;
}
