import { HEX_SIZE, REGION_SPACING, SEA_LEVEL } from '../config';
import {
  axialRound,
  axialToPixel,
  clamp,
  clamp01,
  HEX_DIRECTIONS,
  hexDistance,
  hexesInRange,
  pixelToAxial,
  smoothstep,
  SQRT3,
  type Axial,
} from '../core/hex';
import { Perlin2D } from '../core/noise';
import { Rng, hash2d } from '../core/rng';
import { Terrain, isLand } from './terrain';
import { createNamer, DEFAULT_NAME_CULTURE, type NameCulture } from './names';
import { World, type MapBlob, type RegionCoord, type Tile } from './world';

export interface MapGenOptions {
  seed: number;
  /** 已解锁的大区域，第一项应为初始区域 (0,0)。 */
  regions?: RegionCoord[];
  /** 海拔偏移：正值更多陆地 / 山地，负值更多水域。 */
  elevationOffset?: number;
  /** 湿度偏移：正值更湿润，负值更干燥。 */
  moistureOffset?: number;
  /** 地名文化预设。 */
  culture?: NameCulture;
  /** 关闭河流雕刻 */
  rivers?: boolean;
}

interface NoiseFields {
  elevation: Perlin2D;
  moisture: Perlin2D;
  econ: Perlin2D;
  ridge: Perlin2D;
  lake: Perlin2D;
}

/**
 * 地形分类参数。
 *
 * - FARM_ECON_MAX 是“低经济带农田”阈值：提高它会把更多低经济带郊区转换为农田。
 * - 郊区占比下降主要来自这里和城镇外围晕染概率的调整。
 */
const FARM_MOISTURE = 0.55;
const FARM_ECON_MOISTURE = 0.46;
const FARM_ECON_MAX = 0.55;
const SUBURB_MOISTURE = 0.47;

/**
 * 区域格的候选半径：覆盖一块大区域可能触及的所有地块。
 * 区域六边形的顶点在六边形距离上最远约为 2/3 个区域间距，必须留足余量，
 * 否则三个区域交界处的顶点格会被所有区域漏掉，形成空洞。
 */
const REGION_CANDIDATE_RADIUS = Math.ceil((REGION_SPACING * 2) / 3) + 3;

/**
 * 区域格使用旋转 30° 的宏观六边形网格：
 * 顶边和底边水平，左右两侧为斜边，地图轮廓更平滑。
 * 基向量 u = (bx, by)、v = (bx, -by) 对应像素方向 ±30°。
 */
const REGION_LATTICE_SPACING = SQRT3 * HEX_SIZE * REGION_SPACING;
const REGION_BASIS_X = REGION_LATTICE_SPACING * Math.cos(Math.PI / 6);
const REGION_BASIS_Y = REGION_LATTICE_SPACING * Math.sin(Math.PI / 6);

/** 每块新区域包含的城镇 / 工业区数量，与初始地图同一量级。 */
const REGION_TOWNS = 8;
const REGION_INDUSTRIES = 7;
const REGION_RIVERS = 4;

export interface RegionGenOptions {
  elevationOffset?: number;
  moistureOffset?: number;
  culture?: NameCulture;
  rivers?: boolean;
}

/**
 * 三层地图生成管线：
 *
 *   1. 宏观噪声：海拔 / 湿度 / 经济带 → 初始地块
 *   2. 连片修正：种子膨胀，城镇 8~20 格、工业 3~8 格，再做郊区晕染
 *   3. 局部细化：海岸线平滑 + 顺坡河流雕刻
 *
 * 整张地图由若干“大区域”拼成：初始地图是 (0,0) 区域，
 * 开拓时选择方向，在相邻的大区域格中继续生成。
 */
export function generateWorld(options: MapGenOptions): World {
  const seed = options.seed >>> 0;
  const world = new World(seed);
  const regions = normalizeRegions(options.regions);
  for (const region of regions) {
    addRegion(world, region, options);
  }
  return world;
}

