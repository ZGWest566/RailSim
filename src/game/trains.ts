/** 可购置列车车型。 */

import type { TrackKind } from './tracks';

export interface TrainModel {
  id: string;
  name: string;
  cars: number;
  cost: number;
  /** 地图上的视觉速度，单位：世界像素 / 秒 */
  speed: number;
  capacity: number;
  speedLabel: string;
  description: string;
  /** 是否可进入高速铁路并在其上全速运行。 */
  highSpeedCapable: boolean;
  /** 在普速铁路上的最高速度。 */
  conventionalSpeed: number;
}

/** 快速列车的标准速度，动车组在普速线上按此速度运行。 */
export const EXPRESS_SPEED = 64;

export const TRAIN_MODELS: Record<string, TrainModel> = {
  commuter: {
    id: 'commuter',
    name: '通勤列车',
    cars: 2,
    cost: 60_000,
    speed: 46,
    capacity: 8,
    speedLabel: '标准',
    description: '2 节编组，造价低，适合短途。',
    highSpeedCapable: false,
    conventionalSpeed: 46,
  },
  express: {
    id: 'express',
    name: '快速列车',
    cars: 3,
    cost: 95_000,
    speed: EXPRESS_SPEED,
    capacity: 12,
    speedLabel: '较快',
    description: '3 节编组，速度更快，适合干线。',
    highSpeedCapable: false,
    conventionalSpeed: EXPRESS_SPEED,
  },
  heavy: {
    id: 'heavy',
    name: '重载列车',
    cars: 4,
    cost: 140_000,
    speed: 36,
    capacity: 16,
    speedLabel: '较慢',
    description: '4 节编组，载客多，适合高密度线路。',
    highSpeedCapable: false,
    conventionalSpeed: 36,
  },
  emu: {
    id: 'emu',
    name: '动车组列车',
    cars: 3,
    cost: 220_000,
    speed: EXPRESS_SPEED * 2,
    capacity: 12,
    speedLabel: '高速',
    description: '3 节编组。高速铁路全速运行；普速铁路按快速列车速度运行。',
    highSpeedCapable: true,
    conventionalSpeed: EXPRESS_SPEED,
  },
};

export const TRAIN_MODEL_LIST: TrainModel[] = [
  TRAIN_MODELS.commuter!,
  TRAIN_MODELS.express!,
  TRAIN_MODELS.heavy!,
  TRAIN_MODELS.emu!,
];

export function trainModel(id: string): TrainModel | null {
  return TRAIN_MODELS[id] ?? null;
}

/** 列车在指定轨道类型上的最高速度；普通列车进入高速铁路时返回 0。 */
export function trainSpeedOnTrack(model: TrainModel, kind: TrackKind): number {
  if (kind === 'highspeed') {
    return model.highSpeedCapable ? model.speed : 0;
  }
  return model.conventionalSpeed;
}

/** 列车能否进入指定轨道类型。 */
export function trainCanUseTrack(model: TrainModel, kind: TrackKind): boolean {
  return trainSpeedOnTrack(model, kind) > 0;
}
