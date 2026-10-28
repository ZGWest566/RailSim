import Phaser from 'phaser';
import { CAMERA_MAX_ZOOM, CAMERA_MIN_ZOOM, HEX_SIZE, SEA_LEVEL } from '../config';
import { bus, type BuildTool } from '../core/emitter';
import {
  clamp,
  clamp01,
  HEX_DIRECTIONS,
  hexCorners,
  hexKey,
  pixelToAxial,
  SQRT3,
  type Axial,
} from '../core/hex';
import { RailNetwork } from '../game/network';
import { RailOperations, PASSENGER_KIND_DEFS, type Line, type Train } from '../game/operations';
import type { Truck } from '../game/cargo';
import { STATION_DEFS, type StationDef, type StationType } from '../game/stations';
import { TERRAIN_DEFS, Terrain } from '../game/terrain';
import type { MapBlob, Tile, World } from '../game/world';

interface PointerDownState {
  x: number;
  y: number;
  scrollX: number;
  scrollY: number;
  button: number;
}

interface BlobLabel {
  text: Phaser.GameObjects.Text;
  blob: MapBlob;
}

const COLORS = {
  backdrop: 0x0b1a24,
  ocean: 0x0d2230,
  coast: 0xa5d8e2,
  grid: 0x0b141a,
  hover: 0xffffff,
  select: 0xe9b968,
  townBorder: 0xe4c288,
  industryBorder: 0x9db3c5,
  townLabel: '#f6e3bd',
  industryLabel: '#c3d2de',
};

/**
 * 地图场景：只负责“看”和“指”。
 * 地形绘制、相机平移/缩放、命中检测、悬停与选中高亮都在这里。
 */
export class MapScene extends Phaser.Scene {
  private world!: World;
  private network!: RailNetwork;
  private operations!: RailOperations;

  private terrainGfx!: Phaser.GameObjects.Graphics;
  private coastGfx!: Phaser.GameObjects.Graphics;
  private detailGfx!: Phaser.GameObjects.Graphics;
  private coverageGfx!: Phaser.GameObjects.Graphics;
  private routeGfx!: Phaser.GameObjects.Graphics;
  private trackGfx!: Phaser.GameObjects.Graphics;
  private stationGfx!: Phaser.GameObjects.Graphics;
  private stationDotsGfx!: Phaser.GameObjects.Graphics;
  private trainGfx!: Phaser.GameObjects.Graphics;
  private truckGfx!: Phaser.GameObjects.Graphics;
  private hoverGfx!: Phaser.GameObjects.Graphics;
  private selectGfx!: Phaser.GameObjects.Graphics;

  private readonly corners = hexCorners(HEX_SIZE);
  private labels: BlobLabel[] = [];
  private stationCountLabels = new Map<string, Phaser.GameObjects.Text>();
  private incomeFloats = new Set<Phaser.GameObjects.Text>();
  private appliedZoom = -1;
  private lastCoverageSignature = '';

  private selected: Axial | null = null;
  private hovered: Axial | null = null;
  /** 当前指针的世界坐标，用于「路段」工具判断要剪接哪条边。 */
  private hoverWorld: { x: number; y: number } | null = null;
  private activeTool: BuildTool = 'inspect';
  private activeStationType: StationType = 'light';
  private hoveredLineId: number | null = null;
  private lineEditorActive = false;
  private simSpeed = 1;
  private hoverTarget:
    | { kind: 'station'; tile: Tile }
    | { kind: 'train'; train: Train }
    | { kind: 'truck'; truck: Truck }
    | null = null;
  private hoverClient = { x: 0, y: 0 };
  private simTickAccum = 0;

  private pointerDown: PointerDownState | null = null;
  private dragDistance = 0;
  private userAdjusted = false;

  private panKeys: {
    W: Phaser.Input.Keyboard.Key;
    A: Phaser.Input.Keyboard.Key;
    S: Phaser.Input.Keyboard.Key;
    D: Phaser.Input.Keyboard.Key;
    UP: Phaser.Input.Keyboard.Key;
    LEFT: Phaser.Input.Keyboard.Key;
    DOWN: Phaser.Input.Keyboard.Key;
    RIGHT: Phaser.Input.Keyboard.Key;
  } | null = null;

  constructor() {
    super('MapScene');
  }

  isReady(): boolean {
    return Boolean(this.terrainGfx);
  }

  create(): void {
    this.cameras.main.setBackgroundColor(COLORS.backdrop);

    this.terrainGfx = this.add.graphics().setDepth(1);
    this.coastGfx = this.add.graphics().setDepth(2);
    this.detailGfx = this.add.graphics().setDepth(3);
    this.coverageGfx = this.add.graphics().setDepth(4);
    this.routeGfx = this.add.graphics().setDepth(6.5);
    this.trackGfx = this.add.graphics().setDepth(6);
    this.trainGfx = this.add.graphics().setDepth(6.8);
    this.truckGfx = this.add.graphics().setDepth(6.9);
    this.stationGfx = this.add.graphics().setDepth(7);
    this.stationDotsGfx = this.add.graphics().setDepth(7.2);
    this.hoverGfx = this.add.graphics().setDepth(9);
    this.selectGfx = this.add.graphics().setDepth(10);

    this.world = this.registry.get('world') as World;
    this.network =
      (this.registry.get('network') as RailNetwork | undefined) ?? new RailNetwork(this.world);
    this.operations =
      (this.registry.get('operations') as RailOperations | undefined) ??
      new RailOperations(this.world, this.network);
    this.buildWorld(this.world, false);

    this.setupInput();
    this.game.canvas.addEventListener('contextmenu', (event) => event.preventDefault());
    this.scale.on('resize', this.handleResize, this);

    if (import.meta.env.DEV) {
      (window as unknown as Record<string, unknown>).__mapScene = this;
    }

    // 布局完成后再校准一次，避免侧边栏宽度尚未生效导致地图偏移
    this.time.delayedCall(60, () => {
      if (!this.userAdjusted) this.fitToMap();
    });
  }

  /** 由 App 在生成新地图后调用，保持相机与交互对象复用的同时重绘整张图。 */
  setWorld(world: World, network: RailNetwork, operations: RailOperations): void {
    this.network = network;
    this.operations = operations;
    this.buildWorld(world, true);
    this.emitZoom();
  }

  /** 切换建造工具；App 是唯一的状态源。 */
  setTool(tool: BuildTool, stationType: StationType): void {
    this.activeTool = tool;
    this.activeStationType = stationType;
    this.updateCursor();
    this.lastCoverageSignature = '';
    this.drawNetworkLayers();
    this.paintOverlays();
  }

  setStationType(type: StationType): void {
    this.activeStationType = type;
    this.lastCoverageSignature = '';
    this.drawNetworkLayers();
    this.paintOverlays();
  }

  /** 网络发生变化后重绘轨道、车站、覆盖、线路高亮与列车。 */
  refreshNetwork(): void {
    this.lastCoverageSignature = '';
    this.drawNetworkLayers();
    this.paintOverlays();
    this.drawRouteHighlight();
    this.drawTrains();
    this.drawTrucks();
    if (this.hoverTarget) this.emitHoverInfo();
  }

  /** 线路 / 列车数据变化后刷新线路高亮和列车层。 */
  refreshLines(): void {
    this.drawRouteHighlight();
    this.drawTrains();
    this.drawTrucks();
    this.drawStationPassengers();
    if (this.hoverTarget) this.emitHoverInfo();
  }

  setHoveredLine(lineId: number | null): void {
    if (this.hoveredLineId === lineId) return;
    this.hoveredLineId = lineId;
    this.drawRouteHighlight();
  }

  /** 时间倍率：0 暂停，1 正常，2 加速。只影响列车动画。 */
  setSimSpeed(speed: number): void {
    this.simSpeed = Math.max(0, speed);
  }

  /* ------------------------------ 悬停信息 ------------------------------ */

  /** 返回鼠标世界坐标下的列车（用车厢方块做命中）。 */
  private trainAtPointer(worldPoint: { x: number; y: number }): Train | null {
    if (!this.operations) return null;
    const zoom = Math.max(this.cameras.main.zoom, 0.1);
    const metrics = this.trainCarMetrics(zoom);
    const reach = metrics.length * 0.62 + 3 / zoom;

    for (const line of this.operations.lines) {
      if (line.status !== 'OK' || line.length <= 0) continue;
      for (const trainId of line.trainIds) {
        const train = this.operations.trainById(trainId);
        if (!train) continue;
        for (const car of this.trainCarSamples(train, line, metrics)) {
          if (Math.hypot(worldPoint.x - car.x, worldPoint.y - car.y) <= reach) return train;
        }
      }
    }
    return null;
  }

  /** 返回鼠标世界坐标下的货运列车（单节灰色车厢，沿铁轨移动）。 */
  private truckAtPointer(worldPoint: { x: number; y: number }): Truck | null {
    if (!this.operations) return null;
    const zoom = Math.max(this.cameras.main.zoom, 0.1);
    const length = clamp(26 / zoom, 12, 42);
    const width = clamp(14 / zoom, 7, 24);
    const reach = Math.max(length, width) * 0.62;

    for (const truck of this.operations.trucks) {
      if (truck.state === 'hidden') continue;
      if (Math.hypot(worldPoint.x - truck.x, worldPoint.y - truck.y) <= reach) return truck;
    }
    return null;
  }

