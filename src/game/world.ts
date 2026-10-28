import { Terrain } from './terrain';
import { hexKey, hexDistance, axialRound, neighborsOf, type Axial } from '../core/hex';

/** 单个六边形地块。逻辑数据与渲染数据放在一起，便于面板读取。 */
export interface Tile {
  readonly q: number;
  readonly r: number;
  terrain: Terrain;
  /** 0..1，海平面约 0.34 */
  elevation: number;
  /** 0..1 */
  moisture: number;
  /** 0..1，低频“经济带”噪声，决定工业与城镇的种子偏好 */
  econ: number;
  /** 城镇 / 工业团块 id，未归属为 null */
  blobId: number | null;
  /** 是否由河流雕刻而来（仍属于水域，但过河造价相同） */
  river: boolean;
  /** 覆盖该地块的车站 id 列表（由网络层在建造/拆除后重算） */
  servedBy: number[];
  /** 是否与水域相邻，供渲染海岸线与后续港口逻辑使用 */
  coast: boolean;
  /** 渲染用的稳定随机值 0..1，避免同色地块过于死板 */
  jitter: number;
  /** 世界坐标（像素），由 HEX_SIZE 计算并缓存 */
  x: number;
  y: number;
}

export type BlobKind = 'town' | 'industry';

/** 连片的城镇 / 工业团块。 */
export interface MapBlob {
  id: number;
  kind: BlobKind;
  name: string;
  tiles: Tile[];
  center: Axial;
  size: number;
}

export interface WorldStats {
  total: number;
  land: number;
  water: number;
  riverTiles: number;
  townBlobs: number;
  industryBlobs: number;
  largestTown: number;
  counts: Record<Terrain, number>;
}

/** 一次生成后的世界数据容器。生成逻辑在 mapgen.ts，这里只负责索引与查询。 */
export class World {
  readonly seed: number;
  readonly radius: number;
  readonly tiles = new Map<string, Tile>();
  readonly list: Tile[] = [];
  readonly blobs: MapBlob[] = [];
  readonly blobById = new Map<number, MapBlob>();
  spawn: Axial = { q: 0, r: 0 };
  stats: WorldStats = emptyStats();

  constructor(seed: number, radius: number) {
    this.seed = seed;
    this.radius = radius;
  }

  addTile(tile: Tile): void {
    this.tiles.set(hexKey(tile.q, tile.r), tile);
    this.list.push(tile);
  }

  get(q: number, r: number): Tile | undefined {
    return this.tiles.get(hexKey(q, r));
  }

  at(a: Axial): Tile | undefined {
    return this.tiles.get(hexKey(a.q, a.r));
  }

  has(q: number, r: number): boolean {
    return this.tiles.has(hexKey(q, r));
  }

  neighbors(tile: Tile): Tile[] {
    const out: Tile[] = [];
    for (const n of neighborsOf(tile)) {
      const t = this.at(n);
      if (t) out.push(t);
    }
    return out;
  }

  blobOf(tile: Tile): MapBlob | undefined {
    return tile.blobId === null ? undefined : this.blobById.get(tile.blobId);
  }

  addBlob(kind: BlobKind, tiles: Tile[], name = kind === 'town' ? '无名镇' : '工业区'): MapBlob {
    const id = this.blobs.length;
    const sum = tiles.reduce(
      (acc, t) => {
        acc.q += t.q;
        acc.r += t.r;
        return acc;
      },
      { q: 0, r: 0 },
    );
    const center = axialRound(sum.q / Math.max(1, tiles.length), sum.r / Math.max(1, tiles.length));
    const blob: MapBlob = { id, kind, name, tiles, center, size: tiles.length };
    for (const t of tiles) t.blobId = id;
    this.blobs.push(blob);
    this.blobById.set(id, blob);
    return blob;
  }

  /** 重新统计地形数量、海岸标记与出生点。生成结束后调用一次。 */
  refresh(): void {
    const counts = emptyCounts();
    let land = 0;
    let water = 0;
    let riverTiles = 0;

    for (const tile of this.list) {
      counts[tile.terrain]++;
      if (tile.terrain === Terrain.Water) {
        water++;
        if (tile.river) riverTiles++;
      } else {
        land++;
      }
      tile.coast = this.neighbors(tile).some((n) => n.terrain === Terrain.Water);
    }

    let largestTown = 0;
    let townBlobs = 0;
    let industryBlobs = 0;
    for (const blob of this.blobs) {
      if (blob.kind === 'town') {
        townBlobs++;
        largestTown = Math.max(largestTown, blob.size);
      } else {
        industryBlobs++;
      }
    }

    this.stats = {
      total: this.list.length,
      land,
      water,
      riverTiles,
      townBlobs,
      industryBlobs,
      largestTown,
      counts,
    };

    const biggest = this.blobs
      .filter((b) => b.kind === 'town')
      .sort((a, b) => b.size - a.size)[0];
    this.spawn = biggest ? { ...biggest.center } : { q: 0, r: 0 };
  }

  /** 供 UI 使用的地形统计（含百分比）。 */
  terrainShare(terrain: Terrain): number {
    return this.stats.total === 0 ? 0 : this.stats.counts[terrain] / this.stats.total;
  }

  /** 到世界中心的距离（格），用于生成时判断岛屿边缘。 */
  distanceFromCenter(tile: Tile): number {
    return hexDistance(tile, { q: 0, r: 0 });
  }
}

export function emptyCounts(): Record<Terrain, number> {
  return {
    [Terrain.Wasteland]: 0,
    [Terrain.Farmland]: 0,
    [Terrain.Suburb]: 0,
    [Terrain.Industry]: 0,
    [Terrain.Mountain]: 0,
    [Terrain.Town]: 0,
    [Terrain.Water]: 0,
  };
}

function emptyStats(): WorldStats {
  return {
    total: 0,
    land: 0,
    water: 0,
    riverTiles: 0,
    townBlobs: 0,
    industryBlobs: 0,
    largestTown: 0,
    counts: emptyCounts(),
  };
}
