/** 地名文化预设：不同语言使用各自的地名组合，界面显示原语言名称。 */

import type { Rng } from '../core/rng';

export type NameCulture = 'chinese' | 'english' | 'japanese' | 'german' | 'french';

export interface NameCultureDef {
  id: NameCulture;
  label: string;
}

export const NAME_CULTURES: NameCultureDef[] = [
  { id: 'chinese', label: '中文' },
  { id: 'english', label: 'English' },
  { id: 'japanese', label: '日本語' },
  { id: 'german', label: 'Deutsch' },
  { id: 'french', label: 'Français' },
];

export const DEFAULT_NAME_CULTURE: NameCulture = 'chinese';

export function isNameCulture(value: unknown): value is NameCulture {
  return typeof value === 'string' && NAME_CULTURES.some((culture) => culture.id === value);
}

interface CultureNames {
  townPrefix: string[];
  townSuffix: string[];
  townJoin: string;
  industryPrefix: string[];
  industrySuffix: string[];
  industryJoin: string;
  fallbackTown: string;
  fallbackIndustry: string;
}

const CULTURE_NAMES: Record<NameCulture, CultureNames> = {
  chinese: {
    townPrefix: [
      '青石', '云溪', '北港', '白河', '松岭', '安平', '临川', '望海',
      '丰原', '新桥', '柳湾', '南浦', '东岗', '槐安', '红叶', '双溪',
    ],
    townSuffix: ['镇', '镇', '城', '新区', '港'],
    townJoin: '',
    industryPrefix: ['临港', '北山', '西河', '南岭', '东郊', '新城', '铁西', '云谷'],
    industrySuffix: ['工业区', '物流园', '钢铁园', '产业园', '货运场'],
    industryJoin: '',
    fallbackTown: '新城区',
    fallbackIndustry: '新园区',
  },
  english: {
    townPrefix: [
      'Ash', 'Brook', 'Clay', 'Dun', 'East', 'Fair', 'Green', 'Hart',
      'King', 'Lang', 'Mill', 'North', 'Oak', 'Raven', 'River', 'Stone',
      'West', 'Whit', 'Black', 'Silver',
    ],
    townSuffix: [
      'ford', 'ton', 'field', 'bridge', 'ham', 'wick',
      'dale', 'port', 'bury', 'stead', 'well', 'moor',
    ],
    townJoin: '',
    industryPrefix: [
      'Iron', 'Steel', 'Coal', 'Copper', 'Granite', 'Harbor',
      'North', 'South', 'East', 'West', 'Blackwater', 'Marsh',
    ],
    industrySuffix: ['Works', 'Yard', 'Mill', 'Port', 'Fields', 'Quay', 'Depot'],
    industryJoin: ' ',
    fallbackTown: 'New Town',
    fallbackIndustry: 'New Works',
  },
  japanese: {
    townPrefix: [
      '青葉', '桜', '朝日', '白川', '松風', '港', '北', '南',
      '東', '西', '高砂', '若葉', '緑', '金沢', '小川', '花園',
      '日の出', '三日月',
    ],
    townSuffix: ['町', '市', '台', '坂', '浜', 'ヶ丘', '新町', '荘'],
    townJoin: '',
    industryPrefix: [
      '東洋', '日鉄', '三菱', '住友', '北港', '南港',
      '新日', '川崎', '神戸', '名古屋',
    ],
    industrySuffix: ['工業団地', '製作所', '倉庫群', '港', '工場'],
    industryJoin: '',
    fallbackTown: '新町',
    fallbackIndustry: '新工場',
  },
  german: {
    townPrefix: [
      'Alt', 'Neu', 'Berg', 'Wald', 'Feld', 'Kirch', 'Rot', 'Weiß',
      'Ost', 'West', 'Nord', 'Süd', 'Stein', 'Linden', 'Eichen',
      'Birken', 'Tal', 'See',
    ],
    townSuffix: [
      'stadt', 'dorf', 'heim', 'berg', 'feld', 'hausen',
      'bach', 'hafen', 'au', 'ried',
    ],
    townJoin: '',
    industryPrefix: [
      'Eisen', 'Stahl', 'Kohle', 'Hafen', 'Güter', 'Industrie',
      'Nord', 'Süd', 'Ost', 'West', 'Metall', 'Werk',
    ],
    industrySuffix: ['werk', 'stadt', 'hafen', 'park', 'hof', 'zentrum'],
    industryJoin: '',
    fallbackTown: 'Neustadt',
    fallbackIndustry: 'Neues Werk',
  },
  french: {
    townPrefix: [
      'Beau', 'Bel', 'Mont', 'Val', 'Roche', 'Fontaine', 'Saint', 'Neuf',
      'Vieux', 'Haut', 'Bas', 'Clair', 'Bois', 'Aigle', 'Lac', 'Pierre',
    ],
    townSuffix: ['ville', 'mont', 'val', 'court', 'bourg', 'plage', 'rive', 'bois', 'ac'],
    townJoin: '',
    industryPrefix: [
      'Aciérie', 'Fonderie', 'Charbonnage', 'Port', 'Usine',
      'Entrepôt', 'Zone', 'Atelier', 'Mine',
    ],
    industrySuffix: [
      'du Nord', 'du Sud', "de l'Est", "de l'Ouest",
      'du Val', 'de la Rivière', 'Centrale',
    ],
    industryJoin: ' ',
    fallbackTown: 'Nouvelle Ville',
    fallbackIndustry: 'Nouvelle Usine',
  },
};

export function createNamer(
  culture: NameCulture,
  rng: Rng,
  taken?: Iterable<string>,
): (kind: 'town' | 'industry') => string {
  const names = CULTURE_NAMES[culture] ?? CULTURE_NAMES.chinese;
  const used = new Set<string>(taken ?? []);

  return (kind) => {
    const prefixes = kind === 'town' ? names.townPrefix : names.industryPrefix;
    const suffixes = kind === 'town' ? names.townSuffix : names.industrySuffix;
    const join = kind === 'town' ? names.townJoin : names.industryJoin;

    for (let attempt = 0; attempt < 80; attempt++) {
      const prefix = rng.pick(prefixes);
      const suffix = rng.pick(suffixes);
      if (join === '' && prefix.endsWith(suffix.charAt(0))) continue;
      const name = join === '' ? prefix + suffix : `${prefix}${join}${suffix}`;
      if (!used.has(name)) {
        used.add(name);
        return name;
      }
    }

    const base = kind === 'town' ? names.fallbackTown : names.fallbackIndustry;
    let index = used.size + 1;
    let fallback = `${base} ${index}`;
    while (used.has(fallback)) {
      index += 1;
      fallback = `${base} ${index}`;
    }
    used.add(fallback);
    return fallback;
  };
}