  /** 根据指针位置选择车站 / 列车 / 货运列车，并交给 HUD 显示浮层。 */
  private updateHoverInfo(pointer: Phaser.Input.Pointer): void {
    if (this.lineEditorActive) {
      this.clearHoverInfo();
      return;
    }

    const zoom = Math.max(this.cameras.main.zoom, 0.1);
    const worldPoint = this.cameras.main.getWorldPoint(pointer.x, pointer.y);
    const tile = this.tileAtScreen(pointer.x, pointer.y);
    const station = tile ? this.network.stationAt(tile) : null;
    const iconRadius = this.stationIconRadius(zoom);
    const nearStation =
      station && tile ? Math.hypot(worldPoint.x - tile.x, worldPoint.y - tile.y) < iconRadius : false;
    const truck = this.truckAtPointer(worldPoint);
    const train = this.trainAtPointer(worldPoint);

    let target:
      | { kind: 'station'; tile: Tile }
      | { kind: 'train'; train: Train }
      | { kind: 'truck'; truck: Truck }
      | null = null;
    if (station && tile && (nearStation || (!train && !truck))) target = { kind: 'station', tile };
    else if (truck) target = { kind: 'truck', truck };
    else if (train) target = { kind: 'train', train };
    else if (station && tile) target = { kind: 'station', tile };

    this.hoverTarget = target;
    if (!target) {
      bus.emit('map:tooltip', null);
      return;
    }

    const native = pointer.event as MouseEvent | undefined;
    this.hoverClient = {
      x: typeof native?.clientX === 'number' ? native.clientX : pointer.x,
      y: typeof native?.clientY === 'number' ? native.clientY : pointer.y,
    };
    this.emitHoverInfo();
  }

  /** 重新读取当前悬停目标的实时客流数据（供时间 Tick 刷新）。 */
  private emitHoverInfo(): void {
    const target = this.hoverTarget;
    if (!target) {
      bus.emit('map:tooltip', null);
      return;
    }
    const { x, y } = this.hoverClient;

    if (target.kind === 'station') {
      const info = this.operations.stationInfo(target.tile);
      if (!info) {
        this.clearHoverInfo();
        return;
      }
      bus.emit('map:tooltip', { kind: 'station', x, y, station: info });
      return;
    }

    if (target.kind === 'truck') {
      if (target.truck.state === 'hidden') {
        this.clearHoverInfo();
        return;
      }
      bus.emit('map:tooltip', {
        kind: 'truck',
        x,
        y,
        truck: this.operations.truckInfo(target.truck),
      });
      return;
    }

    const info = this.operations.trainInfo(target.train);
    bus.emit('map:tooltip', { kind: 'train', x, y, train: info });
  }

  private clearHoverInfo(): void {
    if (!this.hoverTarget) return;
    this.hoverTarget = null;
    bus.emit('map:tooltip', null);
  }

  /** 进入 / 退出线路编辑：在地图上给所有车站加一圈可选标记。 */
  setLineEditor(active: boolean): void {
    if (this.lineEditorActive === active) return;
    this.lineEditorActive = active;
    if (active) this.clearHoverInfo();
    this.updateCursor();
    this.lastCoverageSignature = '';
    this.drawNetworkLayers();
    this.paintOverlays();
    this.drawRouteHighlight();
  }

  private buildWorld(world: World, refit: boolean): void {
    this.clearHoverInfo();
    this.world = world;
    this.selected = null;
    this.hovered = null;
    this.hoverWorld = null;
    this.hoveredLineId = null;
    this.lineEditorActive = false;
    this.hoverGfx.clear();
    this.selectGfx.clear();
    this.routeGfx.clear();
    this.trainGfx.clear();
    this.truckGfx.clear();
    this.stationDotsGfx.clear();
    this.destroyStationCountLabels();
    this.destroyIncomeFloats();
    this.lastCoverageSignature = '';
    this.destroyLabels();

    this.drawTerrain();
    this.drawCoastAndBorders();
    this.drawDetails();
    this.drawNetworkLayers();
    this.createLabels();

    this.appliedZoom = -1;
    this.updateZoomState();

    if (refit) {
      this.userAdjusted = false;
      this.fitToMap();
    } else {
      this.time.delayedCall(30, () => {
        if (!this.userAdjusted) this.fitToMap();
      });
    }

    bus.emit('tile:select', null);
    bus.emit('tile:hover', null);
    bus.emit('world:ready', world);
  }

  /* ------------------------------ 绘制 ------------------------------ */

  private drawTerrain(): void {
    const g = this.terrainGfx;
    g.clear();

    // 地图之外的深海底色，让六边形圆盘的边缘自然融入背景
    g.fillStyle(COLORS.ocean, 1);
    g.fillRect(-4000, -4000, 8000, 8000);

    for (const tile of this.world.list) {
      const points = this.pointsOf(tile);
      const def = TERRAIN_DEFS[tile.terrain];
      let shade: number;
      if (tile.terrain === Terrain.Water) {
        const depth = clamp01(1 - tile.elevation / SEA_LEVEL);
        shade = 1.04 - depth * 0.46 + (tile.jitter - 0.5) * 0.04;
      } else {
        shade = 0.84 + tile.elevation * 0.3 + (tile.jitter - 0.5) * 0.08;
      }

      g.fillStyle(shadeColor(def.color, shade), 1);
      g.fillPoints(points, true);

      if (tile.terrain === Terrain.Water && tile.river) {
        // 内陆河流稍浅、偏绿，与海水区分
        g.fillStyle(shadeColor(0x4c92a4, shade), 0.55);
        g.fillPoints(points, true);
      }

      if (tile.terrain !== Terrain.Water) {
        g.lineStyle(1, COLORS.grid, 0.18);
        g.strokePoints(points, true);
      }
    }
  }

  private drawCoastAndBorders(): void {
    const g = this.coastGfx;
    g.clear();

    // 海岸线：只描陆地与水域之间的共享边，避免整张图被网格线淹没
    g.lineStyle(1.7, COLORS.coast, 0.38);
    for (const tile of this.world.list) {
      if (tile.terrain === Terrain.Water) continue;
      const points = this.pointsOf(tile);
      for (let d = 0; d < 6; d++) {
        const dir = HEX_DIRECTIONS[d]!;
        const neighbor = this.world.get(tile.q + dir.q, tile.r + dir.r);
        if (neighbor && neighbor.terrain !== Terrain.Water) continue;
        const edge = (6 - d) % 6;
        const a = points[edge]!;
        const b = points[(edge + 1) % 6]!;
        g.lineBetween(a.x, a.y, b.x, b.y);
      }
    }

    // 连片团块的外轮廓，强调“城镇 / 工业区是成片的”
    for (const blob of this.world.blobs) {
      const town = blob.kind === 'town';
      g.lineStyle(town ? 1.6 : 1.2, town ? COLORS.townBorder : COLORS.industryBorder, town ? 0.2 : 0.14);
      for (const tile of blob.tiles) {
        const points = this.pointsOf(tile);
        for (let d = 0; d < 6; d++) {
          const dir = HEX_DIRECTIONS[d]!;
          const n = this.world.get(tile.q + dir.q, tile.r + dir.r);
          if (n?.blobId === blob.id) continue;
          const edge = (6 - d) % 6;
          const a = points[edge]!;
          const b = points[(edge + 1) % 6]!;
          g.lineBetween(a.x, a.y, b.x, b.y);
        }
      }
    }
  }

  private drawDetails(): void {
    const g = this.detailGfx;
    g.clear();

    for (const tile of this.world.list) {
      switch (tile.terrain) {
        case Terrain.Mountain:
          this.drawMountain(g, tile);
          break;
        case Terrain.Town:
          this.drawTownGlyph(g, tile);
          break;
        case Terrain.Industry:
          this.drawIndustryGlyph(g, tile);
          break;
        case Terrain.Farmland:
          this.drawFarmlandGlyph(g, tile);
          break;
        case Terrain.Suburb:
          this.drawSuburbGlyph(g, tile);
          break;
        case Terrain.Wasteland:
          this.drawWastelandGlyph(g, tile);
          break;
        case Terrain.Water:
          this.drawWaterGlyph(g, tile);
          break;
      }
    }
  }

  private drawMountain(g: Phaser.GameObjects.Graphics, tile: Tile): void {
    const x = tile.x;
    const y = tile.y + 2;
    const scale = 0.86 + tile.jitter * 0.28;
    g.fillStyle(0x4b4238, 0.95);
    g.fillTriangle(x - 11 * scale, y + 8, x, y - 13 * scale, x + 11 * scale, y + 8);
    g.fillStyle(0x9a8d7b, 0.5);
    g.fillTriangle(x, y - 13 * scale, x + 11 * scale, y + 8, x + 2, y + 8);
    if (tile.elevation > 0.725) {
      g.fillStyle(0xe4ded0, 0.82);
      g.fillTriangle(x - 3.2 * scale, y - 5.2 * scale, x, y - 13 * scale, x + 3.2 * scale, y - 5.2 * scale);
    }
  }

  private drawTownGlyph(g: Phaser.GameObjects.Graphics, tile: Tile): void {
    const x = tile.x;
    const y = tile.y + 1;
    const j = tile.jitter - 0.5;
    g.fillStyle(0x7c5f37, 0.55);
    g.fillRect(x - 9 + j * 2, y - 1, 6, 8);
    g.fillRect(x + 4 + j * 2, y + 1, 5, 6);
    g.fillStyle(0x8f7044, 0.55);
    g.fillRect(x - 2, y - 6, 6, 13);
    g.fillStyle(0xa8824e, 0.4);
    g.fillRect(x - 2, y - 6, 6, 2);
  }

