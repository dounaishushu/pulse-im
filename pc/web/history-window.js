(() => {
  'use strict';
  const bridge = window.pulseHistoryWindow, $ = id => document.getElementById(id);
  let typographyRevision = 0;
  bridge.onChatTypographyChanged?.(value => { typographyRevision++; window.PulseChatTypography.apply(value, document.documentElement); });
  const scroller = $('history-scroll'), list = $('history-list');
  let context, loading = false, loaded = false, hasMore = true, oldestId = 0, feedbackTimer;
  const messages = new Map();
  const removedIds = new Set();
  bridge.onMessageRecalled?.(value => {
    const id = Number(value?.messageId);
    if (!Number.isSafeInteger(id) || id <= 0 || context && (Number(value.accountId) !== context.accountId || Number(value.conversationId) !== context.conversationId)) return;
    removedIds.add(id); messages.delete(id);
    const node = list.querySelector(`[data-message-id="${id}"]`);
    node?.querySelectorAll('video,audio').forEach(media => media.pause()); node?.remove();
    list.querySelectorAll('.history-day').forEach(label => { if (!label.nextElementSibling?.classList.contains('history-message')) label.remove(); });
    controls();
  });
  const escape = value => String(value || '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const dateOf = item => /^\d{4}-\d{2}-\d{2}/.exec(item.created_at)?.[0] || '';
  const errorText = error => String(error.message || '操作失败，请重试。').replace(/^Error invoking remote method '[^']+': Error: /, '');
  function feedback(value) { clearTimeout(feedbackTimer); $('history-feedback').textContent = value; feedbackTimer = setTimeout(() => { $('history-feedback').textContent = ''; }, 3500); }
  function pageStatus(value, error = false) { $('history-page-status').textContent = value; $('history-page-status').classList.toggle('is-error', error); }
  function controls() {
    $('history-refresh').disabled = loading;
    $('history-older').disabled = loading || !hasMore;
    $('history-older').textContent = loading ? '正在加载…' : hasMore ? '加载更早记录' : '已到最早记录';
    $('history-count').textContent = `已加载 ${messages.size} 条`;
    $('history-empty').hidden = !loaded || messages.size > 0 || loading;
  }
  function avatar(name, url) { return `<span class="history-avatar">${url ? `<img src="${escape(url)}" alt="" loading="lazy" data-avatar-fallback="${escape(Array.from(name)[0] || '?')}">` : escape(Array.from(name)[0] || '?')}</span>`; }
  function html(item) {
    const body = item.body, mine = item.sender_id === context.accountId;
    let content, copy = body.text ? `<button type="button" data-copy-text="${item.id}">复制文字</button>` : '';
    if (item.type === 'image' && body.url) {
      const dimensions = body.width && body.height ? ` width="${body.width}" height="${body.height}"` : '';
      content = `<button type="button" class="history-image" data-image="${item.id}" aria-label="查看图片"><img src="${escape(body.url)}" alt="${escape(body.name || '聊天图片')}" loading="lazy"${dimensions}></button>`;
      if (body.text) content += `<p class="history-text history-caption">${escape(body.text)}</p>`;
      copy += `<button type="button" data-copy-image="${item.id}">复制图片</button>`;
    } else if ((item.type === 'video' || item.type === 'file' && /^video\//i.test(body.mime)) && body.url) {
      content = `<video controls preload="none" src="${escape(body.url)}" aria-label="${escape(body.name || '聊天视频')}"></video>`;
      if (body.text) content += `<p class="history-text history-caption">${escape(body.text)}</p>`;
    } else if (item.type === 'voice' && body.url) {
      content = `<audio controls preload="none" src="${escape(body.url)}" aria-label="语音消息"></audio>`;
    } else if (item.type === 'file' && body.url) {
      content = `<button class="history-file" type="button" data-download="${item.id}">↓ ${escape(body.name || '下载文件')}</button>`;
    } else if (item.type === 'contact_card') {
      content = `<div class="history-card">${avatar(body.nickname || '?', body.avatar_url)}<div><strong>${escape(body.nickname || '未命名用户')}</strong><small>${escape(body.username ? '@' + body.username : '个人名片')}</small></div></div>`;
    } else {
      content = `<p class="history-text">${escape(body.text || ({ shake: '窗口抖动', system: '系统消息' }[item.type]) || '[消息]')}</p>`;
    }
    const time = item.created_at.match(/[ T](\d{2}:\d{2}(?::\d{2})?)/)?.[1] || item.created_at;
    return `<article class="history-message${mine ? ' mine' : ''}" data-message-id="${item.id}">${avatar(item.sender_name, item.sender_avatar_url)}<div class="history-content"><div class="history-author">${escape(mine ? '我' : item.sender_name)}</div><div class="history-bubble">${content}<time title="${escape(item.created_at)}">${escape(time)}</time></div>${copy ? `<div class="history-actions">${copy}</div>` : ''}</div></article>`;
  }
  function bindMedia() {
    list.querySelectorAll('[data-avatar-fallback]').forEach(image => { image.onerror = () => { image.parentElement.textContent = image.dataset.avatarFallback; }; });
    list.querySelectorAll('.history-image img').forEach(image => { image.onerror = () => {
      if (image.parentElement.querySelector('.history-media-error')) return;
      const label = document.createElement('span'); label.className = 'history-media-error'; label.textContent = '图片加载失败，点击重试'; image.parentElement.append(label);
    }; });
  }
  function addRows(items, reset) {
    const ordered = [...items].sort((a, b) => a.id - b.id).filter(item => !removedIds.has(item.id) && !item.recalled_at && !['deleted', 'recalled'].includes(item.status) && (reset || !messages.has(item.id)));
    if (reset) { messages.clear(); list.querySelectorAll('video,audio').forEach(media => media.pause()); list.replaceChildren(); }
    // Date labels are inserted with each ID page, without rebuilding existing
    // bubbles or restarting images/videos while older records are loaded.
    if (ordered.length) {
      const fragment = document.createDocumentFragment();
      let previous = null;
      for (const item of ordered) {
        const day = dateOf(item);
        if (day !== previous) { const label = document.createElement('div'); label.className = 'history-day'; label.dataset.day = day; label.textContent = day || '日期未知'; fragment.append(label); previous = day; }
        const template = document.createElement('template'); template.innerHTML = html(item); fragment.append(template.content); messages.set(item.id, item);
      }
      const first = list.firstElementChild;
      if (first?.classList.contains('history-day') && first.dataset.day === previous) first.remove();
      list.prepend(fragment);
    }
    oldestId = ordered.length ? Math.min(ordered[0].id, reset ? Infinity : oldestId || Infinity) : oldestId;
    bindMedia();
  }
  async function load(reset = false) {
    if (!context || loading || !reset && !hasMore) return;
    loading = true; controls(); pageStatus('正在加载…');
    const anchor = [...list.querySelectorAll('[data-message-id]')].find(node => node.getBoundingClientRect().bottom >= scroller.getBoundingClientRect().top);
    const offset = anchor?.getBoundingClientRect().top;
    try {
      const result = await bridge.page(reset ? 0 : oldestId);
      addRows(result.items || [], reset);
      if (Number(result.oldestId) > 0) oldestId = reset ? Number(result.oldestId) : Math.min(oldestId || Infinity, Number(result.oldestId));
      loaded = true; hasMore = result.hasMore === true && oldestId > 1;
      pageStatus('');
      if (reset) scroller.scrollTop = scroller.scrollHeight;
      else if (anchor?.isConnected) scroller.scrollTop += anchor.getBoundingClientRect().top - offset;
    } catch (error) { pageStatus(errorText(error), true); }
    finally { loading = false; controls(); }
  }
  list.addEventListener('click', async event => {
    const button = event.target.closest('button');
    if (!button || button.disabled) return;
    const value = button.dataset, id = Number(value.copyText || value.copyImage || value.image || value.download);
    if (!messages.has(id)) return;
    button.disabled = true;
    try {
      if (value.copyText) { await bridge.copyText(id); feedback('文字已复制'); }
      else if (value.copyImage) {
        const image = list.querySelector(`[data-image="${id}"] img`);
        if (!image?.complete || !image.naturalWidth) throw Error('图片尚未加载，请稍后重试。');
        image.scrollIntoView({ block: 'nearest' });
        const bounds = image.getBoundingClientRect(), area = scroller.getBoundingClientRect();
        const x = (Math.max(bounds.left, area.left) + Math.min(bounds.right, area.right)) / 2;
        const y = (Math.max(bounds.top, area.top) + Math.min(bounds.bottom, area.bottom)) / 2;
        await bridge.copyImage({ id, x, y }); feedback('图片已复制');
      } else if (value.image) {
        const image = button.querySelector('img');
        if (image && !image.naturalWidth) { button.querySelector('.history-media-error')?.remove(); image.src = messages.get(id).body.url; }
        else await bridge.openImage(id);
      } else if (value.download) { const result = await bridge.download(id); if (result.saved) feedback('文件已保存'); }
    } catch (error) { feedback(errorText(error)); }
    finally { button.disabled = false; }
  });
  list.addEventListener('dblclick', event => {
    if (event.button !== 0 || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || !(event.target instanceof Element)) return;
    const text = event.target.closest('.history-text'), selection = window.getSelection();
    if (!text || !list.contains(text) || event.target.closest('button,a,input,textarea,video,audio') || !selection) return;
    const range = document.createRange(); range.selectNodeContents(text);
    event.preventDefault(); selection.removeAllRanges(); selection.addRange(range);
  });
  $('history-refresh').onclick = () => load(true);
  $('history-older').onclick = () => load();
  $('history-bottom').onclick = () => { scroller.scrollTop = scroller.scrollHeight; };
  document.addEventListener('keydown', event => { if (event.key === 'Escape') { event.preventDefault(); void bridge.close(); } });
  bridge.context().then(value => {
    context = value; document.body.dataset.theme = value.theme;
    if (!typographyRevision) window.PulseChatTypography.apply(value.chatTypography, document.documentElement);
    $('history-title').textContent = value.title;
    $('history-subtitle').textContent = `${value.type === 'group' ? '群聊' : '私聊'} · 聊天记录`;
    document.title = `${value.title} · 聊天记录 - 小猿口算`;
    return load(true);
  }).catch(error => { pageStatus(error.message || '窗口已失效，请重新打开。', true); });
})();
