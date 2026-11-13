// 群消息搜索：参考图中的发送者列表与月历，复用已有真实筛选接口。
const chatSearchAvatarColors = ['#e46c77', '#e578b9', '#64aed5', '#65c6c9', '#7fc665', '#a490e1', '#ffab6c'];

function chatSearchDateString(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
function parseChatSearchDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '') || value < '1000-01-01') return null;
  const [year, month, day] = value.split('-').map(Number), date = new Date(year, month - 1, day);
  return chatSearchDateString(date) === value ? date : null;
}
function chatSearchLastSeen(member) {
  if (member.last_seen_hidden) return '最近上线时间已隐藏';
  if (member.online) return '当前在线';
  const match = String(member.last_seen_at || '').match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/);
  if (!match) return '最近上线时间暂无记录';
  const today = new Date(), yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
  const day = `${match[1]}-${match[2]}-${match[3]}`, time = `${match[4]}:${match[5]}`;
  if (day === chatSearchDateString(today)) return `最近上线于今天 ${time}`;
  if (day === chatSearchDateString(yesterday)) return `最近上线于昨天 ${time}`;
  return `最近上线于 ${match[3]}.${match[2]}.${match[1].slice(-2)}`;
}
function closeClassicChatSearchFilter() {
  const modal = $('chat-search-filter-popover');
  if (!modal) return;
  const kind = modal.dataset.kind;
  if (state.chatSearch?.filterDialog?.modal === modal) state.chatSearch.filterDialog = null;
  modal.remove();
  $('chat-search-sender')?.setAttribute('aria-expanded', 'false');
  $('chat-search-date')?.setAttribute('aria-expanded', 'false');
  if (state.chatSearch && $(`chat-search-${kind}`)?.isConnected) $(`chat-search-${kind}`).focus();
}
function bindChatSearchFilterDialog(filter) {
  const modal = filter.modal;
  modal.onclick = event => { if (event.target === modal) closeChatSearchFilter(); };
  modal.querySelector('[data-close-search-filter]').onclick = closeChatSearchFilter;
  modal.onkeydown = event => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeChatSearchFilter(); }
    if (event.key !== 'Tab') return;
    const nodes = [...modal.querySelectorAll('button:not(:disabled),input:not(:disabled)')].filter(node => node.getClientRects().length);
    if (!nodes.length) return;
    if (event.shiftKey && (document.activeElement === nodes[0] || !nodes.includes(document.activeElement))) { event.preventDefault(); nodes.at(-1).focus(); }
    else if (!event.shiftKey && (document.activeElement === nodes.at(-1) || !nodes.includes(document.activeElement))) { event.preventDefault(); nodes[0].focus(); }
  };
}
function chatSearchFilterIsCurrent(search, filter) {
  return state.chatSearch === search && search.filterDialog === filter && filter.modal.isConnected && Number(state.active?.id) === search.id;
}

async function openClassicChatSearchFilter(kind) {
  const search = state.chatSearch;
  if (!search || !['sender', 'date'].includes(kind) || (kind === 'sender' && search.conversation.type !== 'group')) return;
  if ($('chat-search-filter-popover')?.dataset.kind === kind) { closeChatSearchFilter(); return; }
  closeChatSearchFilter(); closeFeatureModal();
  const title = kind === 'sender' ? '选择发送者' : '选择日期';
  document.body.insertAdjacentHTML('beforeend', `<div id="chat-search-filter-popover" class="modal-backdrop classic-search-filter-backdrop" data-kind="${kind}"><section class="classic-search-${kind}-dialog" role="dialog" aria-modal="true" aria-label="${title}" tabindex="-1"></section></div>`);
  const filter = { kind, modal: $('chat-search-filter-popover'), loaded: false, members: [] };
  search.filterDialog = filter;
  $(`chat-search-${kind}`).setAttribute('aria-expanded', 'true');
  if (kind === 'sender') await openChatSearchSenderDialog(search, filter);
  else await openChatSearchCalendarDialog(search, filter);
}