  private drawIndustryGlyph(g: Phaser.GameObjects.Graphics, tile: Tile): void {
    const x = tile.x;
    const y = tile.y;
    const j = tile.jitter - 0.5;
    g.fillStyle(0x4b525b, 0.7);
    g.fillRect(x - 10 + j, y - 1, 14, 9);
    g.fillRect(x + 4 + j, y - 10, 3.5, 9);
    g.fillStyle(0xaab2ba, 0.28);
    g.fillCircle(x + 6 + j, y - 12, 2.2);
    g.lineStyle(1, 0x3d444c, 0.5);
    g.strokeRect(x - 10 + j, y - 1, 14, 9);
  }

  private drawFarmlandGlyph(g: Phaser.GameObjects.Graphics, tile: Tile): void {
    const x = tile.x;
    const y = tile.y + 1;
    const j = tile.jitter - 0.5;
    g.lineStyle(1.5, 0x66742f, 0.5);
    for (let i = 0; i < 3; i++) {
      const yy = y - 5 + i * 4 + j * 2;
      g.lineBetween(x - 9, yy, x + 9, yy - 1);
    }
    if (tile.jitter > 0.72) {
      g.fillStyle(0x5c6b2b, 0.55);
      g.fillCircle(x + 7, y + 5, 2);
    }
  }

  private drawSuburbGlyph(g: Phaser.GameObjects.Graphics, tile: Tile): void {
    const x = tile.x + (tile.jitter - 0.5) * 4;
    const y = tile.y + 1;
    g.fillStyle(0x7b6747, 0.5);
    g.fillRect(x - 4, y - 2, 8, 7);
    g.fillStyle(0x8f7955, 0.55);
    g.fillTriangle(x - 6, y - 2, x, y - 8, x + 6, y - 2);
  }

  private drawWastelandGlyph(g: Phaser.GameObjects.Graphics, tile: Tile): void {
    const x = tile.x;
    const y = tile.y;
    const j = tile.jitter - 0.5;
    g.lineStyle(1.2, 0x615a49, 0.5);
    g.lineBetween(x - 5 + j * 4, y + 3, x - 3 + j * 4, y - 2);
    g.lineBetween(x + 2 + j * 4, y + 3, x + 4 + j * 4, y - 1);
  }

  private drawWaterGlyph(g: Phaser.GameObjects.Graphics, tile: Tile): void {
    if (tile.jitter < 0.62) return;
    const x = tile.x + (tile.jitter - 0.5) * 12;
    const y = tile.y + (tile.jitter - 0.5) * 12;
    g.lineStyle(1.2, 0xc7e8f1, 0.16);
    g.beginPath();
    g.moveTo(x - 7, y);
    g.lineTo(x - 3, y - 2);
    g.lineTo(x + 1, y);
    g.lineTo(x + 5, y - 2);
    g.lineTo(x + 8, y);
    g.strokePath();
  }

  /* ------------------------------ 轨道 / 车站 / 覆盖 ------------------------------ */

  private drawNetworkLayers(): void {
    if (!this.network) return;
    this.drawCoverage();
    this.drawTracks();
    this.drawStations();
    this.drawStationPassengers();
    this.lastCoverageSignature = this.coverageSignature();
  }

  private coverageSignature(): string {
    const selectedTile = this.selected ? this.world.get(this.selected.q, this.selected.r) : null;
    const selectedStation = selectedTile ? this.network.stationAt(selectedTile)?.id ?? '-' : '-';
    const hoveredTile = this.hovered ? this.world.get(this.hovered.q, this.hovered.r) : null;
    const hoveredStation =
      this.activeTool === 'inspect' && hoveredTile
        ? this.network.stationAt(hoveredTile)?.id ?? '-'
        : '-';
    const preview =
      this.activeTool === 'station' && hoveredTile
        ? `${hoveredTile.q},${hoveredTile.r}:${this.activeStationType}`
        : '-';
    return `${selectedStation}|${hoveredStation}|${preview}|${this.cameras.main.zoom.toFixed(2)}`;
  }

  private refreshCoverage(): void {
    if (!this.network) return;
    const signature = this.coverageSignature();
    if (signature === this.lastCoverageSignature) return;
    this.lastCoverageSignature = signature;
    this.drawCoverage();
  }

  private drawCoverage(): void {
    const g = this.coverageGfx;
    g.clear();
    if (!this.network) return;

    const zoom = Math.max(this.cameras.main.zoom, 0.1);
    const screen = (px: number) => px / zoom;

    // 常驻的弱覆盖层：让玩家随时看到每个车站的服务范围
    for (const station of this.network.stationList) {
      const def = STATION_DEFS[station.type];
      this.drawCoverageSet(g, station.coverage, def.color, 0.03, def.color, 0.12, screen(1));
    }

    // 查看模式下选中 / 悬停的车站：加强显示
    const highlighted = new Set<number>();
    if (this.activeTool === 'inspect' && this.selected) {
      const tile = this.world.get(this.selected.q, this.selected.r);
      const station = tile ? this.network.stationAt(tile) : null;
      if (station) highlighted.add(station.id);
    }
    if (this.activeTool === 'inspect' && this.hovered) {
      const tile = this.world.get(this.hovered.q, this.hovered.r);
      const station = tile ? this.network.stationAt(tile) : null;
      if (station) highlighted.add(station.id);
    }
    for (const station of this.network.stationList) {
      if (!highlighted.has(station.id)) continue;
      const def = STATION_DEFS[station.type];
      this.drawCoverageSet(g, station.coverage, def.color, 0.09, 0xf2fbff, 0.6, screen(1.8));
    }

    // 车站工具预览。水域 / 已有车站的格子不画覆盖，只留红色虚影
    if (this.activeTool === 'station' && this.hovered) {
      const tile = this.world.get(this.hovered.q, this.hovered.r);
      if (tile && tile.terrain !== Terrain.Water && !this.network.stationAt(tile)) {
        const preview = this.network.previewCoverage(tile, this.activeStationType);
        const quote = this.network.quoteStation(tile, this.activeStationType);
        const def = STATION_DEFS[this.activeStationType];
        const color = quote.ok ? def.color : 0xe07a6a;
        this.drawCoverageSet(g, preview.tiles, color, 0.13, color, 0.75, screen(1.8));
      }
    }
  }

  private drawCoverageSet(
    g: Phaser.GameObjects.Graphics,
    tiles: readonly Tile[],
    fillColor: number,
    fillAlpha: number,
    borderColor: number,
    borderAlpha: number,
    lineWidth: number,
  ): void {
    if (tiles.length === 0) return;
    const keys = new Set<string>();
    for (const tile of tiles) keys.add(hexKey(tile.q, tile.r));

    g.fillStyle(fillColor, fillAlpha);
    for (const tile of tiles) {
      g.fillPoints(this.pointsOf(tile), true);
    }

    g.lineStyle(lineWidth, borderColor, borderAlpha);
    for (const tile of tiles) {
      const points = this.pointsOf(tile);
      for (let d = 0; d < 6; d++) {
        const dir = HEX_DIRECTIONS[d]!;
        if (keys.has(hexKey(tile.q + dir.q, tile.r + dir.r))) continue;
        const edge = (6 - d) % 6;
        const a = points[edge]!;
        const b = points[(edge + 1) % 6]!;
        g.lineBetween(a.x, a.y, b.x, b.y);
      }
    }
  }

  private drawTracks(): void {
    const g = this.trackGfx;
    g.clear();
    if (!this.network) return;

    const tracks = this.network.trackList;
    if (tracks.length === 0) return;

    const zoom = Math.max(this.cameras.main.zoom, 0.1);
    const screen = (px: number) => px / zoom;
    const seenLinks = new Set<string>();

    for (const track of tracks) {
      const tile = track.tile;
      for (const dir of HEX_DIRECTIONS) {
        const neighbor = this.world.get(tile.q + dir.q, tile.r + dir.r);
        if (!neighbor || !this.network.hasTrack(neighbor)) continue;
        const a = hexKey(tile.q, tile.r);
        const b = hexKey(neighbor.q, neighbor.r);
        const link = a < b ? `${a}|${b}` : `${b}|${a}`;
        if (seenLinks.has(link)) continue;
        seenLinks.add(link);
        if (!this.network.isLinkEnabled(tile, neighbor)) continue;
        this.drawRailLink(g, tile, neighbor);
      }
    }

    // 站点 / 道岔标记
    for (const track of tracks) {
      const tile = track.tile;
      if (track.neighbors.length === 0) {
        g.lineStyle(screen(4.5), 0x151b20, 0.9);
        g.lineBetween(tile.x - screen(7), tile.y, tile.x + screen(7), tile.y);
        g.lineStyle(screen(1.3), 0xd8dde0, 0.9);
        g.lineBetween(tile.x - screen(7), tile.y - screen(2), tile.x + screen(7), tile.y - screen(2));
        g.lineBetween(tile.x - screen(7), tile.y + screen(2), tile.x + screen(7), tile.y + screen(2));
      }
      g.fillStyle(0x0b1014, 0.9);
      g.fillCircle(tile.x, tile.y, screen(4.2));
      g.fillStyle(0xaab4ba, 1);
      g.fillCircle(tile.x, tile.y, screen(1.3));
    }
  }

