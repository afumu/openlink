function parseOptions(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw;
  if (typeof raw === 'string') { try { return JSON.parse(raw); } catch { return []; } }
  return [];
}

function getNativeSetter() {
  return Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
}

function parseXmlToolCall(raw: string): any | null {
  const nameMatch = raw.match(/^<tool\s+name="([^"]+)"(?:\s+call_id="([^"]+)")?/);
  if (!nameMatch) return null;
  const name = nameMatch[1];
  const callId = nameMatch[2] || null;
  const args: Record<string, string> = {};
  const paramRe = /<parameter\s+name="([^"]+)">([\s\S]*?)<\/parameter>/g;
  let m;
  while ((m = paramRe.exec(raw)) !== null) args[m[1]] = m[2];
  return { name, args, callId };
}

function tryParseToolJSON(raw: string): any | null {
  try { return JSON.parse(raw); } catch {}
  try {
    let result = '';
    let inString = false;
    let escaped = false;
    for (let i = 0; i < raw.length; i++) {
      const ch = raw[i];
      if (escaped) { result += ch; escaped = false; continue; }
      if (ch === '\\') { result += ch; escaped = true; continue; }
      if (ch === '"') {
        if (!inString) { inString = true; result += ch; continue; }
        let j = i + 1;
        while (j < raw.length && raw[j] === ' ') j++;
        const next = raw[j];
        if (next === ':' || next === ',' || next === '}' || next === ']') {
          inString = false; result += ch;
        } else {
          result += '\\"';
        }
        continue;
      }
      result += ch;
    }
    return JSON.parse(result);
  } catch {}
  return null;
}

type FillMethod = 'paste' | 'execCommand' | 'value' | 'prosemirror';

interface SiteConfig {
  editor: string;
  sendBtn: string;
  stopBtn: string | null;
  fillMethod: FillMethod;
  useObserver: boolean;
  responseSelector?: string;
}

interface SiteAdapter {
  id: string;
  matches(): boolean;
  config: SiteConfig;
  getConversationId(): string;
  getSourceKey(sourceEl?: Element): string;
  isAssistantResponse(el: Element | null): boolean;
  shouldRenderToolText(text: string, sourceEl?: Element): boolean;
  getToolCardMount(sourceEl: Element): { anchor: Element; before: Element | null } | null;
  getEditorRegion(editor: Element | null): Element | null;
  getSendButton(editor: HTMLElement, sendBtnSel: string): HTMLElement | null;
  fillValue?(editor: HTMLElement, text: string, editorSel: string, sendBtnSel: string): Promise<boolean>;
}