async function openChatSearchSenderDialog(search, filter) {
  const card = filter.modal.querySelector('section');
  card.innerHTML = `<header><h2>选择发送者</h2></header><label class="classic-search-sender-query">${navIcon('search')}<input id="chat-search-sender-query" type="search" placeholder="搜索" aria-label="搜索发送者" autocomplete="off"></label><div id="chat-search-sender-list" class="classic-search-sender-list" aria-live="polite"><p class="classic-search-filter-status" role="status">正在读取成员…</p></div><footer><button type="button" data-close-search-filter>取消</button></footer>`;
  bindChatSearchFilterDialog(filter);
  const render = () => {
    if (!chatSearchFilterIsCurrent(search, filter)) return;
    const query = $('chat-search-sender-query').value.trim().toLowerCase();
    const members = filter.members.filter(member => `${member.nickname || ''} ${member.username || ''}`.toLowerCase().includes(query));
    $('chat-search-sender-list').innerHTML = members.map(member => {
      const name = member.nickname || '未命名成员', initial = Array.from(name)[0], color = member.searchAvatarColor;
      return `<button type="button" class="classic-search-sender-row" data-search-sender="${Number(member.user_id)}"><span class="classic-search-sender-avatar" style="background:${color}">${member.avatar_url ? `<img src="${escapeHtml((globalThis.avatarUrl || mediaUrl)(member.avatar_url))}" alt="" data-search-avatar-fallback="${escapeHtml(initial)}">` : escapeHtml(initial)}</span><span class="classic-search-sender-copy"><strong>${escapeHtml(name)}</strong><small>${escapeHtml(chatSearchLastSeen(member))}</small></span></button>`;
    }).join('') || `<p class="classic-search-filter-status" role="status">${query ? '没有匹配的发送者' : '暂无可选择的成员'}</p>`;
    $('chat-search-sender-list').scrollTop = 0;
    card.querySelectorAll('[data-search-sender]').forEach(button => { button.onclick = () => {
      if (!chatSearchFilterIsCurrent(search, filter)) return;
      const member = filter.members.find(item => Number(item.user_id) === Number(button.dataset.searchSender));
      if (!member) return;
      search.senderId = Number(member.user_id); search.senderName = member.nickname || '未命名成员';
      closeChatSearchFilter(); runChatSearch();
    }; });
    card.querySelectorAll('[data-search-avatar-fallback]').forEach(image => image.addEventListener('error', () => { image.parentElement.textContent = image.dataset.searchAvatarFallback; }, { once: true }));
  };
  $('chat-search-sender-query').oninput = () => { if (filter.loaded) render(); };
  $('chat-search-sender-query').focus();
  const load = async () => {
    if (!chatSearchFilterIsCurrent(search, filter)) return;
    $('chat-search-sender-list').innerHTML = '<p class="classic-search-filter-status" role="status">正在读取成员…</p>';
    try {
      const result = await api(`/conversations/members?conversation_id=${search.id}`);
      if (!chatSearchFilterIsCurrent(search, filter)) return;
      filter.members = (result.items || []).map((member, index) => ({ ...member, searchAvatarColor: chatSearchAvatarColors[index % chatSearchAvatarColors.length] })); filter.loaded = true; render();
    } catch (error) {
      if (!chatSearchFilterIsCurrent(search, filter)) return;
      $('chat-search-sender-list').innerHTML = `<p class="classic-search-filter-status" role="status">${escapeHtml(error.message || '成员读取失败')}</p><button id="chat-search-sender-retry" type="button">重新加载</button>`;
      $('chat-search-sender-retry').onclick = load;
    }
  };
  await load();
}