  private drawRailLink(g: Phaser.GameObjects.Graphics, a: Tile, b: Tile): void {
    const zoom = Math.max(this.cameras.main.zoom, 0.1);
    const screen = (px: number) => px / zoom;

    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const length = Math.hypot(dx, dy);
    if (length < 0.001) return;
    const ux = dx / length;
    const uy = dy / length;
    const nx = -uy;
    const ny = ux;
    const bridge = a.terrain === Terrain.Water || b.terrain === Terrain.Water;

    if (bridge) {
      g.lineStyle(screen(12), 0x2b3339, 0.95);
      g.lineBetween(a.x, a.y, b.x, b.y);
      g.lineStyle(screen(1), 0x8ba6b4, 0.4);
      g.lineBetween(a.x + nx * screen(4.5), a.y + ny * screen(4.5), b.x + nx * screen(4.5), b.y + ny * screen(4.5));
      g.lineBetween(a.x - nx * screen(4.5), a.y - ny * screen(4.5), b.x - nx * screen(4.5), b.y - ny * screen(4.5));
    }

    // 道砟 / 枕木 / 钢轨
    g.lineStyle(screen(7.5), 0x13191e, 0.92);
    g.lineBetween(a.x, a.y, b.x, b.y);

    const screenLength = length * zoom;
    const sleeperHalf = screen(4.4);
    g.lineStyle(screen(1.5), 0x7c5b34, 0.92);
    for (let pos = 4; pos < screenLength - 2; pos += 9) {
      const t = pos / screenLength;
      const x = a.x + dx * t;
      const y = a.y + dy * t;
      g.lineBetween(x - nx * sleeperHalf, y - ny * sleeperHalf, x + nx * sleeperHalf, y + ny * sleeperHalf);
    }

    const railOffset = screen(2.1);
    g.lineStyle(screen(1.4), 0xd9dee1, 0.95);
    g.lineBetween(
      a.x + nx * railOffset,
      a.y + ny * railOffset,
      b.x + nx * railOffset,
      b.y + ny * railOffset,
    );
    g.lineBetween(
      a.x - nx * railOffset,
      a.y - ny * railOffset,
      b.x - nx * railOffset,
      b.y - ny * railOffset,
    );
  }

  private drawStations(): void {
    const g = this.stationGfx;
    g.clear();
    if (!this.network) return;

    const zoom = Math.max(this.cameras.main.zoom, 0.1);
    for (const station of this.network.stationList) {
      const def = STATION_DEFS[station.type];
      const disconnected = station.connectedStations < 2;
      this.drawStationIcon(
        g,
        station.tile.x,
        station.tile.y,
        def,
        disconnected ? 0xe07a6a : def.color,
        1,
        zoom,
      );

      if (this.lineEditorActive) {
        // 线路编辑时高亮所有可选车站
        const ring = 24 / zoom;
        g.fillStyle(0xf2d49a, 0.06);
        g.fillCircle(station.tile.x, station.tile.y, ring);
        g.lineStyle(1.4 / zoom, 0xf2d49a, 0.8);
        g.strokeCircle(station.tile.x, station.tile.y, ring);
      }
    }
  }

  /**
   * 车站上方的候车乘客圆点：最多 5 个；超过 5 人时额外显示数字。
   */
  private drawStationPassengers(): void {
    const g = this.stationDotsGfx;
    g.clear();
    if (!this.network || !this.operations) return;

    const zoom = Math.max(this.cameras.main.zoom, 0.1);
    const iconRadius = this.stationIconRadius(zoom);
    const dotRadius = clamp(2.2 / zoom, 1.2, 4);
    const spacing = dotRadius * 3.1;
    const active = new Set<string>();

    for (const station of this.network.stationList) {
      const key = hexKey(station.q, station.r);

      if (station.type === 'freight') {
        const orders = this.operations.cargoWaitingAt(key);
        if (orders > 0) {
          this.drawStationCargoOrders(
            g,
            station.tile.x,
            station.tile.y,
            orders,
            zoom,
            iconRadius,
          );
        }
      }

      const passengers = this.operations.stationWaitingPassengers(station.tile);
      const count = passengers.length;
      if (count <= 0) continue;

      active.add(key);
      const shown = Math.min(count, 5);
      const totalWidth = (shown - 1) * spacing;
      const rowY = station.tile.y - iconRadius - dotRadius * 2.4;
      const startX = station.tile.x - totalWidth / 2;

      for (let i = 0; i < shown; i++) {
        const passenger = passengers[i]!;
        const color = PASSENGER_KIND_DEFS[passenger.kind].color;
        const x = startX + i * spacing;
        g.fillStyle(0x081016, 0.9);
        g.fillCircle(x, rowY, dotRadius * 1.35);
        g.fillStyle(color, 0.98);
        g.fillCircle(x, rowY, dotRadius);
      }

      const label = this.stationCountLabels.get(key);
      if (count > 5) {
        const text = label ?? this.createStationCountLabel();
        this.stationCountLabels.set(key, text);
        text.setText(String(count));
        text.setPosition(station.tile.x + totalWidth / 2 + dotRadius * 2.4, rowY);
        text.setScale(0.55 / zoom);
        text.setVisible(true);
      } else if (label) {
        label.setVisible(false);
      }
    }

    for (const [key, label] of this.stationCountLabels) {
      if (!active.has(key)) label.setVisible(false);
    }
  }

  /**
   * 货站上方的待运货单：暖色货箱，与货车载货箱同尺寸 / 颜色，垂直堆叠，最多 3 个。
   */
  private drawStationCargoOrders(
    g: Phaser.GameObjects.Graphics,
    x: number,
    y: number,
    count: number,
    zoom: number,
    iconRadius: number,
  ): void {
    const truckLength = clamp(26 / zoom, 12, 42);
    const truckWidth = clamp(14 / zoom, 7, 24);
    const boxWidth = truckLength * 0.5;
    const boxHeight = truckWidth * 0.46;
    const gap = Math.max(1.2 / zoom, boxHeight * 0.32);
    const shown = Math.min(Math.max(0, count), 3);
    const bottomY =
      y - iconRadius - Math.max(3 / zoom, boxHeight * 0.6) - boxHeight / 2;

    for (let i = 0; i < shown; i++) {
      const cy = bottomY - i * (boxHeight + gap);
      const left = x - boxWidth / 2;
      const top = cy - boxHeight / 2;

      g.fillStyle(0xc98e4a, 0.98);
      g.fillRect(left, top, boxWidth, boxHeight);
      g.lineStyle(1 / zoom, 0x6e4a24, 0.95);
      g.strokeRect(left, top, boxWidth, boxHeight);
      g.lineStyle(1.2 / zoom, 0xffd8a0, 0.7);
      g.lineBetween(x, cy - boxHeight * 0.38, x, cy + boxHeight * 0.38);
    }
  }

  private createStationCountLabel(): Phaser.GameObjects.Text {
    return this.add
      .text(0, 0, '', {
        fontFamily: '"Microsoft YaHei", "PingFang SC", "Segoe UI", sans-serif',
        fontSize: '22px',
        color: '#ffe6b8',
        stroke: '#0b141a',
        strokeThickness: 4,
      })
      .setDepth(7.3)
      .setOrigin(0, 0.5);
  }

  /* ------------------------------ 收入跳字 ------------------------------ */

  /** 取走本帧到站结算的票款，按车站合并后生成跳字。 */
  private drainIncomeEvents(): void {
    if (!this.operations) return;
    const events = this.operations.drainIncomeEvents();
    if (events.length === 0) return;

    const view = this.cameras.main.worldView;
    const cull = view.width > 0;
    const groups = new Map<
      string,
      { x: number; y: number; amount: number; count: number; kind: 'passenger' | 'cargo' }
    >();
    for (const event of events) {
      if (event.amount <= 0) continue;
      if (
        cull &&
        (event.x < view.left - 80 ||
          event.x > view.right + 80 ||
          event.y < view.top - 80 ||
          event.y > view.bottom + 80)
      ) {
        continue;
      }
      const key = `${event.stationKey}|${event.kind}`;
      const group = groups.get(key) ?? {
        x: event.x,
        y: event.y,
        amount: 0,
        count: 0,
        kind: event.kind,
      };
      group.amount += event.amount;
      group.count += 1;
      groups.set(key, group);
    }

    for (const group of groups.values()) {
      this.spawnIncomeFloat(group.x, group.y, group.amount, group.count, group.kind);
    }
  }

  private spawnIncomeFloat(
    x: number,
    y: number,
    amount: number,
    count: number,
    kind: 'passenger' | 'cargo',
  ): void {
    const zoom = Math.max(this.cameras.main.zoom, 0.1);
    const iconRadius = this.stationIconRadius(zoom);
    const jitterX = Phaser.Math.FloatBetween(-12, 12) / zoom;
    const jitterY = Phaser.Math.FloatBetween(-4, 4) / zoom;
    const secondLine =
      kind === 'cargo'
        ? count > 1
          ? `${count} 单送达`
          : '货单送达'
        : count > 1
          ? `${count} 人下车`
          : '';
    const label = secondLine
      ? `+¥${amount.toLocaleString('en-US')}\n${secondLine}`
      : `+¥${amount.toLocaleString('en-US')}`;

    const text = this.add
      .text(x + jitterX, y - iconRadius - 12 / zoom + jitterY, label, {
        fontFamily: '"Microsoft YaHei", "PingFang SC", "Segoe UI", sans-serif',
        fontSize: '26px',
        color: '#ffe0a3',
        stroke: '#0b141a',
        strokeThickness: 4,
        align: 'center',
        lineSpacing: 2,
      })
      .setOrigin(0.5, 1)
      .setDepth(12)
      .setScale(0.6 / zoom);

    this.incomeFloats.add(text);
    this.tweens.add({
      targets: text,
      scale: 0.7 / zoom,
      duration: 180,
      ease: 'Back.easeOut',
    });
    this.tweens.add({
      targets: text,
      y: text.y - 40 / zoom,
      alpha: 0,
      duration: 1600,
      ease: 'Cubic.easeOut',
      onComplete: () => {
        this.incomeFloats.delete(text);
        text.destroy();
      },
    });
  }

