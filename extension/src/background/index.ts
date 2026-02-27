// 现有 FETCH 处理保持不变
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'FETCH') {
    const { url, options } = msg;
    fetch(url, options)
      .then(async r => ({ ok: r.ok, status: r.status, body: await r.text() }))
      .catch(e => ({ ok: false, status: 0, body: String(e) }))
      .then(sendResponse);
    return true;
  }

  if (msg.type === 'SSE_CONNECT') {
    startSSE(msg.url, msg.token);
    sendResponse({ ok: true });
    return true;
  }

  if (msg.type === 'SSE_DISCONNECT') {
    stopSSE();
    sendResponse({ ok: true });
    return true;
  }

  return false;
});

// ── SSE 管理 ──────────────────────────────────────────────────────────────────

let sseController: AbortController | null = null;
let sseRetryTimer: ReturnType<typeof setTimeout> | null = null;
let sseUrl = '';
let sseToken = '';

function startSSE(url: string, token: string) {
  sseUrl = url;
  sseToken = token;
  connectSSE();
}

function stopSSE() {
  if (sseController) { sseController.abort(); sseController = null; }
  if (sseRetryTimer) { clearTimeout(sseRetryTimer); sseRetryTimer = null; }
  sseUrl = '';
  sseToken = '';
  broadcastToTabs({ type: 'SSE_STATUS', connected: false });
}

async function connectSSE() {
  if (!sseUrl) return;
  if (sseController) sseController.abort();

  sseController = new AbortController();
  const signal = sseController.signal;

  try {
    const resp = await fetch(sseUrl, {
      headers: { 'Authorization': `Bearer ${sseToken}` },
      signal,
    });

    if (!resp.ok || !resp.body) {
      scheduleRetry();
      return;
    }

    broadcastToTabs({ type: 'SSE_STATUS', connected: true });
    sseRetryCount = 0;

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // SSE 事件以 \n\n 分隔
      const parts = buffer.split('\n\n');
      buffer = parts.pop() ?? '';

      for (const part of parts) {
        parseSSEEvent(part);
      }
    }
  } catch (e: any) {
    if (e?.name === 'AbortError') return;
  }

  broadcastToTabs({ type: 'SSE_STATUS', connected: false });
  scheduleRetry();
}

let sseRetryCount = 0;

function scheduleRetry() {
  if (!sseUrl) return;
  if (sseRetryTimer) clearTimeout(sseRetryTimer);
  const delay = Math.min(3000 * Math.pow(2, sseRetryCount), 60000);
  sseRetryCount++;
  sseRetryTimer = setTimeout(() => {
    sseRetryTimer = null;
    connectSSE();
  }, delay);
}

function parseSSEEvent(raw: string) {
  let eventType = '';
  let data = '';
  for (const line of raw.split('\n')) {
    if (line.startsWith('event:')) eventType = line.slice(6).trim();
    else if (line.startsWith('data:')) data = line.slice(5).trim();
  }
  if (eventType === 'proxy_request' && data) {
    try {
      const evt = JSON.parse(data);
      broadcastToTabs({ type: 'PROXY_REQUEST', payload: evt });
    } catch {}
  }
}

function broadcastToTabs(msg: any) {
  chrome.tabs.query({}, tabs => {
    for (const tab of tabs) {
      if (tab.id != null) {
        chrome.tabs.sendMessage(tab.id, msg).catch(() => {});
      }
    }
  });
}

// 插件启动时，如果之前已配置代理，自动重连 SSE
chrome.storage.local.get(['authToken', 'apiUrl', 'proxyEnabled'], (data) => {
  if (data.proxyEnabled && data.apiUrl && data.authToken) {
    startSSE(`${data.apiUrl}/v1/sse`, data.authToken);
  }
});

// 监听配置变化，动态开关 SSE
chrome.storage.onChanged.addListener((changes) => {
  const enabled = changes.proxyEnabled?.newValue;
  if (enabled === true) {
    chrome.storage.local.get(['authToken', 'apiUrl'], (data) => {
      if (data.apiUrl && data.authToken) {
        startSSE(`${data.apiUrl}/v1/sse`, data.authToken);
      }
    });
  } else if (enabled === false) {
    stopSSE();
  }
});
