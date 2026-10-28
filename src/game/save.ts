/** 浏览器 localStorage 存档：只保存种子与可恢复的游戏状态。 */

import type { NetworkSave } from './network';
import type { OperationsSave } from './operations';

export const SAVE_KEY = 'railsim.save.v1';
export const SAVE_VERSION = 1;

export interface SaveGame {
  version: number;
  savedAt: number;
  seed: number;
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