  private destroyIncomeFloats(): void {
    for (const text of this.incomeFloats) {
      this.tweens.killTweensOf(text);
      text.destroy();
    }
    this.incomeFloats.clear();
  }

  private stationIconRadius(zoom: number): number {
    return clamp(20 / zoom, 12, 30);
  }

  private drawStationIcon(
    g: Phaser.GameObjects.Graphics,
    x: number,
    y: number,
    def: StationDef,
    borderColor: number,
    alpha: number,
    zoom: number,
    ghost = false,
  ): void {
    const screen = (px: number) => px / zoom;
    const radius = this.stationIconRadius(zoom);

    g.fillStyle(0x060b0e, ghost ? 0.25 : 0.45);
    g.fillCircle(x, y, radius);
    g.fillStyle(0x101a21, (ghost ? 0.65 : 0.96) * alpha);
    g.fillCircle(x, y, radius * 0.8);
    g.lineStyle(screen(ghost ? 1.4 : 2), borderColor, (ghost ? 0.8 : 1) * alpha);
    g.strokeCircle(x, y, radius * 0.8);
    g.lineStyle(screen(1), borderColor, 0.35 * alpha);
    g.strokeCircle(x, y, radius);

    g.fillStyle(def.color, (ghost ? 0.55 : 0.95) * alpha);
    switch (def.type) {
      case 'light':
        g.fillCircle(x, y, radius * 0.32);
        g.fillStyle(0x0d1419, 0.85 * alpha);
        g.fillCircle(x, y, radius * 0.13);
        break;
      case 'small':
        g.fillRect(x - radius * 0.36, y - radius * 0.36, radius * 0.72, radius * 0.72);
        g.fillStyle(0x0d1419, 0.7 * alpha);
        g.fillRect(x - radius * 0.18, y - radius * 0.18, radius * 0.36, radius * 0.36);
        break;
      case 'large':
        g.fillRect(x - radius * 0.46, y - radius * 0.46, radius * 0.92, radius * 0.92);
        g.fillStyle(0x0d1419, 0.7 * alpha);
        g.fillRect(x - radius * 0.26, y - radius * 0.26, radius * 0.52, radius * 0.52);
        g.fillStyle(def.color, 0.9 * alpha);
        g.fillRect(x - radius * 0.12, y - radius * 0.12, radius * 0.24, radius * 0.24);
        break;
      case 'freight':
        g.fillRect(x - radius * 0.44, y - radius * 0.28, radius * 0.88, radius * 0.56);
        g.fillStyle(0x0d1419, 0.7 * alpha);
        g.fillRect(x - radius * 0.12, y - radius * 0.28, radius * 0.06, radius * 0.56);
        g.fillRect(x + radius * 0.16, y - radius * 0.28, radius * 0.06, radius * 0.56);
        break;
    }
  }

  /* ------------------------------ 线路 / 列车 ------------------------------ */

  private drawRouteHighlight(): void {
    const g = this.routeGfx;
    g.clear();
    if (!this.hoveredLineId || !this.operations) return;

    const line = this.operations.lineById(this.hoveredLineId);
    if (!line) return;

    const zoom = Math.max(this.cameras.main.zoom, 0.1);
    const screen = (px: number) => px / zoom;

    if (line.status === 'OK' && line.points.length >= 2) {
      // 宽光晕 + 细核心，保留底下的钢轨细节
      g.lineStyle(screen(14), line.color, 0.16);
      for (let i = 1; i < line.points.length; i++) {
        const a = line.points[i - 1]!;
        const b = line.points[i]!;
        g.lineBetween(a.x, a.y, b.x, b.y);
      }
      g.lineStyle(screen(3.2), line.color, 0.9);
      for (let i = 1; i < line.points.length; i++) {
        const a = line.points[i - 1]!;
        const b = line.points[i]!;
        g.lineBetween(a.x, a.y, b.x, b.y);
      }
    } else {
      // 断开线路：用红色虚线示意预定停靠顺序
      const stopTiles = line.stops
        .map((stop) => this.world.get(stop.q, stop.r))
        .filter((tile): tile is Tile => Boolean(tile));
      for (let i = 1; i < stopTiles.length; i++) {
        const a = stopTiles[i - 1]!;
        const b = stopTiles[i]!;
        this.drawDashedSegment(g, a.x, a.y, b.x, b.y, zoom, 0xe07a6a, 2, 0.6);
      }
    }

    // 停靠站外圈：跟随车站图标的屏幕尺寸，避免缩小时过大、放大时被图标盖住
    const iconRadius = this.stationIconRadius(zoom);
    const ringRadius = iconRadius * 1.3;
    const outerRadius = ringRadius + screen(3);

    for (const stop of line.stops) {
      const tile = this.world.get(stop.q, stop.r);
      if (!tile) continue;
      const ringColor = line.status === 'OK' ? line.color : 0xe07a6a;
      g.fillStyle(0x0a1117, 0.12);
      g.fillCircle(tile.x, tile.y, ringRadius);
      g.lineStyle(screen(2.2), ringColor, 0.95);
      g.strokeCircle(tile.x, tile.y, ringRadius);
      g.lineStyle(screen(1), ringColor, 0.3);
      g.strokeCircle(tile.x, tile.y, outerRadius);
    }
  }

  private drawDashedSegment(
    g: Phaser.GameObjects.Graphics,
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    zoom: number,
    color: number,
    widthPx: number,
    alpha: number,
  ): void {
    const dash = 6 / zoom;
    const gap = 5 / zoom;
    const dx = x2 - x1;
    const dy = y2 - y1;
    const length = Math.hypot(dx, dy);
    if (length < 0.001) return;
    const ux = dx / length;
    const uy = dy / length;
    g.lineStyle(widthPx / zoom, color, alpha);
    for (let pos = 0; pos < length; pos += dash + gap) {
      const end = Math.min(length, pos + dash);
      g.lineBetween(x1 + ux * pos, y1 + uy * pos, x1 + ux * end, y1 + uy * end);
    }
  }

  private drawTrains(): void {
    const g = this.trainGfx;
    g.clear();
    if (!this.operations) return;

    const zoom = Math.max(this.cameras.main.zoom, 0.1);
    for (const line of this.operations.lines) {
      if (line.status !== 'OK' || line.length <= 0) continue;
      for (const trainId of line.trainIds) {
        const train = this.operations.trainById(trainId);
        if (!train) continue;
        this.drawTrain(g, train, line, zoom);
      }
    }
  }

  /** 车厢尺寸：长度 = 基准 70%，宽度 = 基准 50%，形成更小、更长的方块。 */
  private trainCarMetrics(zoom: number): { length: number; width: number; spacing: number } {
    const base = clamp(33 / zoom, 15, 54);
    const length = base * 0.7;
    const width = base * 0.5;
    const spacing = length * 1.18 + 2 / zoom;
    return { length, width, spacing };
  }

  /** 计算每节车厢的折线采样位置，供绘制与悬停命中复用。 */
  private trainCarSamples(
    train: Train,
    line: Line,
    metrics: { length: number; width: number; spacing: number },
  ): { x: number; y: number; angle: number; head: boolean }[] {
    const { spacing } = metrics;
    const tail = (train.cars - 1) * spacing;

    // 改线回送：沿回送路径排布车厢；路径已包含车头后方的旧线路
    if (train.reposition) {
      const headDistance = train.reposition.distance;
      const result: { x: number; y: number; angle: number; head: boolean }[] = [];
      for (let i = 0; i < train.cars; i++) {
        const distance = headDistance - i * spacing;
        const sample = this.sampleTrainPath(train.reposition, distance);
        if (sample) result.push({ x: sample.x, y: sample.y, angle: sample.angle, head: i === 0 });
      }
      return result;
    }

    // 非环线两端：把车头向内收，保证整列方块都在线路上，而不是挤成一格
    let headDistance = train.distance;
    if (!line.isLoop && line.length > tail) {
      headDistance =
        train.dir > 0
          ? Math.max(headDistance, tail)
          : Math.min(headDistance, line.length - tail);
    }

    const result: { x: number; y: number; angle: number; head: boolean }[] = [];
    for (let i = 0; i < train.cars; i++) {
      // 车头在前；dir=-1 时车厢沿折线反方向排布
      const distance = headDistance - train.dir * i * spacing;
      const sample = this.operations.sampleLine(line, distance);
      if (sample) result.push({ x: sample.x, y: sample.y, angle: sample.angle, head: i === 0 });
    }
    return result;
  }

  private sampleTrainPath(
    path: NonNullable<Train['reposition']>,
    distance: number,
  ): { x: number; y: number; angle: number } | null {
    if (path.points.length < 2 || path.length <= 0) return null;
    const d = clamp(distance, 0, path.length);
    let index = 0;
    while (index < path.points.length - 2 && (path.cumulative[index + 1] ?? 0) < d) {
      index++;
    }

    const start = path.points[index]!;
    const end = path.points[index + 1]!;
    const segStart = path.cumulative[index] ?? 0;
    const segEnd = path.cumulative[index + 1] ?? path.length;
    const t = (d - segStart) / Math.max(0.0001, segEnd - segStart);
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    return {
      x: start.x + dx * t,
      y: start.y + dy * t,
      angle: Math.atan2(dy, dx),
    };
  }

