import Phaser from 'phaser';
import './style.css';
import { bus, type BuildTool } from './core/emitter';
import { hashSeed } from './core/rng';
import { axialRound, hexDistance, hexKey } from './core/hex';
import type { RegionCoord, Tile, World } from './game/world';
import {
  addRegion,
  describeWorld,
  expansionCandidates,
  generateWorld,
} from './game/mapgen';
import { expansionCost } from './game/economy';
import { buildAiState, type AiAction, type AiActionResult } from './game/ai';
import { DEFAULT_NAME_CULTURE, isNameCulture, type NameCulture } from './game/names';
import { RailNetwork, type BuildResult } from './game/network';
import {
  RailOperations,
  type LineInput,
  type LineSavePayload,
  type LineStop,
} from './game/operations';
import {
  clearSave,
  loadSave,
  SAVE_VERSION,
  writeSave,
  type SaveGame,
} from './game/save';
import { MapScene } from './scenes/MapScene';
import { createHud, type Hud, type StartSettings } from './ui/hud';
import { createAiPanel, type AiPanel } from './ui/aiPanel';
import { STATION_TYPE_LIST, type StationType } from './game/stations';
import type { TrackKind } from './game/tracks';

const initialQuery = new URLSearchParams(window.location.search);
const seedFromUrl = parseSeed(initialQuery.get('seed'));
const initialSeed = seedFromUrl ?? randomSeed();
const tileFromUrl = parseTileParam(initialQuery.get('tile'));

class RailSimApp {
  private world: World;
  private network: RailNetwork;
  private operations: RailOperations;
  private readonly hud: Hud;
  private aiPanel!: AiPanel;
  private readonly game: Phaser.Game;
  private tileRestored = false;
  private activeTool: BuildTool = 'inspect';
  private activeStationType: StationType = 'light';
  private activeTrackKind: TrackKind = 'normal';
  private lineEditorActive = false;
  private simSpeed = 1;
  private restored = false;
  private saveTimer: number | null = null;
  private mapCulture: NameCulture = DEFAULT_NAME_CULTURE;
  private elevationOffset = 0;
  private moistureOffset = 0;
  private startScreenOpen = false;
  /** 地图上已选中、等待确认的开拓区域。 */
  private pendingExpansion: RegionCoord | null = null;
  private expansionSelecting = false;

  /** 已开拓区域数量（不含初始地图）。 */
  private get expansions(): number {
    return Math.max(0, this.world.regions.length - 1);
  }