/**
 * 世界坐标中的区域归属：把地图划分成互不重叠的大六边形区域。
 *
 * 区域网格相对地块网格旋转 30°，因此区域顶底为横边、左右为斜边。
 * 先换算到宏观网格坐标，再在附近按实际像素距离找最近的区域中心；
 * 不能只用取整：三个区域交界处可能出现取整误差，留下单格空洞。
 */
export function regionOfTile(q: number, r: number): RegionCoord {
  const x = HEX_SIZE * SQRT3 * (q + r / 2);
  const y = HEX_SIZE * 1.5 * r;
  const mf = (x / REGION_BASIS_X + y / REGION_BASIS_Y) / 2;
  const nf = (x / REGION_BASIS_X - y / REGION_BASIS_Y) / 2;
  const approx = axialRound(mf, nf);

  let best: RegionCoord = { q: approx.q, r: approx.r };
  let bestDistance = Infinity;

  // 近似点最多偏差一格，搜索两圈足以覆盖所有候选
  for (let dq = -2; dq <= 2; dq++) {
    for (let dr = -2; dr <= 2; dr++) {
      const mq = approx.q + dq;
      const mr = approx.r + dr;
      const center = regionCenterPixel({ q: mq, r: mr });
      const dx = x - center.x;
      const dy = y - center.y;
      const distance = dx * dx + dy * dy;
      if (
        distance < bestDistance - 1e-9 ||
        (Math.abs(distance - bestDistance) <= 1e-9 &&
          (mq < best.q || (mq === best.q && mr < best.r)))
      ) {
        bestDistance = distance;
        best = { q: mq, r: mr };
      }
    }
  }

  return best;
}

/** 区域中心对应的近似地块坐标，用于枚举区域内的地块。 */
export function regionCenter(region: RegionCoord): Axial {
  const center = regionCenterPixel(region);
  return pixelToAxial(center.x, center.y, HEX_SIZE);
}

/** 区域中心的世界像素坐标（宏观网格旋转 30°）。 */
export function regionCenterPixel(region: RegionCoord): { x: number; y: number } {
  return {
    x: REGION_BASIS_X * (region.q + region.r),
    y: REGION_BASIS_Y * (region.q - region.r),
  };
}

/** 所有与现有版图相邻、尚未解锁的区域。 */
export function expansionCandidates(world: World): RegionCoord[] {
  const seen = new Set<string>();
  const out: RegionCoord[] = [];
  for (const region of world.regions) {
    for (const step of HEX_DIRECTIONS) {
      const next = { q: region.q + step.q, r: region.r + step.r };
      const key = `${next.q},${next.r}`;
      if (world.regionKeys.has(key) || seen.has(key)) continue;
      seen.add(key);
      out.push(next);
    }
  }
  return out;
}

/** 在指定大区域中生成地形；已存在的区域会被跳过。 */
export function addRegion(
  world: World,
  region: RegionCoord,
  options: RegionGenOptions = {},
): boolean {
  if (world.regionKeys.has(`${region.q},${region.r}`)) return false;

  const elevationOffset = options.elevationOffset ?? 0;
  const moistureOffset = options.moistureOffset ?? 0;
  const culture = options.culture ?? DEFAULT_NAME_CULTURE;
  const fields = createNoiseFields(world.seed);
  const regionIndex = world.regions.length;
  const rng = new Rng(
    (world.seed ^
      Math.imul(region.q, 0x9e3779b1) ^
      Math.imul(region.r, 0x85ebca6b) ^
      0x7f4a7c15) >>>
      0,
  );

  world.addRegion(region);
  const center = regionCenter(region);
  const firstTile = world.list.length;
  const firstBlob = world.blobs.length;

  // 只生成归属该区域的地块；相邻区域的边界由区域六边形自然衔接
  for (const a of hexesInRange(center, REGION_CANDIDATE_RADIUS)) {
    const owner = regionOfTile(a.q, a.r);
    if (owner.q !== region.q || owner.r !== region.r) continue;
    if (world.has(a.q, a.r)) continue;
    world.addTile(createMacroTile(a, fields, elevationOffset, moistureOffset));
  }

  const newTiles = world.list.slice(firstTile);
  if (newTiles.length === 0) {
    world.refresh();
    return false;
  }
  const allowed = new Set(newTiles.map((tile) => `${tile.q},${tile.r}`));

  smoothCoastline(world, rng, newTiles);
  growTowns(world, REGION_SPACING, rng, {
    candidates: newTiles,
    allowed,
    desired: REGION_TOWNS,
    minSpacing: 5,
  });
  growIndustry(world, REGION_SPACING, rng, {
    candidates: newTiles,
    allowed,
    desired: REGION_INDUSTRIES,
    minSpacing: 4,
  });
  paintSuburbHalo(world, rng, 3, allowed);
  if (options.rivers !== false) carveRivers(world, rng, REGION_RIVERS, allowed);

  nameBlobs(world, culture, world.seed, regionIndex, firstBlob);
  applyJitter(world, newTiles);
  world.refresh();
  return true;
}

