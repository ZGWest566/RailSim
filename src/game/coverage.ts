import { hexesInRange } from '../core/hex';
import { isDemandTile } from './economy';
import { STATION_DEFS, type StationType } from './stations';
import type { Tile, World } from './world';

export interface CoveragePreview {
  tiles: Tile[];
  demandTiles: number;
}

/** 车站覆盖到的地块。轻轨/小型/大型按半径，货运站按连片工业区。 */
export function stationCoverageTiles(world: World, tile: Tile, type: StationType): Tile[] {
  if (type === 'freight') return freightCoverageTiles(world, tile);

  const radius = STATION_DEFS[type].radius;
  const tiles: Tile[] = [];
  for (const axial of hexesInRange(tile, radius)) {
    const found = world.get(axial.q, axial.r);
    if (found) tiles.push(found);
  }
  return tiles;
}

/** 货运站覆盖：车站所在工业团块 + 紧邻的工业团块。 */
export function freightCoverageTiles(world: World, tile: Tile): Tile[] {
  const blobIds = new Set<number>();
  const own = tile.blobId === null ? undefined : world.blobById.get(tile.blobId);
  if (own?.kind === 'industry') blobIds.add(own.id);

  for (const neighbor of world.neighbors(tile)) {
    if (neighbor.blobId === null) continue;
    const blob = world.blobById.get(neighbor.blobId);
    if (blob?.kind === 'industry') blobIds.add(blob.id);
  }

  if (blobIds.size === 0) return [];

  const covered = new Map<string, Tile>();
  for (const id of blobIds) {
    const blob = world.blobById.get(id);
    if (!blob) continue;
    for (const t of blob.tiles) covered.set(`${t.q},${t.r}`, t);
  }
  covered.set(`${tile.q},${tile.r}`, tile);
  return [...covered.values()];
}

export function countDemandTiles(tiles: readonly Tile[]): number {
  let count = 0;
  for (const tile of tiles) if (isDemandTile(tile)) count++;
  return count;
}

export function previewStationCoverage(
  world: World,
  tile: Tile,
  type: StationType,
): CoveragePreview {
  const tiles = stationCoverageTiles(world, tile, type);
  return { tiles, demandTiles: countDemandTiles(tiles) };
}
