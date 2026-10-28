/**
 * 六边形网格 / 轴向坐标工具
 *
 * 采用 pointy-top（尖顶朝上）布局：
 *   x = size * sqrt(3) * (q + r / 2)
 *   y = size * 1.5 * r
 *
 * 逻辑层只使用 (q, r)，像素坐标只在渲染与命中检测时出现。
 */

export interface Axial {
  readonly q: number;
  readonly r: number;
}

/** 六边形六个邻居，顺序与 DIRECTION_NAMES 对应（pointy-top）。 */
export const HEX_DIRECTIONS: readonly Axial[] = [
  { q: 1, r: 0 }, // 东
  { q: 1, r: -1 }, // 东北
  { q: 0, r: -1 }, // 西北
  { q: -1, r: 0 }, // 西
  { q: -1, r: 1 }, // 西南
  { q: 0, r: 1 }, // 东南
];

export const DIRECTION_NAMES = ['东', '东北', '西北', '西', '西南', '东南'] as const;

export const SQRT3 = Math.sqrt(3);

export function hexKey(q: number, r: number): string {
  return `${q},${r}`;
}

export function axial(q: number, r: number): Axial {
  return { q, r };
}

export function axialEquals(a: Axial, b: Axial): boolean {
  return a.q === b.q && a.r === b.r;
}

/** 轴向坐标下的六边形距离。 */
export function hexDistance(a: Axial, b: Axial): number {
  const dq = a.q - b.q;
  const dr = a.r - b.r;
  return (Math.abs(dq) + Math.abs(dr) + Math.abs(dq + dr)) / 2;
}

export function neighborsOf(a: Axial): Axial[] {
  return HEX_DIRECTIONS.map((d) => ({ q: a.q + d.q, r: a.r + d.r }));
}

export function neighborAt(a: Axial, direction: number): Axial {
  const d = HEX_DIRECTIONS[((direction % 6) + 6) % 6]!;
  return { q: a.q + d.q, r: a.r + d.r };
}

/** 轴向坐标 -> 像素中心。 */
export function axialToPixel(a: Axial, size: number): { x: number; y: number } {
  return {
    x: size * SQRT3 * (a.q + a.r / 2),
    y: size * 1.5 * a.r,
  };
}

/** 像素 -> 轴向坐标（舍入到最近的六边形）。 */
export function pixelToAxial(x: number, y: number, size: number): Axial {
  const qf = ((SQRT3 / 3) * x - y / 3) / size;
  const rf = ((2 / 3) * y) / size;
  return axialRound(qf, rf);
}

/** 浮点轴向坐标取整（通过立方体坐标保证结果落在正确的六边形内）。 */
export function axialRound(qf: number, rf: number): Axial {
  const sf = -qf - rf;
  let q = Math.round(qf);
  let r = Math.round(rf);
  const s = Math.round(sf);

  const dq = Math.abs(q - qf);
  const dr = Math.abs(r - rf);
  const ds = Math.abs(s - sf);

  if (dq > dr && dq > ds) {
    q = -r - s;
  } else if (dr > ds) {
    r = -q - s;
  }
  return { q, r };
}

/** 六边形顶点（相对中心），pointy-top。 */
export function hexCorners(size: number): { x: number; y: number }[] {
  const points: { x: number; y: number }[] = [];
  for (let i = 0; i < 6; i++) {
    const angle = (Math.PI / 180) * (60 * i - 30);
    points.push({ x: size * Math.cos(angle), y: size * Math.sin(angle) });
  }
  return points;
}

/** 半径 radius 内所有格子（含中心），共 3R² + 3R + 1 个。 */
export function hexesInRange(center: Axial, radius: number): Axial[] {
  const out: Axial[] = [];
  for (let q = -radius; q <= radius; q++) {
    const rMin = Math.max(-radius, -q - radius);
    const rMax = Math.min(radius, -q + radius);
    for (let r = rMin; r <= rMax; r++) {
      out.push({ q: center.q + q, r: center.r + r });
    }
  }
  return out;
}

/** 以 center 为圆心、恰好距离为 radius 的一圈格子。 */
export function hexRing(center: Axial, radius: number): Axial[] {
  if (radius <= 0) return [{ ...center }];
  const out: Axial[] = [];
  let cursor = {
    q: center.q + HEX_DIRECTIONS[4]!.q * radius,
    r: center.r + HEX_DIRECTIONS[4]!.r * radius,
  };
  for (let side = 0; side < 6; side++) {
    for (let step = 0; step < radius; step++) {
      out.push(cursor);
      cursor = neighborAt(cursor, side);
    }
  }
  return out;
}

export function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

export function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

export function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}