function normalizeRegions(regions: RegionCoord[] | undefined): RegionCoord[] {
  const list: RegionCoord[] = [];
  const seen = new Set<string>();
  const push = (region: RegionCoord | undefined): void => {
    if (!region || !Number.isFinite(region.q) || !Number.isFinite(region.r)) return;
    const q = Math.round(region.q);
    const r = Math.round(region.r);
    const key = `${q},${r}`;
    if (seen.has(key)) return;
    seen.add(key);
    list.push({ q, r });
  };
  if (regions && regions.length > 0) {
    for (const region of regions) push(region);
  }
  if (!seen.has('0,0')) list.unshift({ q: 0, r: 0 });
  return list;
}

function createNoiseFields(seed: number): NoiseFields {
  const rng = new Rng(seed);
  return {
    elevation: new Perlin2D(rng),
    moisture: new Perlin2D(rng),
    econ: new Perlin2D(rng),
    ridge: new Perlin2D(rng),
    // 湖泊使用独立随机流，不影响原有城镇 / 工业的随机序列
    lake: new Perlin2D(new Rng((seed ^ 0x27d4eb2d) >>> 0)),
  };
}

function applyJitter(world: World, tiles: Tile[]): void {
  for (const tile of tiles) {
    tile.jitter = hash2d(tile.q, tile.r, world.seed);
  }
}

function nameBlobs(
  world: World,
  culture: NameCulture,
  seed: number,
  regionIndex: number,
  fromIndex: number,
): void {
  const taken = world.blobs.slice(0, fromIndex).map((blob) => blob.name);
  const rng = new Rng(
    (seed ^ 0x51ed270b ^ Math.imul(regionIndex, 0x9e3779b1)) >>> 0,
  );
  const namer = createNamer(culture, rng, taken);
  for (let i = fromIndex; i < world.blobs.length; i++) {
    const blob = world.blobs[i];
    if (blob) blob.name = namer(blob.kind);
  }
}

/* ------------------------------------------------------------------ */
/* 第一层：宏观噪声                                                     */
/* ------------------------------------------------------------------ */

