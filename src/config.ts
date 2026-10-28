/** 全局常量：地图尺寸、渲染尺寸、相机范围。 */

/** 地图半径（格）。半径 20 共 1261 个六边形。 */
export const MAP_RADIUS = 20;

export type MapSize = 'small' | 'medium' | 'large';

export interface MapSizePreset {
  radius: number;
  label: string;
  hint: string;
}

/** 开始界面提供的地图大小；当前默认地图为“小”。 */
export const MAP_SIZE_PRESETS: Record<MapSize, MapSizePreset> = {
  small: { radius: MAP_RADIUS, label: '小', hint: '标准地图' },
  medium: { radius: 28, label: '中', hint: '更大的地图' },
  large: { radius: 36, label: '大', hint: '超大地图' },
};

export function mapSizeForRadius(radius: number): MapSize {
  let best: MapSize = 'small';
  let bestDelta = Infinity;
  for (const [size, preset] of Object.entries(MAP_SIZE_PRESETS) as [
    MapSize,
    MapSizePreset,
  ][]) {
    const delta = Math.abs(preset.radius - radius);
    if (delta < bestDelta) {
      bestDelta = delta;
      best = size;
    }
  }
  return best;
}

/** 单格外接圆半径（世界像素）。地图直径约 1100px。 */
export const HEX_SIZE = 30;

/** 每格代表的实际距离（km），仅用于 UI 展示。 */
export const KM_PER_HEX = 5;

export const CAMERA_MIN_ZOOM = 0.26;
export const CAMERA_MAX_ZOOM = 2.6;

/** 默认海平面，与 mapgen 保持一致。 */
export const SEA_LEVEL = 0.34;

export const DEFAULT_ZOOM_FIT_PADDING = 1.08;
