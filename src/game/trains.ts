/** 可购置列车车型。 */

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
}

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
  },
  express: {
    id: 'express',
    name: '快速列车',
    cars: 3,
    cost: 95_000,
    speed: 64,
    capacity: 12,
    speedLabel: '较快',
    description: '3 节编组，速度更快，适合干线。',
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
  },
};

export const TRAIN_MODEL_LIST: TrainModel[] = [
  TRAIN_MODELS.commuter!,
  TRAIN_MODELS.express!,
  TRAIN_MODELS.heavy!,
];

export function trainModel(id: string): TrainModel | null {
  return TRAIN_MODELS[id] ?? null;
}
