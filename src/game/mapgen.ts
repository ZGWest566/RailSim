import { HEX_SIZE, MAP_RADIUS, SEA_LEVEL } from '../config';
import {
  axialToPixel,
  clamp,
  clamp01,
  hexDistance,
  hexesInRange,
  smoothstep,
  type Axial,
} from '../core/hex';
import { Perlin2D } from '../core/noise';
import { Rng, hash2d } from '../core/rng';
import { Terrain, isLand } from './terrain';
import { World, type MapBlob, type Tile } from './world';

export interface MapGenOptions {
  seed: number;
  radius?: number;
  /** 关闭河流雕刻 */
  rivers?: boolean;
}

const ORIGIN: Axial = { q: 0, r: 0 };

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

const TOWN_PREFIX = [
  '青石', '云溪', '北港', '白河', '松岭', '安平', '临川', '望海',
  '丰原', '新桥', '柳湾', '南浦', '东岗', '槐安', '红叶', '双溪',
];
const TOWN_SUFFIX = ['镇', '镇', '城', '新区', '港'];
const INDUSTRY_PREFIX = ['临港', '北山', '西河', '南岭', '东郊', '新城', '铁西', '云谷'];
const INDUSTRY_SUFFIX = ['工业区', '物流园', '钢铁园', '产业园', '货运场'];

function createNamer(rng: Rng): (kind: 'town' | 'industry') => string {
  const used = new Set<string>();
  return (kind) => {
    for (let i = 0; i < 40; i++) {
      const prefix = rng.pick(kind === 'town' ? TOWN_PREFIX : INDUSTRY_PREFIX);
      const suffix = rng.pick(kind === 'town' ? TOWN_SUFFIX : INDUSTRY_SUFFIX);
      if (prefix.endsWith(suffix.charAt(0))) continue;
      const name = prefix + suffix;
      if (!used.has(name)) {
        used.add(name);
        return name;
      }
    }
    const fallback = `${kind === 'town' ? '新城区' : '新园区'} ${used.size + 1}`;
    used.add(fallback);
    return fallback;
  };
}

/**
 * 三层地图生成管线：
 *
 *   1. 宏观噪声：海拔 / 湿度 / 经济带 → 初始地块
 *   2. 连片修正：种子膨胀，城镇 8~20 格、工业 3~8 格，再做郊区晕染
 *   3. 局部细化：海岸线平滑 + 顺坡河流雕刻
 */
export function generateWorld(options: MapGenOptions): World {
  const seed = options.seed >>> 0;
  const radius = options.radius ?? MAP_RADIUS;
  const world = new World(seed, radius);
  const rng = new Rng(seed);

  const elevNoise = new Perlin2D(rng);
  const moistNoise = new Perlin2D(rng);
  const econNoise = new Perlin2D(rng);
  const ridgeNoise = new Perlin2D(rng);

  buildMacro(world, radius, elevNoise, moistNoise, econNoise, ridgeNoise);
  smoothCoastline(world, rng);
  growTowns(world, radius, rng);
  growIndustry(world, radius, rng);
  paintSuburbHalo(world, rng, 3);
  if (options.rivers !== false) carveRivers(world, rng, 3);

  // 团块名称使用独立的随机流，避免改名字影响地图几何
  const namer = createNamer(new Rng(seed ^ 0x51ed270b));
  for (const blob of world.blobs) blob.name = namer(blob.kind);

  world.refresh();

  // 少量视觉抖动在生成后统一写入，保证刷新地图时纹理稳定
  for (const tile of world.list) {
    tile.jitter = hash2d(tile.q, tile.r, seed);
  }

  return world;
}

/* ------------------------------------------------------------------ */
/* 第一层：宏观噪声                                                     */
/* ------------------------------------------------------------------ */

function buildMacro(
  world: World,
  radius: number,
  elevNoise: Perlin2D,
  moistNoise: Perlin2D,
  econNoise: Perlin2D,
  ridgeNoise: Perlin2D,
): void {
  for (const a of hexesInRange(ORIGIN, radius)) {
    const nx = a.q + a.r * 0.5;
    const ny = a.r * 0.866;
    const dist = hexDistance(a, ORIGIN);
    const edge = smoothstep(radius * 0.78, radius * 1.06, dist);

    const base = elevNoise.fbm(nx * 0.12 + 11.3, ny * 0.12 + 7.7, 5);
    const ridge = ridgeNoise.ridged(nx * 0.18 + 3.1, ny * 0.18 + 9.4, 4);
    const elevation = clamp01(base * 0.8 + 0.08 - edge * 0.72 + (ridge - 0.5) * 0.17);
    const moisture = clamp01(moistNoise.fbm(nx * 0.09 + 40.2, ny * 0.09 + 13.8, 4) * 0.88 + 0.04);
    const econ = clamp01(econNoise.fbm(nx * 0.06 + 70.5, ny * 0.06 + 31.4, 3) * 0.96 + 0.02);

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
    world.addTile({
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
    });
  }
}

/* ------------------------------------------------------------------ */
/* 第三层（先做）：海岸线平滑，避免单格噪点                              */
/* ------------------------------------------------------------------ */

