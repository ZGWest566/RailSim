import { hexDistance, hexKey, HEX_DIRECTIONS } from '../core/hex';
import {
  countDemandTiles,
  previewStationCoverage,
  stationCoverageTiles,
  type CoveragePreview,
} from './coverage';
import {
  formatMoney,
  refundOf,
  STARTING_CREDITS,
  trackCostForTerrain,
} from './economy';
import { STATION_DEFS, type StationType } from './stations';
import { Terrain } from './terrain';
import type { MapBlob, Tile, World } from './world';

export interface Quote {
  ok: boolean;
  cost: number;
  reason: string | null;
}

export interface Track {
  tile: Tile;
  cost: number;
  neighbors: Tile[];
  componentId: number;
}

export interface Station {
  id: number;
  tile: Tile;
  q: number;
  r: number;
  type: StationType;
  name: string;
  /** 车站本身的造价（不含自动铺轨） */
  baseCost: number;
  /** 玩家实际支付的总价（含自动铺轨） */
  totalCost: number;
  autoTrack: boolean;
  coverage: Tile[];
  demandTiles: number;
  /** 同一轨道连通分量内的车站数量（含自己） */
  connectedStations: number;
  componentId: number;
}

export interface BuildResult {
  ok: boolean;
  message: string;
  cost?: number;
  refund?: number;
  station?: Station;
  track?: Track;
}

export interface NetworkStats {
  credits: number;
  tracks: number;
  stations: number;
  connectedStations: number;
  components: number;
  spent: number;
  refunded: number;
}

/** localStorage 存档使用的网络快照。 */
export interface NetworkSave {
  credits: number;
  totalSpent: number;
  totalRefunded: number;
  nextStationId: number;
  tracks: { q: number; r: number; cost: number }[];
  stations: {
    id: number;
    q: number;
    r: number;
    type: StationType;
    name: string;
    baseCost: number;
    totalCost: number;
    autoTrack: boolean;
  }[];
  disabledLinks: string[];
}

export interface TileNetworkInfo {
  credits: number;
  hasTrack: boolean;
  trackPaid: number;
  trackQuote: Quote;
  connections: number;
  station: Station | null;
  stationQuote: Quote;
  stationType: StationType;
  /** 当前地块被几个车站覆盖 */
  coveredBy: number;
  /** 若在此建当前类型的车站，预计覆盖 / 需求地块数 */
  previewCoverage: number;
  previewDemand: number;
}

/**
 * 物理轨道 + 车站网络。
 *
 * - 轨道以六边形地块为节点，邻接自动成边；A* 可在此图上运行。
 * - 相邻节点默认连通，玩家可免费断开 / 恢复某一段；列车寻路只走启用的连接段。
 * - 车站需要落在轨道节点上；若建站时该格没有轨道，会自动补一格轨道并计入造价。
 * - 每次建造 / 拆除后统一重算覆盖范围（写入 Tile.servedBy）与连通分量。
 */
export class RailNetwork {
  readonly world: World;
  credits: number;

  private readonly tracks = new Map<string, Track>();
  private readonly stations = new Map<string, Station>();
  /** 玩家手动断开的连接段，键为排序后的 "q,r|q,r"。 */
  private readonly disabledLinks = new Set<string>();
  private nextStationId = 1;
  private totalSpent = 0;
  private totalRefunded = 0;
  private componentCount = 0;

  constructor(world: World, credits = STARTING_CREDITS) {
    this.world = world;
    this.credits = credits;
    this.recompute();
  }

  /* ------------------------------ 查询 ------------------------------ */

  hasTrack(tile: Tile): boolean {
    return this.tracks.has(hexKey(tile.q, tile.r));
  }

  trackAt(tile: Tile): Track | null {
    return this.tracks.get(hexKey(tile.q, tile.r)) ?? null;
  }

  stationAt(tile: Tile): Station | null {
    return this.stations.get(hexKey(tile.q, tile.r)) ?? null;
  }

  get trackList(): Track[] {
    return [...this.tracks.values()];
  }

  get stationList(): Station[] {
    return [...this.stations.values()];
  }

  connectionsFor(tile: Tile): Tile[] {
    return this.trackAt(tile)?.neighbors ?? [];
  }

