if (!(window as any).__OPENLINK_LOADED__) {
  (window as any).__OPENLINK_LOADED__ = true;

  const script = document.createElement('script');
  script.src = chrome.runtime.getURL('injected.js');
  (document.head || document.documentElement).appendChild(script);

  let execQueue = Promise.resolve();
  window.addEventListener('message', (event) => {
    if (event.data.type === 'TOOL_CALL') {
      execQueue = execQueue.then(() => executeToolCall(event.data.data));
    }
  });

  if (document.body) {
    injectInitButton();
  } else {
    document.addEventListener('DOMContentLoaded', injectInitButton);
  }
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

async function executeToolCall(toolCall: any) {
  try {
    const { authToken, apiUrl } = await chrome.storage.local.get(['authToken', 'apiUrl']);
    const headers: any = { 'Content-Type': 'application/json' };
    if (authToken) {
      headers['Authorization'] = `Bearer ${authToken}`;
    }

    if (!apiUrl) {
      fillAndSend('请先在插件中配置 API 地址', false);
      return;
    }

    const response = await bgFetch(`${apiUrl}/exec`, {
      method: 'POST',
      headers,
      body: JSON.stringify(toolCall)
    });

    if (response.status === 401) {
      fillAndSend('认证失败，请在插件中重新输入 Token', false);
      return;
    }
    if (!response.ok) {
      fillAndSend(`[OpenLink 错误] HTTP ${response.status}`, false);
      return;
    }

    const result = JSON.parse(response.body);
    fillAndSend(result.output, true);
  } catch (error) {
    fillAndSend(`[OpenLink 错误] ${error}`, false);
  }
}

function fillAndSend(result: string, autoSend = false) {
  const editor = document.querySelector('[data-slate-editor="true"]') as HTMLElement;
  if (!editor) return;

  editor.focus();
  const dataTransfer = new DataTransfer();
  dataTransfer.setData('text/plain', result);
  editor.dispatchEvent(new ClipboardEvent('paste', {clipboardData: dataTransfer, bubbles: true, cancelable: true}));

  if (autoSend) {
    const checkAndClick = (attempts = 0) => {
      if (attempts > 50) return;
      // Selectors target Qwen/Tongyi chat UI — update if app is rebuilt with new hashes
      const sendBtn = document.querySelector('.operateBtn-JsB9e2') as HTMLElement;
      if (sendBtn && !sendBtn.classList.contains('disabled-ZaDDJC')) {
        sendBtn.click();
      } else {
        setTimeout(() => checkAndClick(attempts + 1), 100);
      }
    };
    setTimeout(() => checkAndClick(), 300);
  }
}
