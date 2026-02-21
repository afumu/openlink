(function() {
  console.log('[OpenLink] 插件已加载');
  const originalFetch = window.fetch;
  let buffer = '';

  window.fetch = function(...args) {
    const processedTools = new Set<string>();
    const decoder = new TextDecoder();
    return originalFetch.apply(this, args).then(async response => {
      const reader = response.body!.getReader();
      const stream = new ReadableStream({
        async start(controller) {
          while (true) {
            const {done, value} = await reader.read();
            if (done) { buffer = ''; break; }

            const text = decoder.decode(value, { stream: true });
            buffer += text;

            let match;
            while ((match = buffer.match(/<tool>([\s\S]*?)<\/tool(?:_call)?>/))) {
              const raw = match[1].trim();
              if (!processedTools.has(raw)) {
                processedTools.add(raw);
                let toolCall = null;
                const tries = [
                  () => JSON.parse(raw),
                  () => JSON.parse(raw.replace(/\\n/g, '')),
                  () => JSON.parse(raw.replace(/\\"/g, '"')),
                  () => JSON.parse(JSON.parse('"' + raw + '"'))
                ];

                for (const fn of tries) {
                  try { toolCall = fn(); break; } catch {}
                }

                if (toolCall) {
                  window.postMessage({type: 'TOOL_CALL', data: toolCall}, '*');
                }
              }
              buffer = buffer.replace(match[0], '');
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