function defaultConversationId(): string {
  const m = location.pathname.match(/\/a\/chat\/s\/([^/?#]+)/) || location.pathname.match(/\/chat\/([^/?#]+)/) || location.search.match(/[?&]id=([^&]+)/);
  return m ? m[1] : '__default__';
}

function getElementPathKey(el: Element | null, depth = 6): string {
  if (!el) return 'none';
  const parts: string[] = [];
  let cursor: Element | null = el;
  while (cursor && parts.length < depth) {
    let index = 0;
    let prev = cursor.previousElementSibling;
    while (prev) { index++; prev = prev.previousElementSibling; }
    parts.push(`${cursor.tagName.toLowerCase()}:${index}`);
    cursor = cursor.parentElement;
  }
  return parts.join('>');
}

function defaultSourceKey(sourceEl?: Element): string {
  if (!sourceEl) return 'global';
  const item = sourceEl.closest('[data-virtual-list-item-key]');
  if (item) return item.getAttribute('data-virtual-list-item-key') || 'item';
  const message = sourceEl.closest('.ds-message, message-content, ms-chat-turn, .prose');
  if (message) return `${getElementPathKey(message)}:${hashStr((message.textContent || '').slice(0, 200))}`;
  return `${getElementPathKey(sourceEl)}:${hashStr((sourceEl.textContent || '').slice(0, 120))}`;
}

function defaultToolMount(sourceEl: Element): { anchor: Element; before: Element | null } | null {
  const messageContent = sourceEl.closest('message-content') ?? sourceEl.closest('.prose') ?? sourceEl;
  const anchor = messageContent.parentElement ?? sourceEl.parentElement;
  if (!anchor) return null;
  return { anchor, before: messageContent };
}

function defaultEditorRegion(editor: Element | null): Element | null {
  if (!editor) return null;
  return editor.closest('form') ?? editor.parentElement?.parentElement ?? editor.parentElement ?? null;
}

function arenaActionRow(root: Element): Element | null {
  return Array.from(root.children).find((child) => {
    if (!(child instanceof Element)) return false;
    const hasLike = !!child.querySelector('button[aria-label="Like this response"]');
    const hasDislike = !!child.querySelector('button[aria-label="Dislike this response"]');
    return hasLike && hasDislike;
  }) as Element | null;
}

const siteAdapters: SiteAdapter[] = [
  {
    id: 'arena',
    matches: () => location.hostname === 'arena.ai' && (location.pathname.startsWith('/text/direct') || location.pathname.startsWith('/c/')),
    config: {
      editor: 'textarea[name="message"][placeholder*="Ask followup"], textarea[name="message"], form textarea, textarea',
      sendBtn: 'form button[type="submit"]:not([disabled]), form button[type="submit"]',
      stopBtn: null,
      fillMethod: 'value',
      useObserver: true,
      responseSelector: '.prose',
    },
    getConversationId: defaultConversationId,
    getSourceKey(sourceEl) {
      if (!sourceEl) return 'global';
      let cursor: Element | null = sourceEl.closest('.prose') ?? sourceEl;
      while (cursor) {
        const row = arenaActionRow(cursor);
        if (row) return `${getElementPathKey(cursor)}:${hashStr((cursor.textContent || '').slice(0, 300))}`;
        cursor = cursor.parentElement;
      }
      return defaultSourceKey(sourceEl);
    },
    isAssistantResponse(el) {
      if (!el) return false;
      let cursor: Element | null = el.closest('.prose') ?? el;
      while (cursor) {
        const row = arenaActionRow(cursor);
        if (row) return true;
        cursor = cursor.parentElement;
      }
      return false;
    },
    shouldRenderToolText(text, sourceEl) {
      if (sourceEl?.closest('pre, code')) return false;
      const normalized = text.replace(/\s+/g, ' ').trim();
      if (!normalized.startsWith('<tool')) return false;
      return true;
    },
    getToolCardMount(sourceEl) {
      const prose = sourceEl.closest('.prose') ?? sourceEl;
      let cursor: Element | null = prose;
      while (cursor) {
        const row = arenaActionRow(cursor);
        if (row) return { anchor: cursor, before: row };
        cursor = cursor.parentElement;
      }
      const messageCard = prose.closest('.bg-surface-primary.relative.flex.w-full.min-w-0.flex-1.flex-col') as Element | null;
      if (messageCard) return { anchor: messageCard, before: messageCard.lastElementChild ?? null };
      const proseWrapper = prose.parentElement?.parentElement ?? prose.parentElement;
      if (!proseWrapper) return null;
      return { anchor: proseWrapper, before: proseWrapper.firstElementChild ?? null };
    },
    getEditorRegion: defaultEditorRegion,
    getSendButton(editor, sendBtnSel) {
      const form = editor.closest('form');
      if (form) {
        for (const sel of sendBtnSel.split(',').map(s => s.trim()).filter(Boolean)) {
          const btn = form.querySelector(sel) as HTMLElement | null;
          if (btn && isVisibleElement(btn)) return btn;
        }
      }
      return querySelectorFirst(sendBtnSel);
    },
    async fillValue(editor, text, editorSel, sendBtnSel) {
      const ta = await fillArenaTextarea(text, editorSel, sendBtnSel);
      return !!ta;
    },
  },
  {
    id: 'deepseek',
    matches: () => location.hostname === 'chat.deepseek.com',
    config: {
      editor: 'textarea[placeholder*="DeepSeek"], textarea',
      sendBtn: 'div.bf38813a div[role="button"][aria-disabled], div[role="button"][aria-disabled]',
      stopBtn: null,
      fillMethod: 'value',
      useObserver: true,
      responseSelector: '.ds-message .ds-markdown',
    },
    getConversationId: defaultConversationId,
    getSourceKey: defaultSourceKey,
    isAssistantResponse(el) {
      if (!el) return false;
      const item = el.closest('[data-virtual-list-item-key]');
      if (!item) return false;
      if (!item.querySelector('.ds-message .ds-markdown')) return false;
      if (item.querySelector('textarea')) return false;
      return true;
    },
    shouldRenderToolText: () => true,
    getToolCardMount(sourceEl) {
      const message = sourceEl.closest('[data-virtual-list-item-key]') ?? sourceEl.closest('.ds-message')?.parentElement;
      if (!message) return null;
      const actionRow = Array.from(message.children).find((child) => {
        if (!(child instanceof Element)) return false;
        return !!child.querySelector('div[role="button"][aria-disabled]');
      }) as Element | undefined;
      return { anchor: message, before: actionRow ?? null };
    },
    getEditorRegion: defaultEditorRegion,
    getSendButton(editor) {
      const region = defaultEditorRegion(editor);
      if (!region) return null;
      const buttons = Array.from(region.querySelectorAll<HTMLElement>('div[role="button"][aria-disabled]')).filter((btn) => isVisibleElement(btn));
      return buttons.at(-1) ?? null;
    },
  },
  {
    id: 'labsfx',
    matches: () => location.hostname === 'labs.google' && location.pathname.startsWith('/fx'),
    config: {
      editor: 'div[role="textbox"][data-slate-editor="true"][contenteditable="true"]',
      sendBtn: 'button',
      stopBtn: null,
      fillMethod: 'execCommand',
      useObserver: false,
    },
    getConversationId: defaultConversationId,
    getSourceKey: defaultSourceKey,
    isAssistantResponse: () => false,
    shouldRenderToolText: () => false,
    getToolCardMount: defaultToolMount,
    getEditorRegion(editor) {
      if (!editor) return null;
      return editor.closest('.sc-84e494b2-0') ?? defaultEditorRegion(editor);
    },
    getSendButton(editor) {
      const region = (editor.closest('.sc-84e494b2-0') ?? defaultEditorRegion(editor)) as Element | null;
      if (!region) return null;
      const buttons = Array.from(region.querySelectorAll<HTMLElement>('button')).filter((btn) => isVisibleElement(btn));
      const action = buttons.findLast((btn) => {
        const iconText = btn.querySelector('.google-symbols')?.textContent?.trim();
        return iconText === 'arrow_forward' || (btn.textContent || '').includes('创建');
      });
      return action ?? buttons.at(-1) ?? null;
    },
  },
  {
    id: 'doubao',
    matches: () => location.hostname === 'www.doubao.com' || location.hostname === 'doubao.com',
    config: {
      editor: 'textarea[data-testid="chat_input_input"], textarea.semi-input-textarea',
      sendBtn: 'button[data-testid="chat_input_send_button"], #flow-end-msg-send',
      stopBtn: null,
      fillMethod: 'value',
      useObserver: true,
      responseSelector: '[data-testid="receive_message"] [data-testid="message_text_content"], [data-testid="receive_message"] [data-testid="message_content"]',
    },
    getConversationId: defaultConversationId,
    getSourceKey(sourceEl) {
      if (!sourceEl) return 'global';
      const msg = sourceEl.closest('[data-testid="message_content"]');
      const id = msg?.getAttribute('data-message-id');
      if (id) return id;
      return defaultSourceKey(sourceEl);
    },
    isAssistantResponse(el) {
      if (!el) return false;
      const receive = el.closest('[data-testid="receive_message"]');
      if (!receive) return false;
      return !!receive.querySelector('[data-testid="message_action_bar"]');
    },
    shouldRenderToolText(text, sourceEl) {
      if (sourceEl?.closest('pre, code')) return false;
      return text.replace(/\s+/g, ' ').includes('<tool');
    },
    getToolCardMount(sourceEl) {
      const receive = sourceEl.closest('[data-testid="receive_message"]');
      if (!receive) return null;
      const content = receive.querySelector('[data-testid="message_content"]') as Element | null;
      const column = content?.parentElement as Element | null;
      const actionBar = receive.querySelector('[data-testid="message_action_bar"]') as Element | null;
      if (column) return { anchor: column, before: actionBar?.parentElement ?? actionBar ?? null };
      if (content) return { anchor: content, before: content.lastElementChild };
      return { anchor: receive, before: actionBar };
    },
    getEditorRegion(editor) {
      if (!editor) return null;
      return editor.closest('.relative.flex.flex-col-reverse') ?? editor.closest('[data-testid="input-container"]') ?? defaultEditorRegion(editor);
    },
    getSendButton(editor, sendBtnSel) {
      const region = (editor.closest('.relative.flex.flex-col-reverse') ?? defaultEditorRegion(editor)) as Element | null;
      if (region) {
        const btn = region.querySelector<HTMLElement>('button[data-testid="chat_input_send_button"], #flow-end-msg-send');
        if (btn && isVisibleElement(btn)) return btn;
      }
      return querySelectorFirst(sendBtnSel);
    },
  },
  {
    id: 'qwen',
    matches: () => location.hostname === 'tongyi.aliyun.com' || location.hostname === 'chat.qwen.ai',
    config: {
      editor: 'textarea.message-input-textarea, .message-input-container textarea',
      sendBtn: '.message-input-right-button-send button.send-button, button.send-button',
      stopBtn: null,
      fillMethod: 'value',
      useObserver: true,
      responseSelector: '.chat-response-message .response-message-content .qwen-markdown, .chat-response-message .response-message-content',
    },
    getConversationId: defaultConversationId,
    getSourceKey(sourceEl) {
      if (!sourceEl) return 'global';
      const msg = sourceEl.closest('.chat-response-message');
      if (msg?.id) return msg.id;
      return defaultSourceKey(sourceEl);
    },
    isAssistantResponse(el) {
      if (!el) return false;
      const msg = el.closest('.chat-response-message');
      if (!msg) return false;
      if (msg.querySelector('.response-message-content')) return true;
      return false;
    },
    shouldRenderToolText(text, sourceEl) {
      if (sourceEl?.closest('pre, code')) return false;
      return text.replace(/\s+/g, ' ').includes('<tool');
    },
    getToolCardMount(sourceEl) {
      const message = sourceEl.closest('.chat-response-message');
      if (!message) return null;
      const body = message.querySelector('.chat-response-message-right > div') as Element | null;
      if (!body) return { anchor: message, before: message.firstElementChild };
      const footer = body.querySelector('.message-hoc-container');
      return { anchor: body, before: footer ?? body.lastElementChild };
    },
    getEditorRegion(editor) {
      if (!editor) return null;
      return editor.closest('.message-input-container') ?? defaultEditorRegion(editor);
    },
    getSendButton(editor, sendBtnSel) {
      const region = (editor.closest('.message-input-container') ?? defaultEditorRegion(editor)) as Element | null;
      if (region) {
        const btn = region.querySelector<HTMLElement>('.message-input-right-button-send button.send-button, button.send-button');
        if (btn && isVisibleElement(btn)) return btn;
      }
      return querySelectorFirst(sendBtnSel);
    },
  },
  {
    id: 'gemini',
    matches: () => location.hostname.includes('gemini.google.com'),
    config: {
      editor: 'div.ql-editor[contenteditable="true"]',
      sendBtn: 'button.send-button[aria-label*="发送"], button.send-button[aria-label*="Send"]',
      stopBtn: null,
      fillMethod: 'execCommand',
      useObserver: true,
      responseSelector: 'model-response, .model-response-text, message-content',
    },
    getConversationId: defaultConversationId,
    getSourceKey: defaultSourceKey,
    isAssistantResponse: () => true,
    shouldRenderToolText: () => true,
    getToolCardMount: defaultToolMount,
    getEditorRegion: defaultEditorRegion,
    getSendButton(editor, sendBtnSel) {
      const form = editor.closest('form');
      if (form) {
        for (const sel of sendBtnSel.split(',').map(s => s.trim()).filter(Boolean)) {
          const btn = form.querySelector(sel) as HTMLElement | null;
          if (btn && isVisibleElement(btn)) return btn;
        }
      }
      return querySelectorFirst(sendBtnSel);
    },
  },
  {
    id: 'default',
    matches: () => true,
    config: {
      editor: 'textarea[placeholder*="Start typing a prompt"]',
      sendBtn: 'button.ctrl-enter-submits.ms-button-primary[type="submit"], button[aria-label*="Run"]',
      stopBtn: null,
      fillMethod: 'value',
      useObserver: true,
      responseSelector: 'ms-chat-turn',
    },
    getConversationId: defaultConversationId,
    getSourceKey: defaultSourceKey,
    isAssistantResponse: () => true,
    shouldRenderToolText: () => true,
    getToolCardMount: defaultToolMount,
    getEditorRegion: defaultEditorRegion,
    getSendButton(editor, sendBtnSel) {
      const form = editor.closest('form');
      if (form) {
        for (const sel of sendBtnSel.split(',').map(s => s.trim()).filter(Boolean)) {
          const btn = form.querySelector(sel) as HTMLElement | null;
          if (btn && isVisibleElement(btn)) return btn;
        }
      }
      return querySelectorFirst(sendBtnSel);
    },
  },
];

function getSiteAdapter(): SiteAdapter {
  return siteAdapters.find((adapter) => adapter.matches())!;
}

function getSiteConfig(): SiteConfig {
  return getSiteAdapter().config;
}

const DEBUG_LOG_LIMIT = 200;
let debugModeEnabled = false;
let debugLogSeq = 0;
let debugPanelLogEl: HTMLPreElement | null = null;
const debugLogs: string[] = [];
let labsFxAPIHeaders: Record<string, string> = {};
let labsFxProjectId = '';
let labsFxReferencesInjectedReady = false;
let labsFxGeneratePatchedSeq = 0;
let geminiLatestMediaURLs: string[] = [];
let geminiMediaSeq = 0;

function formatDebugValue(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  try { return JSON.stringify(value); } catch { return String(value); }
}

function refreshDebugLogView() {
  if (!debugPanelLogEl) return;
  debugPanelLogEl.textContent = debugLogs.join('\n');
  debugPanelLogEl.scrollTop = debugPanelLogEl.scrollHeight;
}

function debugLog(message: string, data?: unknown) {
  const suffix = formatDebugValue(data);
  const line = `[${new Date().toLocaleTimeString('zh-CN', { hour12: false })} #${++debugLogSeq}] ${message}${suffix ? ` ${suffix}` : ''}`;
  console.log('[OpenLink][Debug]', message, data ?? '');
  debugLogs.push(line);
  if (debugLogs.length > DEBUG_LOG_LIMIT) debugLogs.splice(0, debugLogs.length - DEBUG_LOG_LIMIT);
  if (debugModeEnabled) refreshDebugLogView();
}

if (!(window as any).__OPENLINK_LOADED__) {
  (window as any).__OPENLINK_LOADED__ = true;

  const cfg = getSiteConfig();
  const adapter = getSiteAdapter();
  let debugMode = false;
  debugLog('内容脚本已加载', { adapter: adapter.id, href: location.href });

  if (!cfg.useObserver || adapter.id === 'gemini') {
    const script = document.createElement('script');
    script.src = chrome.runtime.getURL('injected.js');
    (document.head || document.documentElement).appendChild(script);
  } else if (cfg.responseSelector) {
    const sel = cfg.responseSelector;
    if (document.body) startDOMObserver(sel);
    else document.addEventListener('DOMContentLoaded', () => startDOMObserver(sel));
  }

  let execQueue = Promise.resolve();
  window.addEventListener('message', (event) => {
    if (event.data.type === 'TOOL_CALL') {
      execQueue = execQueue.then(() => executeToolCall(event.data.data));
    } else if (event.data.type === 'OPENLINK_DEBUG_LOG') {
      const payload = event.data.data || {};
      const source = typeof payload.source === 'string' && payload.source ? payload.source : 'injected';
      const message = typeof payload.message === 'string' && payload.message ? payload.message : '调试日志';
      debugLog(`[${source}] ${message}`, payload.meta || {});
    } else if (event.data.type === 'OPENLINK_FLOW_CONTEXT') {
      const payload = event.data.data || {};
      const headers = payload.headers && typeof payload.headers === 'object' ? payload.headers : {};
      if (headers.authorization) {
        labsFxAPIHeaders = {
          ...labsFxAPIHeaders,
          ...headers,
        };
        debugLog('labsfx 已捕获页面 API 认证头', {
          keys: Object.keys(labsFxAPIHeaders),
          authPrefix: String(headers.authorization).slice(0, 24),
        });
      }
      if (typeof payload.projectId === 'string' && payload.projectId) {
        labsFxProjectId = payload.projectId;
        debugLog('labsfx 已捕获项目 ID', { projectId: labsFxProjectId });
      }
    } else if (event.data.type === 'OPENLINK_FLOW_REFERENCES_READY') {
      labsFxReferencesInjectedReady = (event.data.data?.count || 0) > 0;
      debugLog('labsfx 已下发待注入参考图', {
        count: event.data.data?.count || 0,
        mediaKind: event.data.data?.mediaKind || 'image',
      });
    } else if (event.data.type === 'OPENLINK_FLOW_GENERATE_PATCHED') {
      labsFxGeneratePatchedSeq += 1;
      debugLog('labsfx 已将参考图注入生成请求', {
        count: event.data.data?.count || 0,
        mediaKind: event.data.data?.mediaKind || 'image',
      });
    } else if (event.data.type === 'OPENLINK_GEMINI_MEDIA_FOUND') {
      geminiLatestMediaURLs = Array.isArray(event.data.data?.urls) ? event.data.data.urls : [];
      geminiMediaSeq = Number(event.data.data?.seq || (geminiMediaSeq + 1));
      debugLog('gemini 已捕获无水印媒体 URL', {
        seq: geminiMediaSeq,
        count: geminiLatestMediaURLs.length,
        first: geminiLatestMediaURLs[0] || '',
      });
    }
  });

  const mountDebugUi = () => {
    injectInitButton();
    debugModeEnabled = debugMode;
    if (debugMode) injectDebugPanel();
    else removeDebugPanel();
  };

  chrome.storage.local.get(['debugMode']).then((result) => {
    debugMode = !!result.debugMode;
    debugModeEnabled = debugMode;
    debugLog('调试模式状态初始化', { enabled: debugMode });
    if (document.body) mountDebugUi();
  });
  chrome.storage.onChanged.addListener((changes) => {
    if ('debugMode' in changes) {
      debugMode = !!changes.debugMode.newValue;
      debugModeEnabled = debugMode;
      debugLog('调试模式状态变更', { enabled: debugMode });
      if (document.body) mountDebugUi();
    }
  });

  if (!document.body) document.addEventListener('DOMContentLoaded', mountDebugUi);

  if (document.body) mountInputListener();
  else document.addEventListener('DOMContentLoaded', mountInputListener);

  if (location.hostname === 'labs.google' && location.pathname.startsWith('/fx')) {
    if (document.body) startLabsFxImageWorker();
    else document.addEventListener('DOMContentLoaded', startLabsFxImageWorker);
  } else if (location.hostname.includes('gemini.google.com')) {
    if (document.body) startGeminiImageWorker();
    else document.addEventListener('DOMContentLoaded', startGeminiImageWorker);
  }
}

function hashStr(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = Math.imul(31, h) + s.charCodeAt(i) | 0;
  return h >>> 0;
}

function getConversationId(): string { return getSiteAdapter().getConversationId(); }

function getSourceKey(sourceEl?: Element): string { return getSiteAdapter().getSourceKey(sourceEl); }

function isExecuted(key: string): boolean {
  try {
    const store: Record<string, number> = JSON.parse(localStorage.getItem('openlink_executed') || '{}');
    return !!store[key];
  } catch { return false; }
}

const TTL = 7 * 24 * 60 * 60 * 1000;

function markExecuted(key: string): void {
  try {
    const store: Record<string, number> = JSON.parse(localStorage.getItem('openlink_executed') || '{}');
    const now = Date.now();
    for (const k of Object.keys(store)) {
      if (now - store[k] > TTL) delete store[k];
    }
    store[key] = now;
    localStorage.setItem('openlink_executed', JSON.stringify(store));
  } catch {}
}

async function executeToolCallRaw(toolCall: any): Promise<string> {
  const { authToken, apiUrl } = await chrome.storage.local.get(['authToken', 'apiUrl']);
  if (!apiUrl) return '请先在插件中配置 API 地址';
  const headers: any = { 'Content-Type': 'application/json' };
  if (authToken) headers['Authorization'] = `Bearer ${authToken}`;
  const response = await bgFetch(`${apiUrl}/exec`, { method: 'POST', headers, body: JSON.stringify(toolCall) });
  if (response.status === 401) return '认证失败，请在插件中重新输入 Token';
  if (!response.ok) return `[OpenLink 错误] HTTP ${response.status}`;
  const result = JSON.parse(response.body);
  return result.output || result.error || '[OpenLink] 空响应';
}

function getToolCardMount(sourceEl: Element): { anchor: Element; before: Element | null } | null {
  return getSiteAdapter().getToolCardMount(sourceEl);
}

function isAssistantResponse(el: Element | null): boolean {
  return getSiteAdapter().isAssistantResponse(el);
}

function shouldRenderToolText(text: string, sourceEl?: Element): boolean {
  return getSiteAdapter().shouldRenderToolText(text, sourceEl);
}

function renderToolCard(data: any, _full: string, sourceEl: Element, key: string, processed: Set<string>) {
  const mount = getToolCardMount(sourceEl);
  if (!mount) return;
  const { anchor, before } = mount;

  // Prevent duplicate cards
  if (anchor.querySelector(`[data-openlink-key="${key}"]`)) return;

  const args = data.args || {};
  const card = document.createElement('div');
  card.setAttribute('data-openlink-key', key);
  card.style.cssText = 'border:1px solid #444;border-radius:8px;padding:12px;margin:8px 0;background:#1e1e2e;color:#cdd6f4;font-size:13px';

  const header = document.createElement('div');
  header.style.cssText = 'font-weight:bold;margin-bottom:8px';
  header.innerHTML = `🔧 ${data.name} <span style="color:#888;font-size:11px">#${data.callId || ''}</span>`;
  card.appendChild(header);

  const argsBox = document.createElement('div');
  argsBox.style.cssText = 'margin:8px 0;background:#181825;border-radius:6px;padding:8px';
  for (const [k, v] of Object.entries(args)) {
    const row = document.createElement('div');
    row.style.cssText = 'margin-bottom:4px';
    row.innerHTML = `<span style="color:#89b4fa;font-size:11px">${k}</span>`;
    const val = document.createElement('div');
    val.style.cssText = 'color:#cdd6f4;font-size:12px;font-family:monospace;white-space:pre-wrap;max-height:80px;overflow-y:auto';
    val.textContent = typeof v === 'string' ? v : JSON.stringify(v);
    row.appendChild(val);
    argsBox.appendChild(row);
  }
  card.appendChild(argsBox);

  const btnRow = document.createElement('div');
  btnRow.style.cssText = 'display:flex;gap:8px';
  const execBtn = document.createElement('button');
  execBtn.textContent = '执行';
  execBtn.style.cssText = 'padding:4px 12px;background:#1677ff;color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:12px';
  const skipBtn = document.createElement('button');
  skipBtn.textContent = '忽略';
  skipBtn.style.cssText = 'padding:4px 12px;background:#313244;color:#cdd6f4;border:1px solid #45475a;border-radius:6px;cursor:pointer;font-size:12px';
  btnRow.appendChild(execBtn);
  btnRow.appendChild(skipBtn);
  card.appendChild(btnRow);

  execBtn.onclick = async () => {
    execBtn.disabled = true;
    execBtn.textContent = '执行中...';
    markExecuted(key);
    try {
      const text = await executeToolCallRaw(data);
      const resultBox = document.createElement('div');
      resultBox.style.cssText = 'margin-top:10px;background:#181825;border-radius:6px;padding:8px;max-height:200px;overflow-y:auto;font-family:monospace;font-size:12px;color:#cdd6f4;white-space:pre-wrap';
      resultBox.textContent = text;
      const insertBtn = document.createElement('button');
      insertBtn.type = 'button';
      insertBtn.textContent = '插入到对话';
      insertBtn.style.cssText = 'margin-top:6px;padding:4px 12px;background:#313244;color:#89b4fa;border:1px solid #89b4fa;border-radius:6px;cursor:pointer;font-size:12px';
      insertBtn.onclick = () => fillAndSend(text, true);
      card.appendChild(resultBox);
      card.appendChild(insertBtn);
      execBtn.textContent = '✅ 已执行';
    } catch {
      execBtn.textContent = '❌ 执行失败';
      execBtn.disabled = false;
    }
  };

  skipBtn.onclick = () => { card.remove(); processed.delete(key); };

  if (before) anchor.insertBefore(card, before);
  else anchor.appendChild(card);
}

function startDOMObserver(responseSelector: string) {
  const processed = new Set<string>();
  const TOOL_RE = /<tool(?:\s[^>]*)?>[\s\S]*?<\/tool>/g;
  const responseSelectors = responseSelector.split(',').map(s => s.trim()).filter(Boolean);
  let autoExecute = false;
  chrome.storage.local.get(['autoExecute']).then(r => { autoExecute = !!r.autoExecute; });
  chrome.storage.onChanged.addListener((changes) => {
    if ('autoExecute' in changes) autoExecute = !!changes.autoExecute.newValue;
  });

  function scanText(text: string, sourceEl?: Element) {
    if (!text.includes('<tool')) return;
    if (sourceEl && !isAssistantResponse(sourceEl)) return;
    if (!shouldRenderToolText(text, sourceEl)) return;
    TOOL_RE.lastIndex = 0;
    let match;
    while ((match = TOOL_RE.exec(text)) !== null) {
      const full = match[0];
      const inner = full.replace(/^<tool[^>]*>|<\/tool>$/g, '').trim();
      const data = parseXmlToolCall(full) || tryParseToolJSON(inner);
      if (!data) { console.warn('[OpenLink] 工具调用解析失败:', full); continue; }
      const convId = getConversationId();
      const sourceKey = getSourceKey(sourceEl);
      const key = data.callId ? `${convId}:${data.name}:${data.callId}` : `${convId}:${sourceKey}:${hashStr(full)}`;
      if (processed.has(key)) continue;
      console.log('[OpenLink] 提取到工具调用:', data);

      if (sourceEl) {
        processed.add(key);
        renderToolCard(data, full, sourceEl, key, processed);
        if (autoExecute && !isExecuted(key)) {
          markExecuted(key);
          window.postMessage({ type: 'TOOL_CALL', data }, '*');
        }
      } else {
        if (isExecuted(key)) continue;
        processed.add(key);
        markExecuted(key);
        window.postMessage({ type: 'TOOL_CALL', data }, '*');
      }
    }
  }

  function scanNode(node: Node) {
    let el: Element | null;
    if (node.nodeType === Node.TEXT_NODE) {
      el = (node as Text).parentElement;
    } else if (node.nodeType === Node.ELEMENT_NODE) {
      el = node as Element;
    } else {
      return;
    }
    if (!el) return;
    const mc = findResponseContainer(el);
    if (mc) scheduleScan(mc);
  }

  function findResponseContainer(el: Element | null): Element | null {
    while (el) {
      if (responseSelectors.some(sel => {
        try { return el!.matches(sel); } catch { return false; }
      }) && isAssistantResponse(el)) return el;
      el = el.parentElement;
    }
    return null;
  }

  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let maxWaitTimer: ReturnType<typeof setTimeout> | null = null;
  const pendingContainers = new Set<Element>();

  // 块级标签：遍历到这些元素时在前面插入换行
  const BLOCK_TAGS = new Set(['P', 'DIV', 'BR', 'LI', 'TR', 'PRE', 'BLOCKQUOTE', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6']);

  // 跳过这些元素及其子树（UI 噪声）
  const SKIP_TAGS = new Set(['MS-THOUGHT-CHUNK', 'MAT-ICON', 'SCRIPT', 'STYLE', 'BUTTON', 'MAT-EXPANSION-PANEL-HEADER']);

  function extractText(node: Node, buf: string[]): void {
    if (node.nodeType === Node.TEXT_NODE) {
      buf.push(node.textContent || '');
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const el = node as Element;

    // 跳过 aria-hidden 元素（Material Icons 图标文字）和噪声标签
    if (el.getAttribute('aria-hidden') === 'true') return;
    if (SKIP_TAGS.has(el.tagName)) return;

    // 块级元素前插换行，保证多行结构
    if (BLOCK_TAGS.has(el.tagName)) buf.push('\n');

    for (const child of el.childNodes) {
      extractText(child, buf);
    }
  }

  function getCleanText(el: Element): string {
    const buf: string[] = [];
    extractText(el, buf);
    return buf.join('');
  }

  function scheduleScan(container: Element) {
    pendingContainers.add(container);
    if (!maxWaitTimer) {
      maxWaitTimer = setTimeout(() => {
        maxWaitTimer = null;
        if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = null; }
        const els = [...pendingContainers];
        pendingContainers.clear();
        requestAnimationFrame(() => {
          for (const el of els) scanText(getCleanText(el), el);
        });
      }, 3000);
    }
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      if (maxWaitTimer) { clearTimeout(maxWaitTimer); maxWaitTimer = null; }
      const els = [...pendingContainers];
      pendingContainers.clear();
      requestAnimationFrame(() => {
        for (const el of els) scanText(getCleanText(el), el);
      });
    }, 800);
  }

  new MutationObserver(mutations => {
    for (const mutation of mutations) {
      if (mutation.type === 'characterData') {
        const container = findResponseContainer((mutation.target as Text).parentElement);
        if (container) scheduleScan(container);
      } else {
        mutation.addedNodes.forEach(scanNode);
      }
    }
  }).observe(document.body, { childList: true, subtree: true, characterData: true });

  // Initial scan for already-rendered tool calls (e.g. after page refresh)
  requestAnimationFrame(() => {
    document.querySelectorAll(responseSelector).forEach(el => {
      if (!isAssistantResponse(el)) return;
      scanText(getCleanText(el), el);
    });
  });
}

function injectFloatingButton(id: string, label: string, bottom: number, background: string, onClick: () => void | Promise<void>) {
  document.getElementById(id)?.remove();
  const btn = document.createElement('button');
  btn.id = id;
  btn.type = 'button';
  btn.textContent = label;
  btn.style.cssText = `position:fixed;bottom:${bottom}px;right:20px;z-index:99999;padding:8px 14px;background:${background};color:#fff;border:none;border-radius:20px;cursor:pointer;font-size:13px;box-shadow:0 2px 8px rgba(0,0,0,0.3)`;
  btn.onclick = () => { void onClick(); };
  document.body.appendChild(btn);
}

function injectInitButton() {
  injectFloatingButton('openlink-init-btn', '🔗 初始化', 80, '#1677ff', sendInitPrompt);
}

function removeDebugPanel() {
  document.getElementById('openlink-debug-panel')?.remove();
  debugPanelLogEl = null;
}

function shortenHtml(html: string, max = 4000): string {
  return html.length > max ? `${html.slice(0, max)}\n...[truncated ${html.length - max} chars]` : html;
}

function elementSnapshot(el: Element | null) {
  if (!el) return null;
  const htmlEl = el as HTMLElement;
  const rect = htmlEl.getBoundingClientRect();
  return {
    tag: el.tagName.toLowerCase(),
    id: el.id || '',
    className: el.className || '',
    name: el.getAttribute('name') || '',
    placeholder: el.getAttribute('placeholder') || '',
    type: el.getAttribute('type') || '',
    ariaLabel: el.getAttribute('aria-label') || '',
    readOnly: htmlEl instanceof HTMLTextAreaElement ? htmlEl.readOnly : false,
    disabled: htmlEl instanceof HTMLButtonElement || htmlEl instanceof HTMLTextAreaElement ? htmlEl.disabled : false,
    value: htmlEl instanceof HTMLTextAreaElement ? htmlEl.value : '',
    text: (htmlEl.innerText || '').slice(0, 500),
    rect: { top: rect.top, left: rect.left, width: rect.width, height: rect.height },
    outerHTML: shortenHtml(el.outerHTML || ''),
  };
}

function getEditorRegion(editor: Element | null): Element | null { return getSiteAdapter().getEditorRegion(editor); }

function getNearbyButtons(editor: Element | null): Element[] {
  const region = getEditorRegion(editor);
  if (!region) return [];
  return Array.from(region.querySelectorAll('button, [role="button"]')).slice(0, 12);
}

function collectDebugData() {
  const cfg = getSiteConfig();
  const editorCandidates = getEditorCandidates(cfg.editor);
  const visibleTextareas = getVisibleTextareas();
  const currentEditor = getCurrentEditor(cfg.editor);
  const editorRegion = getEditorRegion(currentEditor);
  const sendButtons = Array.from(document.querySelectorAll(cfg.sendBtn.split(',').map(s => s.trim()).filter(Boolean).join(',')));
  const responseNodes = cfg.responseSelector ? Array.from(document.querySelectorAll(cfg.responseSelector)).slice(-3) : [];
  const toolNodes = Array.from(document.querySelectorAll('.prose, message-content, ms-chat-turn'))
    .filter((el) => (el.textContent || '').includes('<tool'))
    .slice(-3);
  return {
    capturedAt: new Date().toISOString(),
    location: { href: location.href, hostname: location.hostname, pathname: location.pathname },
    adapterId: getSiteAdapter().id,
    siteConfig: cfg,
    activeElement: elementSnapshot(document.activeElement as Element | null),
    currentEditor: elementSnapshot(currentEditor),
    editorRegion: elementSnapshot(editorRegion),
    visibleTextareaCount: visibleTextareas.length,
    editorCandidateCount: editorCandidates.length,
    visibleTextareas: visibleTextareas.map((el) => elementSnapshot(el)),
    editorCandidates: editorCandidates.map((el) => elementSnapshot(el)),
    sendButtons: sendButtons.map((el) => elementSnapshot(el)),
    nearbyButtons: getNearbyButtons(currentEditor).map((el) => elementSnapshot(el)),
    latestResponses: responseNodes.map((el) => elementSnapshot(el)),
    latestToolContainers: toolNodes.map((el) => elementSnapshot(el)),
    labsFxProjectId,
    labsFxAPIHeaderKeys: Object.keys(labsFxAPIHeaders),
    debugLogs: [...debugLogs],
  };
}

async function copyText(text: string) {
  await navigator.clipboard.writeText(text);
  showToast('已复制到剪贴板', 2000);
}

function downloadText(filename: string, text: string) {
  const blob = new Blob([text], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  showToast(`已下载 ${filename}`, 2000);
}

function injectDebugPanel() {
  if (document.getElementById('openlink-debug-panel')) return;
  const panel = document.createElement('div');
  panel.id = 'openlink-debug-panel';
  panel.style.cssText = 'position:fixed;bottom:180px;right:20px;z-index:99999;width:320px;max-height:70vh;background:#111827;color:#f3f4f6;border:1px solid #374151;border-radius:12px;padding:10px;box-shadow:0 8px 24px rgba(0,0,0,0.35);font-size:12px;display:flex;flex-direction:column';

  const title = document.createElement('div');
  title.textContent = 'OpenLink 调试模式';
  title.style.cssText = 'font-weight:700;margin-bottom:8px';
  panel.appendChild(title);

  const actions: Array<{ label: string; onClick: () => void | Promise<void> }> = [
    {
      label: '复制调试 JSON',
      onClick: () => copyText(JSON.stringify(collectDebugData(), null, 2)),
    },
    {
      label: '下载调试 JSON',
      onClick: () => {
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        downloadText(`openlink-debug-${stamp}.json`, JSON.stringify(collectDebugData(), null, 2));
      },
    },
    {
      label: '复制当前输入框 HTML',
      onClick: () => copyText((collectDebugData().currentEditor?.outerHTML) || ''),
    },
    {
      label: '复制当前输入区 HTML',
      onClick: () => copyText((collectDebugData().editorRegion?.outerHTML) || ''),
    },
    {
      label: '复制候选发送按钮 HTML',
      onClick: () => {
        const html = collectDebugData().nearbyButtons.map((item) => item?.outerHTML || '').join('\n\n');
        void copyText(html);
      },
    },
    {
      label: '复制最近回复 HTML',
      onClick: () => {
        const last = collectDebugData().latestResponses.at(-1);
        void copyText(last?.outerHTML || '');
      },
    },
    {
      label: '复制调试日志',
      onClick: () => copyText(debugLogs.join('\n')),
    },
    {
      label: '清空调试日志',
      onClick: () => {
        debugLogs.length = 0;
        refreshDebugLogView();
        showToast('已清空调试日志', 2000);
      },
    },
  ];

  for (const action of actions) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = action.label;
    btn.style.cssText = 'display:block;width:100%;margin-top:6px;padding:7px 10px;background:#1f2937;color:#f9fafb;border:1px solid #4b5563;border-radius:8px;cursor:pointer;text-align:left';
    btn.onclick = () => { void action.onClick(); };
    panel.appendChild(btn);
  }

  const hint = document.createElement('div');
  hint.textContent = '用于抓取站点兼容信息';
  hint.style.cssText = 'margin-top:8px;color:#9ca3af;line-height:1.4';
  panel.appendChild(hint);

  const logTitle = document.createElement('div');
  logTitle.textContent = '实时日志';
  logTitle.style.cssText = 'margin-top:8px;margin-bottom:6px;font-weight:700';
  panel.appendChild(logTitle);

  const logBox = document.createElement('pre');
  logBox.style.cssText = 'margin:0;flex:1;min-height:180px;max-height:260px;overflow:auto;background:#030712;border:1px solid #374151;border-radius:8px;padding:8px;color:#d1fae5;font-size:11px;line-height:1.45;white-space:pre-wrap;word-break:break-word';
  panel.appendChild(logBox);
  debugPanelLogEl = logBox;
  refreshDebugLogView();

  document.body.appendChild(panel);
  debugLog('调试面板已挂载');
}

async function bgFetch(url: string, options?: any): Promise<{ ok: boolean; status: number; body: string }> {
  return chrome.runtime.sendMessage({ type: 'FETCH', url, options });
}

async function bgFetchBinary(url: string, options?: any): Promise<{ ok: boolean; status: number; bodyBase64: string; contentType: string; finalUrl: string; error?: string }> {
  return chrome.runtime.sendMessage({ type: 'FETCH_BINARY', url, options });
}

let labsFxWorkerStarted = false;

function startLabsFxImageWorker() {
  if (labsFxWorkerStarted) return;
  labsFxWorkerStarted = true;
  debugLog('labs.google/fx worker 已启动');
  let running = false;

  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const { authToken, apiUrl } = await chrome.storage.local.get(['authToken', 'apiUrl']);
      if (!authToken || !apiUrl) {
        debugLog('labsfx 跳过轮询，缺少配置', { hasAuthToken: !!authToken, hasApiUrl: !!apiUrl });
        return;
      }
      const headers: Record<string, string> = { Authorization: `Bearer ${authToken}` };
      const resp = await bgFetch(`${apiUrl}/bridge/image-jobs/next?site_id=labsfx`, { headers });
      if (!resp.ok) {
        debugLog('labsfx 拉取任务失败', { status: resp.status });
        return;
      }
      const payload = JSON.parse(resp.body || '{}');
      const job = payload.job;
      if (!job?.id || !job?.prompt) return;
      debugLog('labsfx 收到媒体任务', {
        id: job.id,
        mediaKind: job.media_kind || 'image',
        prompt: String(job.prompt).slice(0, 120),
      });
      try {
        await runLabsFxMediaJob(job, apiUrl, authToken);
      } catch (err) {
        debugLog('labsfx 任务执行失败，准备回传错误', { id: job.id, error: err instanceof Error ? err.message : String(err) });
        await bgFetch(`${apiUrl}/bridge/image-jobs/${encodeURIComponent(job.id)}/result`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${authToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }),
        });
        throw err;
      }
    } catch (err) {
      console.warn('[OpenLink] labs.google/fx media worker error:', err);
      debugLog('labsfx worker 异常', err instanceof Error ? err.message : String(err));
    } finally {
      running = false;
    }
  };

  void tick();
  window.setInterval(() => { void tick(); }, 2500);
}