  constructor(fallbackSeed: number) {
    const saved = loadSave();
    const seed = saved && Number.isFinite(saved.seed) ? saved.seed : fallbackSeed;
    const savedMap = saved?.map;
    this.mapCulture = isNameCulture(savedMap?.culture)
      ? savedMap.culture
      : DEFAULT_NAME_CULTURE;
    this.elevationOffset = clampMapOffset(savedMap?.elevationOffset);
    this.moistureOffset = clampMapOffset(savedMap?.moistureOffset);

    this.world = generateWorld(this.worldOptions(seed, savedMap?.regions));
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
      zoom: (factor) => this.scene()?.zoomBy(factor),
      fit: () => this.scene()?.fitToMap(),
      tool: (tool) => {
        if (this.expansionSelecting) this.exitExpansionSelection();
        this.activeTool = tool;
        this.scene()?.setTool(tool, this.activeStationType);
      },
      stationType: (type) => {
        this.activeStationType = type;
        this.scene()?.setStationType(type);
      },
      trackKind: (kind) => {
        this.activeTrackKind = kind;
        this.scene()?.setTrackKind(kind);
      },
      setSpeed: (speed) => {
        this.simSpeed = speed;
        this.scene()?.setSimSpeed(speed);
      },
      tileInfo: (tile) =>
        this.network.tileInfo(tile, this.activeStationType, this.activeTrackKind),
      stationNetworkBonus: (stationId) => this.operations.networkBonusForStation(stationId),
      buildTrack: (tile) =>
        this.applyResult(this.network.buildTrack(tile, this.activeTrackKind), tile),
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
      startNewGame: (settings) => this.startNewGame(settings),
      continueGame: () => this.continueFromStart(),
      toggleAi: () => this.aiPanel.toggle(),
      expansionInfo: () => ({
        expansions: this.expansions,
        regions: this.world.regions.length,
        tiles: this.world.stats.total,
        cost: expansionCost(this.expansions),
      }),
      startExpansionSelection: () => this.startExpansionSelection(),
      confirmExpansion: () => this.confirmExpansion(),
      cancelExpansionPick: () => this.cancelExpansionPick(),
      exitExpansionSelection: () => this.exitExpansionSelection(),
    });

    this.aiPanel = createAiPanel({
      getState: () =>
        buildAiState(this.world, this.network, this.operations, this.simSpeed),
      executeActions: (actions) => this.executeAiActions(actions),
      canAct: () =>
        !this.startScreenOpen &&
        !this.lineEditorActive &&
        !this.expansionSelecting &&
        !this.hud.isTutorialOpen(),
    });

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
      this.scene()?.setSimSpeed(this.startScreenOpen ? 0 : this.simSpeed);
    });
    bus.on('tile:select', (tile) => {
      this.hud.showTile(tile);
      this.syncUrl(tile);
    });
    bus.on('tile:hover', (tile) => this.hud.hoverTile(tile));
    bus.on('camera:zoom', (zoom) => this.hud.setZoom(zoom));
    bus.on('sim:tick', (view) => this.hud.setClock(view, this.network.credits));
    bus.on('map:tooltip', (tooltip) => this.hud.showMapTooltip(tooltip));
    bus.on('expand:pick', (region) => this.pickExpansionRegion(region));
    bus.on('line:pick', (tile) => this.pickLineStation(tile));
    bus.on('map:action', ({ tile, tool, neighbor }) => {
      if (tool === 'track') {
        this.applyResult(this.network.buildTrack(tile, this.activeTrackKind), tile);
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

    this.startScreenOpen = true;
    this.hud.openStartScreen({
      seedText: String(seed),
      culture: this.mapCulture,
      elevationOffset: this.elevationOffset,
      moistureOffset: this.moistureOffset,
      hasSave: this.restored,
    });
    this.scene()?.setSimSpeed(0);

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
    if (this.startScreenOpen) return;
    try {
      const save: SaveGame = {
        version: SAVE_VERSION,
        savedAt: Date.now(),
        seed: this.world.seed,
        map: {
          regions: this.world.regions.map((region) => ({ q: region.q, r: region.r })),
          elevationOffset: this.elevationOffset,
          moistureOffset: this.moistureOffset,
          culture: this.mapCulture,
        },
        network: this.network.serialize(),
        operations: this.operations.serialize(),
      };
      writeSave(save);
    } catch (error) {
      console.warn('[RailSim] 保存失败', error);
    }
  }

  private worldOptions(seed: number, regions?: RegionCoord[]) {
    return {
      seed,
      regions: regions ?? [{ q: 0, r: 0 }],
      elevationOffset: this.elevationOffset,
      moistureOffset: this.moistureOffset,
      culture: this.mapCulture,
    };
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
    if (station.type === 'freight') {
      this.hud.toast('货运站不能加入客运线路。');
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

  private startNewGame(settings: StartSettings): void {
    const seed = parseSeed(settings.seedText) ?? randomSeed();
    this.mapCulture = settings.culture;
    this.elevationOffset = clampMapOffset(settings.elevationOffset);
    this.moistureOffset = clampMapOffset(settings.moistureOffset);
    this.startScreenOpen = false;
    this.simSpeed = 1;
    this.regenerate(String(seed));
    this.scene()?.setSimSpeed(1);
    this.hud.openTutorial();
  }

  private continueFromStart(): void {
    this.startScreenOpen = false;
    this.simSpeed = 1;
    this.scene()?.setSimSpeed(1);
    if (this.restored) this.hud.toast('已继续上次存档');
  }

  /** 进入地图开拓选区，显示可开拓的黄色六边形。 */
  private startExpansionSelection(): void {
    if (this.lineEditorActive) {
      this.lineEditorActive = false;
      this.scene()?.setLineEditor(false);
      this.hud.closeLineEditor();
    }

    this.pendingExpansion = null;
    this.expansionSelecting = true;
    this.scene()?.setExpansionSelection(true);
    this.hud.setExpansionSelecting(true);
    this.hud.toast('点击黄色六边形选择新区域');
  }

  /** 在地图上选中一块区域后，打开确认窗口。 */
  private pickExpansionRegion(region: RegionCoord): void {
    this.pendingExpansion = region;
    this.hud.setExpansionSelecting(false);
    this.hud.openExpandConfirm();
  }

  /** 关闭确认窗口，回到地图选区继续选择。 */
  private cancelExpansionPick(): void {
    this.pendingExpansion = null;
    if (this.scene()) this.hud.setExpansionSelecting(true);
  }

  private exitExpansionSelection(): void {
    this.pendingExpansion = null;
    this.expansionSelecting = false;
    this.scene()?.setExpansionSelection(false);
    this.hud.setExpansionSelecting(false);
  }

  /** 确认开拓所选区域并扣除费用。 */
  private confirmExpansion(): void {
    const region = this.pendingExpansion;
    if (!region) return;

    const cost = expansionCost(this.expansions);
    if (this.network.credits < cost) {
      this.hud.toast(`资金不足：开拓需要 ${cost.toLocaleString('en-US')} 元`);
      return;
    }

    this.network.credits -= cost;
    const added = addRegion(this.world, region, {
      elevationOffset: this.elevationOffset,
      moistureOffset: this.moistureOffset,
      culture: this.mapCulture,
    });
    if (!added) {
      this.network.credits += cost;
      this.pendingExpansion = null;
      this.hud.toast('这个位置暂时无法开拓。');
      this.hud.setExpansionSelecting(true);
      return;
    }

    this.pendingExpansion = null;
    this.expansionSelecting = false;
    this.operations.refreshWorld();

    const scene = this.scene();
    if (scene) {
      scene.expandRegion(region);
      scene.setExpansionSelection(false);
    } else {
      this.hud.bindWorld(this.world);
      this.hud.setNetworkStats(this.network.stats);
      this.hud.setRailView(this.operations.view());
    }
    this.hud.setExpansionSelecting(false);
    this.hud.setClock(this.operations.clockView(), this.network.credits);
    this.hud.refreshSelected();
    this.hud.toast(
      `新区域已开拓 · 共 ${this.world.regions.length} 块 · 下次开拓 ¥${expansionCost(this.expansions).toLocaleString('en-US')}`,
    );
    this.saveGame();
  }

  /* ------------------------------ AI 动作执行 ------------------------------ */

  /**
   * 执行 AI 返回的结构化动作。
   * 动作只在主程序中执行，AI 不会直接访问 DOM、存档或任意 JavaScript。
   */
  private executeAiActions(actions: AiAction[]): AiActionResult[] {
    const results: AiActionResult[] = [];
    let networkChanged = false;
    let linesChanged = false;
    let fleetChanged = false;
    let lastExpansion: RegionCoord | null = null;

    if (this.expansionSelecting) this.exitExpansionSelection();
    if (this.lineEditorActive) this.cancelLineEditor();

    const push = (action: AiAction, ok: boolean, message: string): void => {
      results.push({ action, ok, message });
    };

    for (const action of actions.slice(0, 20)) {
      if (!action || typeof action !== 'object' || typeof action.type !== 'string') {
        continue;
      }

      switch (action.type) {
        case 'build_track': {
          const tile = this.aiTile(action.q, action.r);
          if (!tile) {
            push(action, false, `地块 (${action.q},${action.r}) 不存在`);
            break;
          }
          const kind: TrackKind = action.kind === 'highspeed' ? 'highspeed' : 'normal';
          const result = this.network.buildTrack(tile, kind);
          if (result.ok) networkChanged = true;
          push(action, result.ok, result.message);
          break;
        }

        case 'build_station': {
          const tile = this.aiTile(action.q, action.r);
          if (!tile) {
            push(action, false, `地块 (${action.q},${action.r}) 不存在`);
            break;
          }
          if (
            action.station &&
            !STATION_TYPE_LIST.some((def) => def.type === action.station)
          ) {
            push(action, false, `未知车站类型：${String(action.station)}`);
            break;
          }
          const type: StationType = action.station ?? 'small';
          const result = this.network.buildStation(tile, type);
          if (result.ok) networkChanged = true;
          push(action, result.ok, result.message);
          break;
        }

        case 'remove': {
          const tile = this.aiTile(action.q, action.r);
          if (!tile) {
            push(action, false, `地块 (${action.q},${action.r}) 不存在`);
            break;
          }
          const result = this.network.removeAt(tile);
          if (result.ok) networkChanged = true;
          push(action, result.ok, result.message);
          break;
        }

        case 'connect': {
          const from = this.aiTile(action.from?.q, action.from?.r);
          const to = this.aiTile(action.to?.q, action.to?.r);
          if (!from || !to) {
            push(action, false, '轨道起点或终点不存在');
            break;
          }
          const waypoints: { q: number; r: number }[] = Array.isArray(action.via)
            ? action.via
            : [];
          const points: Tile[] = [from];
          let invalidWaypoint = false;
          for (const point of waypoints) {
            const tile = this.aiTile(point?.q, point?.r);
            if (!tile) {
              invalidWaypoint = true;
              break;
            }
            points.push(tile);
          }
          if (invalidWaypoint) {
            push(action, false, 'connect 的 via 途经点不存在');
            break;
          }
          points.push(to);

          const path: Tile[] = [];
          const seen = new Set<string>();
          for (let i = 1; i < points.length; i++) {
            for (const tile of this.aiHexPath(points[i - 1]!, points[i]!)) {
              const key = hexKey(tile.q, tile.r);
              if (seen.has(key)) continue;
              seen.add(key);
              path.push(tile);
            }
          }
          if (path.length === 0) {
            push(action, false, '无法生成轨道路径');
            break;
          }
          const kind: TrackKind = action.kind === 'highspeed' ? 'highspeed' : 'normal';
          let built = 0;
          let skipped = 0;
          let error = '';
          for (const tile of path) {
            if (this.network.trackAt(tile)) {
              skipped += 1;
              continue;
            }
            const result = this.network.buildTrack(tile, kind);
            if (!result.ok) {
              error = result.message;
              break;
            }
            built += 1;
          }
          if (built > 0) networkChanged = true;
          if (built === 0 && skipped === 0) {
            push(action, false, error || '铺轨失败');
          } else {
            const kindName = kind === 'highspeed' ? '高速铁路' : '普通铁路';
            push(
              action,
              true,
              `连接 ${from.q},${from.r} → ${to.q},${to.r}${waypoints.length ? `（经 ${waypoints.length} 个途经点）` : ''} · ${kindName}：新铺 ${built} 格，跳过 ${skipped} 格${error ? `，中断：${error}` : ''}`,
            );
          }
          break;
        }

        case 'create_line': {
          const stops = this.aiLineStops(action.stops);
          if (typeof stops === 'string') {
            push(action, false, stops);
            break;
          }
          const color = this.aiLineColor(action.color);
          const input: LineInput = {
            name: action.name?.trim() || `AI 线路 ${this.operations.lines.length + 1}`,
            color: color.color,
            colorCss: color.colorCss,
            isLoop: Boolean(action.isLoop),
            evenHeadway: Boolean(action.evenHeadway),
            stops,
          };
          const result = this.operations.createLine(input);
          if (result.ok) {
            linesChanged = true;
            const created = this.operations.lines[this.operations.lines.length - 1];
            push(action, true, `${result.message}${created ? ` · #${created.id}` : ''}`);
          } else {
            push(action, false, result.message);
          }
          break;
        }

        case 'update_line': {
          const line = this.operations.lineById(action.lineId);
          if (!line) {
            push(action, false, `线路 #${action.lineId} 不存在`);
            break;
          }
          const stops = action.stops
            ? this.aiLineStops(action.stops)
            : line.stops.map((stop) => ({ ...stop }));
          if (typeof stops === 'string') {
            push(action, false, stops);
            break;
          }
          const color = action.color
            ? this.aiLineColor(action.color)
            : { color: line.color, colorCss: line.colorCss };
          const input: LineInput = {
            name: action.name?.trim() || line.name,
            color: color.color,
            colorCss: color.colorCss,
            isLoop: action.isLoop ?? line.isLoop,
            evenHeadway: action.evenHeadway ?? line.evenHeadway,
            stops,
          };
          const result = this.operations.updateLine(line.id, input);
          if (result.ok) linesChanged = true;
          push(action, result.ok, result.message);
          break;
        }

        case 'delete_line': {
          const result = this.operations.deleteLine(action.lineId);
          if (result.ok) linesChanged = true;
          push(action, result.ok, result.message);
          break;
        }

        case 'purchase_train': {
          const result = this.operations.purchaseTrain(action.model);
          if (!result.ok) {
            push(action, false, result.message);
            break;
          }
          fleetChanged = true;
          let message = result.message;
          if (Number.isFinite(action.lineId)) {
            const newest = this.operations.trains[this.operations.trains.length - 1];
            if (newest) {
              const assigned = this.operations.assignTrain(newest.id, action.lineId!);
              message += `；${assigned.message}`;
            }
          }
          push(action, true, message);
          break;
        }

        case 'assign_train': {
          const result = this.operations.assignTrain(action.trainId, action.lineId);
          if (result.ok) fleetChanged = true;
          push(action, result.ok, result.message);
          break;
        }

        case 'unassign_train': {
          const result = this.operations.unassignTrain(action.trainId);
          if (result.ok) fleetChanged = true;
          push(action, result.ok, result.message);
          break;
        }

        case 'purchase_truck': {
          const result = this.operations.purchaseTruck();
          if (result.ok) fleetChanged = true;
          push(action, result.ok, result.message);
          break;
        }

        case 'expand_region': {
          const region = {
            q: Math.round(action.q),
            r: Math.round(action.r),
          };
          if (!Number.isFinite(action.q) || !Number.isFinite(action.r)) {
            push(action, false, '开拓坐标无效');
            break;
          }
          const available = expansionCandidates(this.world).some(
            (item) => item.q === region.q && item.r === region.r,
          );
          if (!available) {
            push(action, false, '该区域当前不可开拓');
            break;
          }
          const cost = expansionCost(this.world.regions.length - 1);
          if (this.network.credits < cost) {
            push(action, false, `资金不足，需要 ¥${cost.toLocaleString('en-US')}`);
            break;
          }
          this.network.credits -= cost;
          const added = addRegion(this.world, region, {
            elevationOffset: this.elevationOffset,
            moistureOffset: this.moistureOffset,
            culture: this.mapCulture,
          });
          if (!added) {
            this.network.credits += cost;
            push(action, false, '区域生成失败');
            break;
          }
          this.operations.refreshWorld();
          lastExpansion = region;
          push(
            action,
            true,
            `开拓区域 (${region.q},${region.r}) · 花费 ¥${cost.toLocaleString('en-US')}`,
          );
          break;
        }

        case 'set_speed': {
          const speed = action.speed === 0 ? 0 : action.speed === 2 ? 2 : 1;
          this.simSpeed = speed;
          this.scene()?.setSimSpeed(speed);
          this.hud.setSpeedDisplay(speed);
          push(
            action,
            true,
            speed === 0 ? '游戏已暂停' : `游戏速度设为 ${speed}×`,
          );
          break;
        }

        default: {
          const unknown = action as { type?: string };
          push(action, false, `未知动作：${unknown.type ?? '?'}`);
          break;
        }
      }
    }

    if (networkChanged || linesChanged || fleetChanged) {
      this.operations.recomputeRoutes();
    }

    const scene = this.scene();
    if (lastExpansion) {
      if (scene) scene.expandRegion(lastExpansion);
      else this.hud.bindWorld(this.world);
    }
    if (networkChanged) scene?.refreshNetwork();
    if (linesChanged || fleetChanged) scene?.refreshLines();

    this.hud.setNetworkStats(this.network.stats);
    this.hud.setRailView(this.operations.view());
    this.hud.setClock(this.operations.clockView(), this.network.credits);
    this.hud.refreshSelected();
    if (results.some((result) => result.ok)) this.saveGame();
    return results;
  }

  private aiTile(q: unknown, r: unknown): Tile | null {
    if (typeof q !== 'number' || typeof r !== 'number') return null;
    if (!Number.isFinite(q) || !Number.isFinite(r)) return null;
    return this.world.get(Math.round(q), Math.round(r)) ?? null;
  }

  private aiLineStops(
    stops: { q: number; r: number }[] | undefined,
  ): LineStop[] | string {
    if (!Array.isArray(stops) || stops.length < 2) {
      return '线路至少需要 2 个车站';
    }
    const result: LineStop[] = [];
    const used = new Set<string>();
    for (const stop of stops) {
      const tile = this.aiTile(stop?.q, stop?.r);
      if (!tile) return `车站地块 (${stop?.q},${stop?.r}) 不存在`;
      const station = this.network.stationAt(tile);
      if (!station) return `地块 (${tile.q},${tile.r}) 没有车站`;
      if (station.type === 'freight') return `货运站不能作为客运线路停靠站`;
      const key = hexKey(station.q, station.r);
      if (used.has(key)) return `停靠站重复：${station.name}`;
      used.add(key);
      result.push({
        key,
        name: station.name,
        q: station.q,
        r: station.r,
      });
    }
    return result;
  }

  private aiLineColor(css?: string): { color: number; colorCss: string } {
    const palette = [
      '#e9b968',
      '#6cc4d5',
      '#7f9cf5',
      '#8fe0b0',
      '#e8955f',
      '#c792ea',
    ];
    const fallback = palette[this.operations.lines.length % palette.length]!;
    const colorCss =
      typeof css === 'string' && /^#[0-9a-f]{6}$/i.test(css) ? css : fallback;
    return {
      color: Number.parseInt(colorCss.slice(1), 16),
      colorCss,
    };
  }

  private aiHexPath(from: Tile, to: Tile): Tile[] {
    const steps = Math.max(1, hexDistance(from, to));
    const path: Tile[] = [];
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const rounded = axialRound(
        from.q + (to.q - from.q) * t,
        from.r + (to.r - from.r) * t,
      );
      const tile = this.world.get(rounded.q, rounded.r);
      if (tile) path.push(tile);
    }
    return path;
  }

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
    this.pendingExpansion = null;
    this.expansionSelecting = false;
    this.hud.setExpansionSelecting(false);

    this.world = generateWorld(this.worldOptions(seed));
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

    this.hud.bindWorld(this.world);
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

function clampMapOffset(value: number | undefined): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(-0.2, Math.min(0.2, value as number));
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