function createMacroTile(
  a: Axial,
  fields: NoiseFields,
  elevationOffset: number,
  moistureOffset: number,
): Tile {
  const nx = a.q + a.r * 0.5;
  const ny = a.r * 0.866;

  const base = fields.elevation.fbm(nx * 0.12 + 11.3, ny * 0.12 + 7.7, 5);
  const ridge = fields.ridge.ridged(nx * 0.18 + 3.1, ny * 0.18 + 9.4, 4);
  // 大湖：低频湖泊噪声在地势较低处形成大片水面，取代原来的海洋边界
  const lakeNoise = fields.lake.fbm(nx * 0.045 + 61.7, ny * 0.045 + 19.3, 3);
  const lakeBasin = smoothstep(0.62, 0.82, lakeNoise);
  const elevation = clamp01(
    base * 0.8 + 0.1 + (ridge - 0.5) * 0.17 + elevationOffset - lakeBasin * 0.42,
  );
  const moisture = clamp01(
    fields.moisture.fbm(nx * 0.09 + 40.2, ny * 0.09 + 13.8, 4) * 0.88 +
      0.04 +
      moistureOffset,
  );
  const econ = clamp01(
    fields.econ.fbm(nx * 0.06 + 70.5, ny * 0.06 + 31.4, 3) * 0.96 + 0.02,
  );

  let terrain: Terrain;
  if (elevation < SEA_LEVEL) {
    terrain = Terrain.Water;
  } else if (elevation > 0.69) {
    terrain = Terrain.Mountain;
  } else if (econ > 0.6 && moisture < 0.58 && elevation < 0.66) {
    terrain = Terrain.Industry;
  } else if (isFarmlandCandidate(elevation, moisture, econ)) {
    terrain = Terrain.Farmland;
  } else if (moisture > SUBURB_MOISTURE) {
    terrain = Terrain.Suburb;
  } else {
    terrain = Terrain.Wasteland;
  }

  const pixel = axialToPixel(a, HEX_SIZE);
  return {
    q: a.q,
    r: a.r,
    terrain,
    elevation,
    moisture,
    econ,
    blobId: null,
    river: false,
    servedBy: [],
    coast: false,
    jitter: 0,
    x: pixel.x,
    y: pixel.y,
  };
}

/* ------------------------------------------------------------------ */
/* 第三层（先做）：海岸线平滑，避免单格噪点                              */
/* ------------------------------------------------------------------ */

function smoothCoastline(world: World, rng: Rng, tiles: Tile[]): void {
  const waterKeys = new Set<string>();
  for (const t of world.list) {
    if (t.terrain === Terrain.Water) waterKeys.add(`${t.q},${t.r}`);
  }

  const conversions: { tile: Tile; toWater: boolean }[] = [];

  for (const tile of tiles) {
    const ns = world.neighbors(tile);
    const waterNeighbors = ns.filter((n) => waterKeys.has(`${n.q},${n.r}`)).length;
    if (tile.terrain === Terrain.Water && waterNeighbors <= 1) {
      conversions.push({ tile, toWater: false });
    } else if (isLand(tile.terrain) && tile.terrain !== Terrain.Mountain && waterNeighbors >= 5) {
      conversions.push({ tile, toWater: true });
    }
  }

  for (const { tile, toWater } of conversions) {
    if (toWater) {
      tile.terrain = Terrain.Water;
    } else {
      tile.terrain = classifyLand(tile, rng);
    }
  }
}

/* ------------------------------------------------------------------ */
/* 第二层：连片修正                                                     */
/* ------------------------------------------------------------------ */

interface GrowOptions {
  /** 参与选点的地块；默认整张地图。开拓时只允许新区域。 */
  candidates?: Tile[];
  /** 团块允许扩张到的地块键；默认不限制。 */
  allowed?: Set<string>;
  desired?: number;
  minSpacing?: number;
}

function growTowns(world: World, radius: number, rng: Rng, options: GrowOptions = {}): void {
  const pool = options.candidates ?? world.list;
  const candidates = pool.filter(
    (t) =>
      isLand(t.terrain) &&
      t.terrain !== Terrain.Mountain &&
      t.blobId === null &&
      t.elevation > 0.4 &&
      t.elevation < 0.72,
  );
  if (candidates.length === 0) return;

  const desired = options.desired ?? clamp(Math.round(radius * 0.4), 4, 10);
  const minSpacing = options.minSpacing ?? Math.max(5, radius * 0.27);
  const seeds: Tile[] = [];

  for (let attempt = 0; attempt < 900 && seeds.length < desired; attempt++) {
    let best: Tile | null = null;
    let bestScore = -Infinity;
    for (let i = 0; i < 12; i++) {
      const cand = rng.pick(candidates);
      if (cand.blobId !== null) continue;
      if (seeds.some((s) => hexDistance(s, cand) < minSpacing)) continue;
      if (world.blobs.some((blob) => hexDistance(blob.center, cand) < minSpacing)) continue;
      const coastal = world.neighbors(cand).some((n) => n.terrain === Terrain.Water) ? 0.16 : 0;
      const score =
        cand.econ * 0.55 +
        coastal +
        rng.next() * 0.4 -
        Math.abs(cand.elevation - 0.56) * 0.55;
      if (score > bestScore) {
        bestScore = score;
        best = cand;
      }
    }
    if (best) seeds.push(best);
  }

  if (seeds.length === 0 && world.blobs.length === 0) {
    // 极端情况下退化为随机播种，保证初始地图上一定有城镇
    seeds.push(rng.pick(candidates));
  }

  for (const seed of seeds) {
    const targetSize = rng.intBetween(8, 20);
    const tiles = growBlob(world, seed, targetSize, 'town', rng, options.allowed);
    for (const t of tiles) t.terrain = Terrain.Town;
    world.addBlob('town', tiles);
  }
}

