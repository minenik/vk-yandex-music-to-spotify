(() => {
  let running = false;
  let cancelled = false;

  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const normalize = (value) => (value || '').replace(/\s+/g, ' ').trim();
  const unique = (values) => [...new Set(values.map(normalize).filter(Boolean))];

  function source() {
    return location.hostname === 'music.yandex.ru' ? 'yandex' : 'vk';
  }

  function visible(element) {
    const style = getComputedStyle(element);
    return style.display !== 'none' && style.visibility !== 'hidden' && element.getClientRects().length > 0;
  }

  function textFrom(element, selectors) {
    for (const selector of selectors) {
      const found = element.querySelector(selector);
      if (found) {
        const text = normalize(found.textContent);
        if (text) return text;
      }
    }
    return '';
  }

  function yandexTracks() {
    // У Яндекс Музыки классы регулярно меняются, но ссылки на трек и артиста
    // остаются стабильнее. Ищем пары по ним, поднимаясь к общему контейнеру.
    const trackLinks = document.querySelectorAll('a[href*="/track/"]');
    const found = [];
    for (const link of trackLinks) {
      const title = normalize(link.textContent);
      if (!title || !visible(link)) continue;
      let row = link.parentElement;
      let artist = '';
      for (let level = 0; row && level < 7; level += 1, row = row.parentElement) {
        const artists = unique([...row.querySelectorAll('a[href*="/artist/"]')]
          .map((element) => element.textContent));
        if (artists.length) {
          artist = artists.join(', ');
          break;
        }
      }
      if (title && artist) found.push(`${artist} – ${title}`);
    }
    return unique(found);
  }

  function vkTracks() {
    const rows = document.querySelectorAll('[data-testid="MusicTrackRow"], .audio_row, [data-audio]');
    const found = [];
    for (const row of rows) {
      if (!visible(row)) continue;
      const title = textFrom(row, [
        '[data-testid="MusicTrackRow_Title"]',
        '.audio_row__title_inner', '[class*="audio_row__title"]', '[class*="AudioRow__title"]'
      ]);
      const vkAuthors = unique([...row.querySelectorAll('[data-testid="MusicTrackRow_Authors"]')]
        .map((element) => element.textContent));
      const artist = vkAuthors.join(', ') || textFrom(row, [
        '.audio_row__performer', '[class*="audio_row__performer"]', '[class*="AudioRow__performer"]'
      ]);
      if (title && artist) found.push(`${artist} – ${title}`);
    }
    return unique(found);
  }

  function collect() {
    return source() === 'yandex' ? yandexTracks() : vkTracks();
  }

  function scrollTarget() {
    if (source() === 'yandex') {
      const virtuosoScroller = document.querySelector('[data-virtuoso-scroller="true"]');
      if (virtuosoScroller) return virtuosoScroller;
    }
    const rows = source() === 'yandex'
      ? document.querySelectorAll('a[href*="/track/"]')
      : document.querySelectorAll('[data-testid="MusicTrackRow"], .audio_row, [data-audio]');
    const candidates = new Map();
    for (const row of rows) {
      let parent = row.parentElement;
      for (let level = 0; parent && level < 8; level += 1, parent = parent.parentElement) {
        const style = getComputedStyle(parent);
        if (parent.scrollHeight > parent.clientHeight + 60 && /(auto|scroll)/.test(style.overflowY)) {
          candidates.set(parent, (candidates.get(parent) || 0) + 1);
        }
      }
    }
    const best = [...candidates.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
    return best || document.scrollingElement;
  }

  function scrollTrackList() {
    const amount = Math.max(Math.floor(window.innerHeight * 0.82), 420);
    const primaryTarget = scrollTarget();

    // React Virtuoso — компонент, которым Яндекс Музыка виртуализирует список.
    // Именно этот элемент должен получить изменение scrollTop, иначе новые строки
    // не будут отрисованы.
    if (source() === 'yandex' && primaryTarget?.dataset.virtuosoScroller === 'true') {
      const before = primaryTarget.scrollTop;
      const maxTop = primaryTarget.scrollHeight - primaryTarget.clientHeight;
      primaryTarget.scrollTop = Math.min(before + amount, maxTop);
      primaryTarget.dispatchEvent(new Event('scroll', { bubbles: true }));
      return {
        moved: primaryTarget.scrollTop !== before,
        atEnd: primaryTarget.scrollTop >= maxTop - 2
      };
    }

    const targets = new Set([document.scrollingElement, primaryTarget]);
    const links = source() === 'yandex'
      ? document.querySelectorAll('a[href*="/track/"]')
      : document.querySelectorAll('[data-testid="MusicTrackRow"], .audio_row, [data-audio]');

    // Берём ближайший реально прокручиваемый предок каждой строки. На Яндекс
    // Музыке он может меняться между версиями интерфейса.
    for (const link of links) {
      let parent = link.parentElement;
      for (let level = 0; parent && level < 10; level += 1, parent = parent.parentElement) {
        if (parent.scrollHeight > parent.clientHeight + 40) {
          targets.add(parent);
          break;
        }
      }
    }

    let moved = false;
    for (const target of targets) {
      if (!target || target.scrollHeight <= target.clientHeight + 20) continue;
      const before = target.scrollTop;
      target.scrollTop = Math.min(target.scrollTop + amount, target.scrollHeight);
      moved ||= target.scrollTop !== before;
    }
    // Иногда основной скролл обрабатывается самой страницей, а не контейнером.
    window.scrollBy(0, amount);
    return { moved, atEnd: false };
  }

  async function exportTracks() {
    running = true;
    cancelled = false;
    const all = new Set();
    let staleSteps = 0;
    let lastCount = 0;

    for (let step = 0; step < 900 && staleSteps < 20 && !cancelled; step += 1) {
      for (const track of collect()) all.add(track);
      if (all.size !== lastCount) {
        lastCount = all.size;
        staleSteps = 0;
        chrome.runtime.sendMessage({ type: 'EXPORT_PROGRESS', count: all.size });
      } else {
        staleSteps += 1;
      }

      const { moved, atEnd } = scrollTrackList();
      await delay(moved ? 850 : 1100);
      if (atEnd) break;
    }

    for (const track of collect()) all.add(track);
    running = false;
    chrome.runtime.sendMessage({ type: 'EXPORT_DONE', tracks: [...all], cancelled });
  }

  chrome.runtime.onMessage.addListener((message, _sender, respond) => {
    if (message.type === 'PING') {
      respond({ ok: true });
      return;
    }
    if (message.type === 'START_EXPORT') {
      if (running) {
        respond({ ok: false, error: 'Сбор уже выполняется.' });
      } else {
        exportTracks().catch((error) => {
          running = false;
          chrome.runtime.sendMessage({ type: 'EXPORT_DONE', tracks: [], cancelled: true });
          console.error('Music export failed:', error);
        });
        respond({ ok: true });
      }
    }
    if (message.type === 'STOP_EXPORT') {
      cancelled = true;
      respond({ ok: true });
    }
  });
})();