  private drawTrain(
    g: Phaser.GameObjects.Graphics,
    train: Train,
    line: Line,
    zoom: number,
  ): void {
    const metrics = this.trainCarMetrics(zoom);
    const samples = this.trainCarSamples(train, line, metrics);
    const dir = train.reposition ? 1 : train.dir;

    for (let index = 0; index < samples.length; index++) {
      const car = samples[index]!;
      const passengers = train.onboard.filter((passenger) => passenger.carIndex === index);
      this.drawTrainCar(
        g,
        car.x,
        car.y,
        car.angle,
        metrics.length,
        metrics.width,
        line.color,
        car.head,
        dir,
        zoom,
        passengers,
      );
    }
  }

  private drawTrainCar(
    g: Phaser.GameObjects.Graphics,
    x: number,
    y: number,
    angle: number,
    length: number,
    width: number,
    color: number,
    head: boolean,
    dir: 1 | -1,
    zoom: number,
    passengers: Train['onboard'],
  ): void {
    const screen = (px: number) => px / zoom;
    const halfLength = length / 2;
    const halfWidth = width / 2;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const local = [
      [-halfLength, -halfWidth],
      [halfLength, -halfWidth],
      [halfLength, halfWidth],
      [-halfLength, halfWidth],
    ];
    const points = local.map(
      ([lx, ly]) =>
        new Phaser.Math.Vector2(
          x + (lx ?? 0) * cos - (ly ?? 0) * sin,
          y + (lx ?? 0) * sin + (ly ?? 0) * cos,
        ),
    );

    g.fillStyle(color, 0.96);
    g.fillPoints(points, true);
    g.lineStyle(screen(1.2), 0x0b1116, 0.9);
    g.strokePoints(points, true);

    if (head) {
      // 车头前端白条，指示行驶方向
      const travel = angle + (dir < 0 ? Math.PI : 0);
      const tx = Math.cos(travel);
      const ty = Math.sin(travel);
      const nx = -ty;
      const ny = tx;
      const front = halfLength * 0.72;
      const side = halfWidth * 0.62;
      g.lineStyle(screen(1.6), 0xffffff, 0.9);
      g.lineBetween(
        x + tx * front - nx * side,
        y + ty * front - ny * side,
        x + tx * front + nx * side,
        y + ty * front + ny * side,
      );
    }

    // 车厢内乘客圆点：2×2 布局，每节最多 4 人
    const dotRadius = clamp(2.2 / zoom, 1.2, 4);
    const offsets = [
      [-length * 0.18, -width * 0.18],
      [length * 0.18, -width * 0.18],
      [-length * 0.18, width * 0.18],
      [length * 0.18, width * 0.18],
    ];
    const shown = Math.min(passengers.length, 4);
    for (let i = 0; i < shown; i++) {
      const [lx, ly] = offsets[i]!;
      const px = x + (lx ?? 0) * cos - (ly ?? 0) * sin;
      const py = y + (lx ?? 0) * sin + (ly ?? 0) * cos;
      const passenger = passengers[i]!;
      const color = PASSENGER_KIND_DEFS[passenger.kind].color;
      g.fillStyle(0x091116, 0.8);
      g.fillCircle(px, py, dotRadius * 1.35);
      g.fillStyle(color, 0.98);
      g.fillCircle(px, py, dotRadius);
    }
  }

  /* ------------------------------ 货运列车 ------------------------------ */

  private drawTrucks(): void {
    const g = this.truckGfx;
    g.clear();
    if (!this.operations) return;

    const zoom = Math.max(this.cameras.main.zoom, 0.1);
    for (const truck of this.operations.trucks) {
      if (truck.state === 'hidden') continue;
      this.drawTruck(g, truck, zoom);
    }
  }

  private drawTruck(
    g: Phaser.GameObjects.Graphics,
    truck: Truck,
    zoom: number,
  ): void {
    const length = clamp(26 / zoom, 12, 42);
    const width = clamp(14 / zoom, 7, 24);
    const halfLength = length / 2;
    const halfWidth = width / 2;
    const cos = Math.cos(truck.heading);
    const sin = Math.sin(truck.heading);
    const worldPoint = (lx: number, ly: number): Phaser.Math.Vector2 =>
      new Phaser.Math.Vector2(
        truck.x + lx * cos - ly * sin,
        truck.y + lx * sin + ly * cos,
      );

    const body = [
      worldPoint(-halfLength, -halfWidth),
      worldPoint(halfLength, -halfWidth),
      worldPoint(halfLength, halfWidth),
      worldPoint(-halfLength, halfWidth),
    ];
    g.fillStyle(0x9aa5ae, 0.97);
    g.fillPoints(body, true);
    g.lineStyle(1.2 / zoom, 0x39454e, 0.95);
    g.strokePoints(body, true);

    // 货箱：空车为深色凹槽，载货为暖色集装箱
    const bayLength = length * 0.5;
    const bayWidth = width * 0.46;
    const bay = [
      worldPoint(-bayLength / 2, -bayWidth / 2),
      worldPoint(bayLength / 2, -bayWidth / 2),
      worldPoint(bayLength / 2, bayWidth / 2),
      worldPoint(-bayLength / 2, bayWidth / 2),
    ];
    g.fillStyle(truck.loaded ? 0xc98e4a : 0x46525b, 0.98);
    g.fillPoints(bay, true);
    g.lineStyle(1 / zoom, truck.loaded ? 0x6e4a24 : 0x2f3940, 0.95);
    g.strokePoints(bay, true);

    if (truck.loaded) {
      // 载货时加一条浅色捆扎线
      const strapA = worldPoint(-bayLength * 0.08, -bayWidth / 2);
      const strapB = worldPoint(-bayLength * 0.08, bayWidth / 2);
      g.lineStyle(1.2 / zoom, 0xffd8a0, 0.7);
      g.lineBetween(strapA.x, strapA.y, strapB.x, strapB.y);
    }

    // 车头白条，指示行驶方向
    const tx = Math.cos(truck.heading);
    const ty = Math.sin(truck.heading);
    const nx = -ty;
    const ny = tx;
    const front = halfLength * 0.8;
    const side = halfWidth * 0.54;
    g.lineStyle(1.4 / zoom, 0xffffff, 0.85);
    g.lineBetween(
      truck.x + tx * front - nx * side,
      truck.y + ty * front - ny * side,
      truck.x + tx * front + nx * side,
      truck.y + ty * front + ny * side,
    );
  }

  /* ------------------------------ 标签 ------------------------------ */

  private createLabels(): void {
    for (const blob of this.world.blobs) {
      const town = blob.kind === 'town';
      const label = this.add
        .text(blob.center.q, blob.center.r, blob.name, {
          fontFamily: '"Microsoft YaHei", "PingFang SC", "Segoe UI", sans-serif',
          fontSize: town ? '32px' : '24px',
          color: town ? COLORS.townLabel : COLORS.industryLabel,
          stroke: '#0b141a',
          strokeThickness: town ? 4 : 3,
          align: 'center',
        })
        .setDepth(11)
        .setOrigin(0.5, 1)
        .setAlpha(town ? 0.92 : 0.72);

      const pixel = this.tilePixel(blob.center.q, blob.center.r);
      label.setPosition(pixel.x, pixel.y - HEX_SIZE * 0.85);
      this.labels.push({ text: label, blob });
    }
    this.appliedZoom = -1;
    this.updateZoomState();
  }

  private destroyLabels(): void {
    for (const label of this.labels) label.text.destroy();
    this.labels = [];
  }

  private destroyStationCountLabels(): void {
    for (const label of this.stationCountLabels.values()) label.destroy();
    this.stationCountLabels.clear();
  }

  /* ------------------------------ 相机 ------------------------------ */

  private safeArea(): { left: number; right: number; top: number; bottom: number; cx: number; cy: number } {
    const width = this.scale.width;
    const height = this.scale.height;
    const leftPanel = document.getElementById('panel-left')?.getBoundingClientRect();
    const rightPanelEl = document.getElementById('panel-right');
    const rightPanel = rightPanelEl?.getBoundingClientRect();
    const topbar = document.getElementById('topbar')?.getBoundingClientRect();
    const dock = document.getElementById('dock')?.getBoundingClientRect();

    const left = leftPanel && leftPanel.width > 0 ? leftPanel.right + 14 : 16;
    const rightIsOverlay =
      window.innerWidth <= 1180 && (rightPanelEl?.classList.contains('is-open') ?? false);
    const right =
      rightPanel && rightPanel.width > 0 && !rightIsOverlay ? rightPanel.left - 14 : width - 16;
    const top = topbar && topbar.height > 0 ? topbar.bottom + 14 : 16;
    const bottom = dock && dock.height > 0 ? dock.top - 12 : height - 16;

    const safeLeft = Math.min(left, width * 0.5);
    const safeRight = Math.max(right, width * 0.5);
    const safeTop = Math.min(top, height * 0.5);
    const safeBottom = Math.max(bottom, height * 0.5);

    return {
      left: safeLeft,
      right: safeRight,
      top: safeTop,
      bottom: safeBottom,
      cx: (safeLeft + safeRight) / 2,
      cy: (safeTop + safeBottom) / 2,
    };
  }

  fitToMap(): void {
    const cam = this.cameras.main;
    const safe = this.safeArea();
    const mapW = SQRT3 * HEX_SIZE * (2 * this.world.radius + 1);
    const mapH = 1.5 * HEX_SIZE * (2 * this.world.radius + 1) + HEX_SIZE;
    const zoom = clamp(
      Math.min((safe.right - safe.left) / (mapW * 1.05), (safe.bottom - safe.top) / (mapH * 1.05)),
      CAMERA_MIN_ZOOM,
      CAMERA_MAX_ZOOM,
    );

    cam.setZoom(zoom);
    cam.centerOn(0, 0);
    cam.scrollX += (this.scale.width / 2 - safe.cx) / zoom;
    cam.scrollY += (this.scale.height / 2 - safe.cy) / zoom;

    this.userAdjusted = false;
    this.emitZoom();
    this.updateZoomState();
  }

