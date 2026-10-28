import { formatMoney } from '../game/economy';
import type { NetworkStats, TileNetworkInfo } from '../game/network';
import {
  LINE_COLORS,
  PASSENGERS_PER_CAR,
  type ClockView,
  type LineSavePayload,
  type LineStop,
  type LineView,
  type MapTooltip,
  type PassengerKindCount,
  type RailView,
} from '../game/operations';
import {
  STATION_DEFS,
  STATION_TYPE_LIST,
  stationRadiusLabel,
  type StationType,
} from '../game/stations';
import { TRAIN_MODEL_LIST } from '../game/trains';
import { TERRAIN_DEFS, TERRAIN_LIST } from '../game/terrain';
import type { Tile, World } from '../game/world';
import type { BuildTool } from '../core/emitter';

export interface HudHandlers {
  regenerate(seedText: string): void;
  randomSeed(): void;
  zoom(factor: number): void;
  fit(): void;
  tool(tool: BuildTool): void;
  stationType(type: StationType): void;
  setSpeed(speed: number): void;
  tileInfo(tile: Tile): TileNetworkInfo;
  buildTrack(tile: Tile): void;
  buildStation(tile: Tile): void;
  remove(tile: Tile): void;
  startLineCreate(): void;
  editLine(id: number): void;
  deleteLine(id: number): void;
  saveLine(input: LineSavePayload): void;
  cancelLineEditor(): void;
  hoverLine(id: number | null): void;
  purchaseTrain(modelId: string): void;
  purchaseTruck(): void;
  railView(): RailView;
  assignTrain(trainId: number, lineId: number): void;
  unassignTrain(trainId: number): void;
}

export interface Hud {
  bindWorld(world: World): void;
  setNetworkStats(stats: NetworkStats): void;
  setRailView(view: RailView): void;
  setClock(view: ClockView, credits: number): void;
  showMapTooltip(tooltip: MapTooltip | null): void;
  showTile(tile: Tile | null): void;
  refreshSelected(): void;
  hoverTile(tile: Tile | null): void;
  setZoom(zoom: number): void;
  setSeed(seed: number): void;
  setTool(tool: BuildTool): void;
  setStationType(type: StationType): void;
  openLineEditor(line: LineView | null, defaultName: string): void;
  closeLineEditor(): void;
  addDraftStop(stop: LineStop): void;
  toast(message: string): void;
}

const TOOL_HINTS: Record<BuildTool, string> = {
  inspect: '拖动平移 · 滚轮缩放 · 点击地块',
  track: '点击地块铺轨，相邻轨道自动连接',
  station: '选择站型后点击地块建站',
  demolish: '点击轨道或车站拆除，返还 50%',
  segment: '点击相邻轨道连接处断开 / 恢复',
};

interface DraftLine {
  id: number | null;
  color: number;
  colorCss: string;
  isLoop: boolean;
  stops: LineStop[];
}

