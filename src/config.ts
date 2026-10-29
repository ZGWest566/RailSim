/** 全局常量：区域尺寸、渲染尺寸、相机范围。 */

/**
 * 区域格：整张初始地图是一块“区域”，每块区域由半径约 20 格的大六边形组成。
 * 相邻区域中心在轴向坐标中相隔 REGION_SPACING 格，区域面积约 REGION_SPACING² 格。
 */
export const REGION_SPACING = 36;

/** 单格外接圆半径（世界像素）。 */
export const HEX_SIZE = 30;

/** 每格代表的实际距离（km），仅用于 UI 展示。 */
export const KM_PER_HEX = 5;

export const CAMERA_MIN_ZOOM = 0.05;
export const CAMERA_MAX_ZOOM = 2.6;

/** 默认海平面，与 mapgen 保持一致。 */
export const SEA_LEVEL = 0.34;

export const DEFAULT_ZOOM_FIT_PADDING = 1.08;