  /** 以屏幕坐标 (sx, sy) 为锚点缩放，保证鼠标下的地块不移动。 */
  private zoomAt(sx: number, sy: number, targetZoom: number): void {
    const cam = this.cameras.main;
    const newZoom = clamp(targetZoom, CAMERA_MIN_ZOOM, CAMERA_MAX_ZOOM);
    const oldZoom = cam.zoom;
    if (Math.abs(newZoom - oldZoom) < 0.0001) return;

    const ax = sx - this.scale.width / 2;
    const ay = sy - this.scale.height / 2;
    cam.setZoom(newZoom);
    cam.scrollX += ax * (1 / oldZoom - 1 / newZoom);
    cam.scrollY += ay * (1 / oldZoom - 1 / newZoom);

    this.userAdjusted = true;
    this.emitZoom();
    this.updateZoomState();
    this.clampCamera();
  }

  zoomBy(factor: number): void {
    const safe = this.safeArea();
    this.zoomAt(safe.cx, safe.cy, this.cameras.main.zoom * factor);
  }

  private emitZoom(): void {
    bus.emit('camera:zoom', this.cameras.main.zoom);
  }

  private clampCamera(): void {
    const cam = this.cameras.main;
    const halfW = (SQRT3 * HEX_SIZE * (2 * this.world.radius + 1)) / 2;
    const halfH = (1.5 * HEX_SIZE * (2 * this.world.radius + 1)) / 2;
    const limitX = halfW * 0.9;
    const limitY = halfH * 0.9;
    const midX = cam.scrollX + this.scale.width / 2;
    const midY = cam.scrollY + this.scale.height / 2;
    const targetX = clamp(midX, -limitX, limitX);
    const targetY = clamp(midY, -limitY, limitY);
    cam.scrollX += targetX - midX;
    cam.scrollY += targetY - midY;
  }

  private updateZoomState(): void {
    const cam = this.cameras.main;
    if (Math.abs(cam.zoom - this.appliedZoom) < 0.001) return;
    this.appliedZoom = cam.zoom;

    const scale = 0.5 / cam.zoom;
    for (const { text, blob } of this.labels) {
      text.setScale(scale);
      const visible =
        blob.kind === 'town'
          ? cam.zoom >= 0.28 && (cam.zoom >= 0.7 || blob.size >= 14)
          : cam.zoom >= 1.05;
      text.setVisible(visible);
    }
    this.detailGfx.setVisible(cam.zoom >= 0.45);
    this.drawNetworkLayers();
    this.drawRouteHighlight();
    this.paintOverlays();
    this.drawTrains();
    this.drawTrucks();
  }

  /* ------------------------------ 输入 ------------------------------ */

  private setupInput(): void {
    this.input.on('wheel', (pointer: Phaser.Input.Pointer, _over: unknown, _dx: number, dy: number) => {
      const factor = dy > 0 ? 0.86 : 1.16;
      this.zoomAt(pointer.x, pointer.y, this.cameras.main.zoom * factor);
    });

    this.input.on('pointerdown', (pointer: Phaser.Input.Pointer) => {
      this.pointerDown = {
        x: pointer.x,
        y: pointer.y,
        scrollX: this.cameras.main.scrollX,
        scrollY: this.cameras.main.scrollY,
        button: pointer.button,
      };
      this.dragDistance = 0;
      this.game.canvas.style.cursor = 'grabbing';
      this.clearHoverInfo();
    });

    this.input.on('pointermove', (pointer: Phaser.Input.Pointer) => {
      if (this.pointerDown && pointer.isDown) {
        const dx = pointer.x - this.pointerDown.x;
        const dy = pointer.y - this.pointerDown.y;
        this.dragDistance = Math.max(this.dragDistance, Math.hypot(dx, dy));
        if (this.dragDistance > 4) {
          const zoom = this.cameras.main.zoom;
          this.cameras.main.scrollX = this.pointerDown.scrollX - dx / zoom;
          this.cameras.main.scrollY = this.pointerDown.scrollY - dy / zoom;
          this.userAdjusted = true;
          this.hoverWorld = null;
          this.setHovered(null);
          this.clearHoverInfo();
          this.clampCamera();
        }
        return;
      }

      const worldPoint = this.cameras.main.getWorldPoint(pointer.x, pointer.y);
      this.hoverWorld = { x: worldPoint.x, y: worldPoint.y };
      this.setHovered(this.tileAtScreen(pointer.x, pointer.y));
      // 同一格内移动到另一条边时，格坐标不变，需要单独重绘路段手柄
      if (this.activeTool === 'segment') this.paintOverlays();
      this.updateHoverInfo(pointer);
    });

    const finishPointer = (pointer: Phaser.Input.Pointer): void => {
      const state = this.pointerDown;
      if (!state) return;
      this.pointerDown = null;
      const wasDrag = this.dragDistance > 4;

      const worldPoint = this.cameras.main.getWorldPoint(pointer.x, pointer.y);
      this.hoverWorld = { x: worldPoint.x, y: worldPoint.y };
      const tile = this.tileAtScreen(pointer.x, pointer.y);

      if (!wasDrag && state.button === 0) {
        if (this.lineEditorActive) {
          this.selectTile(tile);
          bus.emit('line:pick', tile);
        } else if (tile) {
          const neighbor = this.activeTool === 'segment' ? this.segmentNeighbor(tile) : null;
          this.selectTile(tile);
          if (this.activeTool !== 'inspect') {
            bus.emit('map:action', {
              tile,
              tool: this.activeTool,
              ...(neighbor ? { neighbor } : {}),
            });
            // 建造 / 拆除 / 剪接后强制刷新 Dock 的悬停读数
            bus.emit('tile:hover', tile);
          }
        } else {
          this.selectTile(null);
        }
      }

      this.setHovered(tile);
      if (this.activeTool === 'segment') this.paintOverlays();
      this.updateCursor();
      this.updateHoverInfo(pointer);
    };

    this.input.on('pointerup', finishPointer);
    this.input.on('pointerupoutside', finishPointer);
    this.input.on('gameout', () => {
      this.hoverWorld = null;
      this.setHovered(null);
      this.clearHoverInfo();
    });

    this.updateCursor();

    const keyboard = this.input.keyboard;
    if (keyboard) {
      this.panKeys = keyboard.addKeys('W,A,S,D,UP,LEFT,DOWN,RIGHT') as typeof this.panKeys;
    }
  }

  private tileAtScreen(sx: number, sy: number): Tile | null {
    const worldPoint = this.cameras.main.getWorldPoint(sx, sy);
    const axial = pixelToAxial(worldPoint.x, worldPoint.y, HEX_SIZE);
    return this.world.get(axial.q, axial.r) ?? null;
  }

  private handleResize(): void {
    if (!this.userAdjusted) {
      this.fitToMap();
    } else {
      this.clampCamera();
    }
  }

  private setHovered(tile: Tile | null): void {
    const axial = tile ? { q: tile.q, r: tile.r } : null;
    if (
      (axial === null && this.hovered === null) ||
      (axial && this.hovered && axial.q === this.hovered.q && axial.r === this.hovered.r)
    ) {
      return;
    }
    this.hovered = axial;
    this.refreshCoverage();
    this.paintOverlays();
    bus.emit('tile:hover', tile);
  }

  /** 供 URL 深链使用：按轴向坐标选中地块，并把镜头移到它附近。 */
  selectTileByAxial(q: number, r: number): void {
    const tile = this.world.get(q, r);
    if (!tile) return;
    this.selectTile(tile);

    const cam = this.cameras.main;
    if (cam.zoom < 0.9) cam.setZoom(0.9);
    cam.centerOn(tile.x, tile.y);
    this.userAdjusted = true;
    this.emitZoom();
    this.updateZoomState();
  }

  private selectTile(tile: Tile | null): void {
    this.selected = tile ? { q: tile.q, r: tile.r } : null;
    this.refreshCoverage();
    this.paintOverlays();
    bus.emit('tile:select', tile);
  }

  private updateCursor(): void {
    if (this.pointerDown) return;
    this.game.canvas.style.cursor =
      this.lineEditorActive || this.activeTool !== 'inspect' ? 'crosshair' : 'grab';
  }

