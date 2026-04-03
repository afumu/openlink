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

function getSiteConfig(): SiteConfig {
  const h = location.hostname;
  const p = location.pathname;
  if (h.includes('gemini.google.com'))
    return { editor: 'div.ql-editor[contenteditable="true"]', sendBtn: 'button.send-button[aria-label*="发送"], button.send-button[aria-label*="Send"]', stopBtn: null, fillMethod: 'execCommand', useObserver: true, responseSelector: 'model-response, .model-response-text, message-content' };
  if (h === 'arena.ai' && (p.startsWith('/text/direct') || p.startsWith('/c/')))
    return { editor: 'textarea[name="message"][placeholder*="Ask followup"], textarea[name="message"], form textarea, textarea', sendBtn: 'form button[type="submit"]:not([disabled]), form button[type="submit"]', stopBtn: null, fillMethod: 'value', useObserver: true, responseSelector: '.prose' };
  // Default: AI Studio
  return { editor: 'textarea[placeholder*="Start typing a prompt"]', sendBtn: 'button.ctrl-enter-submits.ms-button-primary[type="submit"], button[aria-label*="Run"]', stopBtn: null, fillMethod: 'value', useObserver: true, responseSelector: 'ms-chat-turn' };
}

if (!(window as any).__OPENLINK_LOADED__) {
  (window as any).__OPENLINK_LOADED__ = true;

  const cfg = getSiteConfig();
  let debugMode = false;

  if (!cfg.useObserver) {
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
    }
  });

  const mountDebugUi = () => {
    injectInitButton();
    if (debugMode) injectDebugPanel();
    else removeDebugPanel();
  };

  chrome.storage.local.get(['debugMode']).then((result) => {
    debugMode = !!result.debugMode;
    if (document.body) mountDebugUi();
  });
  chrome.storage.onChanged.addListener((changes) => {
    if ('debugMode' in changes) {
      debugMode = !!changes.debugMode.newValue;
      if (document.body) mountDebugUi();
    }
  });

  if (!document.body) document.addEventListener('DOMContentLoaded', mountDebugUi);

  if (document.body) mountInputListener();
  else document.addEventListener('DOMContentLoaded', mountInputListener);
}

function hashStr(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = Math.imul(31, h) + s.charCodeAt(i) | 0;
  return h >>> 0;
}

function getConversationId(): string {
  const m = location.pathname.match(/\/chat\/([^/?#]+)/) || location.search.match(/[?&]id=([^&]+)/);
  return m ? m[1] : '__default__';
}

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
  if (location.hostname === 'arena.ai' && (location.pathname.startsWith('/text/direct') || location.pathname.startsWith('/c/'))) {
    const prose = sourceEl.closest('.prose') ?? sourceEl;
    const findActionRow = (root: Element): Element | null => {
      return Array.from(root.children).find((child) => {
        if (!(child instanceof Element)) return false;
        return !!child.querySelector('button[aria-label="Like this response"], button[aria-label="Dislike this response"]');
      }) as Element | null;
    };

    let cursor: Element | null = prose;
    while (cursor) {
      const actionRow = findActionRow(cursor);
      if (actionRow) return { anchor: cursor, before: actionRow };
      cursor = cursor.parentElement;
    }

    const proseWrapper = prose.parentElement?.parentElement ?? prose.parentElement;
    if (proseWrapper) {
      return { anchor: proseWrapper, before: proseWrapper.firstElementChild ?? null };
    }
  }

  const messageContent = sourceEl.closest('message-content') ?? sourceEl.closest('.prose') ?? sourceEl;
  const anchor = messageContent.parentElement ?? sourceEl.parentElement;
  if (!anchor) return null;
  return { anchor, before: messageContent };
}

function isArenaAssistantResponse(el: Element | null): boolean {
  if (!el || location.hostname !== 'arena.ai' || !(location.pathname.startsWith('/text/direct') || location.pathname.startsWith('/c/'))) return true;
  let cursor: Element | null = el.closest('.prose') ?? el;
  while (cursor) {
    const hasActionRow = Array.from(cursor.children).some((child) => {
      if (!(child instanceof Element)) return false;
      return !!child.querySelector('button[aria-label="Like this response"], button[aria-label="Dislike this response"]');
    });
    if (hasActionRow) return true;
    cursor = cursor.parentElement;
  }
  return false;
}

function shouldRenderArenaToolText(text: string, sourceEl?: Element): boolean {
  if (location.hostname !== 'arena.ai' || !(location.pathname.startsWith('/text/direct') || location.pathname.startsWith('/c/'))) return true;
  if (sourceEl?.closest('pre, code')) return false;
  const toolOnly = text.replace(/<tool(?:\s[^>]*)?>[\s\S]*?<\/tool>/g, ' ').replace(/\s+/g, ' ').trim();
  return toolOnly.length <= 24;
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
    if (sourceEl && !isArenaAssistantResponse(sourceEl)) return;
    if (!shouldRenderArenaToolText(text, sourceEl)) return;
    TOOL_RE.lastIndex = 0;
    let match;
    while ((match = TOOL_RE.exec(text)) !== null) {
      const full = match[0];
      const inner = full.replace(/^<tool[^>]*>|<\/tool>$/g, '').trim();
      const data = parseXmlToolCall(full) || tryParseToolJSON(inner);
      if (!data) { console.warn('[OpenLink] 工具调用解析失败:', full); continue; }
      const convId = getConversationId();
      const key = data.callId ? `${convId}:${data.name}:${data.callId}` : String(hashStr(full));
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
      }) && isArenaAssistantResponse(el)) return el;
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
      if (!isArenaAssistantResponse(el)) return;
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
  injectFloatingButton('openlink-test-btn', '🧪 插入TEST', 130, '#16a34a', () => fillAndSend('TEST', false));
}