async function runLabsFxMediaJob(job: any, apiUrl: string, authToken: string) {
  const mediaKind = job?.media_kind === 'video' ? 'video' : 'image';
  showToast(`开始生成${mediaKind === 'video' ? '视频' : '图片'}: ${job.id}`, 2500);
  debugLog('labsfx 开始执行任务', { id: job.id, mediaKind });
  const editor = await waitForElement<HTMLElement>('div[role="textbox"][data-slate-editor="true"][contenteditable="true"]', 20000);
  debugLog('labsfx 已定位输入框');
  await ensureLabsFxMode(editor, mediaKind);
  const referenceImages = Array.isArray(job.reference_images) ? job.reference_images : [];
  await prepareLabsFxPromptArea(editor);
  if (referenceImages.length > 0) {
    debugLog('labsfx 开始附加参考图', { count: referenceImages.length });
    await attachLabsFxReferenceImages(editor, referenceImages, mediaKind);
    debugLog('labsfx 参考图附加完成', { count: getLabsFxReferenceCardCount(editor) });
  } else {
    debugLog('labsfx 本次任务无参考图');
  }
  await setLabsFxPrompt(editor, String(job.prompt));
  debugLog('labsfx Prompt 已写入', { prompt: String(job.prompt).slice(0, 120), editorText: getEditorText(editor).slice(0, 120) });
  if (referenceImages.length > 0) {
    refreshLabsFxComposerState(editor);
    debugLog('labsfx 已触发输入区刷新以同步参考图状态', { mediaKind });
    await sleep(180);
  }
  await sleep(300);
  const beforeKeys = getLabsFxTileKeys();
  debugLog(`labsfx 提交前${mediaKind === 'video' ? '媒体' : '图片'} key 集合`, beforeKeys);
  const sendBtn = getSendButtonForEditor(editor, getSiteConfig().sendBtn);
  if (!sendBtn) throw new Error('labs.google/fx send button not found');
  debugLog('labsfx 已定位发送按钮', { text: (sendBtn.textContent || '').trim().slice(0, 60) });
  const patchedSeqBeforeSend = labsFxGeneratePatchedSeq;
  await clickElementLikeUser(sendBtn);
  debugLog('labsfx 已触发发送按钮点击');
  if (referenceImages.length > 0) {
    if (!await waitForLabsFxGeneratePatched(patchedSeqBeforeSend, 8000)) {
      throw new Error(`labs.google/fx ${mediaKind} generate request was not patched with reference images`);
    }
  }

  const mediaEl = await waitForNewLabsFxGeneratedMedia(mediaKind, beforeKeys, mediaKind === 'video' ? 25 * 60 * 1000 : 180000);
  const src = mediaEl.getAttribute('src');
  if (!src) throw new Error(`generated ${mediaKind} src missing`);
  debugLog(`labsfx 检测到新${mediaKind === 'video' ? '视频' : '图片'}`, { src });

  const absoluteUrl = new URL(src, location.href).toString();
  const mediaResp = await bgFetchBinary(absoluteUrl, { credentials: 'include' });
  if (!mediaResp.ok || !mediaResp.bodyBase64) throw new Error(`${mediaKind} fetch failed: HTTP ${mediaResp.status}${mediaResp.error ? ` ${mediaResp.error}` : ''}`);
  debugLog(`labsfx ${mediaKind === 'video' ? '视频' : '图片'}抓取成功`, { status: mediaResp.status, url: absoluteUrl, finalUrl: mediaResp.finalUrl, contentType: mediaResp.contentType });
  const base64 = mediaResp.bodyBase64;
  const fileName = `${job.id}${guessMediaExtension(mediaResp.contentType || '', mediaResp.finalUrl || absoluteUrl)}`;

  const headers: Record<string, string> = {
    Authorization: `Bearer ${authToken}`,
    'Content-Type': 'application/json',
  };
  const resultResp = await bgFetch(`${apiUrl}/bridge/image-jobs/${encodeURIComponent(job.id)}/result`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      file_name: fileName,
      mime_type: mediaResp.contentType || (mediaKind === 'video' ? 'video/mp4' : 'image/png'),
      data: base64,
    }),
  });
  if (!resultResp.ok) throw new Error(`${mediaKind} result upload failed: HTTP ${resultResp.status}`);
  debugLog(`labsfx ${mediaKind === 'video' ? '视频' : '图片'}结果回传成功`, { fileName, status: resultResp.status });
  showToast(`${mediaKind === 'video' ? '视频' : '图片'}已保存: ${fileName}`, 3500);
}

