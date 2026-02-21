chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type !== 'FETCH') return false;
  const { url, options } = msg;
  fetch(url, options)
    .then(async r => ({ ok: r.ok, status: r.status, body: await r.text() }))
    .catch(e => ({ ok: false, status: 0, body: String(e) }))
    .then(sendResponse);
  return true; // keep channel open for async response
});
