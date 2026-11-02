/** 「压力一只AI」浮窗：设置 API、聊天、定时汇报与动作执行。 */

import {
  AI_SYSTEM_PROMPT,
  type AiAction,
  type AiActionResult,
  type AiChatMessage,
  type AiGameState,
} from '../game/ai';

export interface AiPanelHandlers {
  getState(): AiGameState;
  executeActions(actions: AiAction[]): AiActionResult[];
  /** 定时回合是否允许执行（例如开始界面 / 线路编辑时暂停）。 */
  canAct?(): boolean;
}

export interface AiPanel {
  toggle(): void;
  open(): void;
  close(): void;
  isOpen(): boolean;
}

interface AiSettings {
  apiKey: string;
  baseUrl: string;
  model: string;
  auto: boolean;
  autoSeconds: number;
  maxTokens: number;
}

const SETTINGS_KEY = 'railsim.ai.settings.v1';
const DEFAULT_AUTO_SECONDS = 30;
const MIN_AUTO_SECONDS = 5;
const MAX_AUTO_SECONDS = 600;
const DEFAULT_MAX_TOKENS = 8192;
const MIN_MAX_TOKENS = 512;
const MAX_MAX_TOKENS = 65536;
const DEFAULT_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_MODEL = 'gpt-4o-mini';

function clampAutoSeconds(value: unknown): number {
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numeric)) return DEFAULT_AUTO_SECONDS;
  return Math.min(
    MAX_AUTO_SECONDS,
    Math.max(MIN_AUTO_SECONDS, Math.round(numeric)),
  );
}

function clampMaxTokens(value: unknown): number {
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numeric)) return DEFAULT_MAX_TOKENS;
  return Math.min(
    MAX_MAX_TOKENS,
    Math.max(MIN_MAX_TOKENS, Math.round(numeric)),
  );
}

function loadSettings(): AiSettings {
  try {
    const raw = window.localStorage.getItem(SETTINGS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<AiSettings>;
      return {
        apiKey: typeof parsed.apiKey === 'string' ? parsed.apiKey : '',
        baseUrl:
          typeof parsed.baseUrl === 'string' && parsed.baseUrl.trim()
            ? parsed.baseUrl
            : DEFAULT_BASE_URL,
        model:
          typeof parsed.model === 'string' && parsed.model.trim()
            ? parsed.model
            : DEFAULT_MODEL,
        auto: parsed.auto !== false,
        autoSeconds: clampAutoSeconds(parsed.autoSeconds),
        maxTokens: clampMaxTokens(parsed.maxTokens),
      };
    }
  } catch (error) {
    console.warn('[RailSim] 读取 AI 设置失败', error);
  }
  return {
    apiKey: '',
    baseUrl: DEFAULT_BASE_URL,
    model: DEFAULT_MODEL,
    auto: true,
    autoSeconds: DEFAULT_AUTO_SECONDS,
    maxTokens: DEFAULT_MAX_TOKENS,
  };
}