function startGeminiImageWorker() {
  let running = false;
  debugLog('gemini 图片 worker 已启动');

  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const { authToken, apiUrl } = await chrome.storage.local.get(['authToken', 'apiUrl']);
      if (!authToken || !apiUrl) {
        debugLog('gemini 跳过轮询，缺少配置', { hasAuthToken: !!authToken, hasApiUrl: !!apiUrl });
        return;
      }
      const headers: Record<string, string> = { Authorization: `Bearer ${authToken}` };
      const resp = await bgFetch(`${apiUrl}/bridge/image-jobs/next?site_id=gemini`, { headers });
      if (!resp.ok) {
        debugLog('gemini 拉取任务失败', { status: resp.status });
        return;
      }
      const payload = JSON.parse(resp.body || '{}');
      const job = payload.job;
      if (!job?.id || !job?.prompt) return;
      debugLog('gemini 收到媒体任务', {
        id: job.id,
        mediaKind: job.media_kind || 'image',
        prompt: String(job.prompt).slice(0, 120),
      });
      try {
        await runGeminiImageJob(job, apiUrl, authToken);
      } catch (err) {
        debugLog('gemini 任务执行失败，准备回传错误', { id: job.id, error: err instanceof Error ? err.message : String(err) });
        await bgFetch(`${apiUrl}/bridge/image-jobs/${encodeURIComponent(job.id)}/result`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${authToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }),
        });
        throw err;
      }
    } catch (err) {
      console.warn('[OpenLink] gemini image worker error:', err);
      debugLog('gemini worker 异常', err instanceof Error ? err.message : String(err));
    } finally {
      running = false;
    }
  };

  void tick();
  window.setInterval(() => { void tick(); }, 2500);
}

async function runGeminiImageJob(job: any, apiUrl: string, authToken: string) {
  window.postMessage({ type: 'OPENLINK_SET_GEMINI_MEDIA_CAPTURE', data: { active: true } }, '*');
  try {
    showToast(`Gemini 开始生成图片: ${job.id}`, 2500);
    debugLog('gemini 开始执行图片任务', { id: job.id });
    const editor = await waitForElement<HTMLElement>('div.ql-editor[contenteditable="true"]', 20000);
    debugLog('gemini 已定位输入框');
    const beforeKeys = getGeminiImageKeys();
    const beforeMediaSeq = geminiMediaSeq;
    debugLog('gemini 提交前图片 key 集合', beforeKeys);
    await setGeminiPrompt(editor, String(job.prompt));
    debugLog('gemini Prompt 已写入', { prompt: String(job.prompt).slice(0, 120), editorText: getEditorText(editor).slice(0, 120) });
    const sendBtn = getSendButtonForEditor(editor, getSiteConfig().sendBtn);
    if (!sendBtn) throw new Error('gemini send button not found');
    debugLog('gemini 已定位发送按钮', { text: (sendBtn.textContent || '').trim().slice(0, 60) });
    await clickElementLikeUser(sendBtn);
    debugLog('gemini 已触发发送按钮点击');

    const imageEl = await waitForNewGeminiImage(beforeKeys, 180000);
    const imageSrc = imageEl.getAttribute('src');
    if (!imageSrc) throw new Error('gemini generated image src missing');
    debugLog('gemini 检测到新图片', { src: imageSrc });

    debugLog('gemini 新图已出现，继续等待无水印原图 URL', { previousSeq: beforeMediaSeq, timeoutMs: 120000 });
    const originalURL = await waitForGeminiOriginalMediaURL(beforeMediaSeq, 120000).catch(() => '');
    let base64: string;
    let mimeType: string;
    let sourceURL: string;
    if (originalURL) {
      debugLog('gemini 使用无水印原图 URL', { url: originalURL });
      const originalMediaResp = await fetchGeminiOriginalImageWithRetry(originalURL);
      sourceURL = originalMediaResp.finalUrl || originalURL;
      base64 = originalMediaResp.bodyBase64;
      mimeType = originalMediaResp.contentType || 'image/png';
    } else {
      debugLog('gemini 等待无水印原图 URL 超时，回退页面 blob 图片', { src: imageSrc });
      sourceURL = new URL(imageSrc, location.href).toString();
      const blob = await fetch(sourceURL).then(async (r) => {
        if (!r.ok) throw new Error(`gemini image fetch failed: HTTP ${r.status}`);
        return r.blob();
      });
      base64 = await blobToBase64(blob);
      mimeType = blob.type || 'image/png';
    }
    const fileName = `${job.id}${guessMediaExtension(mimeType, sourceURL)}`;

    const resultResp = await bgFetch(`${apiUrl}/bridge/image-jobs/${encodeURIComponent(job.id)}/result`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${authToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        file_name: fileName,
        mime_type: mimeType,
        data: base64,
      }),
    });
    if (!resultResp.ok) throw new Error(`gemini image result upload failed: HTTP ${resultResp.status}`);
    debugLog('gemini 图片结果回传成功', { fileName, status: resultResp.status });
    showToast(`Gemini 图片已保存: ${fileName}`, 3500);
  } finally {
    window.postMessage({ type: 'OPENLINK_SET_GEMINI_MEDIA_CAPTURE', data: { active: false } }, '*');
  }
}

async function fetchGeminiOriginalImageWithRetry(originalURL: string): Promise<{ bodyBase64: string; contentType: string; finalUrl: string }> {
  const maxAttempts = 3;
  let lastError = 'unknown error';
  const strategies = [
    {
      name: 'omit',
      options: {
        credentials: 'omit',
        redirect: 'follow',
        referrer: 'https://gemini.google.com/',
        referrerPolicy: 'no-referrer-when-downgrade',
      },
    },
    {
      name: 'include',
      options: {
        credentials: 'include',
        redirect: 'follow',
        referrer: 'https://gemini.google.com/',
        referrerPolicy: 'no-referrer-when-downgrade',
      },
    },
  ] as const;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (attempt > 1) {
      const delayMs = 1200 * attempt;
      debugLog('gemini 无水印原图抓取重试等待', { attempt, delayMs, url: originalURL });
      await sleep(delayMs);
    }
    for (const strategy of strategies) {
      const mediaResp = await bgFetchBinary(originalURL, strategy.options);
      if (mediaResp.ok && mediaResp.bodyBase64) {
        debugLog('gemini 无水印原图抓取成功', {
          attempt,
          strategy: strategy.name,
          status: mediaResp.status,
          url: originalURL,
          finalUrl: mediaResp.finalUrl,
          contentType: mediaResp.contentType,
        });
        return mediaResp;
      }
      lastError = `HTTP ${mediaResp.status}${mediaResp.error ? ` ${mediaResp.error}` : ''}`;
      debugLog('gemini 无水印原图抓取失败', {
        attempt,
        strategy: strategy.name,
        url: originalURL,
        error: lastError,
      });
    }
  }
  throw new Error(`gemini original image fetch failed after retry: ${lastError}`);
}