function removeDebugPanel() {
  document.getElementById('openlink-debug-panel')?.remove();
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

function collectDebugData() {
  const cfg = getSiteConfig();
  const editorCandidates = getEditorCandidates(cfg.editor);
  const visibleTextareas = getVisibleTextareas();
  const currentEditor = getCurrentEditor(cfg.editor);
  const sendButtons = Array.from(document.querySelectorAll(cfg.sendBtn.split(',').map(s => s.trim()).filter(Boolean).join(',')));
  const responseNodes = cfg.responseSelector ? Array.from(document.querySelectorAll(cfg.responseSelector)).slice(-3) : [];
  const toolNodes = Array.from(document.querySelectorAll('.prose, message-content, ms-chat-turn'))
    .filter((el) => (el.textContent || '').includes('<tool'))
    .slice(-3);
  return {
    capturedAt: new Date().toISOString(),
    location: { href: location.href, hostname: location.hostname, pathname: location.pathname },
    siteConfig: cfg,
    activeElement: elementSnapshot(document.activeElement as Element | null),
    currentEditor: elementSnapshot(currentEditor),
    visibleTextareaCount: visibleTextareas.length,
    editorCandidateCount: editorCandidates.length,
    visibleTextareas: visibleTextareas.map((el) => elementSnapshot(el)),
    editorCandidates: editorCandidates.map((el) => elementSnapshot(el)),
    sendButtons: sendButtons.map((el) => elementSnapshot(el)),
    latestResponses: responseNodes.map((el) => elementSnapshot(el)),
    latestToolContainers: toolNodes.map((el) => elementSnapshot(el)),
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
  panel.style.cssText = 'position:fixed;bottom:180px;right:20px;z-index:99999;width:220px;background:#111827;color:#f3f4f6;border:1px solid #374151;border-radius:12px;padding:10px;box-shadow:0 8px 24px rgba(0,0,0,0.35);font-size:12px';

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
      label: '复制最近回复 HTML',
      onClick: () => {
        const last = collectDebugData().latestResponses.at(-1);
        void copyText(last?.outerHTML || '');
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

  document.body.appendChild(panel);
}

async function bgFetch(url: string, options?: any): Promise<{ ok: boolean; status: number; body: string }> {
  return chrome.runtime.sendMessage({ type: 'FETCH', url, options });
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
  const form = editor.closest('form');
  if (form) {
    for (const sel of sendBtnSel.split(',').map(s => s.trim()).filter(Boolean)) {
      const btn = form.querySelector(sel) as HTMLElement | null;
      if (btn && isVisibleElement(btn)) return btn;
    }
  }
  return querySelectorFirst(sendBtnSel);
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
  ta.dispatchEvent(new Event('blur', { bubbles: true }));
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
  const { editor: editorSel, sendBtn: sendBtnSel, fillMethod } = getSiteConfig();
  const editor = getCurrentEditor(editorSel);
  if (!editor) {
    const visibleTextareas = getVisibleTextareas().length;
    showToast(`未找到输入框，可见 textarea: ${visibleTextareas}`, 4000);
    return;
  }

  editor.focus();

  if (fillMethod === 'paste') {
    const dataTransfer = new DataTransfer();
    dataTransfer.setData('text/plain', result);
    editor.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dataTransfer, bubbles: true, cancelable: true }));
  } else if (fillMethod === 'execCommand') {
    document.execCommand('insertText', false, result);
  } else if (fillMethod === 'value') {
    if (location.hostname === 'arena.ai' && (location.pathname.startsWith('/text/direct') || location.pathname.startsWith('/c/'))) {
      const ta = await fillArenaTextarea(result, editorSel, sendBtnSel);
      if (!ta) return;
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
      const checkAndClick = (attempts = 0) => {
        if (attempts > 50) {
          const ed = getCurrentEditor(editorSel);
          if (ed) ed.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
          return;
        }
        const currentEditor = getCurrentEditor(editorSel);
        const sendBtn = currentEditor ? getSendButtonForEditor(currentEditor, sendBtnSel) : querySelectorFirst(sendBtnSel);
        if (sendBtn) {
          sendBtn.click();
        } else {
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