function renderChatSearchCalendar(search, filter) {
  if (!chatSearchFilterIsCurrent(search, filter)) return;
  const year = filter.month.getFullYear(), month = filter.month.getMonth();
  const offset = (new Date(year, month, 1).getDay() + 6) % 7;
  const count = Math.ceil((offset + new Date(year, month + 1, 0).getDate()) / 7) * 7;
  const currentMonth = chatSearchDateString(filter.month).slice(0, 7);
  const cells = Array.from({ length: count }, (_, index) => {
    const date = new Date(year, month, index - offset + 1), value = chatSearchDateString(date);
    const outside = date.getMonth() !== month;
    const disabled = !filter.loaded || filter.empty || outside || value > filter.today || (filter.firstDate && value < filter.firstDate);
    return `<button type="button" data-search-date="${value}" aria-label="${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日" ${value === filter.today ? 'aria-current="date"' : ''} ${value === search.date ? 'aria-pressed="true"' : 'aria-pressed="false"'} ${disabled ? 'disabled' : ''} class="${outside ? 'is-other-month' : ''}">${date.getDate()}</button>`;
  }).join('');
  const card = filter.modal.querySelector('section');
  card.innerHTML = `<header class="classic-search-calendar-head"><button id="chat-search-month-prev" type="button" aria-label="上个月" ${!filter.loaded || filter.empty || currentMonth <= (filter.firstDate || '1000-01-01').slice(0, 7) ? 'disabled' : ''}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m14 5-7 7 7 7"/></svg></button><h2>${month + 1}月 ${year}</h2><button id="chat-search-month-next" type="button" aria-label="下个月" ${!filter.loaded || filter.empty || currentMonth >= filter.today.slice(0, 7) ? 'disabled' : ''}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m10 5 7 7-7 7"/></svg></button></header><div class="classic-search-calendar-weekdays" aria-hidden="true">${['周一', '周二', '周三', '周四', '周五', '周六', '周日'].map(day => `<span>${day}</span>`).join('')}</div><div class="classic-search-calendar-days">${cells}</div><p class="classic-search-calendar-status" role="status">${escapeHtml(filter.error || (!filter.loaded ? '正在读取消息日期…' : filter.empty ? '暂无可查看的聊天记录' : ''))}</p>${filter.error ? '<button id="chat-search-calendar-retry" type="button">重新加载</button>' : ''}<footer><button id="chat-search-first-message" type="button" ${!filter.loaded || filter.empty ? 'disabled' : ''}>最初消息</button><button type="button" data-close-search-filter>关闭</button></footer>`;
  bindChatSearchFilterDialog(filter);
  card.querySelectorAll('[data-search-date]:not(:disabled)').forEach(button => { button.onclick = () => {
    search.date = button.dataset.searchDate; closeChatSearchFilter(); runChatSearch();
  }; });
  const navigate = delta => { filter.month = new Date(year, month + delta, 1); renderChatSearchCalendar(search, filter); const button = $(`chat-search-month-${delta < 0 ? 'prev' : 'next'}`); (button.disabled ? card.querySelector('[data-close-search-filter]') : button).focus(); };
  $('chat-search-month-prev').onclick = () => navigate(-1);
  $('chat-search-month-next').onclick = () => navigate(1);
  $('chat-search-first-message').onclick = () => { closeChatSearchFilter(); locateChatSearchMessage({ first: true }); };
  $('chat-search-calendar-retry')?.addEventListener('click', () => loadChatSearchCalendar(search, filter));
}
async function loadChatSearchCalendar(search, filter) {
  filter.loaded = false; filter.error = ''; renderChatSearchCalendar(search, filter);
  try {
    const range = await api(`/messages/calendar?conversation_id=${search.id}`);
    if (!chatSearchFilterIsCurrent(search, filter)) return;
    filter.today = parseChatSearchDate(range.today) ? range.today : chatSearchDateString(new Date());
    filter.firstDate = parseChatSearchDate(range.first_date) ? range.first_date : '';
    filter.empty = Object.hasOwn(range, 'first_date') && !filter.firstDate;
    const minMonth = (filter.firstDate || '1000-01-01').slice(0, 7), maxMonth = filter.today.slice(0, 7);
    let month = chatSearchDateString(filter.month).slice(0, 7);
    month = month > maxMonth ? maxMonth : month < minMonth ? minMonth : month;
    filter.month = parseChatSearchDate(`${month}-01`); filter.loaded = true;
  } catch (error) { if (chatSearchFilterIsCurrent(search, filter)) filter.error = error.message || '消息日期读取失败'; }
  renderChatSearchCalendar(search, filter);
}
async function openChatSearchCalendarDialog(search, filter) {
  filter.today = chatSearchDateString(new Date());
  const initial = parseChatSearchDate(search.date) || new Date();
  filter.month = new Date(initial.getFullYear(), initial.getMonth(), 1);
  filter.modal.querySelector('section').focus();
  await loadChatSearchCalendar(search, filter);
  if (chatSearchFilterIsCurrent(search, filter)) filter.modal.querySelector('[aria-current="date"]:not(:disabled),[data-close-search-filter]').focus();
}

function resetChatHistoryLocation() { state.historyRevision = (state.historyRevision || 0) + 1; state.historyLocation = null; $('chat-history-location')?.remove(); }
async function locateChatSearchMessage({ messageId = 0, first = false } = {}) {
  const search = state.chatSearch;
  if (!search || Number(state.active?.id) !== search.id) return;
  const request = search.locateRequest = (search.locateRequest || 0) + 1;
  search.status = '正在定位消息…'; renderChatSearchPanel(search);
  try {
    const params = new URLSearchParams({ conversation_id: String(search.id) });
    if (first) params.set('first', '1'); else params.set('message_id', String(messageId));
    const result = await api(`/messages/locate?${params}`);
    if (state.chatSearch !== search || search.locateRequest !== request || Number(state.active?.id) !== search.id) return;
    const targetId = Number(result.target_id), messages = (result.items || []).filter(item => Number(item.id) > Number(state.active.cleared_before_message_id || 0)).reverse();
    if (!messages.some(item => Number(item.id) === targetId)) throw Error('该消息已不可查看，请重新搜索。');
    resetChatHistoryLocation();
    state.historyPage = Number(result.page) || 1;
    state.historyHasMore = state.historyPage * 50 < Number(result.total || 0);
    state.historyLocation = { conversationId: search.id, maxId: Number(result.max_id) || Math.max(...messages.map(item => Number(item.id))) };
    $('messages').innerHTML = messages.map(messageHtml).join(''); bindMessageActions();
    $('messages').insertAdjacentHTML('beforebegin', '<div id="chat-history-location" class="classic-history-location"><span>已定位历史消息</span><button type="button">返回最新消息</button></div>');
    $('chat-history-location').querySelector('button').onclick = () => openConversation(search.id);
    const target = $('messages').querySelector(`[data-message-id="${targetId}"]`);
    target.classList.add('classic-search-message-target'); target.scrollIntoView({ block: 'center' });
    search.status = '';
  } catch (error) { if (state.chatSearch === search && search.locateRequest === request) search.status = error.message || '消息定位失败，请重试'; }
  finally { if (state.chatSearch === search && search.locateRequest === request) renderChatSearchPanel(search); }
}