  private paintOverlays(): void {
    this.hoverGfx.clear();
    this.selectGfx.clear();

    // 覆盖层用屏幕像素宽度换算到世界坐标，低倍率下也不会细成一条线
    const zoom = Math.max(this.cameras.main.zoom, 0.1);
    const screen = (px: number) => px / zoom;
    const hoveredTile = this.hovered ? this.world.get(this.hovered.q, this.hovered.r) : null;

    if (this.hovered) {
      const tile = hoveredTile;
      if (tile) {
        const points = this.pointsOf(tile);
        this.hoverGfx.fillStyle(COLORS.hover, 0.06);
        this.hoverGfx.fillPoints(points, true);
        this.hoverGfx.lineStyle(screen(1.4), COLORS.hover, 0.5);
        this.hoverGfx.strokePoints(points, true);
      }
    }

    if (this.network && hoveredTile && !this.lineEditorActive) {
      if (this.activeTool === 'track') {
        const quote = this.network.quoteTrack(hoveredTile);
        const color = quote.ok ? 0x8fe0b0 : 0xe07a6a;
        this.hoverGfx.lineStyle(screen(2.2), color, 0.55);
        for (const dir of HEX_DIRECTIONS) {
          const neighbor = this.world.get(
            hoveredTile.q + dir.q,
            hoveredTile.r + dir.r,
          );
          if (neighbor && this.network.hasTrack(neighbor)) {
            this.hoverGfx.lineBetween(hoveredTile.x, hoveredTile.y, neighbor.x, neighbor.y);
          }
        }
        this.hoverGfx.fillStyle(color, 0.22);
        this.hoverGfx.fillCircle(hoveredTile.x, hoveredTile.y, screen(7));
        this.hoverGfx.lineStyle(screen(1.6), color, 0.95);
        this.hoverGfx.strokeCircle(hoveredTile.x, hoveredTile.y, screen(7));
        this.hoverGfx.lineStyle(screen(1.1), color, 0.8);
        this.hoverGfx.lineBetween(
          hoveredTile.x - screen(4.5),
          hoveredTile.y,
          hoveredTile.x + screen(4.5),
          hoveredTile.y,
        );
        this.hoverGfx.lineBetween(
          hoveredTile.x,
          hoveredTile.y - screen(4.5),
          hoveredTile.x,
          hoveredTile.y + screen(4.5),
        );
      } else if (this.activeTool === 'station') {
        const def = STATION_DEFS[this.activeStationType];
        const quote = this.network.quoteStation(hoveredTile, this.activeStationType);
        this.drawStationIcon(
          this.hoverGfx,
          hoveredTile.x,
          hoveredTile.y,
          def,
          quote.ok ? 0x8fe0b0 : 0xe07a6a,
          0.78,
          zoom,
          true,
        );
      } else if (this.activeTool === 'demolish') {
        const hasStation = this.network.stationAt(hoveredTile) !== null;
        const hasTrack = this.network.hasTrack(hoveredTile);
        if (hasStation || hasTrack) {
          const r = HEX_SIZE * 0.34;
          this.hoverGfx.lineStyle(screen(2.6), 0xe07a6a, 0.95);
          this.hoverGfx.lineBetween(
            hoveredTile.x - r,
            hoveredTile.y - r,
            hoveredTile.x + r,
            hoveredTile.y + r,
          );
          this.hoverGfx.lineBetween(
            hoveredTile.x + r,
            hoveredTile.y - r,
            hoveredTile.x - r,
            hoveredTile.y + r,
          );
        }
      } else if (this.activeTool === 'segment') {
        const segment = this.segmentPreview(hoveredTile);
        if (segment) this.drawSegmentHandle(segment.from, segment.to, segment.enabled);
      }
    }

    if (this.selected) {
      const tile = this.world.get(this.selected.q, this.selected.r);
      if (tile) {
        const inner = this.pointsOf(tile);
        this.selectGfx.fillStyle(0xffffff, 0.12);
        this.selectGfx.fillPoints(inner, true);

        // 深色外描边 + 浅色内描边，保证在城镇的金色地块上也足够醒目
        this.selectGfx.lineStyle(screen(4.5), 0x1a1206, 0.55);
        this.selectGfx.strokePoints(inner, true);
        this.selectGfx.lineStyle(screen(2.2), 0xfff3d4, 1);
        this.selectGfx.strokePoints(inner, true);

        const outer = this.corners.map(
          (c) => new Phaser.Math.Vector2(tile.x + c.x * 1.16, tile.y + c.y * 1.16),
        );
        this.selectGfx.lineStyle(screen(1.2), COLORS.select, 0.8);
        this.selectGfx.strokePoints(outer, true);
      }
    }
  }

  /* ------------------------------ 工具 ------------------------------ */

  /** 根据指针在六边形内的朝向，选出要编辑的相邻地块。 */
  private segmentNeighbor(tile: Tile): Tile | null {
    if (!this.hoverWorld) return null;
    const dx = this.hoverWorld.x - tile.x;
    const dy = this.hoverWorld.y - tile.y;
    if (Math.hypot(dx, dy) < 8) return null; // 指向格心时不猜方向

    let bestDir = -1;
    let bestDot = -Infinity;
    for (let d = 0; d < 6; d++) {
      const dir = HEX_DIRECTIONS[d]!;
      const neighborPixel = this.tilePixel(tile.q + dir.q, tile.r + dir.r);
      const vx = neighborPixel.x - tile.x;
      const vy = neighborPixel.y - tile.y;
      const length = Math.hypot(vx, vy) || 1;
      const dot = (dx * vx + dy * vy) / length;
      if (dot > bestDot) {
        bestDot = dot;
        bestDir = d;
      }
    }

    if (bestDir < 0) return null;
    const dir = HEX_DIRECTIONS[bestDir]!;
    return this.world.get(tile.q + dir.q, tile.r + dir.r) ?? null;
  }

  private segmentPreview(tile: Tile): { from: Tile; to: Tile; enabled: boolean } | null {
    if (!this.network.hasTrack(tile)) return null;
    const neighbor = this.segmentNeighbor(tile);
    if (!neighbor || !this.network.hasTrack(neighbor)) return null;
    return {
      from: tile,
      to: neighbor,
      enabled: this.network.isLinkEnabled(tile, neighbor),
    };
  }

  private drawSegmentHandle(from: Tile, to: Tile, enabled: boolean): void {
    const g = this.hoverGfx;
    const zoom = Math.max(this.cameras.main.zoom, 0.1);
    const screen = (px: number) => px / zoom;
    const color = enabled ? 0xe07a6a : 0x7ee0a8;

    if (enabled) {
      // 当前有连接：红色高亮，提示点击后断开
      g.lineStyle(screen(4.5), color, 0.22);
      g.lineBetween(from.x, from.y, to.x, to.y);
      g.lineStyle(screen(1.2), color, 0.9);
      g.lineBetween(from.x, from.y, to.x, to.y);
    } else {
      // 已断开：绿色虚线 + 加号，提示点击后恢复
      const dash = screen(5);
      const gap = screen(4);
      const dx = to.x - from.x;
      const dy = to.y - from.y;
      const length = Math.hypot(dx, dy);
      if (length > 0.001) {
        const ux = dx / length;
        const uy = dy / length;
        g.lineStyle(screen(1.8), color, 0.75);
        for (let pos = 0; pos < length; pos += dash + gap) {
          const end = Math.min(length, pos + dash);
          g.lineBetween(
            from.x + ux * pos,
            from.y + uy * pos,
            from.x + ux * end,
            from.y + uy * end,
          );
        }
      }
    }

    // 共享边中点的圆形手柄
    const mx = (from.x + to.x) / 2;
    const my = (from.y + to.y) / 2;
    const radius = screen(9);
    g.fillStyle(0x0a1015, 0.94);
    g.fillCircle(mx, my, radius);
    g.lineStyle(screen(1.8), color, 1);
    g.strokeCircle(mx, my, radius);
    g.lineStyle(screen(1.6), color, 1);
    g.lineBetween(mx - screen(4), my, mx + screen(4), my);
    if (!enabled) {
      g.lineBetween(mx, my - screen(4), mx, my + screen(4));
    }
  }

  private pointsOf(tile: Tile): Phaser.Math.Vector2[] {
    return this.corners.map((c) => new Phaser.Math.Vector2(tile.x + c.x, tile.y + c.y));
  }

  private tilePixel(q: number, r: number): { x: number; y: number } {
    const tile = this.world.get(q, r);
    if (tile) return { x: tile.x, y: tile.y };
    return {
      x: HEX_SIZE * SQRT3 * (q + r / 2),
      y: HEX_SIZE * 1.5 * r,
    };
  }

  update(_time: number, delta: number): void {
    const cam = this.cameras.main;
    if (this.panKeys && !isTypingTarget()) {
      const speed = (820 * delta) / 1000 / cam.zoom;
      let dx = 0;
      let dy = 0;
      if (this.panKeys.A.isDown || this.panKeys.LEFT.isDown) dx -= speed;
      if (this.panKeys.D.isDown || this.panKeys.RIGHT.isDown) dx += speed;
      if (this.panKeys.W.isDown || this.panKeys.UP.isDown) dy -= speed;
      if (this.panKeys.S.isDown || this.panKeys.DOWN.isDown) dy += speed;
      if (dx !== 0 || dy !== 0) {
        cam.scrollX += dx;
        cam.scrollY += dy;
        this.userAdjusted = true;
        this.clampCamera();
      }
    }

    if (cam.zoom !== this.appliedZoom) {
      this.updateZoomState();
      this.emitZoom();
    }

    // 拖拽/缩放的钳制：保持世界中心不远离地图
    this.clampCamera();

    if (this.operations) {
      this.operations.update((delta / 1000) * this.simSpeed);
      this.drawTrains();
      this.drawTrucks();
      this.drainIncomeEvents();

      // 每 0.4 秒同步一次游戏时钟 / 收入 / 悬停客流
      this.simTickAccum += delta;
      if (this.simTickAccum >= 400) {
        this.simTickAccum = 0;
        this.drawStationPassengers();
        bus.emit('sim:tick', this.operations.clockView());
        if (this.hoverTarget) this.emitHoverInfo();
      }
    }
  }
}

/** 色调明暗，factor 1 为原色。 */
function shadeColor(color: number, factor: number): number {
  const r = Math.min(255, Math.max(0, Math.round(((color >> 16) & 0xff) * factor)));
  const g = Math.min(255, Math.max(0, Math.round(((color >> 8) & 0xff) * factor)));
  const b = Math.min(255, Math.max(0, Math.round((color & 0xff) * factor)));
  return (r << 16) | (g << 8) | b;
}

function isTypingTarget(): boolean {
  const el = document.activeElement;
  return el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement;
}