function saveSettings(settings: AiSettings): void {
  try {
    window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch (error) {
    console.warn('[RailSim] 保存 AI 设置失败', error);
  }
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className = '',
  text = '',
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

function extractJson(text: string): { message: string; actions: AiAction[] } {
  console.log('[RailSim AI] 解析前回复文本', text);
  const trimmed = text.trim();
  const stripped = trimmed
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
  const start = stripped.indexOf('{');
  const end = stripped.lastIndexOf('}');
  const candidate =
    start >= 0 && end > start ? stripped.slice(start, end + 1) : stripped;

  try {
    const parsed = JSON.parse(candidate) as {
      message?: unknown;
      actions?: unknown;
    };
    const message =
      typeof parsed.message === 'string' && parsed.message.trim()
        ? parsed.message.trim()
        : '（AI 没有附加说明）';
    const actions = Array.isArray(parsed.actions)
      ? (parsed.actions.filter(
          (item) => item && typeof item === 'object',
        ) as AiAction[])
      : [];
    console.log('[RailSim AI] 解析结果', { message, actions });
    return { message, actions };
  } catch (error) {
    console.warn('[RailSim AI] JSON 解析失败，按普通文本处理', { text, error });
    return { message: trimmed || '（AI 返回了空内容）', actions: [] };
  }
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export function createAiPanel(handlers: AiPanelHandlers): AiPanel {
  const app = document.getElementById('app');
  if (!app) throw new Error('AI 面板缺少 #app 容器');

  let settings = loadSettings();
  let open = false;
  let busy = false;
  let countdown = settings.autoSeconds;
  const history: AiChatMessage[] = [];
  let logCount = 0;

  /* ------------------------------ DOM ------------------------------ */

  const card = el('section', 'ai-card hidden');
  card.id = 'ai-card';
  card.setAttribute('aria-label', '压力一只AI');
  const head = el('div', 'ai-head');
  const titleWrap = el('div', 'ai-title-wrap');
  const dot = el('span', 'ai-dot');
  const title = el('strong', 'ai-title', '压力一只AI');
  const status = el('em', 'ai-status', '未配置');
  titleWrap.append(dot, title, status);

  const headActions = el('div', 'ai-head-actions');
  const settingsBtn = el('button', 'ai-icon-btn', '⚙');
  settingsBtn.type = 'button';
  settingsBtn.title = 'AI 设置';
  const closeBtn = el('button', 'ai-icon-btn', '×');
  closeBtn.type = 'button';
  closeBtn.title = '关闭';
  headActions.append(settingsBtn, closeBtn);
  head.append(titleWrap, headActions);

  const body = el('div', 'ai-body');

  const settingsView = el('div', 'ai-view ai-settings-view hidden');
  const keyField = el('label', 'ai-field');
  keyField.append(el('span', '', 'API 密钥'));
  const keyInput = el('input');
  keyInput.id = 'ai-key';
  keyInput.type = 'password';
  keyInput.placeholder = 'sk-...';
  keyInput.autocomplete = 'off';
  keyField.append(keyInput);

  const baseField = el('label', 'ai-field');
  baseField.append(el('span', '', 'API 地址'));
  const baseInput = el('input');
  baseInput.id = 'ai-base';
  baseInput.type = 'text';
  baseInput.placeholder = DEFAULT_BASE_URL;
  baseInput.autocomplete = 'off';
  baseField.append(baseInput);

  const modelField = el('label', 'ai-field');
  modelField.append(el('span', '', '模型'));
  const modelInput = el('input');
  modelInput.id = 'ai-model';
  modelInput.type = 'text';
  modelInput.placeholder = DEFAULT_MODEL;
  modelInput.autocomplete = 'off';
  modelField.append(modelInput);

  const intervalField = el('label', 'ai-field');
  intervalField.append(el('span', '', '自动汇报间隔（秒）'));
  const intervalInput = el('input');
  intervalInput.id = 'ai-interval';
  intervalInput.type = 'number';
  intervalInput.min = String(MIN_AUTO_SECONDS);
  intervalInput.max = String(MAX_AUTO_SECONDS);
  intervalInput.step = '5';
  intervalInput.autocomplete = 'off';
  intervalField.append(intervalInput);

  const tokensField = el('label', 'ai-field');
  tokensField.append(el('span', '', '最大回复 token 数'));
  const tokensInput = el('input');
  tokensInput.id = 'ai-max-tokens';
  tokensInput.type = 'number';
  tokensInput.min = String(MIN_MAX_TOKENS);
  tokensInput.max = String(MAX_MAX_TOKENS);
  tokensInput.step = '512';
  tokensInput.autocomplete = 'off';
  tokensField.append(tokensInput);

  const settingsHint = el(
    'p',
    'ai-hint',
    `密钥只保存在本机浏览器，不会写入游戏存档。接口使用 OpenAI 兼容的 /chat/completions。自动汇报间隔范围 ${MIN_AUTO_SECONDS}~${MAX_AUTO_SECONDS} 秒；回复被截断时提高最大回复 token 数。`,
  );
  const settingsActions = el('div', 'ai-settings-actions');
  const settingsCancel = el('button', 'btn btn-ghost', '取消');
  settingsCancel.id = 'ai-cancel';
  settingsCancel.type = 'button';
  const settingsSave = el('button', 'btn btn-primary', '保存');
  settingsSave.id = 'ai-save';
  settingsSave.type = 'button';
  settingsActions.append(settingsCancel, settingsSave);
  settingsView.append(
    keyField,
    baseField,
    modelField,
    intervalField,
    tokensField,
    settingsHint,
    settingsActions,
  );

  const chatView = el('div', 'ai-view ai-chat-view');
  const log = el('div', 'ai-log');
  log.id = 'ai-log';
  const composer = el('div', 'ai-composer');
  const input = el('textarea', 'ai-input');
  input.id = 'ai-input';
  input.rows = 2;
  input.placeholder = '对 AI 说点什么，或让它继续自动经营…';
  const sendBtn = el('button', 'btn btn-primary ai-send', '发送');
  sendBtn.id = 'ai-send';
  sendBtn.type = 'button';
  composer.append(input, sendBtn);
  const footer = el('div', 'ai-footer');
  const autoLabel = el('label', 'ai-auto');
  const autoToggle = el('input');
  autoToggle.id = 'ai-auto';
  autoToggle.type = 'checkbox';
  const autoText = el('span', '', '自动汇报');
  autoLabel.append(autoToggle, autoText);
  const nextText = el('span', 'ai-next', '—');
  nextText.id = 'ai-next';
  footer.append(autoLabel, nextText);
  chatView.append(log, composer, footer);

  body.append(settingsView, chatView);
  card.append(head, body);
  app.append(card);

  /* ------------------------------ 状态 ------------------------------ */

  function setStatus(text: string, tone: 'idle' | 'ok' | 'busy' | 'error' = 'idle'): void {
    status.textContent = text;
    dot.className = `ai-dot is-${tone}`;
  }

  function setBusy(value: boolean): void {
    busy = value;
    sendBtn.disabled = value;
    input.disabled = value;
    settingsSave.disabled = value;
    if (value) setStatus('思考中…', 'busy');
  }

  function renderFooter(): void {
    autoToggle.checked = settings.auto;
    autoToggle.disabled = !settings.apiKey;
    autoText.textContent = `每 ${settings.autoSeconds} 秒自动汇报`;
    if (!settings.apiKey) {
      nextText.textContent = '未配置';
    } else if (!settings.auto) {
      nextText.textContent = '已暂停自动';
    } else {
      nextText.textContent = `下次汇报 ${Math.max(0, countdown)}s`;
    }
  }

  function showChatView(): void {
    settingsView.classList.add('hidden');
    chatView.classList.remove('hidden');
    renderFooter();
    window.setTimeout(() => input.focus(), 30);
  }

  function showSettingsView(): void {
    keyInput.value = settings.apiKey;
    baseInput.value = settings.baseUrl;
    modelInput.value = settings.model;
    intervalInput.value = String(settings.autoSeconds);
    tokensInput.value = String(settings.maxTokens);
    settingsView.classList.remove('hidden');
    chatView.classList.add('hidden');
    window.setTimeout(() => keyInput.focus(), 30);
  }

  function updateStatusIdle(): void {
    if (!settings.apiKey) {
      setStatus('未配置', 'idle');
    } else if (settings.auto) {
      setStatus('自动托管', 'ok');
    } else {
      setStatus('待命', 'idle');
    }
    renderFooter();
  }

  /* ------------------------------ 聊天 UI ------------------------------ */

  function scrollLog(): void {
    log.scrollTop = log.scrollHeight;
  }

  function appendLog(role: 'user' | 'assistant' | 'system' | 'error', text: string): void {
    const row = el('div', `ai-msg is-${role}`);
    row.textContent = text;
    log.append(row);
    logCount += 1;
    while (logCount > 80 && log.firstElementChild) {
      log.firstElementChild.remove();
      logCount -= 1;
    }
    scrollLog();
  }

  function appendChat(role: 'user' | 'assistant', text: string): void {
    appendLog(role, text);
    history.push({ role, content: text });
    while (history.length > 12) history.shift();
  }

  function appendActionResults(results: AiActionResult[]): void {
    if (results.length === 0) return;
    const summary = results
      .map((result) => `${result.ok ? '✓' : '✗'} ${result.message}`)
      .join(' · ');
    appendLog('system', `执行 ${results.length} 项：${summary.slice(0, 260)}`);
  }

  /* ------------------------------ API ------------------------------ */

  function endpoint(): string {
    const base = settings.baseUrl.trim().replace(/\/+$/g, '') || DEFAULT_BASE_URL;
    return /\/chat\/completions$/i.test(base) ? base : `${base}/chat/completions`;
  }

  async function request(messages: { role: string; content: string }[]): Promise<string> {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 60_000);
    try {
      console.log('[RailSim AI] 请求参数', {
        url: endpoint(),
        model: settings.model,
        maxTokens: settings.maxTokens,
        messages: messages.length,
      });
      const response = await fetch(endpoint(), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${settings.apiKey}`,
        },
        body: JSON.stringify({
          model: settings.model,
          messages,
          temperature: 0.25,
          max_tokens: settings.maxTokens,
        }),
        signal: controller.signal,
      });
      if (!response.ok) {
        const detail = await response.text();
        console.error('[RailSim AI] API 错误响应', {
          status: response.status,
          statusText: response.statusText,
          body: detail,
        });
        throw new Error(
          `API ${response.status}${detail ? `：${detail.slice(0, 240)}` : ''}`,
        );
      }
      const rawText = await response.text();
      // 完整记录每次 AI 回复，便于排查空内容 / 非标准返回结构
      console.log('[RailSim AI] 原始响应文本', rawText);
      const data = JSON.parse(rawText) as {
        model?: string;
        choices?: {
          finish_reason?: string;
          text?: string;
          message?: {
            content?: unknown;
            reasoning_content?: unknown;
          };
        }[];
      };
      console.log('[RailSim AI] 完整响应 JSON', data);
      console.log(
        '[RailSim AI] 完整响应 JSON 字符串',
        JSON.stringify(data, null, 2),
      );
      const choice = data.choices?.[0];
      const content = choice?.message?.content;
      console.log('[RailSim AI] 回复 content', content);
      if (choice?.finish_reason === 'length') {
        console.warn(
          `[RailSim AI] 回复因 max_tokens=${settings.maxTokens} 被截断；如需完整回复请在设置中提高最大回复 token 数。`,
        );
      }
      if (choice?.message?.reasoning_content) {
        console.log('[RailSim AI] 回复 reasoning_content', choice.message.reasoning_content);
      }
      if (typeof content === 'string') {
        if (content.trim()) return content;
      } else if (Array.isArray(content)) {
        const text = content
          .map((part) =>
            part && typeof part === 'object' && 'text' in part
              ? String((part as { text?: unknown }).text ?? '')
              : '',
          )
          .join('');
        if (text.trim()) {
          console.log('[RailSim AI] 从数组 content 提取文本', text);
          return text;
        }
      }
      if (typeof choice?.text === 'string' && choice.text.trim()) {
        console.log('[RailSim AI] 从 choices[0].text 提取文本', choice.text);
        return choice.text;
      }
      const finish = choice?.finish_reason ?? '未知';
      const hint =
        finish === 'length'
          ? `。回复被 max_tokens=${settings.maxTokens} 截断，请在设置中提高“最大回复 token 数”`
          : '';
      throw new Error(
        `API 返回内容为空（finish_reason=${finish}，model=${data.model ?? settings.model}）${hint}。完整响应已输出到控制台。`,
      );
    } finally {
      window.clearTimeout(timeout);
    }
  }

  /* ------------------------------ 回合 ------------------------------ */

  async function runTurn(source: 'auto' | 'user'): Promise<void> {
    if (busy) return;
    if (!settings.apiKey) {
      showSettingsView();
      setStatus('请先配置密钥', 'error');
      return;
    }
    if (source === 'auto' && handlers.canAct && !handlers.canAct()) {
      countdown = settings.autoSeconds;
      updateStatusIdle();
      return;
    }

    setBusy(true);
    const state = handlers.getState();
    const directive =
      source === 'auto'
        ? '这是每 30 秒的定时汇报，请根据当前状态自主推进下一步。'
        : '玩家刚刚发来消息，请结合上一条玩家消息和当前状态决定下一步。';
    const stateMessage = `【全局状态】\n${JSON.stringify(state)}\n\n【指令】${directive}`;

    try {
      const baseMessages = [
        { role: 'system', content: AI_SYSTEM_PROMPT },
        ...history.slice(-12).map((message) => ({
          role: message.role,
          content: message.content,
        })),
        { role: 'user', content: stateMessage },
      ];
      const first = extractJson(await request(baseMessages));
      console.log('[RailSim AI] 回合结果', { source, reply: first });
      if (first.message) appendChat('assistant', first.message);
      if (first.actions.length > 0) {
        const firstResults = handlers.executeActions(first.actions.slice(0, 20));
        appendActionResults(firstResults);
        if (firstResults.some((result) => result.ok)) {
          // AI 完成操作后，把最新状态再汇报一次
          const updated = handlers.getState();
          setStatus('汇报操作后状态…', 'busy');
          const followMessages = [
            { role: 'system', content: AI_SYSTEM_PROMPT },
            ...history.slice(-12).map((message) => ({
              role: message.role,
              content: message.content,
            })),
            {
              role: 'user',
              content: `【操作完成后的全局状态】\n${JSON.stringify(updated)}\n\n【指令】这是你刚才操作后产生的新状态。若无需继续操作，actions 返回空数组。`,
            },
          ];
          const follow = extractJson(await request(followMessages));
          console.log('[RailSim AI] 操作后汇报结果', follow);
          if (follow.message) appendChat('assistant', follow.message);
          if (follow.actions.length > 0) {
            const followResults = handlers.executeActions(follow.actions.slice(0, 20));
            appendActionResults(followResults);
          }
        }
      }
      setStatus(settings.auto ? '自动托管' : '待命', 'ok');
    } catch (error) {
      const message = errorText(error);
      appendLog('error', `请求失败：${message}`);
      setStatus('请求失败', 'error');
      if (/API (401|403|429)/.test(message)) {
        settings = { ...settings, auto: false };
        saveSettings(settings);
        autoToggle.checked = false;
        appendLog('system', '已暂停自动托管；请检查密钥、余额或请求频率。');
      }
    } finally {
      setBusy(false);
      countdown = settings.autoSeconds;
      renderFooter();
    }
  }

  /* ------------------------------ 事件 ------------------------------ */

  closeBtn.addEventListener('click', () => close());
  settingsBtn.addEventListener('click', () => {
    if (!settingsView.classList.contains('hidden')) showChatView();
    else showSettingsView();
  });

  settingsCancel.addEventListener('click', () => {
    if (settings.apiKey) showChatView();
    else setStatus('请先配置密钥', 'error');
  });

  settingsSave.addEventListener('click', () => {
    const key = keyInput.value.trim();
    const base = baseInput.value.trim() || DEFAULT_BASE_URL;
    const model = modelInput.value.trim() || DEFAULT_MODEL;
    if (!key) {
      setStatus('密钥不能为空', 'error');
      keyInput.focus();
      return;
    }
    settings = {
      ...settings,
      apiKey: key,
      baseUrl: base,
      model,
      autoSeconds: clampAutoSeconds(intervalInput.value),
      maxTokens: clampMaxTokens(tokensInput.value),
    };
    saveSettings(settings);
    countdown = settings.autoSeconds;
    updateStatusIdle();
    showChatView();
    appendLog('system', `已保存设置 · 模型 ${settings.model}`);
  });

  autoToggle.addEventListener('change', () => {
    settings = { ...settings, auto: autoToggle.checked };
    saveSettings(settings);
    countdown = settings.autoSeconds;
    updateStatusIdle();
  });

  sendBtn.addEventListener('click', () => {
    if (busy) return;
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    appendChat('user', text);
    void runTurn('user');
  });

  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      sendBtn.click();
    }
  });

  /* ------------------------------ 计时 ------------------------------ */

  window.setInterval(() => {
    if (!settings.auto || !settings.apiKey) {
      countdown = settings.autoSeconds;
      renderFooter();
      return;
    }
    if (document.hidden || busy) {
      renderFooter();
      return;
    }
    if (countdown > settings.autoSeconds) countdown = settings.autoSeconds;
    countdown -= 1;
    if (countdown <= 0) {
      countdown = settings.autoSeconds;
      renderFooter();
      void runTurn('auto');
      return;
    }
    renderFooter();
  }, 1000);

  /* ------------------------------ 对外接口 ------------------------------ */

  function openPanel(): void {
    if (open) return;
    open = true;
    card.classList.remove('hidden');
    if (!settings.apiKey) {
      showSettingsView();
      setStatus('未配置', 'idle');
    } else {
      showChatView();
      updateStatusIdle();
    }
  }

  function close(): void {
    if (!open) return;
    open = false;
    card.classList.add('hidden');
  }

  updateStatusIdle();

  return {
    toggle: () => (open ? close() : openPanel()),
    open: openPanel,
    close,
    isOpen: () => open,
  };
}
