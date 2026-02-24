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
  supported?: boolean;
}

function getSiteConfig(): SiteConfig {
  const h = location.hostname;
  if (h.includes('gemini.google.com'))
    return { editor: 'div.ql-editor[contenteditable="true"]', sendBtn: 'button.send-button[aria-label*="发送"], button.send-button[aria-label*="Send"]', stopBtn: null, fillMethod: 'execCommand', useObserver: true, responseSelector: 'model-response, .model-response-text, message-content', supported: true };
  if (h.includes('chatgpt.com'))
    return { editor: '#prompt-textarea, .ProseMirror[contenteditable="true"]', sendBtn: 'button[data-testid="send-button"], button[aria-label*="Send"]', stopBtn: null, fillMethod: 'prosemirror', useObserver: false };
  if (h.includes('x.com') || h.includes('grok.com'))
    return { editor: 'textarea[aria-label="Ask Grok anything"], textarea[placeholder="Ask anything"], textarea', sendBtn: 'button[aria-label="Submit"], button.send-button', stopBtn: null, fillMethod: 'value', useObserver: false };
  if (h.includes('kimi.com'))
    return { editor: '.chat-input-editor[contenteditable="true"], div[contenteditable="true"][data-lexical-editor="true"]', sendBtn: '.send-button, button[aria-label*="Send"]', stopBtn: null, fillMethod: 'execCommand', useObserver: false };
  if (h.includes('chat.mistral.ai'))
    return { editor: 'div.ProseMirror[contenteditable="true"]', sendBtn: '.ms-auto .flex.gap-2 button[type="submit"], button.bg-state-primary', stopBtn: null, fillMethod: 'execCommand', useObserver: false };
  if (h.includes('perplexity.ai'))
    return { editor: '#ask-input[contenteditable="true"], div[contenteditable="true"][data-lexical-editor="true"]', sendBtn: 'button[aria-label="Submit"], button[aria-label="Send"]', stopBtn: null, fillMethod: 'execCommand', useObserver: false };
  if (h.includes('openrouter.ai'))
    return { editor: 'textarea[data-testid="composer-input"], textarea[placeholder="Start a new message..."]', sendBtn: 'button[data-testid="send-button"], button[aria-label="Send message"]', stopBtn: null, fillMethod: 'value', useObserver: false };
  if (h.includes('qwen.ai'))
    return { editor: 'textarea.message-input-textarea, #chat-input', sendBtn: 'button.omni-button-content-btn, div.message-input-right-button-send button', stopBtn: null, fillMethod: 'value', useObserver: true, responseSelector: '.chat-response-message', supported: true };
  if (h.includes('t3.chat'))
    return { editor: 'textarea#chat-input, textarea[placeholder*="Type your message"]', sendBtn: 'button[type="submit"], button[aria-label*="Send"]', stopBtn: null, fillMethod: 'value', useObserver: false };
  if (h.includes('aistudio.google.com'))
    return { editor: 'textarea.textarea[placeholder="Start typing a prompt"]', sendBtn: 'button[aria-label*="Run"], button[mattooltip*="Run"]', stopBtn: null, fillMethod: 'value', useObserver: false };
  if (h.includes('github.com'))
    return { editor: '#copilot-chat-textarea, textarea[placeholder*="How can I help"]', sendBtn: 'button[aria-labelledby*="Send"], button:has(.octicon-paper-airplane)', stopBtn: null, fillMethod: 'value', useObserver: false };
  if (h.includes('z.ai'))
    return { editor: '#chat-input', sendBtn: '#send-message-button', stopBtn: null, fillMethod: 'value', useObserver: false };
  // Default: DeepSeek
  return { editor: '[data-slate-editor="true"]', sendBtn: '.operateBtn-JsB9e2:not(.disabled-ZaDDJC)', stopBtn: '.stop-yGpvO2 img', fillMethod: 'paste', useObserver: false };
}

