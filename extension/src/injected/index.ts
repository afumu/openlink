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

(function() {
  console.log('[OpenLink] 插件已加载');
  const originalFetch = window.fetch;
  let buffer = '';
  let pendingFlowReferenceInputs = [];
  let pendingFlowReferenceKind = 'image';

  // Global dedup: keyed by conversation ID extracted from URL
  const processedByConv = new Map<string, Set<string>>();

  function getConvId(): string {
    // Claude: /chat/<id>, ChatGPT: /c/<id>, DeepSeek: ?id=<id> or path
    const m = location.pathname.match(/\/(?:chat|c)\/([^/?#]+)/) ||
              location.search.match(/[?&]id=([^&]+)/);
    return m ? m[1] : '__default__';
  }

  function getProcessed(): Set<string> {
    const id = getConvId();
    if (!processedByConv.has(id)) processedByConv.set(id, new Set());
    return processedByConv.get(id)!;
  }

  function getRequestURL(input: RequestInfo | URL): string {
    if (typeof input === 'string') return input;
    if (input instanceof URL) return input.toString();
    return input.url;
  }

  function isFlowAPIRequest(url: string): boolean {
    return url.includes('aisandbox-pa.googleapis.com/v1/') ||
      url.includes('/flow/uploadImage') ||
      url.includes('/flowMedia:batchGenerateImages');
  }

  function bodyProjectId(body: any): string {
    if (!body || typeof body !== 'object') return '';
    if (typeof body.projectId === 'string' && body.projectId) return body.projectId;
    if (body.clientContext && typeof body.clientContext.projectId === 'string' && body.clientContext.projectId) return body.clientContext.projectId;
    if (Array.isArray(body.requests)) {
      for (const item of body.requests) {
        const nested = bodyProjectId(item);
        if (nested) return nested;
      }
    }
    if (body.mediaGenerationContext && typeof body.mediaGenerationContext.projectId === 'string' && body.mediaGenerationContext.projectId) {
      return body.mediaGenerationContext.projectId;
    }
    return '';
  }

  function extractProjectId(url: string, bodyText?: string): string {
    const fromURL = url.match(/\/projects\/([^/]+)\//)?.[1];
    if (fromURL) return fromURL;
    if (!bodyText) return '';
    try {
      return bodyProjectId(JSON.parse(bodyText));
    } catch {
      return '';
    }
  }

  function normalizeCapturedHeaders(headers: Headers): Record<string, string> {
    const names = [
      'authorization',
      'x-client-data',
      'x-browser-channel',
      'x-browser-copyright',
      'x-browser-validation',
      'x-browser-year',
    ];
    const result: Record<string, string> = {};
    for (const name of names) {
      const value = headers.get(name);
      if (value) result[name] = value;
    }
    return result;
  }

  function normalizePendingFlowReferenceInputs(items) {
    if (!Array.isArray(items)) return [];
    return items
      .map((item) => {
        const mediaId = typeof item?.mediaId === 'string' ? item.mediaId.trim() : '';
        if (!mediaId) return null;
        return {
          name: mediaId,
          imageInputType: 'IMAGE_INPUT_TYPE_REFERENCE',
        };
      })
      .filter(Boolean);
  }

  function buildPendingFlowVideoReferenceInputs(items) {
    if (!Array.isArray(items)) return [];
    return items
      .map((item) => {
        const mediaId = typeof item?.mediaId === 'string' ? item.mediaId.trim() : '';
        if (!mediaId) return null;
        return {
          mediaId,
          imageUsageType: 'IMAGE_USAGE_TYPE_ASSET',
        };
      })
      .filter(Boolean);
  }

  function mergeFlowReferenceInputs(payload) {
    if (!payload || typeof payload !== 'object') return payload;
    const merged = { ...payload };
    const existingInputs = Array.isArray(merged.imageInputs) ? merged.imageInputs.slice() : [];
    const seen = new Set(existingInputs.map((item) => JSON.stringify(item)));
    for (const item of pendingFlowReferenceInputs) {
      const key = JSON.stringify(item);
      if (seen.has(key)) continue;
      seen.add(key);
      existingInputs.push(item);
    }
    merged.imageInputs = existingInputs;
    return merged;
  }

  function ensureStructuredVideoTextInput(request) {
    if (!request || typeof request !== 'object') return request;
    const next = { ...request };
    const textInput = next.textInput && typeof next.textInput === 'object' ? { ...next.textInput } : {};
    const prompt = typeof textInput.prompt === 'string' ? textInput.prompt : '';
    if (!textInput.structuredPrompt && prompt) {
      textInput.structuredPrompt = { parts: [{ text: prompt }] };
      delete textInput.prompt;
    }
    next.textInput = textInput;
    return next;
  }

  function ensureVideoGenerationContext(payload) {
    if (!payload || typeof payload !== 'object') return payload;
    const next = { ...payload };
    next.useV2ModelConfig = true;
    const mediaGenerationContext = next.mediaGenerationContext && typeof next.mediaGenerationContext === 'object'
      ? { ...next.mediaGenerationContext }
      : {};
    if (!mediaGenerationContext.batchId && typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      mediaGenerationContext.batchId = crypto.randomUUID();
    }
    next.mediaGenerationContext = mediaGenerationContext;
    return next;
  }

  function patchFlowGenerateBody(bodyText) {
    if (!bodyText || !pendingFlowReferenceInputs.length || pendingFlowReferenceKind !== 'image') return { bodyText, patched: false };
    try {
      const payload = JSON.parse(bodyText);
      if (Array.isArray(payload.requests)) {
        payload.requests = payload.requests.map((request) => mergeFlowReferenceInputs(request));
      } else {
        Object.assign(payload, mergeFlowReferenceInputs(payload));
      }
      window.postMessage({
        type: 'OPENLINK_FLOW_GENERATE_PATCHED',
        data: {
          count: pendingFlowReferenceInputs.length,
        },
      }, '*');
      pendingFlowReferenceInputs = [];
      return { bodyText: JSON.stringify(payload), patched: true };
    } catch {
      return { bodyText, patched: false };
    }
  }

  function patchFlowVideoGenerateBody(url, bodyText) {
    if (!bodyText || !pendingFlowReferenceInputs.length || pendingFlowReferenceKind !== 'video') {
      return { url, bodyText, patched: false };
    }
    try {
      const payload = JSON.parse(bodyText);
      const videoRefs = buildPendingFlowVideoReferenceInputs(pendingFlowReferenceInputs);
      if (!videoRefs.length) return { url, bodyText, patched: false };

      let nextURL = url;
      if (videoRefs.length >= 2) {
        nextURL = url.replace('/video:batchAsyncGenerateVideoText', '/video:batchAsyncGenerateVideoStartAndEndImage');
        nextURL = nextURL.replace('/video:batchAsyncGenerateVideoReferenceImages', '/video:batchAsyncGenerateVideoStartAndEndImage');
      } else if (videoRefs.length === 1) {
        nextURL = url.replace('/video:batchAsyncGenerateVideoText', '/video:batchAsyncGenerateVideoReferenceImages');
        nextURL = nextURL.replace('/video:batchAsyncGenerateVideoStartAndEndImage', '/video:batchAsyncGenerateVideoReferenceImages');
      }

      const patchRequest = (request) => {
        let next = ensureStructuredVideoTextInput(request);
        if (videoRefs.length >= 2) {
          next = {
            ...next,
            startImage: { mediaId: videoRefs[0].mediaId },
            endImage: { mediaId: videoRefs[1].mediaId },
          };
          delete next.referenceImages;
        } else {
          next = {
            ...next,
            referenceImages: videoRefs,
          };
          delete next.startImage;
          delete next.endImage;
        }
        return next;
      };

      let nextPayload;
      if (Array.isArray(payload.requests)) {
        nextPayload = {
          ...payload,
          requests: payload.requests.map((request) => patchRequest(request)),
        };
      } else {
        nextPayload = patchRequest(payload);
      }
      nextPayload = ensureVideoGenerationContext(nextPayload);

      window.postMessage({
        type: 'OPENLINK_FLOW_GENERATE_PATCHED',
        data: {
          count: pendingFlowReferenceInputs.length,
          mediaKind: 'video',
        },
      }, '*');
      pendingFlowReferenceInputs = [];
      pendingFlowReferenceKind = 'image';
      return { url: nextURL, bodyText: JSON.stringify(nextPayload), patched: true };
    } catch {
      return { url, bodyText, patched: false };
    }
  }

  async function patchFlowGenerateArgs(args) {
    const input = args[0];
    const init = args[1] || {};
    const url = getRequestURL(input);
    const isImageGenerate = url.includes('/flowMedia:batchGenerateImages');
    const isVideoGenerate =
      url.includes('/video:batchAsyncGenerateVideoText') ||
      url.includes('/video:batchAsyncGenerateVideoReferenceImages') ||
      url.includes('/video:batchAsyncGenerateVideoStartAndEndImage');
    if ((!isImageGenerate && !isVideoGenerate) || !pendingFlowReferenceInputs.length) {
      return args;
    }

    if (typeof init.body === 'string') {
      if (isImageGenerate) {
        const patched = patchFlowGenerateBody(init.body);
        if (!patched.patched) return args;
        return [input, { ...init, body: patched.bodyText }];
      }
      const patched = patchFlowVideoGenerateBody(url, init.body);
      if (!patched.patched) return args;
      return [patched.url, { ...init, body: patched.bodyText }];
    }

    if (input instanceof Request) {
      try {
        const cloned = input.clone();
        const originalBody = await cloned.text();
        if (isImageGenerate) {
          const patched = patchFlowGenerateBody(originalBody);
          if (!patched.patched) return args;
          const headers = new Headers(input.headers);
          const request = new Request(input.url, {
            method: input.method,
            headers,
            body: patched.bodyText,
            mode: input.mode,
            credentials: input.credentials,
            cache: input.cache,
            redirect: input.redirect,
            referrer: input.referrer,
            referrerPolicy: input.referrerPolicy,
            integrity: input.integrity,
            keepalive: input.keepalive,
            signal: input.signal,
          });
          return [request, init];
        }
        const patched = patchFlowVideoGenerateBody(url, originalBody);
        if (!patched.patched) return args;
        const headers = new Headers(input.headers);
        const request = new Request(patched.url, {
          method: input.method,
          headers,
          body: patched.bodyText,
          mode: input.mode,
          credentials: input.credentials,
          cache: input.cache,
          redirect: input.redirect,
          referrer: input.referrer,
          referrerPolicy: input.referrerPolicy,
          integrity: input.integrity,
          keepalive: input.keepalive,
          signal: input.signal,
        });
        return [request, init];
      } catch {}
    }

    return args;
  }

  function captureFlowRequest(args: any[]) {
    try {
      const input = args[0];
      const init = (args[1] || {}) as RequestInit;
      const url = getRequestURL(input);
      if (!isFlowAPIRequest(url)) return;

      const headers = new Headers(input instanceof Request ? input.headers : undefined);
      const overrideHeaders = new Headers(init.headers || {});
      overrideHeaders.forEach((value, key) => headers.set(key, value));

      let bodyText = '';
      const body = init.body;
      if (typeof body === 'string') bodyText = body;
      else if (input instanceof Request && typeof (input as any)._bodyText === 'string') bodyText = (input as any)._bodyText;

      const captured = normalizeCapturedHeaders(headers);
      const projectId = extractProjectId(url, bodyText);
      if (!captured.authorization && !projectId) return;

      window.postMessage({
        type: 'OPENLINK_FLOW_CONTEXT',
        data: {
          url,
          projectId,
          headers: captured,
        },
      }, '*');
    } catch {}
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    if (event.data?.type === 'OPENLINK_SET_PENDING_FLOW_REFERENCES') {
      pendingFlowReferenceInputs = normalizePendingFlowReferenceInputs(event.data?.data?.items);
      pendingFlowReferenceKind = event.data?.data?.mediaKind === 'video' ? 'video' : 'image';
      window.postMessage({
        type: 'OPENLINK_FLOW_REFERENCES_READY',
        data: {
          count: pendingFlowReferenceInputs.length,
          mediaKind: pendingFlowReferenceKind,
        },
      }, '*');
    }
  });

  window.fetch = function(...args) {
    const decoder = new TextDecoder();
    return Promise.resolve().then(async () => {
      let nextArgs = args;
      nextArgs = await patchFlowGenerateArgs(nextArgs);
      captureFlowRequest(nextArgs);
      const response = await originalFetch.apply(this, nextArgs);
      const reader = response.body!.getReader();
      const stream = new ReadableStream({
        async start(controller) {
          while (true) {
            const {done, value} = await reader.read();
            if (done) { buffer = ''; break; }

            const text = decoder.decode(value, { stream: true });
            buffer += text;

            let match;
            while ((match = buffer.match(/<tool(?:\s[^>]*)?>[\s\S]*?<\/tool(?:_call)?>/))) {
              const full = match[0];
              const processed = getProcessed();
              if (!processed.has(full)) {
                processed.add(full);
                const toolCall = parseXmlToolCall(full) || tryParseToolJSON(full.replace(/^<tool[^>]*>|<\/tool(?:_call)?>$/g, '').trim());
                if (toolCall) {
                  window.postMessage({type: 'TOOL_CALL', data: toolCall}, '*');
                }
              }
              buffer = buffer.replace(full, '');
            }
            controller.enqueue(value);
          }
          controller.close();
        }
      });

      return new Response(stream, {
        headers: response.headers,
        status: response.status
      });
    });
  };
})();
