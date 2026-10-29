/** 浏览器 localStorage 存档：只保存种子与可恢复的游戏状态。 */

import type { NetworkSave } from './network';
import type { OperationsSave } from './operations';
import type { NameCulture } from './names';
import type { RegionCoord } from './world';

export const SAVE_KEY = 'railsim.save.v3';
export const SAVE_VERSION = 3;

export interface SaveMapSettings {
  /** 已解锁的大区域，第一项为初始区域 (0,0)。 */
  regions?: RegionCoord[];
  elevationOffset: number;
  moistureOffset: number;
  culture: NameCulture;
}

export interface SaveGame {
  version: number;
  savedAt: number;
  seed: number;
  /** 地图生成设置；旧存档没有此字段时按标准地图 / 中文处理。 */
  map?: SaveMapSettings;
  network: NetworkSave;
  operations: OperationsSave;
}

export function loadSave(): SaveGame | null {
  try {
    const raw = window.localStorage.getItem(SAVE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<SaveGame>;
    if (
      !parsed ||
      parsed.version !== SAVE_VERSION ||
      !Number.isFinite(parsed.seed) ||
      !parsed.network ||
      !parsed.operations
    ) {
      return null;
    }
    return parsed as SaveGame;
  } catch (error) {
    console.warn('[RailSim] 读取存档失败', error);
    return null;
  }
}

export function writeSave(save: SaveGame): void {
  try {
    window.localStorage.setItem(SAVE_KEY, JSON.stringify(save));
  } catch (error) {
    // localStorage 可能因为隐私模式 / 配额限制不可用，不能影响游戏运行
    console.warn('[RailSim] 写入存档失败', error);
  }
}

export function clearSave(): void {
  try {
    window.localStorage.removeItem(SAVE_KEY);
  } catch {
    // ignore
  }
}
