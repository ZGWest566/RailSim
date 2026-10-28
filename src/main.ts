import Phaser from 'phaser';
import './style.css';
import { bus, type BuildTool } from './core/emitter';
import { hashSeed } from './core/rng';
import { hexKey } from './core/hex';
import type { Tile, World } from './game/world';
import { describeWorld, generateWorld } from './game/mapgen';
import { RailNetwork, type BuildResult } from './game/network';
import { RailOperations, type LineSavePayload } from './game/operations';
import {
  clearSave,
  loadSave,
  SAVE_VERSION,
  writeSave,
  type SaveGame,
} from './game/save';
import { MapScene } from './scenes/MapScene';
import { createHud, type Hud } from './ui/hud';
import type { StationType } from './game/stations';

const initialQuery = new URLSearchParams(window.location.search);
const seedFromUrl = parseSeed(initialQuery.get('seed'));
const initialSeed = seedFromUrl ?? randomSeed();
const tileFromUrl = parseTileParam(initialQuery.get('tile'));

class RailSimApp {
  private world: World;
  private network: RailNetwork;
  private operations: RailOperations;
  private readonly hud: Hud;
  private readonly game: Phaser.Game;
  private tileRestored = false;
  private activeTool: BuildTool = 'inspect';
  private activeStationType: StationType = 'light';
  private lineEditorActive = false;
  private simSpeed = 1;
  private restored = false;
  private saveTimer: number | null = null;

