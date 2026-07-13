chrome.runtime.onMessage.addListener((message) => {
  if (message.type !== 'EXPORT_DONE' || !Array.isArray(message.tracks)) return;

  const text = `${message.tracks.join('\n')}\n`;
  const url = `data:text/plain;charset=utf-8,${encodeURIComponent(text)}`;
  chrome.downloads.download({ url, filename: 'tracks.txt', saveAs: true });
});