function growIndustry(world: World, radius: number, rng: Rng, options: GrowOptions = {}): void {
  const desired = options.desired ?? clamp(Math.round(radius * 0.35), 3, 8);
  const minSpacing = options.minSpacing ?? Math.max(4, radius * 0.2);

  const isTownAdjacent = (tile: Tile): boolean => {
    if (tile.blobId !== null) return true;
    for (const n of world.neighbors(tile)) {
      if (n.blobId === null) continue;
      if (world.blobById.get(n.blobId)?.kind === 'town') return true;
    }
    return false;
  };

  const pool = options.candidates ?? world.list;
  const preferred = pool.filter(
    (t) =>
      isLand(t.terrain) &&
      t.terrain !== Terrain.Mountain &&
      t.blobId === null &&
      !isTownAdjacent(t) &&
      (t.terrain === Terrain.Industry || t.econ > 0.5),
  );

  const seeds: Tile[] = [];
  for (let attempt = 0; attempt < 700 && seeds.length < desired; attempt++) {
    let best: Tile | null = null;
    let bestScore = -Infinity;
    for (let i = 0; i < 10; i++) {
      if (preferred.length === 0) break;
      const cand = rng.pick(preferred);
      if (cand.blobId !== null || isTownAdjacent(cand)) continue;
      if (seeds.some((s) => hexDistance(s, cand) < minSpacing)) continue;
      if (world.blobs.some((blob) => hexDistance(blob.center, cand) < minSpacing)) continue;
      const score = cand.econ * 0.7 + rng.next() * 0.3;
      if (score > bestScore) {
        bestScore = score;
        best = cand;
      }
    }
    if (best) seeds.push(best);
  }

  for (const seed of seeds) {
    const targetSize = rng.intBetween(3, 8);
    const tiles = growBlob(world, seed, targetSize, 'industry', rng, options.allowed);
    for (const t of tiles) t.terrain = Terrain.Industry;
    world.addBlob('industry', tiles);
  }

  // 没有被团块吸收的宏观工业地块回退为郊区/荒地，保证“工业连片”语义
  for (const tile of pool) {
    if (tile.terrain !== Terrain.Industry || tile.blobId !== null) continue;
    const nearTown = world.neighbors(tile).some((n) => {
      const blob = n.blobId === null ? undefined : world.blobById.get(n.blobId);
      return blob?.kind === 'town';
    });
    tile.terrain = nearTown
      ? Terrain.Suburb
      : isFarmlandCandidate(tile.elevation, tile.moisture, tile.econ)
        ? Terrain.Farmland
        : Terrain.Wasteland;
  }
}