function smoothCoastline(world: World, rng: Rng): void {
  const waterKeys = new Set<string>();
  for (const t of world.list) {
    if (t.terrain === Terrain.Water) waterKeys.add(`${t.q},${t.r}`);
  }

  const conversions: { tile: Tile; toWater: boolean }[] = [];

  for (const tile of world.list) {
    const ns = world.neighbors(tile);
    const outside = 6 - ns.length;
    const waterNeighbors = ns.filter((n) => waterKeys.has(`${n.q},${n.r}`)).length + outside;
    if (tile.terrain === Terrain.Water && waterNeighbors <= 1 && outside === 0) {
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

function growTowns(world: World, radius: number, rng: Rng): void {
  const candidates = world.list.filter(
    (t) =>
      isLand(t.terrain) &&
      t.terrain !== Terrain.Mountain &&
      t.blobId === null &&
      t.elevation > 0.4 &&
      t.elevation < 0.72,
  );
  if (candidates.length === 0) return;

  const desired = clamp(Math.round(radius * 0.4), 4, 10);
  const minSpacing = Math.max(5, radius * 0.27);
  const seeds: Tile[] = [];

  for (let attempt = 0; attempt < 900 && seeds.length < desired; attempt++) {
    let best: Tile | null = null;
    let bestScore = -Infinity;
    for (let i = 0; i < 12; i++) {
      const cand = rng.pick(candidates);
      if (cand.blobId !== null) continue;
      if (seeds.some((s) => hexDistance(s, cand) < minSpacing)) continue;
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

  if (seeds.length === 0) {
    // 极端情况下退化为随机播种，保证地图上一定有城镇
    seeds.push(rng.pick(candidates));
  }

  for (const seed of seeds) {
    const targetSize = rng.intBetween(8, 20);
    const tiles = growBlob(world, seed, targetSize, 'town', rng);
    for (const t of tiles) t.terrain = Terrain.Town;
    world.addBlob('town', tiles);
  }
}

function growIndustry(world: World, radius: number, rng: Rng): void {
  const desired = clamp(Math.round(radius * 0.35), 3, 8);
  const minSpacing = Math.max(4, radius * 0.2);

  const isTownAdjacent = (tile: Tile): boolean => {
    if (tile.blobId !== null) return true;
    for (const n of world.neighbors(tile)) {
      if (n.blobId === null) continue;
      if (world.blobById.get(n.blobId)?.kind === 'town') return true;
    }
    return false;
  };

  const preferred = world.list.filter(
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
    const tiles = growBlob(world, seed, targetSize, 'industry', rng);
    for (const t of tiles) t.terrain = Terrain.Industry;
    world.addBlob('industry', tiles);
  }

  // 没有被团块吸收的宏观工业地块回退为郊区/荒地，保证“工业连片”语义
  for (const tile of world.list) {
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
): Tile[] {
  const chosen: Tile[] = [seed];
  const inBlob = new Set<string>([`${seed.q},${seed.r}`]);

  while (chosen.length < targetSize) {
    const frontier = new Map<string, Tile>();
    for (const tile of chosen) {
      for (const n of world.neighbors(tile)) {
        const key = `${n.q},${n.r}`;
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
function paintSuburbHalo(world: World, rng: Rng, maxDistance: number): void {
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

/** 从海岸向高处逆流而上，保证每条河都能从山地汇入海洋。 */
function carveRivers(world: World, rng: Rng, count: number): void {
  const mouths = world.list.filter(
    (t) =>
      t.terrain === Terrain.Water &&
      !t.river &&
      world.neighbors(t).some((n) => isLand(n.terrain) && n.blobId === null),
  );
  if (mouths.length === 0) return;

  const usedMouths: Tile[] = [];
  let carved = 0;

  for (let attempt = 0; attempt < count * 30 && carved < count; attempt++) {
    const mouth = rng.pick(mouths);
    if (usedMouths.some((m) => hexDistance(m, mouth) < 6)) continue;

    const path = traceRiverInland(world, mouth, rng);
    if (!path || path.length < 8) continue;

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

/** 从入海口出发，沿地势向上游走，返回从内陆到海口的路径。 */
function traceRiverInland(world: World, mouth: Tile, rng: Rng): Tile[] | null {
  const firstStep = world
    .neighbors(mouth)
    .filter((n) => isLand(n.terrain) && n.blobId === null)
    .sort((a, b) => b.elevation - a.elevation)[0];
  if (!firstStep) return null;

  const path: Tile[] = [firstStep];
  const visited = new Set<string>([`${firstStep.q},${firstStep.r}`, `${mouth.q},${mouth.r}`]);
  let current = firstStep;

  for (let step = 0; step < 26; step++) {
    if (current.elevation > 0.6 && path.length >= 10) break;

    let next: Tile | null = null;
    let bestScore = -Infinity;
    for (const n of world.neighbors(current)) {
      const key = `${n.q},${n.r}`;
      if (visited.has(key)) continue;
      if (!isLand(n.terrain) || n.blobId !== null) continue;
      if (n.elevation < current.elevation - 0.015) continue; // 只向上游走
      const score = n.elevation + rng.next() * 0.05;
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

  return path.length >= 8 ? path : null;
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
