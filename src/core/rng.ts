/** 可复现的伪随机数生成器（mulberry32），同一 seed 永远生成同一张地图。 */
export class Rng {
  private state: number;

  constructor(seed: number) {
    // 保证种子落在 uint32 内，且不会因为 0 退化
    this.state = (Math.floor(seed) >>> 0) || 0x9e3779b9;
  }

  /** [0, 1) */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** 序列化用：读取内部状态。 */
  getState(): number {
    return this.state;
  }

  /** 序列化用：恢复内部状态。 */
  setState(state: number): void {
    this.state = (Math.floor(state) >>> 0) || 0x9e3779b9;
  }

  /** [min, max) */
  range(min: number, max: number): number {
    return min + this.next() * (max - min);
  }

  /** [0, max) 的整数 */
  int(maxExclusive: number): number {
    return Math.floor(this.next() * maxExclusive);
  }

  /** [min, max] 的整数 */
  intBetween(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }

  chance(probability: number): boolean {
    return this.next() < probability;
  }

  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new Error('Rng.pick: empty array');
    return items[this.int(items.length)]!;
  }

  /** 按权重抽取下标，权重必须为非负数。 */
  weightedIndex(weights: readonly number[]): number {
    let total = 0;
    for (const w of weights) total += Math.max(0, w);
    if (total <= 0) return 0;
    let roll = this.next() * total;
    for (let i = 0; i < weights.length; i++) {
      roll -= Math.max(0, weights[i]!);
      if (roll <= 0) return i;
    }
    return weights.length - 1;
  }

  shuffle<T>(items: T[]): T[] {
    for (let i = items.length - 1; i > 0; i--) {
      const j = this.int(i + 1);
      const tmp = items[i]!;
      items[i] = items[j]!;
      items[j] = tmp;
    }
    return items;
  }
}

/** 把字符串种子（例如玩家输入）折叠成 32 位整数。 */
export function hashSeed(input: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** 由两个整数派生稳定的 [0,1) 小数，用于与渲染相关的微小抖动。 */
export function hash2d(q: number, r: number, salt = 0): number {
  let h = Math.imul(q, 374761393) + Math.imul(r, 668265263) + Math.imul(salt, 2147483647);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