  constructor(fallbackSeed: number) {
    const saved = loadSave();
    const seed = saved && Number.isFinite(saved.seed) ? saved.seed : fallbackSeed;

    this.world = generateWorld({ seed });
    this.network = new RailNetwork(this.world);
    this.operations = new RailOperations(this.world, this.network);

    if (saved) {
      try {
        this.network.restore(saved.network);
        this.operations.restore(saved.operations);
        this.restored = true;
      } catch (error) {
        console.warn('[RailSim] 存档损坏，已开始新游戏', error);
        clearSave();
        this.network = new RailNetwork(this.world);
        this.operations = new RailOperations(this.world, this.network);
      }
    }

    this.hud = createHud({
      regenerate: (text) => this.regenerate(text),
      randomSeed: () => {
        const next = randomSeed();
        this.hud.setSeed(next);
        this.regenerate(String(next));
      },
      zoom: (factor) => this.scene()?.zoomBy(factor),
      fit: () => this.scene()?.fitToMap(),
      tool: (tool) => {
        this.activeTool = tool;
        this.scene()?.setTool(tool, this.activeStationType);
      },
      stationType: (type) => {
        this.activeStationType = type;
        this.scene()?.setStationType(type);
      },
      setSpeed: (speed) => {
        this.simSpeed = speed;
        this.scene()?.setSimSpeed(speed);
      },
      tileInfo: (tile) => this.network.tileInfo(tile, this.activeStationType),
      buildTrack: (tile) => this.applyResult(this.network.buildTrack(tile), tile),
      buildStation: (tile) =>
        this.applyResult(this.network.buildStation(tile, this.activeStationType), tile),
      remove: (tile) => this.applyResult(this.network.removeAt(tile), tile),
      startLineCreate: () => this.startLineCreate(),
      editLine: (id) => this.startLineEdit(id),
      deleteLine: (id) => this.deleteLine(id),
      saveLine: (input) => this.saveLine(input),
      cancelLineEditor: () => this.cancelLineEditor(),
      hoverLine: (id) => this.scene()?.setHoveredLine(id),
      purchaseTrain: (modelId) => this.purchaseTrain(modelId),
      purchaseTruck: () => this.purchaseTruck(),
      railView: () => this.operations.view(),
      assignTrain: (trainId, lineId) => this.assignTrain(trainId, lineId),
      unassignTrain: (trainId) => this.unassignTrain(trainId),
    });

    this.hud.setSeed(seed);
    this.hud.setNetworkStats(this.network.stats);
    this.hud.setRailView(this.operations.view());
    this.hud.setClock(this.operations.clockView(), this.network.credits);
    this.hud.setTool(this.activeTool);
    this.hud.setStationType(this.activeStationType);

    bus.on('world:ready', (world) => {
      this.world = world;
      this.hud.bindWorld(world);
      this.hud.setNetworkStats(this.network.stats);
      this.hud.setRailView(this.operations.view());
      if (!this.tileRestored) {
        this.tileRestored = true;
        this.scene()?.setTool(this.activeTool, this.activeStationType);
        if (tileFromUrl) this.scene()?.selectTileByAxial(tileFromUrl.q, tileFromUrl.r);
      }
      this.scene()?.setSimSpeed(this.simSpeed);
    });
    bus.on('tile:select', (tile) => {
      this.hud.showTile(tile);
      this.syncUrl(tile);
    });
    bus.on('tile:hover', (tile) => this.hud.hoverTile(tile));
    bus.on('camera:zoom', (zoom) => this.hud.setZoom(zoom));
    bus.on('sim:tick', (view) => this.hud.setClock(view, this.network.credits));
    bus.on('map:tooltip', (tooltip) => this.hud.showMapTooltip(tooltip));
    bus.on('line:pick', (tile) => this.pickLineStation(tile));
    bus.on('map:action', ({ tile, tool, neighbor }) => {
      if (tool === 'track') {
        this.applyResult(this.network.buildTrack(tile), tile);
      } else if (tool === 'station') {
        this.applyResult(this.network.buildStation(tile, this.activeStationType), tile);
      } else if (tool === 'demolish') {
        this.applyResult(this.network.removeAt(tile), tile);
      } else if (tool === 'segment') {
        if (!neighbor) {
          this.hud.toast('请点击两个相邻轨道节点之间的连接处。');
          return;
        }
        this.applyResult(this.network.toggleLink(tile, neighbor), tile);
      }
    });

    this.game = new Phaser.Game({
      type: Phaser.AUTO,
      parent: 'game',
      backgroundColor: '#0a141b',
      banner: false,
      scale: {
        mode: Phaser.Scale.RESIZE,
        width: '100%',
        height: '100%',
      },
      render: {
        antialias: true,
        roundPixels: false,
      },
      scene: [MapScene],
      callbacks: {
        preBoot: (game) => {
          game.registry.set('world', this.world);
          game.registry.set('network', this.network);
          game.registry.set('operations', this.operations);
        },
      },
    });

    this.game.registry.set('world', this.world);
    this.game.registry.set('network', this.network);
    this.game.registry.set('operations', this.operations);
    this.writeSeedToUrl(seed);

    if (this.restored) {
      const clock = this.operations.clockView();
      window.setTimeout(() => {
        this.hud.toast(`已恢复存档 · 第 ${clock.day} 日 ${clock.time}`);
      }, 700);
    }

    if (import.meta.env.DEV) {
      (window as unknown as Record<string, unknown>).__railsim = this;
    }

    this.startAutoSave();
    console.info('[RailSim]', describeWorld(this.world));
  }

  /* ------------------------------ 存档 ------------------------------ */