async function clickElementLikeUser(el: HTMLElement) {
  el.focus();
  const rect = el.getBoundingClientRect();
  const clientX = rect.left + Math.max(1, Math.min(rect.width - 1, rect.width / 2 || 1));
  const clientY = rect.top + Math.max(1, Math.min(rect.height - 1, rect.height / 2 || 1));
  const mouseInit = { bubbles: true, cancelable: true, composed: true, clientX, clientY, button: 0 };

  try { el.dispatchEvent(new PointerEvent('pointerdown', mouseInit)); } catch {}
  el.dispatchEvent(new MouseEvent('mousedown', mouseInit));
  await sleep(30);
  try { el.dispatchEvent(new PointerEvent('pointerup', mouseInit)); } catch {}
  el.dispatchEvent(new MouseEvent('mouseup', mouseInit));
  el.dispatchEvent(new MouseEvent('click', mouseInit));
  await sleep(80);

  if (location.hostname === 'labs.google' && location.pathname.startsWith('/fx')) {
    const stillThere = document.contains(el);
    if (stillThere) {
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
      el.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
    }
  }
}

function setContentEditableText(el: HTMLElement, text: string) {
  el.focus();
  const selection = window.getSelection();
  if (selection) {
    const range = document.createRange();
    range.selectNodeContents(el);
    selection.removeAllRanges();
    selection.addRange(range);
  }
  document.execCommand('insertText', false, text);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

async function setLabsFxPrompt(editor: HTMLElement, text: string) {
  debugLog('labsfx 开始写入 Prompt', { text: text.slice(0, 120) });
  pasteIntoLabsFxEditor(editor, text);
  await sleep(150);
  debugLog('labsfx paste 后校验', {
    plain: getEditorText(editor).replace(/\uFEFF/g, '').trim().slice(0, 120),
    hasStringNode: !!editor.querySelector('[data-slate-string="true"]'),
  });

  if (!isLabsFxPromptApplied(editor, text)) {
    clearLabsFxEditor(editor);
    await sleep(80);
    placeCaretInLabsFxEditor(editor);
    document.execCommand('insertText', false, text);
    editor.dispatchEvent(new Event('input', { bubbles: true }));
    editor.dispatchEvent(new Event('change', { bubbles: true }));
    await sleep(150);
    debugLog('labsfx insertText 后校验', {
      plain: getEditorText(editor).replace(/\uFEFF/g, '').trim().slice(0, 120),
      hasStringNode: !!editor.querySelector('[data-slate-string="true"]'),
    });
  }

  if (!isLabsFxPromptApplied(editor, text)) {
    clearLabsFxEditor(editor);
    await sleep(80);
    placeCaretInLabsFxEditor(editor);
    setContentEditableText(editor, text);
    await sleep(150);
    debugLog('labsfx contenteditable 回退后校验', {
      plain: getEditorText(editor).replace(/\uFEFF/g, '').trim().slice(0, 120),
      hasStringNode: !!editor.querySelector('[data-slate-string="true"]'),
    });
  }

  if (!isLabsFxPromptApplied(editor, text)) {
    debugLog('labsfx Prompt 写入失败', shortenHtml(editor.innerHTML || '', 1000));
    throw new Error('labs.google/fx editor fill failed');
  }
  debugLog('labsfx Prompt 写入成功');
}

async function prepareLabsFxPromptArea(editor: HTMLElement) {
  const clearBtn = Array.from(editor.parentElement?.parentElement?.querySelectorAll('button') || []).find((btn) => {
    return (btn.textContent || '').includes('清除提示');
  }) as HTMLElement | undefined;
  if (clearBtn && isVisibleElement(clearBtn)) {
    debugLog('labsfx 点击清除提示');
    await clickElementLikeUser(clearBtn);
    await sleep(200);
  }

  await clearLabsFxReferenceImages(editor);
  clearLabsFxEditor(editor);
  debugLog('labsfx 已清空输入框');
  await sleep(100);
}

function clearLabsFxEditor(editor: HTMLElement) {
  editor.focus();
  const selection = window.getSelection();
  if (selection) {
    const range = document.createRange();
    range.selectNodeContents(editor);
    selection.removeAllRanges();
    selection.addRange(range);
  }
  document.execCommand('delete', false);
  editor.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType: 'deleteContentBackward', data: null }));
  editor.dispatchEvent(new Event('input', { bubbles: true }));
  editor.dispatchEvent(new Event('change', { bubbles: true }));
}

function getLabsFxReferenceCardCount(editor: HTMLElement): number {
  const region = (editor.closest('.sc-84e494b2-0') ?? defaultEditorRegion(editor)) as Element | null;
  if (!region) return 0;
  return region.querySelectorAll('button[data-card-open] img[alt*="收录在集合中"], button[data-card-open] img[alt*="媒体内容"]').length;
}

function getLabsFxProjectId(): string {
  if (labsFxProjectId) return labsFxProjectId;
  const pathMatch = location.pathname.match(/\/project\/([^/]+)/);
  return pathMatch?.[1] || '';
}

function getLabsFxUploadHeaders(): Record<string, string> | null {
  if (!labsFxAPIHeaders.authorization) return null;
  return {
    ...labsFxAPIHeaders,
    'content-type': 'application/json',
  };
}

async function uploadLabsFxReferenceImageViaAPI(item: any, index: number): Promise<string | null> {
  const projectId = getLabsFxProjectId();
  const headers = getLabsFxUploadHeaders();
  if (!projectId || !headers) {
    debugLog('labsfx API 上传条件不足，回退 UI 上传', {
      hasProjectId: !!projectId,
      headerKeys: Object.keys(labsFxAPIHeaders),
    });
    return null;
  }

  const mimeType = typeof item?.mime_type === 'string' && item.mime_type ? item.mime_type : 'image/png';
  const fileName = typeof item?.file_name === 'string' && item.file_name ? item.file_name : `reference-${index + 1}${guessImageExtension(mimeType, '')}`;
  const data = typeof item?.data === 'string' ? item.data : '';
  if (!data) return null;

  const body = {
    clientContext: {
      tool: 'PINHOLE',
      projectId,
    },
    fileName,
    imageBytes: data,
    isHidden: false,
    isUserUploaded: true,
    mimeType,
  };

  debugLog('labsfx 开始 API 上传参考图', { index: index + 1, fileName, projectId });
  const resp = await bgFetch('https://aisandbox-pa.googleapis.com/v1/flow/uploadImage', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    debugLog('labsfx API 上传失败', { index: index + 1, status: resp.status, body: resp.body.slice(0, 400) });
    return null;
  }

  let payload: any = {};
  try { payload = JSON.parse(resp.body || '{}'); } catch {}
  const mediaId = payload?.media?.name || payload?.mediaGenerationId?.mediaGenerationId || '';
  if (!mediaId) {
    debugLog('labsfx API 上传返回缺少 mediaId', { index: index + 1, body: resp.body.slice(0, 400) });
    return null;
  }
  debugLog('labsfx API 上传成功', { index: index + 1, mediaId });
  return mediaId;
}

function setPendingLabsFxReferenceInputs(mediaIds: string[], mediaKind: 'image' | 'video') {
  labsFxReferencesInjectedReady = false;
  window.postMessage({
    type: 'OPENLINK_SET_PENDING_FLOW_REFERENCES',
    data: {
      mediaKind,
      items: mediaIds.map((mediaId) => ({ mediaId })),
    },
  }, '*');
}

async function waitForLabsFxPendingReferencesReady(timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (labsFxReferencesInjectedReady) return true;
    await sleep(100);
  }
  return false;
}

async function waitForLabsFxGeneratePatched(previousSeq: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (labsFxGeneratePatchedSeq > previousSeq) return true;
    await sleep(100);
  }
  return false;
}

function refreshLabsFxComposerState(editor: HTMLElement) {
  editor.focus();
  placeCaretInLabsFxEditor(editor);
  editor.dispatchEvent(new Event('focus', { bubbles: true }));
  editor.dispatchEvent(new InputEvent('beforeinput', {
    bubbles: true,
    cancelable: true,
    inputType: 'insertText',
    data: '',
  }));
  editor.dispatchEvent(new Event('input', { bubbles: true }));
  editor.dispatchEvent(new Event('change', { bubbles: true }));
}

async function clearLabsFxReferenceImages(editor: HTMLElement) {
  const region = (editor.closest('.sc-84e494b2-0') ?? defaultEditorRegion(editor)) as Element | null;
  if (!region) return;

  for (let pass = 0; pass < 3; pass++) {
    const count = getLabsFxReferenceCardCount(editor);
    if (count === 0) return;
    debugLog('labsfx 清理参考图', { pass, count });
    const cancelIcons = Array.from(region.querySelectorAll<HTMLElement>('.google-symbols')).filter((el) => (el.textContent || '').trim() === 'cancel');
    if (cancelIcons.length === 0) break;
    for (const icon of cancelIcons) {
      const target = (icon.parentElement as HTMLElement | null) ?? icon;
      await clickElementLikeUser(target);
      await sleep(120);
    }
    await sleep(300);
  }

  const remaining = getLabsFxReferenceCardCount(editor);
  if (remaining > 0) debugLog('labsfx 参考图未完全清理', { remaining });
}

function findLabsFxFileInput(): HTMLInputElement | null {
  return Array.from(document.querySelectorAll<HTMLInputElement>('input[type="file"]')).find((input) => input.isConnected) ?? null;
}

function getLabsFxAddButton(editor: HTMLElement): HTMLElement | null {
  const region = (editor.closest('.sc-84e494b2-0') ?? defaultEditorRegion(editor)) as Element | null;
  if (!region) return null;
  return Array.from(region.querySelectorAll<HTMLElement>('button')).find((btn) => btn.querySelector('.google-symbols')?.textContent?.trim() === 'add_2') ?? null;
}

async function ensureLabsFxFileInput(editor: HTMLElement): Promise<HTMLInputElement | null> {
  const existing = findLabsFxFileInput();
  if (existing) return existing;
  const addBtn = getLabsFxAddButton(editor);
  if (!addBtn) return null;
  await clickElementLikeUser(addBtn);
  await sleep(250);
  return findLabsFxFileInput();
}

function setFileInputFiles(input: HTMLInputElement, files: File[]) {
  const dataTransfer = new DataTransfer();
  for (const file of files) dataTransfer.items.add(file);
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'files')?.set;
  if (setter) setter.call(input, dataTransfer.files);
  else Object.defineProperty(input, 'files', { configurable: true, value: dataTransfer.files });
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function referenceImageJobToFile(item: any, index: number): File {
  const mimeType = typeof item?.mime_type === 'string' && item.mime_type ? item.mime_type : 'image/png';
  const fileName = typeof item?.file_name === 'string' && item.file_name ? item.file_name : `reference-${index + 1}${guessImageExtension(mimeType, '')}`;
  const data = typeof item?.data === 'string' ? item.data : '';
  const bytes = base64ToBytes(data);
  return new File([bytes], fileName, { type: mimeType });
}

async function waitForLabsFxReferenceCount(editor: HTMLElement, expectedCount: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (getLabsFxReferenceCardCount(editor) >= expectedCount) return true;
    await sleep(200);
  }
  return false;
}

async function waitForLabsFxNewResourceTile(previousKeys: string[], timeoutMs: number): Promise<HTMLElement | null> {
  const before = new Set(previousKeys);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const tile of getLabsFxVisibleResourceTiles()) {
      const key = tile.getAttribute('data-tile-id') || tile.querySelector('img[alt="生成的图片"]')?.getAttribute('src') || '';
      if (key && !before.has(key)) return tile;
    }
    await sleep(250);
  }
  return null;
}

async function attachLabsFxUploadedResourceTile(editor: HTMLElement, tile: HTMLElement, expectedCount: number): Promise<boolean> {
  const key = tile.getAttribute('data-tile-id') || '';
  const clickTargets = [
    tile.querySelector<HTMLElement>('[role="button"]'),
    tile.querySelector<HTMLElement>('a'),
    tile,
  ].filter(Boolean) as HTMLElement[];

  for (const target of clickTargets) {
    debugLog('labsfx 尝试附着已上传资源卡片', {
      key,
      target: target.tagName.toLowerCase(),
      role: target.getAttribute('role') || '',
    });
    await clickElementLikeUser(target);
    if (await waitForLabsFxReferenceCount(editor, expectedCount, 2500)) return true;
  }
  return false;
}

function dispatchLabsFxPasteFile(target: HTMLElement, file: File) {
  const dataTransfer = new DataTransfer();
  dataTransfer.items.add(file);
  try {
    target.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dataTransfer, bubbles: true, cancelable: true }));
  } catch {}
}

function dispatchLabsFxDropFile(target: HTMLElement, file: File) {
  const dataTransfer = new DataTransfer();
  dataTransfer.items.add(file);
  const eventInit = { bubbles: true, cancelable: true, dataTransfer } as DragEventInit;
  for (const type of ['dragenter', 'dragover', 'drop']) {
    try {
      target.dispatchEvent(new DragEvent(type, eventInit));
    } catch {}
  }
}

async function attachLabsFxReferenceImages(editor: HTMLElement, items: any[], mediaKind: 'image' | 'video' = 'image') {
  const target = (editor.closest('.sc-84e494b2-0') as HTMLElement | null) ?? editor;
  const uploadedMediaIds: string[] = [];
  for (let i = 0; i < items.length; i++) {
    const file = referenceImageJobToFile(items[i], i);
    const beforeCount = getLabsFxReferenceCardCount(editor);
    const beforeKeys = getLabsFxTileKeys();
    debugLog('labsfx 附加参考图', { index: i + 1, beforeCount, fileName: file.name, size: file.size, type: file.type });

    const mediaId = await uploadLabsFxReferenceImageViaAPI(items[i], i);
    if (mediaId) {
      uploadedMediaIds.push(mediaId);
      if (await waitForLabsFxReferenceCount(editor, beforeCount + 1, 1500)) continue;
      const newTile = await waitForLabsFxNewResourceTile(beforeKeys, 4000);
      if (newTile) {
        const key = newTile.getAttribute('data-tile-id') || '';
        debugLog('labsfx API 上传后发现新资源卡片', { index: i + 1, mediaId, key });
      }
      continue;
    }

    const input = await ensureLabsFxFileInput(editor);
    if (input) {
      debugLog('labsfx 使用文件输入上传参考图', { index: i + 1 });
      setFileInputFiles(input, [file]);
      if (await waitForLabsFxReferenceCount(editor, beforeCount + 1, 15000)) continue;
      debugLog('labsfx 文件输入上传未生效，准备回退', { index: i + 1 });
    }

    debugLog('labsfx 使用 paste 上传参考图', { index: i + 1 });
    dispatchLabsFxPasteFile(editor, file);
    if (await waitForLabsFxReferenceCount(editor, beforeCount + 1, 15000)) continue;
    debugLog('labsfx paste 上传未生效，准备回退', { index: i + 1 });

    debugLog('labsfx 使用 drop 上传参考图', { index: i + 1 });
    dispatchLabsFxDropFile(target, file);
    if (await waitForLabsFxReferenceCount(editor, beforeCount + 1, 15000)) continue;

    debugLog('labsfx 参考图附加失败', { index: i + 1, fileName: file.name });
    throw new Error(`labs.google/fx reference image attach failed: ${file.name}`);
  }

  if (uploadedMediaIds.length > 0) {
    debugLog('labsfx 准备注入已上传参考图到生成请求', { count: uploadedMediaIds.length, mediaKind });
    setPendingLabsFxReferenceInputs(uploadedMediaIds, mediaKind);
    if (!await waitForLabsFxPendingReferencesReady(2000)) {
      throw new Error('labs.google/fx pending reference injection setup failed');
    }
    refreshLabsFxComposerState(editor);
    debugLog('labsfx 注入准备完成后已刷新输入区状态', { mediaKind });
    await sleep(120);
  }
}