export function createHud(handlers: HudHandlers): Hud {
  /* ------------------------------ 元素 ------------------------------ */

  const seedInput = el<HTMLInputElement>('seed-input');
  const legend = el<HTMLUListElement>('legend');
  const dockStatus = el<HTMLSpanElement>('dock-status');
  const dockInfo = document.querySelector<HTMLDivElement>('.dock-info');
  const inspectorEmpty = el<HTMLDivElement>('inspector-empty');
  const inspectorBody = el<HTMLDivElement>('inspector-body');
  const inspectorPanel = document.getElementById('panel-right');
  const tileCoord = el<HTMLSpanElement>('tile-coord');
  const tileDot = el<HTMLSpanElement>('tile-dot');
  const tileName = el<HTMLElement>('tile-name');
  const tileBlob = el<HTMLElement>('tile-blob');
  const tileCost = el<HTMLSpanElement>('tile-cost');
  const tileDesc = el<HTMLElement>('tile-desc');
  const tileDemand = el<HTMLElement>('tile-demand');
  const tileTrack = el<HTMLElement>('tile-track');
  const tileStation = el<HTMLElement>('tile-station');
  const tileCoverage = el<HTMLElement>('tile-coverage');
  const barElev = el<HTMLElement>('bar-elev');
  const barMoist = el<HTMLElement>('bar-moist');
  const barEcon = el<HTMLElement>('bar-econ');
  const valElev = el<HTMLElement>('val-elev');
  const valMoist = el<HTMLElement>('val-moist');
  const valEcon = el<HTMLElement>('val-econ');
  const facilityCard = el<HTMLDivElement>('facility-card');
  const facilityDot = el<HTMLElement>('facility-dot');
  const facilityName = el<HTMLElement>('facility-name');
  const facilityType = el<HTMLElement>('facility-type');
  const facilityCoverage = el<HTMLElement>('facility-coverage');
  const facilityConnect = el<HTMLElement>('facility-connect');
  const actionTrack = el<HTMLButtonElement>('action-track');
  const actionStation = el<HTMLButtonElement>('action-station');
  const actionRemove = el<HTMLButtonElement>('action-remove');
  const inspectorHint = document.querySelector<HTMLParagraphElement>('.hint');
  const worldTotal = el<HTMLElement>('world-total');
  const worldLand = el<HTMLElement>('world-land');
  const worldTowns = el<HTMLElement>('world-towns');
  const worldIndustry = el<HTMLElement>('world-industry');
  const moneyEl = el<HTMLElement>('stat-money');
  const statStations = el<HTMLElement>('stat-stations');
  const statTracks = el<HTMLElement>('stat-tracks');
  const statTrains = el<HTMLElement>('stat-trains');
  const statLines = el<HTMLElement>('stat-lines');
  const statDay = el<HTMLElement>('stat-day');
  const statClock = el<HTMLElement>('stat-clock');
  const networkNote = el<HTMLElement>('network-note');
  const mapTooltip = el<HTMLDivElement>('map-tooltip');
  const zoomReadout = el<HTMLElement>('zoom-readout');
  const toastEl = el<HTMLDivElement>('toast');
  const boot = el<HTMLDivElement>('boot');
  const stationPicker = el<HTMLDivElement>('station-picker');
  const stationOptions = el<HTMLDivElement>('station-options');
  const stationButtons: HTMLButtonElement[] = [];
  const toolButtons = Array.from(document.querySelectorAll<HTMLButtonElement>('.tool[data-tool]'));
  const speedButtons = Array.from(document.querySelectorAll<HTMLButtonElement>('.speed-btn'));

  const lineCount = el<HTMLElement>('line-count');
  const lineNew = el<HTMLButtonElement>('line-new');
  const lineEmpty = el<HTMLDivElement>('line-empty');
  const lineList = el<HTMLDivElement>('line-list');
  const lineEditor = el<HTMLDivElement>('line-editor');
  const lineEditorTitle = el<HTMLElement>('line-editor-title');
  const lineEditorCount = el<HTMLElement>('line-editor-count');
  const lineNameInput = el<HTMLInputElement>('line-name');
  const lineColors = el<HTMLDivElement>('line-colors');
  const lineLoopButtons = Array.from(document.querySelectorAll<HTMLButtonElement>('[data-loop]'));
  const lineStops = el<HTMLDivElement>('line-stops');
  const lineClearStops = el<HTMLButtonElement>('line-clear-stops');
  const lineCancel = el<HTMLButtonElement>('line-cancel');
  const lineSave = el<HTMLButtonElement>('line-save');

  const garageButton = el<HTMLButtonElement>('garage-button');
  const garageModal = el<HTMLDivElement>('garage-modal');
  const garageBackdrop = el<HTMLDivElement>('garage-backdrop');
  const garageClose = el<HTMLButtonElement>('garage-close');
  const garageMoney = el<HTMLElement>('garage-money');
  const garageBody = el<HTMLDivElement>('garage-body');

  const confirmModal = el<HTMLDivElement>('confirm-modal');
  const confirmBackdrop = el<HTMLDivElement>('confirm-backdrop');
  const confirmClose = el<HTMLButtonElement>('confirm-close');
  const confirmTitle = el<HTMLElement>('confirm-title');
  const confirmSub = el<HTMLElement>('confirm-sub');
  const confirmText = el<HTMLElement>('confirm-text');
  const confirmCancel = el<HTMLButtonElement>('confirm-cancel');
  const confirmOk = el<HTMLButtonElement>('confirm-ok');

  /* ------------------------------ 状态 ------------------------------ */

  let toastTimer = 0;
  let activeTool: BuildTool = 'inspect';
  let activeStationType: StationType = 'light';
  let hoveredTile: Tile | null = null;
  let selectedTile: Tile | null = null;
  let bootHidden = false;
  let currentWorld: World | null = null;
  let railView: RailView | null = null;
  let lastStats: NetworkStats | null = null;
  let lineDraft: DraftLine | null = null;
  let revenueToday = 0;
  let opexToday = 0;
  /** 当前模拟速度与暂停前的速度，供空格键恢复。 */
  let currentSpeed = 1;
  let resumeSpeed = 1;
  let tooltipSignature = '';
  let stopDragIndex: number | null = null;
  let garageOpen = false;
  let garagePreferredLineId: number | null = null;
  let confirmOpen = false;
  let confirmResolve: ((ok: boolean) => void) | null = null;
  const lineColorButtons: { button: HTMLButtonElement; color: number; css: string }[] = [];

  // 站型选择条由数据生成，避免和 stations.ts 的造价 / 半径出现漂移
  for (const def of STATION_TYPE_LIST) {
    const button = document.createElement('button');
    button.className = 'station-option';
    button.dataset.stationType = def.type;
    button.title = `${def.name}：${def.description}`;

    const dot = document.createElement('span');
    dot.className = 'station-dot';
    dot.style.setProperty('--c', def.colorCss);

    const name = document.createElement('span');
    name.className = 'station-opt-name';
    name.textContent = def.name;

    const meta = document.createElement('span');
    meta.className = 'station-opt-meta';
    meta.textContent =
      def.type === 'freight'
        ? `工业区 · ¥${Math.round(def.cost / 1000)}k · 自动货单`
        : `半径 ${def.radius} · ¥${Math.round(def.cost / 1000)}k · ${def.dailyDemand} 人/日`;

    button.append(dot, name, meta);
    button.addEventListener('click', () => {
      applyStationType(def.type, true);
    });
    stationOptions.append(button);
    stationButtons.push(button);
  }

  // 线路色板
  for (const option of LINE_COLORS) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'line-color';
    button.style.setProperty('--line', option.css);
    button.title = option.name;
    button.addEventListener('click', () => {
      if (!lineDraft) return;
      lineDraft.color = option.color;
      lineDraft.colorCss = option.css;
      updateEditorPalette();
    });
    lineColors.append(button);
    lineColorButtons.push({ button, color: option.color, css: option.css });
  }

  /* ------------------------------ 确认框 ------------------------------ */

  interface ConfirmOptions {
    title: string;
    sub: string;
    message: string;
    okText: string;
  }

  /** 关闭确认框并回传结果；重复调用不会重复 resolve。 */
  function closeConfirm(ok: boolean): void {
    if (!confirmOpen) return;
    confirmOpen = false;
    confirmModal.classList.add('hidden');
    const resolve = confirmResolve;
    confirmResolve = null;
    resolve?.(ok);
  }

  function askConfirm(options: ConfirmOptions): Promise<boolean> {
    if (confirmOpen) closeConfirm(false);
    confirmOpen = true;
    confirmTitle.textContent = options.title;
    confirmSub.textContent = options.sub;
    confirmText.textContent = options.message;
    confirmOk.textContent = options.okText;
    confirmModal.classList.remove('hidden');
    confirmOk.focus();
    return new Promise((resolve) => {
      confirmResolve = resolve;
    });
  }

  confirmCancel.addEventListener('click', () => closeConfirm(false));
  confirmClose.addEventListener('click', () => closeConfirm(false));
  confirmBackdrop.addEventListener('click', () => closeConfirm(false));
  confirmOk.addEventListener('click', () => closeConfirm(true));

  /** 重新生成必然清空存档，先让玩家确认。 */
  function requestRegenerate(seedText: string): void {
    const cleaned = seedText.trim();
    void askConfirm({
      title: '重新生成地图？',
      sub: '清空存档',
      message: `用种子「${cleaned || '随机'}」重新生成，并删除当前存档。`,
      okText: '清空并生成',
    }).then((ok) => {
      if (ok) handlers.regenerate(seedText);
    });
  }

  function requestRandomSeed(): void {
    void askConfirm({
      title: '随机种子重开？',
      sub: '清空存档',
      message: '随机生成新地图，并删除当前存档。',
      okText: '清空并生成',
    }).then((ok) => {
      if (ok) handlers.randomSeed();
    });
  }

  /* ------------------------------ 顶栏 / 种子 ------------------------------ */

  el<HTMLButtonElement>('regenerate').addEventListener('click', () =>
    requestRegenerate(seedInput.value),
  );
  el<HTMLButtonElement>('random-seed').addEventListener('click', requestRandomSeed);
  seedInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      requestRegenerate(seedInput.value);
      seedInput.blur();
    }
  });

  el<HTMLButtonElement>('zoom-in').addEventListener('click', () => handlers.zoom(1.25));
  el<HTMLButtonElement>('zoom-out').addEventListener('click', () => handlers.zoom(0.8));
  el<HTMLButtonElement>('zoom-fit').addEventListener('click', handlers.fit);

  el<HTMLButtonElement>('inspector-close').addEventListener('click', () => {
    inspectorPanel?.classList.remove('is-open');
  });

  /* ------------------------------ 建造 / 拆除 ------------------------------ */

  actionTrack.addEventListener('click', () => {
    if (selectedTile) handlers.buildTrack(selectedTile);
  });
  actionStation.addEventListener('click', () => {
    if (selectedTile) handlers.buildStation(selectedTile);
  });
  actionRemove.addEventListener('click', () => {
    if (selectedTile) handlers.remove(selectedTile);
  });

  for (const button of lineLoopButtons) {
    button.addEventListener('click', () => {
      if (!lineDraft) return;
      lineDraft.isLoop = button.dataset.loop === '1';
      updateEditorLoop();
    });
  }

  function applySpeed(speed: number): void {
    currentSpeed = speed;
    if (speed > 0) resumeSpeed = speed;
    for (const button of speedButtons) {
      button.classList.toggle('is-active', Number(button.dataset.speed ?? 0) === speed);
    }
    handlers.setSpeed(speed);
  }

  for (const button of speedButtons) {
    button.addEventListener('click', () => {
      applySpeed(Number(button.dataset.speed ?? 1));
    });
  }

  /* ------------------------------ 线路 / 车库 ------------------------------ */

  lineNew.addEventListener('click', () => handlers.startLineCreate());
  el<HTMLButtonElement>('new-line').addEventListener('click', () => handlers.startLineCreate());

  lineCancel.addEventListener('click', () => handlers.cancelLineEditor());
  lineSave.addEventListener('click', () => saveLineDraft());
  lineClearStops.addEventListener('click', () => {
    if (!lineDraft) return;
    lineDraft.stops = [];
    renderDraftStops();
  });
  lineNameInput.addEventListener('input', updateEditorState);
  lineNameInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !lineSave.disabled) {
      event.preventDefault();
      saveLineDraft();
    }
  });

  garageButton.addEventListener('click', () => openGarage(null));
  garageClose.addEventListener('click', closeGarage);
  garageBackdrop.addEventListener('click', closeGarage);

  /* ------------------------------ 工具栏 ------------------------------ */

  for (const button of toolButtons) {
    button.addEventListener('click', () => {
      const tool = (button.dataset.tool ?? 'inspect') as BuildTool;
      selectTool(tool, true);
    });
  }

  /* ------------------------------ 键盘 ------------------------------ */

  window.addEventListener('keydown', (event) => {
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    if (isTypingTarget()) return;
    const key = event.key.toLowerCase();

    if (key === 'escape') {
      if (confirmOpen) closeConfirm(false);
      else if (garageOpen) closeGarage();
      else if (lineDraft) handlers.cancelLineEditor();
      return;
    }

    if (confirmOpen) return;

    if (event.code === 'Space' || key === ' ') {
      applySpeed(currentSpeed === 0 ? resumeSpeed : 0);
      event.preventDefault();
      return;
    }

    if (key >= '1' && key <= '5') {
      const tool = (['inspect', 'track', 'station', 'demolish', 'segment'] as BuildTool[])[
        Number(key) - 1
      ]!;
      selectTool(tool, true);
      event.preventDefault();
    } else if (key === 'b') {
      openGarage(null);
      event.preventDefault();
    } else if (key === 'f') {
      handlers.fit();
      event.preventDefault();
    } else if (key === 'g') {
      requestRegenerate(seedInput.value);
      event.preventDefault();
    } else if (key === '+' || key === '=') {
      handlers.zoom(1.25);
      event.preventDefault();
    } else if (key === '-') {
      handlers.zoom(0.8);
      event.preventDefault();
    }
  });

  /* ------------------------------ 世界数据 ------------------------------ */

  function bindWorld(world: World): void {
    currentWorld = world;
    worldTotal.textContent = String(world.stats.total);
    worldLand.textContent = `${Math.round((world.stats.land / world.stats.total) * 100)}%`;
    worldTowns.textContent = `${world.stats.townBlobs} 片`;
    worldIndustry.textContent = `${world.stats.industryBlobs} 片`;
    seedInput.value = String(world.seed);

    legend.replaceChildren();
    for (const def of TERRAIN_LIST) {
      const count = world.stats.counts[def.id];
      const share = ((count / world.stats.total) * 100).toFixed(1);
      const li = document.createElement('li');
      li.title = `${def.name}：${def.description}`;

      const swatch = document.createElement('span');
      swatch.className = 'swatch';
      swatch.style.background = def.colorCss;

      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = def.name;

      const shareEl = document.createElement('span');
      shareEl.className = 'share';
      shareEl.textContent = `${share}%`;

      const cost = document.createElement('span');
      cost.className = `cost${def.id === 'WATER' ? ' is-water' : ''}`;
      cost.textContent = `×${def.costFactor.toFixed(1)}`;

      li.append(swatch, name, shareEl, cost);
      legend.append(li);
    }

    if (!bootHidden) {
      bootHidden = true;
      boot.classList.add('is-hidden');
      window.setTimeout(() => {
        boot.style.display = 'none';
      }, 600);
    }
  }

  function setNetworkStats(stats: NetworkStats): void {
    lastStats = stats;
    moneyEl.textContent = formatMoney(stats.credits);
    moneyEl.classList.toggle('is-low', stats.credits < 60_000);
    statStations.textContent = String(stats.stations);
    statTracks.textContent = String(stats.tracks);
    statTrains.textContent = String(railView?.trains.length ?? 0);
    statLines.textContent = String(railView?.lines.length ?? 0);
    updateNetworkNote();
    if (garageOpen) renderGarage();
  }

  function setRailView(view: RailView): void {
    railView = view;
    statTrains.textContent = String(view.trains.length);
    statLines.textContent = String(view.lines.length);
    lineCount.textContent = String(view.lines.length);
    renderLines();
    updateLineSectionVisibility();
    updateNetworkNote();
    if (garageOpen) renderGarage();
  }

  function updateNetworkNote(): void {
    const connected = lastStats
      ? `${lastStats.connectedStations} / ${lastStats.stations}`
      : '0 / 0';
    const inventory = railView?.inventory.length ?? 0;
    networkNote.textContent = `连通 ${connected} · 库存 ${inventory} · 今日 +${formatMoney(revenueToday)} · 成本 ${formatMoney(opexToday)}`;
  }

  /** 时间 Tick：更新日期、资金与今日收入 / 运行成本，不重建线路 / 车库 DOM。 */
  function setClock(view: ClockView, credits: number): void {
    statDay.textContent = String(view.day);
    statClock.textContent = view.time;
    revenueToday = view.revenueToday;
    opexToday = view.opexToday;
    moneyEl.textContent = formatMoney(credits);
    moneyEl.classList.toggle('is-low', credits < 60_000);
    if (lastStats) lastStats.credits = credits;
    updateNetworkNote();
    if (garageOpen) garageMoney.textContent = formatMoney(credits);
  }

  /* ------------------------------ 悬停浮层 ------------------------------ */

  function showMapTooltip(tooltip: MapTooltip | null): void {
    if (!tooltip) {
      mapTooltip.classList.add('hidden');
      tooltipSignature = '';
      return;
    }

    const signature =
      tooltip.kind === 'station'
        ? `s|${tooltip.station.key}|${tooltip.station.waiting}|${tooltip.station.transferring}|${tooltip.station.dailyDemand}|${tooltip.station.avgEcon.toFixed(3)}|${tooltip.station.econFactor.toFixed(3)}|${tooltip.station.cargoWaiting}|${tooltip.station.generatedToday}|${tooltip.station.boardedToday}|${tooltip.station.deliveredToday}|${tooltip.station.gaveUpToday}|${tooltip.station.kinds.map((item) => `${item.kind}:${item.count}`).join(',')}|${tooltip.station.destinations.map((item) => `${item.name}:${item.count}`).join(',')}|${tooltip.station.lines.map((line) => line.name).join(',')}`
        : tooltip.kind === 'truck'
          ? `k|${tooltip.truck.id}|${tooltip.truck.state}|${tooltip.truck.loaded}|${tooltip.truck.order?.originName ?? ''}|${tooltip.truck.order?.destName ?? ''}|${tooltip.truck.order?.amount ?? 0}|${tooltip.truck.order?.reward ?? 0}|${tooltip.truck.revenueToday}|${tooltip.truck.deliveriesToday}|${tooltip.truck.opexToday}|${tooltip.truck.opexTotal}`
          : `t|${tooltip.train.id}|${tooltip.train.lineName}|${tooltip.train.state}|${tooltip.train.speed}|${tooltip.train.onboard}|${tooltip.train.carLoads.join(',')}|${tooltip.train.kinds.map((item) => `${item.kind}:${item.count}`).join(',')}|${tooltip.train.nextStopName}|${tooltip.train.revenueToday}|${tooltip.train.deliveredToday}|${tooltip.train.opexToday}|${tooltip.train.opexTotal}|${tooltip.train.destinations.map((item) => `${item.name}:${item.count}`).join(',')}`;

    if (signature !== tooltipSignature) {
      tooltipSignature = signature;
      mapTooltip.replaceChildren();
      mapTooltip.classList.toggle('is-train', tooltip.kind === 'train');
      mapTooltip.classList.toggle('is-truck', tooltip.kind === 'truck');
      mapTooltip.style.setProperty(
        '--tip',
        tooltip.kind === 'station'
          ? STATION_DEFS[tooltip.station.type].colorCss
          : tooltip.kind === 'train'
            ? tooltip.train.lineColorCss
            : '#9aa5ae',
      );

      const head = document.createElement('div');
      head.className = 'tip-head';
      const dot = document.createElement('span');
      dot.className = 'tip-dot';
      const title = document.createElement('strong');
      title.className = 'tip-title';
      const badge = document.createElement('span');
      badge.className = 'tip-badge';

      if (tooltip.kind === 'station') {
        const station = tooltip.station;
        title.textContent = station.name;
        badge.textContent = STATION_DEFS[station.type].name;
        head.append(dot, title, badge);
        mapTooltip.append(head);

        if (station.type === 'freight') {
          mapTooltip.append(
            tipSub(`覆盖 ${station.coverage} / ${station.demandTiles} 格`),
          );
          mapTooltip.append(tipRow('货单', `${station.cargoWaiting} 单待运`));
          mapTooltip.append(tipRow('说明', '自动接单 · 沿轨道行驶'));
        } else {
          mapTooltip.append(
            tipSub(
              `日需求 ${station.dailyDemand} 人 · 经济 ×${station.econFactor.toFixed(2)} · 覆盖 ${station.coverage} / ${station.demandTiles} 格`,
            ),
          );
          mapTooltip.append(tipRow('候车', `${station.waiting} 人${station.transferring > 0 ? `（换乘 ${station.transferring}）` : ''}`));
          const stationKinds = tipKindRow(station.kinds);
          if (stationKinds) mapTooltip.append(stationKinds);
          mapTooltip.append(
            tipRow(
              '今日',
              `生成 ${station.generatedToday} · 上车 ${station.boardedToday} · 送达 ${station.deliveredToday}`,
            ),
          );
          if (station.destinations.length > 0) {
            const dest = station.destinations
              .slice(0, 3)
              .map((item) => `${item.name} ×${item.count}`)
              .join(' · ');
            mapTooltip.append(
              tipRow('去往', `${dest}${station.destinations.length > 3 ? ' …' : ''}`),
            );
          }
          if (station.gaveUpToday > 0) {
            mapTooltip.append(tipRow('放弃', `${station.gaveUpToday} 人`));
          }
        }

        const lineNames = station.lines.map((line) => line.name).join(' · ');
        mapTooltip.append(tipRow('线路', lineNames.length > 0 ? lineNames : '暂无线路'));
      } else if (tooltip.kind === 'train') {
        const train = tooltip.train;
        title.textContent = train.lineName ?? '库存列车';
        badge.textContent = `#${train.id} · ${train.modelName}`;
        head.append(dot, title, badge);
        mapTooltip.append(head);
        mapTooltip.append(tipRow('状态', `${train.state} · ${train.cars} 节`));
        mapTooltip.append(tipRow('载客', `${train.onboard} / ${train.capacity} 人`));
        const trainKinds = tipKindRow(train.kinds);
        if (trainKinds) mapTooltip.append(trainKinds);
        mapTooltip.append(
          tipRow(
            '车厢',
            train.carLoads.map((load) => `${load}/${PASSENGERS_PER_CAR}`).join(' · '),
          ),
        );
        mapTooltip.append(
          tipRow(train.state === '停站中' ? '本站' : '下一站', train.nextStopName ?? '—'),
        );
        mapTooltip.append(
          tipRow('今日', `送达 ${train.deliveredToday} 人 · 收入 ${formatMoney(train.revenueToday)}`),
        );
        mapTooltip.append(
          tipRow('成本', `今日 ${formatMoney(train.opexToday)} / 累计 ${formatMoney(train.opexTotal)}`),
        );
        if (train.destinations.length > 0) {
          const dest = train.destinations
            .slice(0, 3)
            .map((item) => `${item.name} ×${item.count}`)
            .join(' · ');
          mapTooltip.append(
            tipRow('去往', `${dest}${train.destinations.length > 3 ? ' …' : ''}`),
          );
        }
        mapTooltip.append(
          tipRow('速度', train.state === '停站中' ? '停站中' : `${train.speed} px/s`),
        );
      } else {
        const truck = tooltip.truck;
        title.textContent = `货运列车 #${truck.id}`;
        badge.textContent = truck.state;
        head.append(dot, title, badge);
        mapTooltip.append(head);
        mapTooltip.append(tipRow('载货', truck.loaded ? '已载货' : '空车'));
        if (truck.order) {
          mapTooltip.append(
            tipRow('货单', `${truck.order.originName} → ${truck.order.destName}`),
          );
          mapTooltip.append(
            tipRow(
              '货物',
              `${truck.order.amount} 件 · 运费 ${formatMoney(truck.order.reward)}`,
            ),
          );
        } else {
          mapTooltip.append(tipRow('货单', '等待接单'));
        }
        mapTooltip.append(
          tipRow('今日', `送达 ${truck.deliveriesToday} 单 · 收入 ${formatMoney(truck.revenueToday)}`),
        );
        mapTooltip.append(
          tipRow('成本', `今日 ${formatMoney(truck.opexToday)} / 累计 ${formatMoney(truck.opexTotal)}`),
        );
      }
    }

    mapTooltip.classList.remove('hidden');

    // 先测量再翻转，避免浮层超出窗口
    const margin = 14;
    const width = mapTooltip.offsetWidth;
    const height = mapTooltip.offsetHeight;
    let left = tooltip.x + margin;
    let top = tooltip.y + margin;
    if (left + width > window.innerWidth - 8) left = tooltip.x - width - margin;
    if (top + height > window.innerHeight - 8) top = tooltip.y - height - margin;
    mapTooltip.style.left = `${Math.max(8, left)}px`;
    mapTooltip.style.top = `${Math.max(8, top)}px`;
  }

  function tipRow(label: string, value: string): HTMLDivElement {
    const row = document.createElement('div');
    row.className = 'tip-row';
    const labelEl = document.createElement('span');
    labelEl.className = 'tip-label';
    labelEl.textContent = label;
    const valueEl = document.createElement('span');
    valueEl.className = 'tip-value';
    valueEl.textContent = value;
    row.append(labelEl, valueEl);
    return row;
  }

  function tipSub(text: string): HTMLParagraphElement {
    const paragraph = document.createElement('p');
    paragraph.className = 'tip-sub';
    paragraph.textContent = text;
    return paragraph;
  }

  /** 用彩色小圆点展示乘客类型构成。 */
  function tipKindRow(kinds: PassengerKindCount[]): HTMLDivElement | null {
    if (kinds.length === 0) return null;
    const row = tipRow('类型', '');
    const value = row.querySelector<HTMLElement>('.tip-value');
    if (!value) return row;
    const wrap = document.createElement('span');
    wrap.className = 'tip-kinds';
    for (const item of kinds) {
      const chip = document.createElement('span');
      chip.className = 'tip-kind';
      const dot = document.createElement('i');
      dot.style.background = item.colorCss;
      chip.append(dot, document.createTextNode(`${item.name} ${item.count}`));
      wrap.append(chip);
    }
    value.append(wrap);
    return row;
  }

  /* ------------------------------ 地块面板 ------------------------------ */

  function showTile(tile: Tile | null): void {
    if (!tile) {
      selectedTile = null;
      inspectorEmpty.classList.remove('hidden');
      inspectorBody.classList.add('hidden');
      tileCoord.textContent = '—';
      inspectorPanel?.classList.remove('is-open');
      return;
    }

    renderTile(tile, true);
  }

  function renderTile(tile: Tile, openOnNarrow: boolean): void {
    selectedTile = tile;
    const info = handlers.tileInfo(tile);
    const def = TERRAIN_DEFS[tile.terrain];

    inspectorEmpty.classList.add('hidden');
    inspectorBody.classList.remove('hidden');
    if (openOnNarrow && window.innerWidth <= 1180) inspectorPanel?.classList.add('is-open');

    tileCoord.textContent = `${tile.q}, ${tile.r}`;
    tileDot.style.background = def.colorCss;
    tileName.textContent = def.name;
    tileDesc.textContent = def.description;
    tileCost.textContent = `×${def.costFactor.toFixed(1)}`;
    tileCost.title =
      tile.terrain === 'WATER' ? '水域：桥梁 / 隧道按系数计价' : '建造成本系数';
    tileDemand.textContent = def.demand;

    let blobLabel = '无连片';
    if (tile.blobId !== null && currentWorld) {
      const blob = currentWorld.blobById.get(tile.blobId);
      if (blob) {
        blobLabel = `${blob.kind === 'town' ? '城镇' : '工业'} · ${blob.name} · ${blob.size} 格`;
      }
    }
    if (tile.river) blobLabel += ' · 河流';
    tileBlob.textContent = blobLabel;

    tileTrack.textContent = info.hasTrack ? `已铺轨 · ${info.connections} 向` : '未铺设';
    tileStation.textContent = info.station
      ? `${STATION_DEFS[info.station.type].name} · ${info.station.name}`
      : '无';
    tileCoverage.textContent = info.station
      ? `${info.station.coverage.length} / ${info.station.demandTiles} 格`
      : info.coveredBy > 0
        ? `${info.coveredBy} 站覆盖`
        : '未覆盖';

    const elev = Math.round(tile.elevation * 100);
    const moist = Math.round(tile.moisture * 100);
    const econ = Math.round(tile.econ * 100);
    barElev.style.width = `${elev}%`;
    barMoist.style.width = `${moist}%`;
    barEcon.style.width = `${econ}%`;
    valElev.textContent = (elev / 100).toFixed(2);
    valMoist.textContent = `${moist}%`;
    valEcon.textContent = `${econ}%`;

    renderFacility(info);
    renderActions(info);

    if (inspectorHint) {
      inspectorHint.textContent =
        info.credits < 20_000
          ? '资金不足，可拆除返还 50% 或重新生成地图。'
          : '建造立即扣款，拆除返还 50%。';
    }
  }

  function renderFacility(info: TileNetworkInfo): void {
    if (!info.station) {
      facilityCard.classList.add('hidden');
      return;
    }

    const station = info.station;
    const def = STATION_DEFS[station.type];
    const disconnected = station.connectedStations < 2;
    facilityCard.classList.remove('hidden');
    facilityCard.classList.toggle('is-warning', disconnected);
    facilityDot.style.background = def.colorCss;
    facilityDot.style.boxShadow = `0 0 10px ${def.colorCss}`;
    facilityName.textContent = station.name;
    facilityType.textContent = `${def.name} · ${stationRadiusLabel(station.type)}`;
    facilityCoverage.textContent = `${station.coverage.length} / ${station.demandTiles} 格`;
    facilityConnect.textContent = disconnected
      ? '孤立'
      : `${station.connectedStations} 站同网`;
  }

  function renderActions(info: TileNetworkInfo): void {
    actionTrack.disabled = info.hasTrack || !info.trackQuote.ok;
    actionTrack.textContent = info.hasTrack
      ? '轨道已铺设'
      : `铺设轨道 · ${compactMoney(info.trackQuote.cost)}`;
    actionTrack.title = info.trackQuote.reason ?? '';

    actionStation.disabled = info.station !== null || !info.stationQuote.ok;
    actionStation.textContent = info.station
      ? '车站已建成'
      : `建造${STATION_DEFS[info.stationType].name} · ${compactMoney(info.stationQuote.cost)}`;
    actionStation.title = info.stationQuote.reason ?? '';

    const removable = info.station !== null || info.hasTrack;
    actionRemove.classList.toggle('hidden', !removable);
    actionRemove.textContent = info.station
      ? '拆除车站'
      : `拆除轨道 · 返还 ${compactMoney(Math.round(info.trackPaid * 0.5))}`;
    actionRemove.title = info.station
      ? '拆除车站，返还 50% 车站建造费'
      : '拆除轨道，返还 50% 铺轨费';
  }

  /* ------------------------------ 线路列表 / 编辑器 ------------------------------ */

  function renderLines(): void {
    lineList.replaceChildren();
    const lines = railView?.lines ?? [];
    if (lines.length === 0) return;

    for (const line of lines) {
      const card = document.createElement('div');
      card.className = 'line-card';
      card.dataset.lineId = String(line.id);

      card.addEventListener('mouseenter', () => handlers.hoverLine(line.id));
      card.addEventListener('mouseleave', () => handlers.hoverLine(null));

      const head = document.createElement('div');
      head.className = 'line-card-head';

      const swatch = document.createElement('span');
      swatch.className = 'line-swatch';
      swatch.style.setProperty('--line', line.colorCss);

      const name = document.createElement('strong');
      name.className = 'line-name';
      name.textContent = line.name;

      const status = document.createElement('span');
      status.className = `line-status${line.status === 'BROKEN' ? ' is-broken' : ''}`;
      status.textContent = line.status === 'OK' ? '正常' : '断开';

      const trainCount = document.createElement('span');
      trainCount.className = 'line-train-count';
      trainCount.textContent = `${line.trainCount} 列`;

      head.append(swatch, name, status, trainCount);

      const stops = document.createElement('p');
      stops.className = 'line-stops';
      stops.textContent = line.stops.map((stop) => stop.name).join(' → ');
      stops.title = stops.textContent;

      const actions = document.createElement('div');
      actions.className = 'line-actions';

      const assign = lineAction('配车');
      assign.addEventListener('click', (event) => {
        event.stopPropagation();
        handlers.hoverLine(null);
        openGarage(line.id);
      });

      const edit = lineAction('编辑');
      edit.addEventListener('click', (event) => {
        event.stopPropagation();
        handlers.hoverLine(null);
        handlers.editLine(line.id);
      });

      const remove = lineAction('删除', true);
      remove.addEventListener('click', (event) => {
        event.stopPropagation();
        if (!window.confirm(`删除「${line.name}」？列车会退回库存。`)) return;
        handlers.hoverLine(null);
        handlers.deleteLine(line.id);
      });

      actions.append(assign, edit, remove);
      card.append(head, stops, actions);
      lineList.append(card);
    }
  }

  function lineAction(label: string, danger = false): HTMLButtonElement {
    const button = document.createElement('button');
    button.className = `line-action${danger ? ' is-danger' : ''}`;
    button.textContent = label;
    return button;
  }

  function updateLineSectionVisibility(): void {
    const hasLines = (railView?.lines.length ?? 0) > 0;
    if (lineDraft) {
      lineEmpty.classList.add('hidden');
      lineList.classList.add('hidden');
      lineEditor.classList.remove('hidden');
      lineNew.classList.add('hidden');
    } else {
      lineEditor.classList.add('hidden');
      lineNew.classList.remove('hidden');
      lineEmpty.classList.toggle('hidden', hasLines);
      lineList.classList.toggle('hidden', !hasLines);
    }
  }

  function openLineEditor(line: LineView | null, defaultName: string): void {
    handlers.hoverLine(null);
    closeGarage();

    if (line) {
      lineDraft = {
        id: line.id,
        color: line.color,
        colorCss: line.colorCss,
        isLoop: line.isLoop,
        stops: line.stops.map((stop) => ({ ...stop })),
      };
      lineNameInput.value = line.name;
      lineEditorTitle.textContent = '编辑线路';
    } else {
      const used = new Set((railView?.lines ?? []).map((item) => item.color));
      const color = LINE_COLORS.find((option) => !used.has(option.color)) ?? LINE_COLORS[0]!;
      lineDraft = {
        id: null,
        color: color.color,
        colorCss: color.css,
        isLoop: false,
        stops: [],
      };
      lineNameInput.value = defaultName;
      lineEditorTitle.textContent = '新建线路';
    }

    updateEditorPalette();
    updateEditorLoop();
    renderDraftStops();
    updateEditorState();
    updateLineSectionVisibility();
    lineNameInput.focus();
    lineNameInput.select();
  }

  function closeLineEditor(): void {
    lineDraft = null;
    lineNameInput.value = '';
    lineEditor.classList.add('hidden');
    updateLineSectionVisibility();
    handlers.hoverLine(null);
  }

  function addDraftStop(stop: LineStop): void {
    if (!lineDraft) return;
    if (lineDraft.stops.some((item) => item.key === stop.key)) {
      toast('该车站已在线路中');
      return;
    }
    lineDraft.stops.push({ ...stop });
    renderDraftStops();
  }

  function renderDraftStops(): void {
    lineStops.replaceChildren();
    if (!lineDraft) return;

    if (lineDraft.stops.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'empty-note';
      empty.textContent = '点击地图车站添加停靠。';
      lineStops.append(empty);
    } else {
      lineDraft.stops.forEach((stop, index) => {
        const row = document.createElement('div');
        row.className = 'stop-row';
        row.draggable = true;
        row.dataset.stopIndex = String(index);
        row.title = '拖动调整停靠顺序';

        const indexEl = document.createElement('span');
        indexEl.className = 'stop-index';
        indexEl.textContent = String(index + 1);

        const name = document.createElement('span');
        name.className = 'stop-name';
        name.textContent = stop.name;

        const remove = document.createElement('button');
        remove.className = 'stop-remove';
        remove.title = '移除该停靠';
        remove.textContent = '×';
        remove.addEventListener('click', () => {
          if (!lineDraft) return;
          lineDraft.stops = lineDraft.stops.filter((item) => item.key !== stop.key);
          renderDraftStops();
        });

        row.addEventListener('dragstart', (event) => {
          stopDragIndex = index;
          row.classList.add('is-dragging');
          if (event.dataTransfer) {
            event.dataTransfer.effectAllowed = 'move';
            event.dataTransfer.setData('text/plain', String(index));
          }
        });

        row.addEventListener('dragover', (event) => {
          if (stopDragIndex === null) return;
          event.preventDefault();
          if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
          for (const other of lineStops.querySelectorAll<HTMLElement>('.stop-row')) {
            other.classList.remove('is-drop-target');
          }
          if (stopDragIndex !== index) row.classList.add('is-drop-target');
        });

        row.addEventListener('dragleave', () => {
          row.classList.remove('is-drop-target');
        });

        row.addEventListener('drop', (event) => {
          event.preventDefault();
          const from = stopDragIndex;
          stopDragIndex = null;
          clearStopDragStyles();
          if (from === null) return;
          moveDraftStop(from, index);
        });

        row.addEventListener('dragend', () => {
          stopDragIndex = null;
          clearStopDragStyles();
        });

        row.append(indexEl, name, remove);
        lineStops.append(row);
      });
    }

    lineEditorCount.textContent = `${lineDraft.stops.length} 站`;
    lineClearStops.disabled = lineDraft.stops.length === 0;
    updateEditorState();
  }

  function moveDraftStop(from: number, to: number): void {
    if (!lineDraft) return;
    const count = lineDraft.stops.length;
    if (from === to || from < 0 || to < 0 || from >= count || to >= count) return;
    const [moved] = lineDraft.stops.splice(from, 1);
    if (!moved) return;
    lineDraft.stops.splice(to, 0, moved);
    renderDraftStops();
    toast(`已调整停靠顺序 · ${lineDraft.stops.map((stop) => stop.name).join(' → ')}`);
  }

  function clearStopDragStyles(): void {
    for (const row of lineStops.querySelectorAll<HTMLElement>('.stop-row')) {
      row.classList.remove('is-dragging', 'is-drop-target');
    }
  }

  function updateEditorPalette(): void {
    for (const entry of lineColorButtons) {
      entry.button.classList.toggle('is-active', lineDraft?.color === entry.color);
    }
  }

  function updateEditorLoop(): void {
    for (const button of lineLoopButtons) {
      const loop = button.dataset.loop === '1';
      button.classList.toggle('is-active', lineDraft?.isLoop === loop);
    }
  }

  function updateEditorState(): void {
    lineSave.disabled =
      !lineDraft || lineDraft.stops.length < 2 || lineNameInput.value.trim().length === 0;
  }

  function saveLineDraft(): void {
    if (!lineDraft) return;
    const name = lineNameInput.value.trim();
    if (!name) {
      toast('请填写线路名称');
      lineNameInput.focus();
      return;
    }
    if (lineDraft.stops.length < 2) {
      toast('线路至少需要 2 个停靠站');
      return;
    }

    handlers.saveLine({
      id: lineDraft.id,
      name,
      color: lineDraft.color,
      colorCss: lineDraft.colorCss,
      isLoop: lineDraft.isLoop,
      stops: lineDraft.stops.map((stop) => ({ ...stop })),
    });
  }

  /* ------------------------------ 车库 / 商店 ------------------------------ */

  function openGarage(lineId: number | null): void {
    garageOpen = true;
    railView = handlers.railView();
    garagePreferredLineId =
      lineId ??
      railView?.lines.find((line) => line.status === 'OK')?.id ??
      railView?.lines[0]?.id ??
      null;
    handlers.hoverLine(null);
    garageModal.classList.remove('hidden');
    renderGarage();
  }

  function closeGarage(): void {
    garageOpen = false;
    garageModal.classList.add('hidden');
  }

  function renderGarage(): void {
    if (!garageOpen) return;
    const view = railView;
    garageMoney.textContent = formatMoney(view?.credits ?? lastStats?.credits ?? 0);
    garageBody.replaceChildren();
    if (!view) return;

    /* 购买 */
    const shop = section('购买列车');
    const shopGrid = document.createElement('div');
    shopGrid.className = 'train-shop';

    for (const model of TRAIN_MODEL_LIST) {
      const card = document.createElement('div');
      card.className = 'train-model';

      const head = document.createElement('div');
      head.className = 'train-model-head';
      const name = document.createElement('span');
      name.className = 'train-model-name';
      name.textContent = model.name;
      const cost = document.createElement('span');
      cost.className = 'train-model-cost';
      cost.textContent = `¥${model.cost.toLocaleString('en-US')}`;
      head.append(name, cost);

      const preview = document.createElement('div');
      preview.className = 'train-preview';
      for (let i = 0; i < model.cars; i++) {
        const car = document.createElement('span');
        preview.append(car);
      }

      const meta = document.createElement('div');
      meta.className = 'train-model-meta';
      meta.innerHTML = `<span>${model.cars} 节</span><span>定员 ${model.capacity}（4/节）</span><span>速度 ${model.speedLabel}</span>`;

      const desc = document.createElement('p');
      desc.className = 'train-model-desc';
      desc.textContent = model.description;

      const buy = document.createElement('button');
      buy.className = 'btn btn-primary';
      buy.textContent = '购入';
      buy.disabled = view.credits < model.cost;
      buy.title = buy.disabled ? '资金不足' : `购入 ${model.name}`;
      buy.addEventListener('click', () => handlers.purchaseTrain(model.id));

      card.append(head, preview, meta, desc, buy);
      shopGrid.append(card);
    }
    // 货运列车卡片与三种客车同尺寸，合并进“购买列车”网格
    const cargo = view.cargo;
    const cargoCard = document.createElement('div');
    cargoCard.className = 'train-model';

    const cargoHead = document.createElement('div');
    cargoHead.className = 'train-model-head';
    const cargoName = document.createElement('span');
    cargoName.className = 'train-model-name';
    cargoName.textContent = '货运列车';
    const cargoCost = document.createElement('span');
    cargoCost.className = 'train-model-cost';
    cargoCost.textContent = `¥${cargo.truckCost.toLocaleString('en-US')}`;
    cargoHead.append(cargoName, cargoCost);

    const cargoPreview = document.createElement('div');
    cargoPreview.className = 'train-preview cargo-preview';
    const cargoCar = document.createElement('span');
    cargoCar.className = 'cargo-preview-car';
    const cargoBox = document.createElement('i');
    cargoBox.className = 'cargo-preview-box';
    cargoCar.append(cargoBox);
    cargoPreview.append(cargoCar);

    const cargoMeta = document.createElement('div');
    cargoMeta.className = 'train-model-meta';
    cargoMeta.innerHTML = '<span>1 节</span><span>1 单/趟</span><span>沿轨道自动接单</span>';

    const cargoDesc = document.createElement('p');
    cargoDesc.className = 'train-model-desc';
    cargoDesc.textContent = '单节车厢，有货单时自动沿轨道接单。';

    const buyCargo = document.createElement('button');
    buyCargo.className = 'btn btn-primary';
    buyCargo.textContent = '购入';
    buyCargo.disabled = view.credits < cargo.truckCost;
    buyCargo.title = buyCargo.disabled ? '资金不足' : '购入货运列车';
    buyCargo.addEventListener('click', () => handlers.purchaseTruck());

    cargoCard.append(cargoHead, cargoPreview, cargoMeta, cargoDesc, buyCargo);
    shopGrid.append(cargoCard);
    shop.append(shopGrid);

    const cargoSummary = document.createElement('p');
    cargoSummary.className = 'garage-cargo-summary';
    cargoSummary.textContent = `货运 ${cargo.visibleTrucks} 列 · 待运 ${cargo.waitingOrders} 单 · 今日 ${cargo.deliveriesToday} 单 / ${formatMoney(cargo.revenueToday)} · 成本 ${formatMoney(cargo.opexToday)}`;
    shop.append(cargoSummary);

    /* 库存 */
    const okLines = view.lines.filter((line) => line.status === 'OK');
    const cargoTrains = cargo.trucks;
    const inventoryCount = view.inventory.length + cargoTrains.length;
    const inventory = section(`库存列车 · ${inventoryCount}`);
    if (inventoryCount === 0) {
      inventory.append(note('暂无库存列车。'));
    } else {
      if (okLines.length === 0 && view.inventory.length > 0) {
        inventory.append(note('请先创建一条可用线路。'));
      }
      const list = document.createElement('div');
      list.className = 'inventory-list';
      const preferred =
        okLines.find((line) => line.id === garagePreferredLineId) ?? okLines[0] ?? null;

      for (const train of view.inventory) {
        const row = document.createElement('div');
        row.className = 'inventory-row';

        const name = document.createElement('span');
        name.className = 'inventory-name';
        name.textContent = `#${train.id} · ${train.modelName}`;

        const meta = document.createElement('span');
        meta.className = 'inventory-meta';
        meta.textContent = `${train.cars} 节 · 定员 ${train.capacity}`;

        row.append(name, meta);

        if (preferred) {
          const select = document.createElement('select');
          select.setAttribute('aria-label', '选择线路');
          for (const line of okLines) {
            const option = document.createElement('option');
            option.value = String(line.id);
            option.textContent = line.name;
            if (line.id === preferred.id) option.selected = true;
            select.append(option);
          }

          const assign = document.createElement('button');
          assign.className = 'btn btn-ghost';
          assign.textContent = '配车';
          assign.addEventListener('click', () => {
            const lineId = Number(select.value);
            if (!Number.isFinite(lineId)) return;
            garagePreferredLineId = lineId;
            handlers.assignTrain(train.id, lineId);
          });

          row.append(select, assign);
        } else {
          const hint = document.createElement('span');
          hint.className = 'inventory-meta';
          hint.textContent = '未分配 · 先创建线路';
          row.append(hint);
        }

        list.append(row);
      }

      for (const truck of cargoTrains) {
        const row = document.createElement('div');
        row.className = 'inventory-row cargo-inventory-row';

        const name = document.createElement('span');
        name.className = 'inventory-name';
        name.textContent = `货运列车 #${truck.id} · ${truck.state}`;

        const meta = document.createElement('span');
        meta.className = 'inventory-meta';
        meta.textContent = truck.order
          ? `${truck.loaded ? '载货' : '取货'} · ${truck.order.originName} → ${truck.order.destName}`
          : '空车 · 等待货单';

        row.append(name, meta);
        list.append(row);
      }

      inventory.append(list);
    }

    /* 编组 */
    const assigned = section('线路编组');
    const withTrains = view.lines.filter((line) => line.trainCount > 0);
    if (withTrains.length === 0) {
      assigned.append(note('暂无线路配车。'));
    } else {
      for (const line of withTrains) {
        const group = document.createElement('div');
        group.className = 'assigned-group';

        const label = document.createElement('span');
        label.className = 'assigned-line';
        const dot = document.createElement('span');
        dot.className = 'assigned-dot';
        dot.style.setProperty('--line', line.colorCss);
        label.append(dot, document.createTextNode(`${line.name} · ${line.trainCount} 列`));
        group.append(label);

        for (const train of line.trains) {
          const chip = document.createElement('span');
          chip.className = 'assigned-train';
          chip.append(
            document.createTextNode(
              `#${train.id} ${train.modelName} · ${train.onboard}/${train.capacity}`,
            ),
          );
          const unassign = document.createElement('button');
          unassign.title = '退回库存';
          unassign.textContent = '×';
          unassign.addEventListener('click', () => handlers.unassignTrain(train.id));
          chip.append(unassign);
          group.append(chip);
        }
        assigned.append(group);
      }
    }

    garageBody.append(shop, inventory, assigned);
  }

  function section(title: string, sub?: string): HTMLElement {
    const sectionEl = document.createElement('section');
    sectionEl.className = 'garage-section';
    const heading = document.createElement('h3');
    heading.append(document.createTextNode(title));
    if (sub) {
      const subEl = document.createElement('span');
      subEl.textContent = sub;
      heading.append(subEl);
    }
    sectionEl.append(heading);
    return sectionEl;
  }

  function note(text: string): HTMLParagraphElement {
    const paragraph = document.createElement('p');
    paragraph.className = 'empty-note';
    paragraph.textContent = text;
    return paragraph;
  }

  /* ------------------------------ 悬停 / 缩放 / 工具 ------------------------------ */

  function setHovered(tile: Tile | null): void {
    hoveredTile = tile;
    updateDockStatus();
  }

  function updateDockStatus(): void {
    if (!hoveredTile) {
      dockStatus.textContent = TOOL_HINTS[activeTool];
      dockInfo?.classList.remove('is-hovering');
      return;
    }

    const tile = hoveredTile;
    const def = TERRAIN_DEFS[tile.terrain];
    const info = handlers.tileInfo(tile);
    let text = '';

    if (activeTool === 'inspect') {
      const extras: string[] = [];
      if (info.station) extras.push(STATION_DEFS[info.station.type].name);
      else if (info.hasTrack) extras.push('轨道');
      if (info.coveredBy > 0) extras.push(`${info.coveredBy} 站覆盖`);
      text = `${def.name} · (${tile.q}, ${tile.r})${extras.length ? ' · ' + extras.join(' · ') : ''}`;
    } else if (activeTool === 'track') {
      text = info.hasTrack
        ? `已铺轨 · ${info.connections} 向`
        : info.trackQuote.ok
          ? `铺轨 ${compactMoney(info.trackQuote.cost)} · ${def.name}`
          : `无法铺轨：${info.trackQuote.reason}`;
    } else if (activeTool === 'station') {
      const stationDef = STATION_DEFS[activeStationType];
      text = info.station
        ? `已有 ${info.station.name}`
        : info.stationQuote.ok
          ? `${stationDef.name} ${compactMoney(info.stationQuote.cost)} · 覆盖 ${info.previewCoverage} / ${info.previewDemand} 格`
          : `无法建站：${info.stationQuote.reason}`;
    } else if (activeTool === 'segment') {
      text = info.hasTrack
        ? `路段 · ${info.connections} 向 · 红=断开 / 绿=恢复`
        : '路段 · 无轨道';
    } else {
      text = info.station
        ? `拆除 ${info.station.name}`
        : info.hasTrack
          ? '拆除轨道 · 返还 50%'
          : '这里没有可拆除的设施';
    }

    dockStatus.textContent = text;
    dockInfo?.classList.add('is-hovering');
  }

  function setZoom(zoom: number): void {
    zoomReadout.textContent = `每格 ≈ 5 km · 视图 ${Math.round(zoom * 100)}%`;
  }

  function setSeed(seed: number): void {
    seedInput.value = String(seed);
  }

  function selectTool(tool: BuildTool, announce: boolean): void {
    if (lineDraft && tool !== activeTool) {
      toast('请先保存或取消当前线路编辑。');
      return;
    }

    activeTool = tool;
    for (const button of toolButtons) {
      button.classList.toggle('is-active', button.dataset.tool === tool);
    }
    stationPicker.classList.toggle('hidden', tool !== 'station');
    document.body.classList.toggle('station-mode', tool === 'station');
    updateDockStatus();
    handlers.tool(tool);

    if (!announce || tool === 'inspect') return;
    if (tool === 'track') {
      toast('点击地块铺轨。');
    } else if (tool === 'station') {
      toast(`已选择${STATION_DEFS[activeStationType].name}，点击地块建站。`);
    } else if (tool === 'segment') {
      toast('点击连接处断开 / 恢复轨道。');
    } else {
      toast('点击轨道或车站拆除，返还 50%。');
    }
  }

  function applyStationType(type: StationType, notify: boolean): void {
    activeStationType = type;
    for (const button of stationButtons) {
      button.classList.toggle('is-active', button.dataset.stationType === type);
    }
    if (notify) {
      handlers.stationType(type);
      toast(`已选择${STATION_DEFS[type].name} · ${stationRadiusLabel(type)}`);
    }
    refreshSelected();
    updateDockStatus();
  }

  function refreshSelected(): void {
    if (selectedTile) renderTile(selectedTile, false);
  }

  function toast(message: string): void {
    toastEl.textContent = message;
    toastEl.classList.add('is-visible');
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => toastEl.classList.remove('is-visible'), 2600);
  }

  setZoomReadoutDefault();
  applyStationType('light', false);
  selectTool('inspect', false);
  updateLineSectionVisibility();

  window.addEventListener('resize', () => {
    if (window.innerWidth > 1180) inspectorPanel?.classList.remove('is-open');
  });

  function setZoomReadoutDefault(): void {
    zoomReadout.textContent = '每格 ≈ 5 km';
  }

  return {
    bindWorld,
    setNetworkStats,
    setRailView,
    setClock,
    showMapTooltip,
    showTile,
    refreshSelected,
    hoverTile: setHovered,
    setZoom,
    setSeed,
    setTool: (tool) => selectTool(tool, false),
    setStationType: (type) => applyStationType(type, false),
    openLineEditor,
    closeLineEditor,
    addDraftStop,
    toast,
  };
}

function compactMoney(value: number): string {
  return `¥${Math.round(value).toLocaleString('en-US')}`;
}

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`HUD: 缺少 #${id}`);
  return node as T;
}

function isTypingTarget(): boolean {
  const active = document.activeElement;
  return (
    active instanceof HTMLInputElement ||
    active instanceof HTMLTextAreaElement ||
    active instanceof HTMLSelectElement
  );
}
