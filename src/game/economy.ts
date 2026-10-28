import { Terrain, TERRAIN_DEFS } from './terrain';
import type { Tile } from './world';

/** 初始资金。重生成地图会重置到这个数额。 */
export const STARTING_CREDITS = 200_000;

/** 单格轨道基础造价（再乘以地块成本系数）。 */
export const TRACK_BASE_COST = 6_000;

/** 拆除返还比例。 */
export const REFUND_RATE = 0.5;

/** 客运列车运行成本：每格 10 元。 */
export const PASSENGER_OPEX_PER_HEX = 10;
/** 货运列车运行成本：每格 5 元。 */
export const CARGO_OPEX_PER_HEX = 5;

/**
 * 铺轨造价 = 基础价 × 地块系数。
 * 山区、城镇更贵，水域按桥梁计价。
 */
export function trackCostForTerrain(terrain: Terrain): number {
  const factor = TERRAIN_DEFS[terrain].costFactor;
  return Math.round((TRACK_BASE_COST * factor) / 100) * 100;
}

/** 有实际需求的非荒野地块（水域、山地只作为通道或屏障）。 */
export function isDemandTile(tile: Tile): boolean {
  return (
    tile.terrain !== Terrain.Water &&
    tile.terrain !== Terrain.Mountain &&
    tile.terrain !== Terrain.Wasteland
  );
}

export function formatMoney(value: number): string {
  return `¥ ${Math.round(value).toLocaleString('en-US')}`;
}

export function refundOf(paid: number): number {
  return Math.round(paid * REFUND_RATE);
}