function pasteIntoLabsFxEditor(editor: HTMLElement, text: string) {
  placeCaretInLabsFxEditor(editor);
  const dataTransfer = new DataTransfer();
  dataTransfer.setData('text/plain', text);
  editor.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dataTransfer, bubbles: true, cancelable: true }));
  editor.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType: 'insertFromPaste', data: text }));
}

function isLabsFxPromptApplied(editor: HTMLElement, text: string): boolean {
  const plain = getEditorText(editor).replace(/\uFEFF/g, '').trim();
  const hasStringNode = Array.from(editor.querySelectorAll('[data-slate-string="true"]')).some((node) => (node.textContent || '').includes(text));
  return plain === text.trim() && hasStringNode;
}

function placeCaretInLabsFxEditor(editor: HTMLElement) {
  editor.focus();
  const selection = window.getSelection();
  if (!selection) return;

  const stringNode = editor.querySelector('[data-slate-string="true"]')?.firstChild;
  if (stringNode) {
    const range = document.createRange();
    range.setStart(stringNode, stringNode.textContent?.length ?? 0);
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);
    return;
  }

  const zeroWidthNode = editor.querySelector('[data-slate-zero-width]')?.firstChild;
  if (zeroWidthNode) {
    const offset = Math.min(1, zeroWidthNode.textContent?.length ?? 0);
    const range = document.createRange();
    range.setStart(zeroWidthNode, offset);
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);
    return;
  }

  const range = document.createRange();
  range.selectNodeContents(editor);
  range.collapse(false);
  selection.removeAllRanges();
  selection.addRange(range);
}

function getLatestLabsFxImageKey(): string {
  const tile = getLatestLabsFxTile();
  if (!tile) return '';
  return tile.getAttribute('data-tile-id') || tile.querySelector('img[alt="生成的图片"], video')?.getAttribute('src') || '';
}

function getLatestLabsFxImage(): HTMLImageElement | null {
  return getLatestLabsFxTile()?.querySelector('img[alt="生成的图片"]') ?? null;
}

function getLatestLabsFxTile(): HTMLElement | null {
  return getLabsFxVisibleResourceTiles()[0] ?? null;
}

function getLabsFxTileKeys(): string[] {
  return getLabsFxVisibleResourceTiles()
    .map((tile) => tile.getAttribute('data-tile-id') || tile.querySelector('img[alt="生成的图片"], video')?.getAttribute('src') || '')
    .filter(Boolean);
}

function getLabsFxNewTile(previousKeys: Set<string>): { tile: HTMLElement; key: string; img: HTMLImageElement } | null {
  for (const tile of getLabsFxVisibleResourceTiles()) {
    const img = tile.querySelector('img[alt="生成的图片"]') as HTMLImageElement | null;
    if (!img) continue;
    const key = tile.getAttribute('data-tile-id') || img.getAttribute('src') || '';
    if (!key || previousKeys.has(key)) continue;
    return { tile, key, img };
  }
  return null;
}

function getLabsFxNewMediaTile(previousKeys: Set<string>, mediaKind: 'image' | 'video'): { tile: HTMLElement; key: string; media: HTMLImageElement | HTMLVideoElement } | null {
  for (const tile of getLabsFxVisibleResourceTiles()) {
    const media = mediaKind === 'video'
      ? tile.querySelector('video')
      : tile.querySelector('img[alt="生成的图片"]');
    if (!media) continue;
    const key = tile.getAttribute('data-tile-id') || media.getAttribute('src') || '';
    if (!key || previousKeys.has(key)) continue;
    return { tile, key, media: media as HTMLImageElement | HTMLVideoElement };
  }
  return null;
}

function getLabsFxUnexpectedNewMediaKind(previousKeys: Set<string>, expectedKind: 'image' | 'video'): 'image' | 'video' | null {
  const otherKind = expectedKind === 'video' ? 'image' : 'video';
  for (const tile of getLabsFxVisibleResourceTiles()) {
    const media = otherKind === 'video'
      ? tile.querySelector('video')
      : tile.querySelector('img[alt="生成的图片"]');
    if (!media) continue;
    const key = tile.getAttribute('data-tile-id') || media.getAttribute('src') || '';
    if (!key || previousKeys.has(key)) continue;
    return otherKind;
  }
  return null;
}

function getLabsFxVisibleResourceTiles(): HTMLElement[] {
  const seen = new Set<string>();
  const tiles: HTMLElement[] = [];
  for (const tile of Array.from(document.querySelectorAll<HTMLElement>('[data-tile-id]'))) {
    if (!isVisibleElement(tile)) continue;
    const media = tile.querySelector('img[alt="生成的图片"], video');
    if (!media) continue;
    const key = tile.getAttribute('data-tile-id') || media.getAttribute('src') || '';
    if (!key || seen.has(key)) continue;
    seen.add(key);
    tiles.push(tile);
  }
  return tiles;
}

async function waitForNewLabsFxImage(previousKeysInput: string[] | Set<string>, timeoutMs: number): Promise<HTMLImageElement> {
  const deadline = Date.now() + timeoutMs;
  const previousKeys = previousKeysInput instanceof Set ? previousKeysInput : new Set(previousKeysInput);
  debugLog('labsfx 等待新图片', { previousKeys: Array.from(previousKeys), timeoutMs });
  let lastSeenKeys = '';
  while (Date.now() < deadline) {
    const currentKeys = getLabsFxTileKeys();
    const currentKeySummary = currentKeys.join(',');
    if (currentKeySummary !== lastSeenKeys) {
      lastSeenKeys = currentKeySummary;
      debugLog('labsfx 当前资源列表 key', currentKeys);
    }
    const found = getLabsFxNewTile(previousKeys);
    if (found && found.img.complete && found.img.naturalWidth > 0) {
      debugLog('labsfx 新图片已就绪', { key: found.key, width: found.img.naturalWidth, height: found.img.naturalHeight });
      return found.img;
    }
    await sleep(1000);
  }
  debugLog('labsfx 等待新图片超时', { previousKeys: Array.from(previousKeys), timeoutMs, currentKeys: getLabsFxTileKeys() });
  throw new Error('wait for generated image timed out');
}

function isLabsFxMediaReady(mediaKind: 'image' | 'video', media: HTMLImageElement | HTMLVideoElement): boolean {
  if (mediaKind === 'video') {
    const video = media as HTMLVideoElement;
    return !!video.getAttribute('src') && video.readyState >= 2;
  }
  const image = media as HTMLImageElement;
  return image.complete && image.naturalWidth > 0;
}

async function waitForNewLabsFxGeneratedMedia(
  mediaKind: 'image' | 'video',
  previousKeysInput: string[] | Set<string>,
  timeoutMs: number
): Promise<HTMLImageElement | HTMLVideoElement> {
  const deadline = Date.now() + timeoutMs;
  const previousKeys = previousKeysInput instanceof Set ? previousKeysInput : new Set(previousKeysInput);
  debugLog(`labsfx 等待新${mediaKind === 'video' ? '视频' : '图片'}`, { previousKeys: Array.from(previousKeys), timeoutMs });
  let lastSeenKeys = '';
  while (Date.now() < deadline) {
    const currentKeys = getLabsFxTileKeys();
    const currentKeySummary = currentKeys.join(',');
    if (currentKeySummary !== lastSeenKeys) {
      lastSeenKeys = currentKeySummary;
      debugLog('labsfx 当前资源列表 key', currentKeys);
    }
    const found = getLabsFxNewMediaTile(previousKeys, mediaKind);
    if (found && isLabsFxMediaReady(mediaKind, found.media)) {
      if (mediaKind === 'video') {
        const video = found.media as HTMLVideoElement;
        debugLog('labsfx 新视频已就绪', { key: found.key, width: video.videoWidth, height: video.videoHeight });
      } else {
        const image = found.media as HTMLImageElement;
        debugLog('labsfx 新图片已就绪', { key: found.key, width: image.naturalWidth, height: image.naturalHeight });
      }
      return found.media;
    }
    const unexpectedKind = getLabsFxUnexpectedNewMediaKind(previousKeys, mediaKind);
    if (unexpectedKind) {
      debugLog(`labsfx 检测到非预期新${unexpectedKind === 'video' ? '视频' : '图片'}`, {
        expected: mediaKind,
        actual: unexpectedKind,
      });
    }
    await sleep(1000);
  }
  debugLog(`labsfx 等待新${mediaKind === 'video' ? '视频' : '图片'}超时`, { previousKeys: Array.from(previousKeys), timeoutMs, currentKeys: getLabsFxTileKeys() });
  throw new Error(`wait for generated ${mediaKind} timed out`);
}

function getLabsFxModeButton(editor: HTMLElement): HTMLElement | null {
  const region = (editor.closest('.sc-84e494b2-0') ?? defaultEditorRegion(editor)) as Element | null;
  if (!region) return null;
  return Array.from(region.querySelectorAll<HTMLElement>('button[aria-haspopup="menu"]')).find((btn) => {
    const text = (btn.textContent || '').trim();
    return text.includes('视频') || text.includes('Nano') || text.includes('Banana');
  }) ?? null;
}

async function ensureLabsFxMode(editor: HTMLElement, mediaKind: 'image' | 'video') {
  const modeBtn = getLabsFxModeButton(editor);
  if (!modeBtn) return;
  const currentText = (modeBtn.textContent || '').trim();
  const isVideoMode = currentText.includes('视频');
  if (mediaKind === 'video' && isVideoMode) {
    debugLog('labsfx 当前已处于视频模式');
    return;
  }
  if (mediaKind === 'image' && !isVideoMode) {
    debugLog('labsfx 当前已处于图片模式', { currentText: currentText.slice(0, 80) });
    return;
  }

  debugLog(`labsfx 尝试切换到${mediaKind === 'video' ? '视频' : '图片'}模式`, { currentText: currentText.slice(0, 80) });
  await clickElementLikeUser(modeBtn);
  await sleep(300);

  const candidates = Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"], [role="option"], button, div')).filter((el) => {
    if (!isVisibleElement(el)) return false;
    const text = (el.textContent || '').trim();
    if (mediaKind === 'video') return text === '视频' || text.startsWith('视频');
    return text === '图片' || text.startsWith('图片') || text.includes('Nano Banana');
  });
  if (candidates[0]) {
    await clickElementLikeUser(candidates[0]);
    await sleep(400);
    debugLog(`labsfx 已切换到${mediaKind === 'video' ? '视频' : '图片'}模式`);
    return;
  }
  debugLog(`labsfx 未找到${mediaKind === 'video' ? '视频' : '图片'}模式菜单项，继续使用当前模式`);
}

async function waitForElement<T extends Element>(selector: string, timeoutMs: number): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const el = document.querySelector(selector) as T | null;
    if (el) return el;
    await sleep(250);
  }
  throw new Error(`element not found: ${selector}`);
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function setGeminiPrompt(editor: HTMLElement, text: string) {
  editor.focus();
  const selection = window.getSelection();
  if (selection) {
    const range = document.createRange();
    range.selectNodeContents(editor);
    selection.removeAllRanges();
    selection.addRange(range);
  }
  try { document.execCommand('delete', false); } catch {}
  await sleep(80);
  editor.focus();
  try {
    document.execCommand('insertText', false, text);
  } catch {}
  editor.dispatchEvent(new Event('input', { bubbles: true }));
  editor.dispatchEvent(new Event('change', { bubbles: true }));
  await sleep(120);
  if (!getEditorText(editor).includes(text.trim())) {
    editor.textContent = text;
    editor.dispatchEvent(new Event('input', { bubbles: true }));
    editor.dispatchEvent(new Event('change', { bubbles: true }));
  }
}