if (!(window as any).__OPENLINK_LOADED__) {
  (window as any).__OPENLINK_LOADED__ = true;

  const cfg = getSiteConfig();

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

  if (cfg.supported) {
    if (document.body) injectInitButton();
    else document.addEventListener('DOMContentLoaded', injectInitButton);
  }
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

function renderToolCard(data: any, _full: string, sourceEl: Element, key: string, processed: Set<string>) {
  // Find stable anchor: message-content's parent, which Angular doesn't rebuild
  const messageContent = sourceEl.closest('message-content') ?? sourceEl;
  const anchor = messageContent.parentElement ?? sourceEl.parentElement;
  if (!anchor) return;

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

  anchor.insertBefore(card, messageContent);
}

function startDOMObserver(_responseSelector: string) {
  const processed = new Set<string>();
  const TOOL_RE = /<tool(?:\s[^>]*)?>[\s\S]*?<\/tool>/g;
  let autoExecute = false;
  chrome.storage.local.get(['autoExecute']).then(r => { autoExecute = !!r.autoExecute; });
  chrome.storage.onChanged.addListener((changes) => {
    if ('autoExecute' in changes) autoExecute = !!changes.autoExecute.newValue;
  });

  function scanText(text: string, sourceEl?: Element) {
    if (!text.includes('<tool')) return;
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

      if (autoExecute) {
        if (isExecuted(key)) continue;
        processed.add(key);
        markExecuted(key);
        window.postMessage({ type: 'TOOL_CALL', data }, '*');
      } else if (sourceEl) {
        processed.add(key);
        renderToolCard(data, full, sourceEl, key, processed);
      } else {
        if (isExecuted(key)) continue;
        processed.add(key);
        markExecuted(key);
        window.postMessage({ type: 'TOOL_CALL', data }, '*');
      }
    }
  }

  function scanNode(node: Node) {
    const el = node.nodeType === Node.TEXT_NODE ? (node as Text).parentElement : node as Element;
    if (!el) return;
    const mc = findResponseContainer(el);
    if (mc) scheduleScan(mc);
  }

  function findResponseContainer(el: Element | null): Element | null {
    while (el) {
      const tag = el.tagName.toLowerCase();
      if (tag === 'message-content') return el;
      if (el.classList.contains('chat-response-message')) return el;
      el = el.parentElement;
    }
    return null;
  }

  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  const pendingContainers = new Set<Element>();

  function scheduleScan(container: Element) {
    pendingContainers.add(container);
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      const els = [...pendingContainers];
      pendingContainers.clear();
      requestAnimationFrame(() => {
        for (const el of els) scanText(el.textContent || '', el);
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
    document.querySelectorAll('message-content, .chat-response-message').forEach(el => {
      scanText(el.textContent || '', el);
    });
  });
}

function injectInitButton() {
  const btn = document.createElement('button');
  btn.textContent = '🔗 初始化';
  btn.style.cssText = 'position:fixed;bottom:80px;right:20px;z-index:99999;padding:8px 14px;background:#1677ff;color:#fff;border:none;border-radius:20px;cursor:pointer;font-size:13px;box-shadow:0 2px 8px rgba(0,0,0,0.3)';
  btn.onclick = sendInitPrompt;
  document.body.appendChild(btn);
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
  fillAndSend(resp.body, true);
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
    const opts: string[] = Array.isArray(rawOpts) ? rawOpts : (typeof rawOpts === 'string' ? (() => { try { return JSON.parse(rawOpts); } catch { return []; } })() : []);
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

async function fillAndSend(result: string, autoSend = false) {
  const { editor: editorSel, sendBtn: sendBtnSel, fillMethod } = getSiteConfig();
  const editor = querySelectorFirst(editorSel);
  if (!editor) return;

  editor.focus();

  if (fillMethod === 'paste') {
    const dataTransfer = new DataTransfer();
    dataTransfer.setData('text/plain', result);
    editor.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dataTransfer, bubbles: true, cancelable: true }));
  } else if (fillMethod === 'execCommand') {
    document.execCommand('insertText', false, result);
  } else if (fillMethod === 'value') {
    const ta = editor as HTMLTextAreaElement;
    const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
    if (nativeInputValueSetter) nativeInputValueSetter.call(ta, result);
    else ta.value = result;
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  } else if (fillMethod === 'prosemirror') {
    editor.innerHTML = result;
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
        if (attempts > 50) return;
        const sendBtn = querySelectorFirst(sendBtnSel);
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