  /**
   * 在启用的轨道连接上做 A*。列车线路与乘客寻路都以此为基础。
   * 返回包含起点和终点的地块序列；不可达返回 null。
   */
  findPath(from: Tile, to: Tile): Tile[] | null {
    if (!this.hasTrack(from) || !this.hasTrack(to)) return null;
    const startKey = hexKey(from.q, from.r);
    const goalKey = hexKey(to.q, to.r);
    if (startKey === goalKey) return [from];

    const open: Tile[] = [from];
    const gScore = new Map<string, number>([[startKey, 0]]);
    const cameFrom = new Map<string, Tile>();
    const closed = new Set<string>();

    while (open.length > 0) {
      let bestIndex = 0;
      let bestF = Infinity;
      for (let i = 0; i < open.length; i++) {
        const tile = open[i]!;
        const g = gScore.get(hexKey(tile.q, tile.r)) ?? Infinity;
        const f = g + hexDistance(tile, to);
        if (f < bestF) {
          bestF = f;
          bestIndex = i;
        }
      }

      const current = open.splice(bestIndex, 1)[0]!;
      const currentKey = hexKey(current.q, current.r);
      if (currentKey === goalKey) {
        const path: Tile[] = [current];
        let cursorKey = currentKey;
        while (cursorKey !== startKey) {
          const previous = cameFrom.get(cursorKey);
          if (!previous) return null;
          path.push(previous);
          cursorKey = hexKey(previous.q, previous.r);
        }
        path.reverse();
        return path;
      }

      closed.add(currentKey);
      const currentG = gScore.get(currentKey) ?? Infinity;
      for (const neighbor of this.connectionsFor(current)) {
        const neighborKey = hexKey(neighbor.q, neighbor.r);
        if (closed.has(neighborKey)) continue;
        const tentative = currentG + 1;
        if (tentative >= (gScore.get(neighborKey) ?? Infinity)) continue;
        cameFrom.set(neighborKey, current);
        gScore.set(neighborKey, tentative);
        if (!open.some((tile) => tile.q === neighbor.q && tile.r === neighbor.r)) {
          open.push(neighbor);
        }
      }
    }

    return null;
  }

  /**
   * 相邻两个轨道节点之间是否连通。
   * 未来列车 / 线路 A* 应只沿 isLinkEnabled 为 true 的连接段行走。
   */
  isLinkEnabled(a: Tile, b: Tile): boolean {
    if (!this.hasTrack(a) || !this.hasTrack(b)) return false;
    if (hexDistance(a, b) !== 1) return false;
    return !this.disabledLinks.has(this.linkKey(a, b));
  }

  /** 免费断开 / 恢复一段轨道连接。节点与车站覆盖不变，只改变轨道图连通性。 */
  toggleLink(a: Tile, b: Tile): BuildResult {
    if (!this.hasTrack(a) || !this.hasTrack(b)) {
      return { ok: false, message: '线路段两端都需要先铺轨' };
    }
    if (hexDistance(a, b) !== 1) {
      return { ok: false, message: '只能编辑相邻轨道节点之间的线路段' };
    }

    const key = this.linkKey(a, b);
    const wasEnabled = !this.disabledLinks.has(key);
    if (wasEnabled) this.disabledLinks.add(key);
    else this.disabledLinks.delete(key);
    this.recomputeComponents();

    return {
      ok: true,
      message: `${wasEnabled ? '已断开' : '已恢复'}线路段 (${a.q}, ${a.r}) ↔ (${b.q}, ${b.r})（免费）`,
    };
  }

  private linkKey(a: Tile, b: Tile): string {
    const ka = hexKey(a.q, a.r);
    const kb = hexKey(b.q, b.r);
    return ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
  }

  private pruneDisabledLinks(tile: Tile): void {
    const key = hexKey(tile.q, tile.r);
    for (const link of [...this.disabledLinks]) {
      const [a, b] = link.split('|');
      if (a === key || b === key) this.disabledLinks.delete(link);
    }
  }

  previewCoverage(tile: Tile, type: StationType): CoveragePreview {
    return previewStationCoverage(this.world, tile, type);
  }

  /* ------------------------------ 存档 ------------------------------ */