async function blobToBase64(blob: Blob): Promise<string> {
  const buffer = await blob.arrayBuffer();
  let binary = '';
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function guessImageExtension(mimeType: string, src: string): string {
  const lowerMime = mimeType.toLowerCase();
  if (lowerMime.includes('png')) return '.png';
  if (lowerMime.includes('jpeg') || lowerMime.includes('jpg')) return '.jpg';
  if (lowerMime.includes('webp')) return '.webp';
  const match = src.match(/\.(png|jpe?g|webp|gif)(?:$|\?)/i);
  return match ? `.${match[1].toLowerCase() === 'jpeg' ? 'jpg' : match[1].toLowerCase()}` : '.png';
}

function guessMediaExtension(mimeType: string, src: string): string {
  const lowerMime = mimeType.toLowerCase();
  if (lowerMime.includes('video/mp4')) return '.mp4';
  if (lowerMime.includes('video/webm')) return '.webm';
  if (lowerMime.includes('video/quicktime')) return '.mov';
  const videoMatch = src.match(/\.(mp4|webm|mov|m4v)(?:$|\?)/i);
  if (videoMatch) return `.${videoMatch[1].toLowerCase()}`;
  return guessImageExtension(mimeType, src);
}

function getLatestGeminiImageResponseContainer(): Element | null {
  const messageContents = Array.from(document.querySelectorAll('message-content'));
  for (let i = messageContents.length - 1; i >= 0; i--) {
    const message = messageContents[i];
    if (message.querySelector('.attachment-container.generated-images img.image')) return message;
  }
  return null;
}

function getGeminiGeneratedImageElements(): HTMLImageElement[] {
  const latestMessage = getLatestGeminiImageResponseContainer();
  if (!latestMessage) return [];
  return Array.from(latestMessage.querySelectorAll<HTMLImageElement>('generated-image img.image.loaded, .attachment-container.generated-images img.image.loaded'))
    .filter((img) => isVisibleElement(img) && !!img.getAttribute('src'));
}

function getGeminiImageKeys(): string[] {
  return getGeminiGeneratedImageElements()
    .map((img) => img.getAttribute('src') || '')
    .filter(Boolean);
}

async function waitForGeminiOriginalMediaURL(previousSeq: number, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  debugLog('gemini 等待无水印原图 URL', { previousSeq, timeoutMs });
  while (Date.now() < deadline) {
    if (geminiMediaSeq > previousSeq && geminiLatestMediaURLs.length > 0) {
      const url = geminiLatestMediaURLs[geminiLatestMediaURLs.length - 1];
      if (url) return url;
    }
    await sleep(500);
  }
  throw new Error('wait for gemini original media url timed out');
}

async function waitForNewGeminiImage(previousKeysInput: string[] | Set<string>, timeoutMs: number): Promise<HTMLImageElement> {
  const deadline = Date.now() + timeoutMs;
  const previousKeys = previousKeysInput instanceof Set ? previousKeysInput : new Set(previousKeysInput);
  debugLog('gemini 等待新图片', { previousKeys: Array.from(previousKeys), timeoutMs });
  let lastSeenKeys = '';
  while (Date.now() < deadline) {
    const currentKeys = getGeminiImageKeys();
    const currentKeySummary = currentKeys.join(',');
    if (currentKeySummary !== lastSeenKeys) {
      lastSeenKeys = currentKeySummary;
      debugLog('gemini 当前图片 key', currentKeys);
    }
    const images = getGeminiGeneratedImageElements();
    for (let i = images.length - 1; i >= 0; i--) {
      const img = images[i];
      const key = img.getAttribute('src') || '';
      if (!key || previousKeys.has(key)) continue;
      if (key.startsWith('blob:') || (img.complete && img.naturalWidth > 0)) {
        debugLog('gemini 新图片已就绪', { key, width: img.naturalWidth, height: img.naturalHeight });
        return img;
      }
    }
    await sleep(1000);
  }
  debugLog('gemini 等待新图片超时', { previousKeys: Array.from(previousKeys), timeoutMs, currentKeys: getGeminiImageKeys() });
  throw new Error('wait for gemini generated image timed out');
}

async function sendInitPrompt() {
  const { authToken, apiUrl } = await chrome.storage.local.get(['authToken', 'apiUrl']);
  if (!apiUrl) { alert('请先在插件中配置 API 地址'); return; }
  const headers: any = { 'Content-Type': 'application/json' };
  if (authToken) headers['Authorization'] = `Bearer ${authToken}`;
  const resp = await bgFetch(`${apiUrl}/prompt`, { headers });
  if (!resp.ok) { alert('获取初始化提示词失败'); return; }

  if (location.hostname.includes('aistudio.google.com')) {
    await fillAiStudioSystemInstructions(resp.body);
    return;
  }

  fillAndSend(resp.body, true);
}

async function fillAiStudioSystemInstructions(prompt: string) {
  const openBtn = document.querySelector<HTMLElement>('button[data-test-system-instructions-card]');
  if (!openBtn) { fillAndSend(prompt, true); return; }

  openBtn.click();
  await new Promise(r => setTimeout(r, 600));

  const textarea = document.querySelector<HTMLTextAreaElement>('textarea[aria-label="System instructions"]');
  if (!textarea) { fillAndSend(prompt, true); return; }

  const nativeSetter = getNativeSetter();
  if (nativeSetter) nativeSetter.call(textarea, prompt);
  else textarea.value = prompt;
  textarea.dispatchEvent(new Event('input', { bubbles: true }));

  await new Promise(r => setTimeout(r, 300));

  const closeBtn = document.querySelector<HTMLElement>('button[data-test-close-button]');
  if (closeBtn) closeBtn.click();
}

function showQuestionPopup(question: string, options: string[]): Promise<string> {
  return new Promise(resolve => {
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:2147483647;display:flex;align-items:center;justify-content:center';
    const box = document.createElement('div');
    box.style.cssText = 'background:#1e1e2e;color:#cdd6f4;border-radius:12px;padding:24px;max-width:480px;width:90%;box-shadow:0 8px 32px rgba(0,0,0,0.5)';
    const title = document.createElement('p');
    title.style.cssText = 'margin:0 0 16px;font-size:15px;line-height:1.5;white-space:pre-wrap';
    title.textContent = question;
    box.appendChild(title);
    options.forEach((opt, i) => {
      const btn = document.createElement('button');
      btn.textContent = `${i + 1}. ${opt}`;
      btn.style.cssText = 'display:block;width:100%;margin-bottom:8px;padding:10px 14px;background:#313244;color:#cdd6f4;border:1px solid #45475a;border-radius:8px;cursor:pointer;font-size:13px;text-align:left';
      btn.onmouseenter = () => { btn.style.background = '#45475a'; };
      btn.onmouseleave = () => { btn.style.background = '#313244'; };
      btn.onclick = () => { overlay.remove(); resolve(opt); };
      box.appendChild(btn);
    });
    overlay.appendChild(box);
    document.body.appendChild(overlay);
  });
}

async function executeToolCall(toolCall: any) {
  if (toolCall.name === 'question') {
    const q: string = toolCall.args?.question ?? '';
    const rawOpts = toolCall.args?.options;
    const opts: string[] = parseOptions(rawOpts);
    const answer = opts.length > 0 ? await showQuestionPopup(q, opts) : (prompt(q) ?? '');
    fillAndSend(answer, false);
    return;
  }

  try {
    const { authToken, apiUrl } = await chrome.storage.local.get(['authToken', 'apiUrl']);
    const headers: any = { 'Content-Type': 'application/json' };
    if (authToken) headers['Authorization'] = `Bearer ${authToken}`;

    if (!apiUrl) { fillAndSend('请先在插件中配置 API 地址', false); return; }

    const response = await bgFetch(`${apiUrl}/exec`, {
      method: 'POST',
      headers,
      body: JSON.stringify(toolCall)
    });

    if (response.status === 401) { fillAndSend('认证失败，请在插件中重新输入 Token', false); return; }
    if (!response.ok) { fillAndSend(`[OpenLink 错误] HTTP ${response.status}`, false); return; }

    const result = JSON.parse(response.body);
    const text = result.output || result.error || '[OpenLink] 空响应';

    if (result.stopStream) {
      clickStopButton();
      showToast('✅ 文件已写入成功，已停止生成');
      await new Promise(r => setTimeout(r, 600));
      fillAndSend(text, true);
      return;
    }

    fillAndSend(text, true);
  } catch (error) {
    fillAndSend(`[OpenLink 错误] ${error}`, false);
  }
}

function showToast(msg: string, durationMs = 3000): void {
  const toast = document.createElement('div');
  toast.style.cssText = 'position:fixed;bottom:170px;right:20px;z-index:2147483647;background:#1e1e2e;color:#a6e3a1;border:1px solid #a6e3a1;border-radius:10px;padding:10px 16px;font-size:13px;box-shadow:0 4px 16px rgba(0,0,0,0.4)';
  toast.textContent = msg;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), durationMs);
}

function clickStopButton(): void {
  const stopSel = getSiteConfig().stopBtn;
  if (!stopSel) return;
  const btn = document.querySelector(stopSel) as HTMLElement;
  if (btn) btn.click();
}

function showCountdownToast(ms: number, onFire: () => void): void {
  const toast = document.createElement('div');
  toast.style.cssText = 'position:fixed;bottom:130px;right:20px;z-index:2147483647;background:#1e1e2e;color:#cdd6f4;border:1px solid #45475a;border-radius:10px;padding:10px 14px;font-size:13px;display:flex;align-items:center;gap:10px;box-shadow:0 4px 16px rgba(0,0,0,0.4)';
  const label = document.createElement('span');
  const cancelBtn = document.createElement('button');
  cancelBtn.textContent = '取消';
  cancelBtn.style.cssText = 'background:#313244;color:#f38ba8;border:1px solid #f38ba8;border-radius:6px;padding:2px 8px;cursor:pointer;font-size:12px';
  toast.appendChild(label);
  toast.appendChild(cancelBtn);
  document.body.appendChild(toast);

  let remaining = Math.ceil(ms / 1000);
  let cancelled = false;
  label.textContent = `${remaining}s 后自动提交`;
  const interval = setInterval(() => {
    remaining--;
    label.textContent = `${remaining}s 后自动提交`;
    if (remaining <= 0) { clearInterval(interval); toast.remove(); if (!cancelled) onFire(); }
  }, 1000);
  cancelBtn.onclick = () => { cancelled = true; clearInterval(interval); toast.remove(); };
}

function querySelectorFirst(selectors: string): HTMLElement | null {
  for (const sel of selectors.split(',').map(s => s.trim())) {
    const el = document.querySelector(sel) as HTMLElement | null;
    if (el) return el;
  }
  return null;
}

function isVisibleElement(el: HTMLElement): boolean {
  const rect = el.getBoundingClientRect();
  const style = window.getComputedStyle(el);
  if (el.getAttribute('aria-hidden') === 'true') return false;
  if (el.getAttribute('tabindex') === '-1') return false;
  if (style.visibility === 'hidden') return false;
  if (style.display === 'none') return false;
  if (style.opacity === '0') return false;
  return rect.width > 0 && rect.height > 0;
}

function scoreEditorCandidate(el: HTMLElement): number {
  const rect = el.getBoundingClientRect();
  const inViewport = rect.bottom > 0 && rect.top < window.innerHeight;
  const nearBottom = Math.max(0, Math.min(window.innerHeight, rect.bottom));
  const area = Math.min(rect.width * rect.height, 200000);
  const submitBtn = getSendButtonForEditor(el, getSiteConfig().sendBtn);
  const submitScore = submitBtn && !(submitBtn as HTMLButtonElement).disabled ? 2_000_000 : submitBtn ? 1_000_000 : 0;
  return submitScore + (inViewport ? 500_000 : 0) + nearBottom * 100 + area;
}

function getEditorCandidates(editorSel: string): HTMLElement[] {
  const selectors = editorSel.split(',').map(s => s.trim()).filter(Boolean);
  const candidates = selectors.flatMap(sel => Array.from(document.querySelectorAll<HTMLElement>(sel)));
  return candidates
    .filter((el) => {
      if (!el.isConnected) return false;
      if (el instanceof HTMLTextAreaElement && (el.disabled || el.readOnly)) return false;
      if (!isVisibleElement(el)) return false;
      return true;
    });
}

function getVisibleTextareas(): HTMLTextAreaElement[] {
  return Array.from(document.querySelectorAll('textarea')).filter((el): el is HTMLTextAreaElement => {
    return el instanceof HTMLTextAreaElement && isVisibleElement(el);
  });
}

function getCurrentEditor(editorSel: string): HTMLElement | null {
  const selectors = editorSel.split(',').map(s => s.trim()).filter(Boolean);
  const active = document.activeElement as HTMLElement | null;
  if (active && selectors.some(sel => {
    try { return active.matches(sel); } catch { return false; }
  })) return active;

  const ranked = getEditorCandidates(editorSel).sort((a, b) => scoreEditorCandidate(b) - scoreEditorCandidate(a));
  if (ranked[0]) return ranked[0];
  return querySelectorFirst(editorSel);
}

function getSendButtonForEditor(editor: HTMLElement, sendBtnSel: string): HTMLElement | null {
  return getSiteAdapter().getSendButton(editor, sendBtnSel);
}

function applyTextareaValue(ta: HTMLTextAreaElement, next: string): void {
  const previous = ta.value;
  const nativeInputValueSetter = getNativeSetter();
  if (nativeInputValueSetter) nativeInputValueSetter.call(ta, next);
  else ta.value = next;
  const tracker = (ta as any)._valueTracker;
  if (tracker && typeof tracker.setValue === 'function') tracker.setValue(previous);
  const caret = next.length;
  try { ta.setSelectionRange(caret, caret); } catch {}
  ta.dispatchEvent(new Event('focus', { bubbles: true }));
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  ta.dispatchEvent(new Event('change', { bubbles: true }));
  if (location.hostname !== 'chat.deepseek.com') ta.dispatchEvent(new Event('blur', { bubbles: true }));
  ta.dispatchEvent(new KeyboardEvent('keyup', { key: 'End', code: 'End', bubbles: true }));
}

async function fillArenaTextarea(result: string, editorSel: string, sendBtnSel: string): Promise<HTMLTextAreaElement | null> {
  const candidates = getEditorCandidates(editorSel)
    .filter((el): el is HTMLTextAreaElement => el instanceof HTMLTextAreaElement)
    .sort((a, b) => scoreEditorCandidate(b) - scoreEditorCandidate(a));

  for (const ta of candidates) {
    ta.focus();
    const current = ta.value;
    const next = current ? current + '\n' + result : result;
    applyTextareaValue(ta, next);
    await Promise.resolve();
    const submitBtn = getSendButtonForEditor(ta, sendBtnSel) as HTMLButtonElement | null;
    if (ta.value === next || (submitBtn && !submitBtn.disabled)) return ta;
  }

  const visibleTextareas = getVisibleTextareas();
  if (visibleTextareas.length === 1) {
    const ta = visibleTextareas[0];
    ta.focus();
    const current = ta.value;
    const next = current ? current + '\n' + result : result;
    applyTextareaValue(ta, next);
    await Promise.resolve();
    return ta;
  }

  showToast(`未命中活动输入框，候选数: ${candidates.length}`, 4000);
  return null;
}