  private startAutoSave(): void {
    if (this.saveTimer !== null) return;
    this.saveTimer = window.setInterval(() => this.saveGame(), 2500);
    window.addEventListener('beforeunload', () => this.saveGame());
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) this.saveGame();
    });
  }

  private saveGame(): void {
    try {
      const save: SaveGame = {
        version: SAVE_VERSION,
        savedAt: Date.now(),
        seed: this.world.seed,
        network: this.network.serialize(),
        operations: this.operations.serialize(),
      };
      writeSave(save);
    } catch (error) {
      console.warn('[RailSim] 保存失败', error);
    }
  }

  private scene(): MapScene | null {
    if (!this.game?.scene) return null;
    const scene = this.game.scene.getScene('MapScene') as MapScene | null;
    return scene && scene.isReady() ? scene : null;
  }

  private applyResult(result: BuildResult, tile: Tile): void {
    if (!result.ok) {
      this.hud.toast(result.message);
      return;
    }

    // 轨道 / 车站 / 连接段变化会影响所有线路的 A* 路径
    this.operations.recomputeRoutes();

    this.scene()?.refreshNetwork();
    this.scene()?.refreshLines();
    this.hud.setNetworkStats(this.network.stats);
    this.hud.setRailView(this.operations.view());
    this.hud.showTile(tile);
    this.hud.toast(result.message);
    this.saveGame();
  }

  /* ------------------------------ 线路 ------------------------------ */

  private startLineCreate(): void {
    if (this.lineEditorActive) {
      this.hud.toast('请先保存或取消当前线路编辑。');
      return;
    }
    this.activeTool = 'inspect';
    this.hud.setTool('inspect');
    this.scene()?.setTool('inspect', this.activeStationType);
    this.lineEditorActive = true;
    this.scene()?.setLineEditor(true);
    this.scene()?.setHoveredLine(null);
    this.hud.openLineEditor(null, `${this.operations.lines.length + 1}号线`);
  }

  private startLineEdit(id: number): void {
    const line = this.operations.view().lines.find((item) => item.id === id);
    if (!line) {
      this.hud.toast('线路不存在');
      return;
    }
    if (this.lineEditorActive) {
      this.hud.toast('请先保存或取消当前线路编辑。');
      return;
    }
    this.activeTool = 'inspect';
    this.hud.setTool('inspect');
    this.scene()?.setTool('inspect', this.activeStationType);
    this.lineEditorActive = true;
    this.scene()?.setLineEditor(true);
    this.scene()?.setHoveredLine(null);
    this.hud.openLineEditor(line, line.name);
  }

  private pickLineStation(tile: Tile | null): void {
    if (!this.lineEditorActive) return;
    if (!tile) {
      this.hud.toast('请点击已建成的车站。');
      return;
    }
    const station = this.network.stationAt(tile);
    if (!station) {
      this.hud.toast('请点击已建成的车站。');
      return;
    }
    this.hud.addDraftStop({
      key: hexKey(tile.q, tile.r),
      name: station.name,
      q: tile.q,
      r: tile.r,
    });
  }

  private saveLine(input: LineSavePayload): void {
    const result =
      input.id === null
        ? this.operations.createLine(input)
        : this.operations.updateLine(input.id, input);

    if (!result.ok) {
      this.hud.toast(result.message);
      return;
    }

    this.lineEditorActive = false;
    this.scene()?.setLineEditor(false);
    this.scene()?.setHoveredLine(null);
    this.hud.closeLineEditor();
    this.hud.setRailView(this.operations.view());
    this.scene()?.refreshLines();
    this.hud.toast(result.message);
    this.saveGame();
  }

  private cancelLineEditor(): void {
    if (!this.lineEditorActive) return;
    this.lineEditorActive = false;
    this.scene()?.setLineEditor(false);
    this.scene()?.setHoveredLine(null);
    this.hud.closeLineEditor();
    this.hud.toast('已取消线路编辑。');
  }

  private deleteLine(id: number): void {
    const line = this.operations.lineById(id);
    if (!line) return;
    const result = this.operations.deleteLine(id);
    if (!result.ok) {
      this.hud.toast(result.message);
      return;
    }
    this.scene()?.setHoveredLine(null);
    this.scene()?.refreshLines();
    this.hud.setRailView(this.operations.view());
    this.hud.toast(result.message);
    this.saveGame();
  }

  /* ------------------------------ 车库 / 列车 ------------------------------ */

  private purchaseTrain(modelId: string): void {
    const result = this.operations.purchaseTrain(modelId);
    if (!result.ok) {
      this.hud.toast(result.message);
      return;
    }
    this.hud.setNetworkStats(this.network.stats);
    this.hud.setRailView(this.operations.view());
    this.hud.toast(result.message);
    this.saveGame();
  }

  private purchaseTruck(): void {
    const result = this.operations.purchaseTruck();
    if (!result.ok) {
      this.hud.toast(result.message);
      return;
    }
    this.hud.setNetworkStats(this.network.stats);
    this.hud.setRailView(this.operations.view());
    this.scene()?.refreshLines();
    this.hud.toast(result.message);
    this.saveGame();
  }

  private assignTrain(trainId: number, lineId: number): void {
    const result = this.operations.assignTrain(trainId, lineId);
    if (!result.ok) {
      this.hud.toast(result.message);
      return;
    }
    this.hud.setRailView(this.operations.view());
    this.scene()?.refreshLines();
    this.hud.toast(result.message);
    this.saveGame();
  }

  private unassignTrain(trainId: number): void {
    const result = this.operations.unassignTrain(trainId);
    if (!result.ok) {
      this.hud.toast(result.message);
      return;
    }
    this.hud.setRailView(this.operations.view());
    this.scene()?.refreshLines();
    this.hud.toast(result.message);
    this.saveGame();
  }

  /* ------------------------------ 世界重置 ------------------------------ */

  private regenerate(seedText: string): void {
    const seed = parseSeed(seedText);
    if (seed === null) {
      this.hud.toast('种子需要是数字或文本。');
      return;
    }

    if (this.lineEditorActive) {
      this.lineEditorActive = false;
      this.scene()?.setLineEditor(false);
      this.hud.closeLineEditor();
    }

    this.world = generateWorld({ seed });
    this.network = new RailNetwork(this.world);
    this.operations = new RailOperations(this.world, this.network);
    this.game.registry.set('world', this.world);
    this.game.registry.set('network', this.network);
    this.game.registry.set('operations', this.operations);

    const scene = this.scene();
    if (scene) {
      scene.setWorld(this.world, this.network, this.operations);
      scene.setTool(this.activeTool, this.activeStationType);
      scene.setLineEditor(false);
      scene.setHoveredLine(null);
    }

    this.hud.setSeed(seed);
    this.hud.setNetworkStats(this.network.stats);
    this.hud.setRailView(this.operations.view());
    this.hud.setClock(this.operations.clockView(), this.network.credits);
    this.hud.refreshSelected();
    this.writeSeedToUrl(seed);
    clearSave();
    this.saveGame();

    this.hud.toast(`已重新生成 · 种子 ${seed} · 存档已重置`);
    console.info('[RailSim]', describeWorld(this.world));
  }

  private writeSeedToUrl(seed: number): void {
    const url = new URL(window.location.href);
    url.searchParams.set('seed', String(seed));
    url.searchParams.delete('tile');
    window.history.replaceState(null, '', url);
  }

  private syncUrl(tile: { q: number; r: number } | null): void {
    const url = new URL(window.location.href);
    url.searchParams.set('seed', String(this.world.seed));
    if (tile) url.searchParams.set('tile', `${tile.q},${tile.r}`);
    else url.searchParams.delete('tile');
    window.history.replaceState(null, '', url);
  }
}

function parseSeed(text: string | null | undefined): number | null {
  if (text === null || text === undefined) return null;
  const trimmed = text.trim();
  if (trimmed.length === 0) return null;
  if (/^\d{1,10}$/.test(trimmed)) {
    const numeric = Number(trimmed);
    if (Number.isSafeInteger(numeric) && numeric >= 0 && numeric <= 0xffffffff) {
      return numeric >>> 0;
    }
  }
  return hashSeed(trimmed);
}

function randomSeed(): number {
  return 100000 + Math.floor(Math.random() * 900000);
}

function parseTileParam(text: string | null): { q: number; r: number } | null {
  if (!text) return null;
  const match = /^(-?\d+)\s*,\s*(-?\d+)$/.exec(text.trim());
  if (!match) return null;
  return { q: Number(match[1]), r: Number(match[2]) };
}

new RailSimApp(initialSeed);