  serialize(): NetworkSave {
    return {
      credits: this.credits,
      totalSpent: this.totalSpent,
      totalRefunded: this.totalRefunded,
      nextStationId: this.nextStationId,
      tracks: [...this.tracks.values()].map((track) => ({
        q: track.tile.q,
        r: track.tile.r,
        cost: track.cost,
      })),
      stations: [...this.stations.values()].map((station) => ({
        id: station.id,
        q: station.q,
        r: station.r,
        type: station.type,
        name: station.name,
        baseCost: station.baseCost,
        totalCost: station.totalCost,
        autoTrack: station.autoTrack,
      })),
      disabledLinks: [...this.disabledLinks],
    };
  }

  /** 从存档恢复轨道与车站；覆盖、连通分量会重新计算。 */
  restore(save: NetworkSave): void {
    this.tracks.clear();
    this.stations.clear();
    this.disabledLinks.clear();
    this.credits = Number.isFinite(save.credits) ? save.credits : STARTING_CREDITS;
    this.totalSpent = Number.isFinite(save.totalSpent) ? save.totalSpent : 0;
    this.totalRefunded = Number.isFinite(save.totalRefunded) ? save.totalRefunded : 0;

    let maxStationId = 0;
    for (const saved of save.tracks ?? []) {
      const tile = this.world.get(saved.q, saved.r);
      if (!tile) continue;
      this.tracks.set(hexKey(tile.q, tile.r), {
        tile,
        cost: Number.isFinite(saved.cost) ? saved.cost : trackCostForTerrain(tile.terrain),
        neighbors: [],
        componentId: -1,
      });
    }

    for (const saved of save.stations ?? []) {
      const def = STATION_DEFS[saved.type];
      const tile = this.world.get(saved.q, saved.r);
      if (!def || !tile) continue;
      const id = Number.isFinite(saved.id) ? saved.id : maxStationId + 1;
      const baseCost = Number.isFinite(saved.baseCost) ? saved.baseCost : def.cost;
      const station: Station = {
        id,
        tile,
        q: tile.q,
        r: tile.r,
        type: saved.type,
        name: saved.name || this.makeStationName(tile, saved.type),
        baseCost,
        totalCost: Number.isFinite(saved.totalCost) ? saved.totalCost : baseCost,
        autoTrack: Boolean(saved.autoTrack),
        coverage: [],
        demandTiles: 0,
        connectedStations: 0,
        componentId: -1,
      };
      this.stations.set(hexKey(tile.q, tile.r), station);
      maxStationId = Math.max(maxStationId, id);
    }

    for (const link of save.disabledLinks ?? []) {
      if (typeof link === 'string') this.disabledLinks.add(link);
    }

    const next = Number.isFinite(save.nextStationId) ? save.nextStationId : 1;
    this.nextStationId = Math.max(next, maxStationId + 1);
    this.recompute();
  }

  get stats(): NetworkStats {
    let connectedStations = 0;
    for (const station of this.stations.values()) {
      if (station.connectedStations >= 2) connectedStations++;
    }
    return {
      credits: this.credits,
      tracks: this.tracks.size,
      stations: this.stations.size,
      connectedStations,
      components: this.componentCount,
      spent: this.totalSpent,
      refunded: this.totalRefunded,
    };
  }

  tileInfo(tile: Tile, activeType: StationType): TileNetworkInfo {
    const track = this.trackAt(tile);
    const station = this.stationAt(tile);
    const preview = station
      ? { tiles: [], demandTiles: 0 }
      : previewStationCoverage(this.world, tile, activeType);

    return {
      credits: this.credits,
      hasTrack: track !== null,
      trackPaid: track?.cost ?? 0,
      trackQuote: this.quoteTrack(tile),
      connections: track?.neighbors.length ?? 0,
      station,
      stationQuote: this.quoteStation(tile, activeType),
      stationType: activeType,
      coveredBy: tile.servedBy.length,
      previewCoverage: preview.tiles.length,
      previewDemand: preview.demandTiles,
    };
  }

  /* ------------------------------ 报价 ------------------------------ */

