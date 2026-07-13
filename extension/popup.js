const exportButton = document.querySelector('#export');
const stopButton = document.querySelector('#stop');
const status = document.querySelector('#status');

function setStatus(message) {
  status.textContent = message;
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function ensureContentScript(tabId) {
  try {
    const reply = await chrome.tabs.sendMessage(tabId, { type: 'PING' });
    if (reply?.ok) return;
  } catch (_) {
    // Страница была открыта до установки расширения: внедряем скрипт вручную.
  }
  await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
}

exportButton.addEventListener('click', async () => {
  const tab = await activeTab();
  if (!tab?.id || !/^https:\/\/(vk\.com|music\.yandex\.ru)\//.test(tab.url || '')) {
    setStatus('Откройте страницу VK Музыки или Яндекс Музыки.');
    return;
  }

  exportButton.hidden = true;
  stopButton.hidden = false;
  setStatus('Начинаю сбор…');
  try {
    await ensureContentScript(tab.id);
    const response = await chrome.tabs.sendMessage(tab.id, { type: 'START_EXPORT' });
    if (!response?.ok) throw new Error(response?.error || 'Не удалось запустить сбор.');
  } catch (error) {
    setStatus(error.message || 'Не удалось связаться со страницей. Обновите её и повторите.');
    exportButton.hidden = false;
    stopButton.hidden = true;
  }
});

stopButton.addEventListener('click', async () => {
  const tab = await activeTab();
  if (tab?.id) await chrome.tabs.sendMessage(tab.id, { type: 'STOP_EXPORT' });
});

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'EXPORT_PROGRESS') {
    setStatus(`Собрано: ${message.count}. Прокручиваю список…`);
  }
  if (message.type === 'EXPORT_DONE') {
    exportButton.hidden = false;
    stopButton.hidden = true;
    if (message.cancelled) {
      setStatus(`Остановлено. Собрано: ${message.tracks.length}.`);
      return;
    }
    setStatus(`Готово: ${message.tracks.length} треков. Выберите место сохранения.`);
  }
});