/** 从种子格向外膨胀，按评分挑选下一格，形成一个紧凑但不规则的团块。 */
function growBlob(
  world: World,
  seed: Tile,
  targetSize: number,
  kind: 'town' | 'industry',
  rng: Rng,
  allowed?: Set<string>,
): Tile[] {
  const chosen: Tile[] = [seed];
  const inBlob = new Set<string>([`${seed.q},${seed.r}`]);

  while (chosen.length < targetSize) {
    const frontier = new Map<string, Tile>();
    for (const tile of chosen) {
      for (const n of world.neighbors(tile)) {
        const key = `${n.q},${n.r}`;
        if (allowed && !allowed.has(key)) continue;
        if (inBlob.has(key) || n.blobId !== null) continue;
        if (!isLand(n.terrain) || n.terrain === Terrain.Mountain) continue;
        frontier.set(key, n);
      }
    }
    if (frontier.size === 0) break;

    let best: Tile | null = null;
    let bestScore = -Infinity;
    for (const cand of frontier.values()) {
      const touch = world.neighbors(cand).filter((n) => inBlob.has(`${n.q},${n.r}`)).length;
      let score: number;
      if (kind === 'town') {
        score =
          cand.econ * 0.5 +
          (1 - clamp(Math.abs(cand.elevation - 0.56) * 3.2, 0, 1)) * 0.28 +
          touch * 0.08 +
          rng.next() * 0.32;
      } else {
        score =
          cand.econ * 0.62 +
          (1 - clamp(Math.abs(cand.elevation - 0.45) * 3, 0, 1)) * 0.16 +
          touch * 0.06 +
          rng.next() * 0.34;
      }
      if (score > bestScore) {
        bestScore = score;
        best = cand;
      }
    }
    if (!best) break;
    chosen.push(best);
    inBlob.add(`${best.q},${best.r}`);
  }

  return chosen;
}

/** 向城镇外围晕染郊区与农田，让“连片”在视觉上自然过渡。 */
function paintSuburbHalo(
  world: World,
  rng: Rng,
  maxDistance: number,
  allowed?: Set<string>,
): void {
  const townTiles = world.list.filter((t) => t.terrain === Terrain.Town);
  if (townTiles.length === 0) return;

  const distance = new Map<string, number>();
  const queue: Tile[] = [];
  for (const t of townTiles) {
    distance.set(`${t.q},${t.r}`, 0);
    queue.push(t);
  }

  let head = 0;
  while (head < queue.length) {
    const tile = queue[head++]!;
    const d = distance.get(`${tile.q},${tile.r}`) ?? 0;
    if (d >= maxDistance) continue;
    for (const n of world.neighbors(tile)) {
      const key = `${n.q},${n.r}`;
      if (distance.has(key)) continue;
      if (!isLand(n.terrain) || n.terrain === Terrain.Mountain) continue;
      distance.set(key, d + 1);
      queue.push(n);
    }
  }

  for (const [key, d] of distance) {
    if (d === 0) continue;
    if (allowed && !allowed.has(key)) continue;
    const tile = world.tiles.get(key);
    if (!tile || tile.blobId !== null || !isLand(tile.terrain) || tile.terrain === Terrain.Mountain) {
      continue;
    }
    if (d === 1) {
      if (rng.chance(0.94)) tile.terrain = Terrain.Suburb;
    } else if (d === 2) {
      tile.terrain = rng.chance(0.45) ? Terrain.Suburb : Terrain.Farmland;
    } else if (rng.chance(0.75)) {
      tile.terrain = Terrain.Farmland;
    }
  }
}

/* ------------------------------------------------------------------ */
/* 第三层：河流细节                                                     */
/* ------------------------------------------------------------------ */

/** 从湖泊边缘向高处逆流而上，形成较长的内陆河流。 */
function carveRivers(
  world: World,
  rng: Rng,
  count: number,
  allowed?: Set<string>,
): void {
  const mouths = world.list.filter(
    (t) =>
      t.terrain === Terrain.Water &&
      !t.river &&
      world.neighbors(t).some((n) => {
        if (allowed && !allowed.has(`${n.q},${n.r}`)) return false;
        return isLand(n.terrain) && n.blobId === null;
      }),
  );
  if (mouths.length === 0) return;

  const usedMouths: Tile[] = [];
  let carved = 0;

  for (let attempt = 0; attempt < count * 40 && carved < count; attempt++) {
    const mouth = rng.pick(mouths);
    if (usedMouths.some((m) => hexDistance(m, mouth) < 7)) continue;

    const path = traceRiverInland(world, mouth, rng, allowed);
    if (!path || path.length < 12) continue;

    for (const tile of path) {
      if (tile.blobId !== null) continue;
      tile.terrain = Terrain.Water;
      tile.river = true;
      for (const n of world.neighbors(tile)) {
        if (isLand(n.terrain)) n.moisture = clamp01(n.moisture + 0.08);
      }
    }
    usedMouths.push(mouth);
    carved++;
  }
}