  quoteTrack(tile: Tile): Quote {
    const cost = trackCostForTerrain(tile.terrain);
    if (this.hasTrack(tile)) {
      return { ok: false, cost, reason: '该地块已铺轨' };
    }
    if (this.credits < cost) {
      return { ok: false, cost, reason: `资金不足（需要 ${formatMoney(cost)}）` };
    }
    return { ok: true, cost, reason: null };
  }

  quoteStation(tile: Tile, type: StationType): Quote {
    const def = STATION_DEFS[type];
    const needsTrack = !this.hasTrack(tile);
    const cost = def.cost + (needsTrack ? trackCostForTerrain(tile.terrain) : 0);

    if (this.stationAt(tile)) return { ok: false, cost, reason: '该地块已有车站' };
    if (tile.terrain === Terrain.Water) return { ok: false, cost, reason: '水域不能建造车站' };
    if (type === 'freight' && stationCoverageTiles(this.world, tile, type).length === 0) {
      return { ok: false, cost, reason: '货运站需建在工业区或紧邻工业区' };
    }
    if (this.credits < cost) {
      return { ok: false, cost, reason: `资金不足（需要 ${formatMoney(cost)}）` };
    }
    return { ok: true, cost, reason: null };
  }

  /* ------------------------------ 建造 ------------------------------ */

  buildTrack(tile: Tile): BuildResult {
    const quote = this.quoteTrack(tile);
    if (!quote.ok) return { ok: false, message: quote.reason ?? '无法铺轨' };

    this.credits -= quote.cost;
    this.totalSpent += quote.cost;
    const track: Track = {
      tile,
      cost: quote.cost,
      neighbors: [],
      componentId: -1,
    };
    this.tracks.set(hexKey(tile.q, tile.r), track);
    this.recompute();

    return {
      ok: true,
      cost: quote.cost,
      track,
      message: `已铺轨 · (${tile.q}, ${tile.r}) · ${formatMoney(quote.cost)}`,
    };
  }

  buildStation(tile: Tile, type: StationType): BuildResult {
    const quote = this.quoteStation(tile, type);
    if (!quote.ok) return { ok: false, message: quote.reason ?? '无法建站' };

    const def = STATION_DEFS[type];
    const needsTrack = !this.hasTrack(tile);
    const trackCost = needsTrack ? trackCostForTerrain(tile.terrain) : 0;

    this.credits -= quote.cost;
    this.totalSpent += quote.cost;

    if (needsTrack) {
      this.tracks.set(hexKey(tile.q, tile.r), {
        tile,
        cost: trackCost,
        neighbors: [],
        componentId: -1,
      });
    }

    const station: Station = {
      id: this.nextStationId++,
      tile,
      q: tile.q,
      r: tile.r,
      type,
      name: this.makeStationName(tile, type),
      baseCost: def.cost,
      totalCost: quote.cost,
      autoTrack: needsTrack,
      coverage: [],
      demandTiles: 0,
      connectedStations: 0,
      componentId: -1,
    };
    this.stations.set(hexKey(tile.q, tile.r), station);
    this.recompute();

    return {
      ok: true,
      cost: quote.cost,
      station,
      message: `已建成 ${station.name} · ${def.name} · ${formatMoney(quote.cost)}${
        needsTrack ? '（含铺轨）' : ''
      }`,
    };
  }

  removeAt(tile: Tile): BuildResult {
    if (this.stationAt(tile)) return this.removeStation(tile);
    if (this.hasTrack(tile)) return this.removeTrack(tile);
    return { ok: false, message: '这里没有可拆除的轨道或车站' };
  }

  removeTrack(tile: Tile): BuildResult {
    const track = this.trackAt(tile);
    if (!track) return { ok: false, message: '该地块没有轨道' };
    if (this.stationAt(tile)) return { ok: false, message: '请先拆除该地块的车站' };

    const refund = refundOf(track.cost);
    this.credits += refund;
    this.totalRefunded += refund;
    this.pruneDisabledLinks(tile);
    this.tracks.delete(hexKey(tile.q, tile.r));
    this.recompute();

    return {
      ok: true,
      refund,
      message: `已拆除轨道 · 返还 ${formatMoney(refund)}`,
    };
  }