async function fillAndSend(result: string, autoSend = false) {
  const adapter = getSiteAdapter();
  const { editor: editorSel, sendBtn: sendBtnSel, fillMethod } = adapter.config;
  const editor = getCurrentEditor(editorSel);
  if (!editor) {
    const visibleTextareas = getVisibleTextareas().length;
    showToast(`未找到输入框，可见 textarea: ${visibleTextareas}`, 4000);
    return;
  }

  editor.focus();
  debugLog('开始填充输入框', { adapter: adapter.id, fillMethod, autoSend, resultPreview: result.slice(0, 120) });

  if (fillMethod === 'paste') {
    const dataTransfer = new DataTransfer();
    dataTransfer.setData('text/plain', result);
    editor.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dataTransfer, bubbles: true, cancelable: true }));
  } else if (fillMethod === 'execCommand') {
    document.execCommand('insertText', false, result);
  } else if (fillMethod === 'value') {
    if (adapter.fillValue) {
      const ok = await adapter.fillValue(editor, result, editorSel, sendBtnSel);
      if (!ok) return;
    } else {
      const ta = editor as HTMLTextAreaElement;
      const current = ta.value;
      const next = current ? current + '\n' + result : result;
      applyTextareaValue(ta, next);
    }
  } else if (fillMethod === 'prosemirror') {
    const current = editor.innerText.trim();
    editor.innerHTML = current ? current + '\n' + result : result;
    editor.dispatchEvent(new Event('input', { bubbles: true }));
    editor.dispatchEvent(new Event('change', { bubbles: true }));
  }

  if (autoSend) {
    const cfg = await chrome.storage.local.get(['autoSend', 'delayMin', 'delayMax']);
    if (cfg.autoSend === false) return;

    const min = (cfg.delayMin ?? 1) * 1000;
    const max = (cfg.delayMax ?? 4) * 1000;
    const delay = Math.random() * (max - min) + min;

    showCountdownToast(delay, () => {
      debugLog('自动发送倒计时结束', { adapter: adapter.id, delayMs: Math.round(delay) });
      const checkAndClick = (attempts = 0) => {
        if (attempts > 50) {
          const ed = getCurrentEditor(editorSel);
          debugLog('未命中发送按钮，回退 Enter 提交', { adapter: adapter.id });
          if (ed) ed.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
          return;
        }
        const currentEditor = getCurrentEditor(editorSel);
        const sendBtn = currentEditor ? getSendButtonForEditor(currentEditor, sendBtnSel) : querySelectorFirst(sendBtnSel);
        if (sendBtn) {
          debugLog('命中发送按钮并点击', { adapter: adapter.id, attempts, text: (sendBtn.textContent || '').trim().slice(0, 60) });
          sendBtn.click();
        } else {
          if (attempts === 0 || attempts % 10 === 0) debugLog('等待发送按钮出现', { adapter: adapter.id, attempts });
          setTimeout(() => checkAndClick(attempts + 1), 100);
        }
      };
      checkAndClick();
    });
  }
}

// ── 斜杠命令 / @ 文件补全 ──────────────────────────────────────────────────────

let skillsCache: Array<{ name: string; description: string }> | null = null;
let skillsCacheTime = 0;
const filesCache = new Map<string, { ts: number; files: string[] }>();
const FILES_TTL = 5000;

async function fetchSkills(): Promise<Array<{ name: string; description: string }>> {
  if (skillsCache && Date.now() - skillsCacheTime < 30000) return skillsCache;
  const { authToken, apiUrl } = await chrome.storage.local.get(['authToken', 'apiUrl']);
  if (!apiUrl) return [];
  const headers: any = {};
  if (authToken) headers['Authorization'] = `Bearer ${authToken}`;
  try {
    const resp = await bgFetch(`${apiUrl}/skills`, { headers });
    if (!resp.ok) return [];
    const data = JSON.parse(resp.body);
    skillsCache = data.skills || [];
    skillsCacheTime = Date.now();
    return skillsCache!;
  } catch { return []; }
}

async function fetchFiles(q: string): Promise<string[]> {
  const cached = filesCache.get(q);
  if (cached && Date.now() - cached.ts < FILES_TTL) return cached.files;
  const { authToken, apiUrl } = await chrome.storage.local.get(['authToken', 'apiUrl']);
  if (!apiUrl) return [];
  const headers: any = {};
  if (authToken) headers['Authorization'] = `Bearer ${authToken}`;
  try {
    const resp = await bgFetch(`${apiUrl}/files?q=${encodeURIComponent(q)}`, { headers });
    if (!resp.ok) return [];
    const data = JSON.parse(resp.body);
    const files = data.files || [];
    filesCache.set(q, { ts: Date.now(), files });
    return files;
  } catch { return []; }
}

function showPickerPopup(
  anchorEl: HTMLElement,
  items: Array<{ label: string; sub?: string; value: string }>,
  onSelect: (value: string) => void,
  onDismiss: () => void
): () => void {
  const popup = document.createElement('div');
  popup.style.cssText = 'position:fixed;z-index:2147483647;background:#1e1e2e;border:1px solid #45475a;border-radius:8px;padding:4px;min-width:240px;max-width:400px;max-height:240px;overflow-y:auto;box-shadow:0 4px 16px rgba(0,0,0,0.5)';

  let activeIdx = 0;
  const rows: HTMLElement[] = [];

  function render() {
    popup.innerHTML = '';
    rows.length = 0;
    if (items.length === 0) {
      const empty = document.createElement('div');
      empty.style.cssText = 'padding:8px 12px;color:#6c7086;font-size:12px';
      empty.textContent = '无匹配项';
      popup.appendChild(empty);
      return;
    }
    items.forEach((item, i) => {
      const row = document.createElement('div');
      row.style.cssText = `padding:6px 12px;border-radius:6px;cursor:pointer;display:flex;flex-direction:column;gap:2px;background:${i === activeIdx ? '#313244' : 'transparent'}`;
      const label = document.createElement('span');
      label.style.cssText = 'color:#cdd6f4;font-size:13px';
      label.textContent = item.label;
      row.appendChild(label);
      if (item.sub) {
        const sub = document.createElement('span');
        sub.style.cssText = 'color:#6c7086;font-size:11px';
        sub.textContent = item.sub;
        row.appendChild(sub);
      }
      row.onmouseenter = () => { setActive(i); };
      row.onclick = () => { onSelect(item.value); destroy(); };
      rows.push(row);
      popup.appendChild(row);
    });
  }

  function setActive(i: number) {
    if (rows[activeIdx]) rows[activeIdx].style.background = 'transparent';
    activeIdx = i;
    if (rows[activeIdx]) {
      rows[activeIdx].style.background = '#313244';
      rows[activeIdx].scrollIntoView({ block: 'nearest' });
    }
  }

  function reposition() {
    const rect = anchorEl.getBoundingClientRect();
    const popupH = Math.min(240, popup.scrollHeight || 240);
    const spaceAbove = rect.top - 6;
    const spaceBelow = window.innerHeight - rect.bottom - 6;
    if (spaceAbove >= popupH || spaceAbove >= spaceBelow) {
      popup.style.top = `${Math.max(4, rect.top - popupH - 6)}px`;
    } else {
      popup.style.top = `${rect.bottom + 6}px`;
    }
    popup.style.left = `${rect.left}px`;
    popup.style.width = `${Math.min(400, rect.width)}px`;
  }

  render();
  document.body.appendChild(popup);
  reposition();

  function onKeyDown(e: KeyboardEvent) {
    if (!items.length) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); e.stopPropagation(); setActive((activeIdx + 1) % items.length); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); e.stopPropagation(); setActive((activeIdx - 1 + items.length) % items.length); }
    else if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); onSelect(items[activeIdx].value); destroy(); }
    else if (e.key === 'Escape') { onDismiss(); destroy(); }
  }

  function onMouseDown(e: MouseEvent) {
    if (!popup.contains(e.target as Node)) { onDismiss(); destroy(); }
  }

  document.addEventListener('keydown', onKeyDown, true);
  document.addEventListener('mousedown', onMouseDown, true);
  window.addEventListener('scroll', reposition, true);
  window.addEventListener('resize', reposition);

  function destroy() {
    popup.remove();
    document.removeEventListener('keydown', onKeyDown, true);
    document.removeEventListener('mousedown', onMouseDown, true);
    window.removeEventListener('scroll', reposition, true);
    window.removeEventListener('resize', reposition);
  }

  return destroy;
}

function getEditorText(el: HTMLElement): string {
  if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
    return (el as HTMLTextAreaElement).value;
  }
  return el.innerText || '';
}

function getCaretPosition(el: HTMLElement): number {
  if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
    return (el as HTMLTextAreaElement).selectionStart ?? 0;
  }
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return 0;
  const range = sel.getRangeAt(0).cloneRange();
  range.selectNodeContents(el);
  range.setEnd(sel.getRangeAt(0).endContainer, sel.getRangeAt(0).endOffset);
  return range.toString().length;
}

function replaceTokenInEditor(el: HTMLElement, token: string, replacement: string, fillMethod: string) {
  if (fillMethod === 'value') {
    const ta = el as HTMLTextAreaElement;
    const val = ta.value;
    const pos = ta.selectionStart ?? val.length;
    const before = val.slice(0, pos);
    const after = val.slice(pos);
    const tokenStart = before.lastIndexOf(token);
    if (tokenStart === -1) return;
    const newVal = val.slice(0, tokenStart) + replacement + after;
    const nativeSetter = getNativeSetter();
    if (nativeSetter) nativeSetter.call(ta, newVal);
    else ta.value = newVal;
    const newCaret = tokenStart + replacement.length;
    ta.setSelectionRange(newCaret, newCaret);
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  } else if (fillMethod === 'execCommand' || fillMethod === 'prosemirror') {
    // prosemirror 也通过 execCommand insertText 拦截，不能直接写 innerHTML
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return;
    const range = sel.getRangeAt(0);
    const text = getEditorText(el);
    const pos = getCaretPosition(el);
    const before = text.slice(0, pos);
    const tokenStart = before.lastIndexOf(token);
    if (tokenStart === -1) return;
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let charCount = 0;
    let startNode: Text | null = null, startOffset = 0;
    let endNode: Text | null = null, endOffset = 0;
    while (walker.nextNode()) {
      const node = walker.currentNode as Text;
      const len = node.textContent?.length ?? 0;
      if (!startNode && charCount + len > tokenStart) {
        startNode = node;
        startOffset = tokenStart - charCount;
      }
      if (startNode && !endNode && charCount + len >= tokenStart + token.length) {
        endNode = node;
        endOffset = tokenStart + token.length - charCount;
        break;
      }
      charCount += len;
    }
    if (startNode && endNode) {
      range.setStart(startNode, startOffset);
      range.setEnd(endNode, endOffset);
      sel.removeAllRanges();
      sel.addRange(range);
      document.execCommand('insertText', false, replacement);
    }
  } else {
    // paste fallback (DeepSeek/Slate)：先删除 token，再粘贴
    const ta = el as HTMLTextAreaElement;
    const val = ta.tagName === 'TEXTAREA' ? ta.value : el.innerText;
    const tokenStart = val.lastIndexOf(token);
    if (tokenStart !== -1 && ta.tagName === 'TEXTAREA') {
      const newVal = val.slice(0, tokenStart) + val.slice(tokenStart + token.length);
      const nativeSetter = getNativeSetter();
      if (nativeSetter) nativeSetter.call(ta, newVal);
      else ta.value = newVal;
      ta.setSelectionRange(tokenStart, tokenStart);
      ta.dispatchEvent(new Event('input', { bubbles: true }));
    }
    const dataTransfer = new DataTransfer();
    dataTransfer.setData('text/plain', replacement);
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dataTransfer, bubbles: true, cancelable: true }));
  }
}

function attachInputListener(editorEl: HTMLElement) {
  if ((editorEl as any).__openlinkInputBound) return;
  (editorEl as any).__openlinkInputBound = true;
  const { fillMethod } = getSiteConfig();
  let destroyPicker: (() => void) | null = null;
  let inputVersion = 0;

  function dismiss() {
    if (destroyPicker) { destroyPicker(); destroyPicker = null; }
  }

  editorEl.addEventListener('input', async () => {
    const currentVersion = ++inputVersion;
    const text = getEditorText(editorEl);
    const pos = getCaretPosition(editorEl);
    const before = text.slice(0, pos);

    const slashMatch = before.match(/(?:^|[\s\n\u00a0])(\/([\w-]*))$/);
    if (slashMatch) {
      const token = slashMatch[1];
      const query = slashMatch[2].toLowerCase();
      const skills = await fetchSkills();
      if (currentVersion !== inputVersion) return;
      const filtered = query
        ? skills.filter(s => s.name.toLowerCase().includes(query) || s.description.toLowerCase().includes(query))
        : skills;
      dismiss();
      if (filtered.length === 0) return;
      destroyPicker = showPickerPopup(
        editorEl,
        filtered.map(s => ({
          label: s.name,
          sub: s.description,
          value: `<tool name="skill">\n  <parameter name="skill">${s.name}</parameter>\n</tool>`,
        })),
        (xml) => { replaceTokenInEditor(editorEl, token, xml, fillMethod); dismiss(); },
        dismiss
      );
      return;
    }

    const atMatch = before.match(/@([^\s]*)$/);
    if (atMatch) {
      const token = atMatch[0];
      const query = atMatch[1];
      const files = await fetchFiles(query);
      if (currentVersion !== inputVersion) return;
      dismiss();
      if (files.length === 0) return;
      destroyPicker = showPickerPopup(
        editorEl,
        files.map(f => ({ label: f, value: f })),
        (path) => { replaceTokenInEditor(editorEl, token, path, fillMethod); dismiss(); },
        dismiss
      );
      return;
    }

    dismiss();
  });
}

function mountInputListener() {
  const { editor: editorSel } = getSiteConfig();

  const attachCurrent = () => {
    const editorEl = getCurrentEditor(editorSel);
    if (editorEl) attachInputListener(editorEl);
  };

  attachCurrent();

  const obs = new MutationObserver(() => attachCurrent());
  obs.observe(document.body, { childList: true, subtree: true });
}
