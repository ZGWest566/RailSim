import { generateWorld, describeWorld } from '../src/game/mapgen';
import { TERRAIN_DEFS, TERRAIN_LIST } from '../src/game/terrain';

for (const seed of [1, 42, 12345, 99999, 2026]) {
  const world = generateWorld({ seed });
  const share = TERRAIN_LIST.map(
    (d) => `${d.name} ${((world.stats.counts[d.id] / world.stats.total) * 100).toFixed(1)}%`,
  ).join('  ');
  console.log(describeWorld(world));
  console.log('  ' + share);
  console.log(
    '  blobs:',
    world.blobs.map((b) => `${b.kind}#${b.id}:${b.size}`).join(' '),
  );
  const riverTiles = world.list.filter((t) => t.river).length;
  console.log('  river tiles:', riverTiles, 'land ratio:', (world.stats.land / world.stats.total).toFixed(2));
}

// 海拔分布，确认山脉与海洋比例
const world = generateWorld({ seed: 2026 });
const elev = world.list.map((t) => t.elevation).sort((a, b) => a - b);
const pct = (p: number) => elev[Math.floor((elev.length - 1) * p)]!.toFixed(2);
console.log(`elevation p10=${pct(0.1)} p50=${pct(0.5)} p90=${pct(0.9)} p97=${pct(0.97)} max=${elev[elev.length - 1]!.toFixed(2)}`);

// 确保所有地形都出现过
const missing = TERRAIN_LIST.filter((d) => world.stats.counts[d.id] === 0);
console.log('missing terrains:', missing.map((t) => TERRAIN_DEFS[t.id].name));