  removeStation(tile: Tile): BuildResult {
    const station = this.stationAt(tile);
    if (!station) return { ok: false, message: '该地块没有车站' };

    const refund = refundOf(station.baseCost);
    this.credits += refund;
    this.totalRefunded += refund;
    this.stations.delete(hexKey(tile.q, tile.r));
    this.recompute();

    return {
      ok: true,
      refund,
      message: `已拆除 ${station.name} · 返还 ${formatMoney(refund)}${
        station.autoTrack ? ' · 轨道保留' : ''
      }`,
    };
  }

  /* ------------------------------ 重算 ------------------------------ */

  private recompute(): void {
    for (const tile of this.world.list) tile.servedBy.length = 0;
    this.recomputeCoverage();
    this.recomputeComponents();
  }

  private recomputeCoverage(): void {
    for (const station of this.stations.values()) {
      const coverage = stationCoverageTiles(this.world, station.tile, station.type);
      station.coverage = coverage;
      station.demandTiles = countDemandTiles(coverage);
      for (const tile of coverage) {
        if (!tile.servedBy.includes(station.id)) tile.servedBy.push(station.id);
      }
    }
  }

  private recomputeComponents(): void {
    for (const track of this.tracks.values()) {
      track.neighbors = [];
      track.componentId = -1;
      for (const dir of HEX_DIRECTIONS) {
        const neighborTile = this.world.get(track.tile.q + dir.q, track.tile.r + dir.r);
        if (neighborTile && this.isLinkEnabled(track.tile, neighborTile)) {
          track.neighbors.push(neighborTile);
        }
      }
    }

    const visited = new Set<string>();
    const componentOf = new Map<string, number>();
    let componentId = 0;

    for (const track of this.tracks.values()) {
      const startKey = hexKey(track.tile.q, track.tile.r);
      if (visited.has(startKey)) continue;

      const stack: Track[] = [track];
      visited.add(startKey);

      while (stack.length > 0) {
        const current = stack.pop()!;
        componentOf.set(hexKey(current.tile.q, current.tile.r), componentId);
        current.componentId = componentId;
        for (const neighborTile of current.neighbors) {
          const key = hexKey(neighborTile.q, neighborTile.r);
          if (visited.has(key)) continue;
          const neighborTrack = this.tracks.get(key);
          if (!neighborTrack) continue;
          visited.add(key);
          stack.push(neighborTrack);
        }
      }
      componentId++;
    }

    this.componentCount = componentId;

    const stationCount = new Map<number, number>();
    for (const station of this.stations.values()) {
      const comp = componentOf.get(hexKey(station.q, station.r));
      if (comp !== undefined) stationCount.set(comp, (stationCount.get(comp) ?? 0) + 1);
    }
    for (const station of this.stations.values()) {
      const comp = componentOf.get(hexKey(station.q, station.r));
      station.componentId = comp ?? -1;
      station.connectedStations = comp === undefined ? 0 : (stationCount.get(comp) ?? 0);
    }
  }

  /* ------------------------------ 命名 ------------------------------ */

  private makeStationName(tile: Tile, type: StationType): string {
    const blob = this.findNameBlob(tile, type);
    const base = blob?.name ?? `(${tile.q}, ${tile.r})`;
    const suffix = type === 'freight' ? '货运站' : '站';
    let name = `${base}${suffix}`;
    let index = 2;
    const used = new Set([...this.stations.values()].map((s) => s.name));
    while (used.has(name)) {
      name = `${base}${suffix} ${index}`;
      index++;
    }
    return name;
  }

  private findNameBlob(tile: Tile, type: StationType): MapBlob | null {
    const own = tile.blobId === null ? undefined : this.world.blobById.get(tile.blobId);

    if (type === 'freight') {
      if (own?.kind === 'industry') return own;
      for (const neighbor of this.world.neighbors(tile)) {
        if (neighbor.blobId === null) continue;
        const blob = this.world.blobById.get(neighbor.blobId);
        if (blob?.kind === 'industry') return blob;
      }
      return null;
    }

    if (own?.kind === 'town') return own;

    let best: MapBlob | null = null;
    let bestDistance = 6;
    for (const blob of this.world.blobs) {
      if (blob.kind !== 'town') continue;
      const distance = hexDistance(tile, blob.center);
      if (distance <= bestDistance) {
        bestDistance = distance;
        best = blob;
      }
    }
    return best ?? own ?? null;
  }
}