/** 从湖泊入水口出发，沿地势向上游走，返回从内陆到湖泊的路径。 */
function traceRiverInland(
  world: World,
  mouth: Tile,
  rng: Rng,
  allowed?: Set<string>,
): Tile[] | null {
  const firstStep = world
    .neighbors(mouth)
    .filter((n) => {
      if (allowed && !allowed.has(`${n.q},${n.r}`)) return false;
      return isLand(n.terrain) && n.blobId === null;
    })
    .sort((a, b) => a.elevation - b.elevation)[0];
  if (!firstStep) return null;

  const path: Tile[] = [firstStep];
  const visited = new Set<string>([`${firstStep.q},${firstStep.r}`, `${mouth.q},${mouth.r}`]);
  let current = firstStep;

  for (let step = 0; step < 55; step++) {
    if (current.elevation > 0.65 && path.length >= 12) break;

    let next: Tile | null = null;
    let bestScore = -Infinity;
    for (const n of world.neighbors(current)) {
      const key = `${n.q},${n.r}`;
      if (visited.has(key)) continue;
      if (allowed && !allowed.has(key)) continue;
      if (!isLand(n.terrain) || n.blobId !== null) continue;
      // 允许轻微下坡穿越鞍部，让河流能绕过局部小高地继续延伸
      if (n.elevation < current.elevation - 0.05) continue;
      const downhill = Math.max(0, current.elevation - n.elevation);
      const score = n.elevation - downhill * 2 + rng.next() * 0.05;
      if (score > bestScore) {
        bestScore = score;
        next = n;
      }
    }
    if (!next) break;
    visited.add(`${next.q},${next.r}`);
    path.push(next);
    current = next;
  }

  return path.length >= 12 ? path : null;
}

/* ------------------------------------------------------------------ */

function classifyLand(tile: Tile, rng: Rng): Terrain {
  if (tile.elevation > 0.69) return Terrain.Mountain;
  if (tile.econ > 0.6 && tile.moisture < 0.58 && tile.elevation < 0.66) {
    return rng.chance(0.6) ? Terrain.Industry : Terrain.Suburb;
  }
  if (isFarmlandCandidate(tile.elevation, tile.moisture, tile.econ)) return Terrain.Farmland;
  if (tile.moisture > SUBURB_MOISTURE) return Terrain.Suburb;
  return Terrain.Wasteland;
}

function isFarmlandCandidate(elevation: number, moisture: number, econ: number): boolean {
  if (elevation >= 0.62) return false;
  if (moisture > FARM_MOISTURE) return true;
  return moisture > FARM_ECON_MOISTURE && econ < FARM_ECON_MAX;
}

/** 统计各团块尺寸，返回一行摘要。 */
export function describeWorld(world: World): string {
  const townSizes = world.blobs.filter((b) => b.kind === 'town').map((b) => b.size);
  const industrySizes = world.blobs.filter((b) => b.kind === 'industry').map((b) => b.size);
  const cities = world.blobs
    .filter((b: MapBlob) => b.kind === 'town')
    .map((b) => `${b.center.q},${b.center.r}(${b.size})`)
    .join(' ');
  return [
    `seed=${world.seed}`,
    `tiles=${world.stats.total}`,
    `water=${world.stats.water}`,
    `rivers=${world.stats.riverTiles}`,
    `towns=[${townSizes.join(',')}]`,
    `industry=[${industrySizes.join(',')}]`,
    `centers=${cities}`,
  ].join(' ');
}
