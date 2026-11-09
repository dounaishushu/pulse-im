const composerEmojiGroups = [
  { name: '表情', items: [['😀','开心'],['😃','高兴'],['😄','笑'],['😁','微笑'],['😂','笑哭'],['🤣','大笑'],['😊','微笑'],['🥰','喜欢'],['😍','爱'],['😘','亲亲'],['😎','酷'],['🤔','思考'],['🙄','白眼'],['😅','汗'],['😢','哭'],['😭','大哭'],['😤','生气'],['😡','愤怒'],['🤯','惊讶'],['🥳','庆祝'],['😴','睡觉'],['🤗','拥抱'],['🤭','捂嘴'],['🙋','举手'],['😇','天使'],['😋','好吃'],['🤩','星星眼'],['😬','尴尬']] },
  { name: '手势', items: [['👍','赞'],['👎','踩'],['👌','好的'],['✌️','胜利'],['🤞','好运'],['🙏','谢谢'],['👏','鼓掌'],['🙌','欢呼'],['🤝','握手'],['💪','加油'],['👋','再见'],['🤲','双手'],['☝️','注意'],['🤟','爱你']] },
  { name: '符号', items: [['❤️','爱心'],['💙','蓝心'],['💚','绿心'],['💛','黄心'],['💜','紫心'],['💔','心碎'],['🎉','庆祝'],['🎁','礼物'],['🌹','玫瑰'],['🌷','花'],['✨','闪亮'],['🔥','火'],['⭐','星星'],['✅','对'],['❌','错'],['💯','满分'],['🎂','生日'],['☕','咖啡'],['🍵','茶'],['🍎','苹果'],['🎈','气球'],['🚀','火箭'],['🌈','彩虹'],['🐱','猫'],['🐶','狗'],['🐼','熊猫']] },
];

// 使用完整 Unicode Emoji 分类数据，消息发送时仍保存为标准 Unicode 字符。
if (Array.isArray(telegramEmojiGroups) && telegramEmojiGroups.length) {
  composerEmojiGroups.splice(0, composerEmojiGroups.length, { name: '最近使用', items: [] }, ...telegramEmojiGroups);
}
const recentEmojiStorageKey = 'pulse_recent_emojis';
const defaultComposerRecentEmojis = [
  ['😂', '笑哭'], ['😘', '亲亲'], ['❤️', '爱心'], ['😍', '喜欢'], ['😊', '开心'], ['😁', '微笑'],
  ['👍', '赞'], ['😅', '汗'], ['😌', '安心'], ['😃', '高兴'], ['😭', '大哭'], ['💋', '亲吻'],
  ['😏', '得意'], ['😮', '惊讶'], ['😛', '调皮'], ['🙈', '害羞'], ['😉', '眨眼'], ['😃', '高兴'],
  ['😢', '难过'], ['😆', '大笑'], ['😱', '害怕'], ['😡', '生气'], ['😉', '眨眼'], ['😞', '失望'],
  ['😅', '汗'], ['😐', '平静'], ['🙊', '不说'], ['😌', '安心'], ['😀', '开心'], ['😛', '调皮'],
  ['😆', '大笑'], ['👌', '好的'], ['😐', '平静'], ['😕', '困惑'],
];
function loadRecentComposerEmojis() {
  try {
    const items = JSON.parse(localStorage.getItem(recentEmojiStorageKey) || '[]');
    if (Array.isArray(items) && items.length) return items.filter(item => Array.isArray(item) && item.length === 2 && item[0]);
    return defaultComposerRecentEmojis.map(item => [...item]);
  } catch { return []; }
}
function rememberComposerEmoji(emoji) {
  const items = [[emoji, '最近使用'], ...loadRecentComposerEmojis().filter(item => item[0] !== emoji)].slice(0, 36);
  composerEmojiGroups[0].items = items;
  localStorage.setItem(recentEmojiStorageKey, JSON.stringify(items));
}

function composerFeedback(message) {
  if (!$('composer-feedback')) $('composer')?.insertAdjacentHTML('beforeend', '<p id="composer-feedback" class="classic-composer-feedback" role="status"></p>');
  if ($('composer-feedback')) $('composer-feedback').textContent = message || '';
}
function mediaErrorText(error, kind = '设备') {
  if (error?.name === 'NotAllowedError' || error?.name === 'PermissionDeniedError') return `未允许使用${kind}，请在系统隐私设置中授权后重试。`;
  if (error?.name === 'NotFoundError' || error?.name === 'DevicesNotFoundError') return `未检测到${kind}。`;
  if (error?.name === 'NotReadableError') return `${kind}被其他程序占用或暂时无法使用。`;
  if (error?.name === 'OverconstrainedError') return `已选择的${kind}不可用，请重新选择设备。`;
  if (error?.name === 'NotSupportedError') return `当前环境不支持此${kind}操作。`;
  return /[\u4e00-\u9fff]/.test(error?.message || '') ? error.message : `${kind}操作失败，请检查系统权限后重试。`;
}
function bindComposerTools() {
  $('composer').addEventListener('submit', closeComposerEmoji);
  const image = $('image-button');
  if (image) { image.title = '图片'; image.setAttribute('aria-label', '发送图片'); image.onclick = () => $('image-picker')?.click(); }
  const emoji = $('composer').querySelector('[title="表情"]'); emoji.id = 'emoji-button'; emoji.setAttribute('aria-expanded', 'false'); emoji.setAttribute('aria-haspopup', 'dialog'); emoji.setAttribute('aria-controls', 'composer-emoji-picker'); emoji.onclick = toggleComposerEmoji;
  emoji.onpointerdown = () => { const input = $('message-input'); state.emojiSelection = [input.selectionStart, input.selectionEnd]; };
  $('video-button')?.addEventListener('click', () => $('video-picker')?.click());
  $('contact-card-button')?.addEventListener('click', openContactCardPicker);
  $('shake-button')?.addEventListener('click', sendWindowShake);
  const input = $('message-input');
  ['input', 'select', 'keyup', 'click'].forEach(name => input.addEventListener(name, () => { state.emojiSelection = [input.selectionStart, input.selectionEnd]; }));
}
let composerEmojiResizeObserver;
function positionComposerEmoji() {
  const picker = $('composer-emoji-picker');
  if (!picker?.classList.contains('classic-emoji-popup')) return;
  const composer = $('composer'), main = composer?.closest('.main');
  if (!main) return;
  const area = main.getBoundingClientRect(), entry = composer.getBoundingClientRect();
  const scale = main.offsetWidth ? area.width / main.offsetWidth : 1;
  const headerBottom = $('chat-head')?.getBoundingClientRect().bottom || area.top;
  const availableHeight = Math.max(0, (entry.top - Math.max(area.top, headerBottom)) / scale - 16);
  picker.style.bottom = `${Math.max(0, (area.bottom - entry.top) / scale) + 8}px`;
  picker.style.height = `${Math.min(260, availableHeight)}px`;
}
window.addEventListener('resize', positionComposerEmoji);
function closeComposerEmoji() {
  composerEmojiResizeObserver?.disconnect(); composerEmojiResizeObserver = null;
  $('composer-emoji-picker')?.remove();
  $('emoji-button')?.setAttribute('aria-expanded', 'false');
}

function emojiCategoryIcon(index) {
  return ['◷', '🙂', '🐱', '🍎', '🍔', '⚽', '🚗', '💡', '🔣', '❤️'][index] || '•';
}

function composerEmojiDisplayName(name) {
  return ({
    '最近使用': '最近使用',
    '表情与情感': '人物',
    '人物与身体': '手势',
    '动物与自然': '动物',
    '食物与饮料': '食物',
    '旅行与地点': '旅行',
  })[name] || name;
}

function composerEmojiAssetKey(emoji) {
  return [...emoji].map(char => char.codePointAt(0).toString(16)).join('_');
}

function composerEmojiButtonsHtml(items) {
  return items.map(([emoji, name]) => `<button type="button" data-composer-emoji="${escapeHtml(emoji)}" title="${escapeHtml(name)}" aria-label="${escapeHtml(name)}"><img class="classic-emoji-image" src="./emoji/${composerEmojiAssetKey(emoji)}.svg" loading="lazy" decoding="async" alt="" aria-hidden="true" draggable="false" style="visibility:hidden" onload="this.style.visibility='visible';this.nextElementSibling.hidden=true" onerror="this.hidden=true"><span class="classic-emoji-fallback">${emoji}</span></button>`).join('');
}

function composerEmojiGroupsHtml(groups) {
  return groups.filter(group => group.items.length).map((group) => `<section class="classic-emoji-group${group.index === 0 ? ' classic-emoji-recent-group' : ''}" data-emoji-group-section="${group.index}"><div class="classic-emoji-section-label">${escapeHtml(composerEmojiDisplayName(group.name))}</div><div class="classic-emoji-grid">${composerEmojiButtonsHtml(group.items)}</div></section>`).join('') || '<p class="classic-emoji-no-results">最近还没有使用过表情</p>';
}

const composerEmojiSearchAliases = { '😀': '开心', '😃': '开心', '😄': '开心', '😁': '开心', '😂': '笑哭', '🤣': '大笑', '😊': '开心', '🥰': '喜欢', '😍': '喜欢 爱', '😘': '亲亲', '👍': '赞 同意', '👎': '踩 不同意', '🙏': '谢谢 祈祷', '👏': '鼓掌', '❤️': '爱心 喜欢', '💔': '心碎', '🎉': '庆祝', '🎁': '礼物', '🔥': '火 热门', '😢': '难过', '😭': '大哭', '😡': '生气', '🤔': '思考' };
function composerEmojiSearchText(emoji, name) { return `${emoji}${name}${composerEmojiSearchAliases[emoji] || ''}`; }

function toggleComposerEmoji() {
  if ($('message-input')?.disabled) return;
  if ($('composer-emoji-picker')) { closeComposerEmoji(); return; }
  if (!state.active) { composerFeedback('请先选择会话。'); return; }
  composerFeedback('');
  composerEmojiGroups[0].items = loadRecentComposerEmojis();
  const input = $('message-input');
  const range = state.emojiSelection || [input.selectionStart, input.selectionEnd];
  if (PC_LAYOUT && typeof closeChatPanels === 'function') closeChatPanels();
  const host = PC_LAYOUT ? ($('composer')?.closest('.main') || $('composer')) : $('composer');
  if (!host) return;
  host.insertAdjacentHTML('beforeend', `<section id="composer-emoji-picker" class="classic-composer-emoji${PC_LAYOUT ? ' classic-emoji-popup' : ''}" role="dialog" aria-label="选择表情"><header class="classic-emoji-panel-head"><div class="classic-emoji-panel-tabs" role="tablist"><button type="button" class="is-active" data-emoji-panel-tab="emoji" role="tab" aria-selected="true">EMOJI</button><button type="button" data-emoji-panel-tab="sticker" role="tab" aria-selected="false">贴纸</button><button type="button" data-emoji-panel-tab="gif" role="tab" aria-selected="false">GIF 动态图</button></div><button type="button" id="composer-emoji-close" aria-label="关闭表情">×</button></header><input id="composer-emoji-search" type="search" placeholder="搜索表情，如：开心、谢谢" aria-label="搜索表情"><div class="classic-emoji-panel-content" data-emoji-content="emoji"><div id="composer-emoji-grid" class="classic-emoji-groups"></div></div><div class="classic-emoji-empty" data-emoji-content="sticker" hidden><strong>贴纸</strong><span>暂无贴纸</span></div><div class="classic-emoji-empty" data-emoji-content="gif" hidden><strong>GIF 动态图</strong><span>暂无 GIF 动态图</span></div><nav class="classic-emoji-category-bar" aria-label="表情分类">${composerEmojiGroups.map((group, index) => `<button type="button" data-emoji-group="${index}" aria-pressed="${index === 0}" title="${composerEmojiDisplayName(group.name)}" aria-label="${composerEmojiDisplayName(group.name)}">${emojiCategoryIcon(index)}</button>`).join('')}</nav></section>`);
  const picker = $('composer-emoji-picker'); let groupIndex = 0; let panelTab = 'emoji';
  if (picker.classList.contains('classic-emoji-popup')) {
    composerEmojiResizeObserver?.disconnect();
    composerEmojiResizeObserver = new ResizeObserver(positionComposerEmoji);
    [host, $('composer'), $('chat-head')].filter(Boolean).forEach(node => composerEmojiResizeObserver.observe(node));
    positionComposerEmoji();
  }
  const render = () => {
    picker.querySelectorAll('[data-emoji-content]').forEach(node => { node.hidden = node.dataset.emojiContent !== panelTab; });
    picker.querySelectorAll('[data-emoji-panel-tab]').forEach(node => { const active = node.dataset.emojiPanelTab === panelTab; node.classList.toggle('is-active', active); node.setAttribute('aria-selected', String(active)); });
    picker.querySelector('.classic-emoji-category-bar')?.toggleAttribute('hidden', panelTab !== 'emoji');
    if (panelTab !== 'emoji') return;
    const query = $('composer-emoji-search').value.trim();
    const content = $('composer-emoji-grid');
    if (query) {
      const items = composerEmojiGroups.flatMap(group => group.items).filter(([emoji, name]) => composerEmojiSearchText(emoji, name).includes(query));
      content.className = 'classic-emoji-grid classic-emoji-search-results';
      content.innerHTML = composerEmojiButtonsHtml(items) || '<p>没有匹配的表情</p>';
    } else {
      content.className = 'classic-emoji-groups';
      content.innerHTML = composerEmojiGroupsHtml(composerEmojiGroups.map((group, index) => ({ ...group, index })));
    }
    picker.querySelectorAll('[data-composer-emoji]').forEach(button => { button.onclick = () => {
      const emoji = button.dataset.composerEmoji;
      rememberComposerEmoji(emoji);
      const currentRange = state.emojiSelection || range;
      input.setRangeText(emoji, Math.min(currentRange[0], input.value.length), Math.min(currentRange[1], input.value.length), 'end');
      range[0] = range[1] = input.selectionEnd; state.emojiSelection = [...range];
      input.dispatchEvent(new Event('input', { bubbles: true })); input.focus();
    }; });
  };
  picker.querySelectorAll('[data-emoji-panel-tab]').forEach(button => { button.onclick = () => { panelTab = button.dataset.emojiPanelTab || 'emoji'; render(); }; });
  picker.querySelectorAll('[data-emoji-group]').forEach(button => { button.onclick = () => {
    groupIndex = Number(button.dataset.emojiGroup); $('composer-emoji-search').value = '';
    picker.querySelectorAll('[data-emoji-group]').forEach(node => node.setAttribute('aria-pressed', String(node === button))); render();
    const section = picker.querySelector(`[data-emoji-group-section="${groupIndex}"]`) || picker.querySelector('.classic-emoji-group');
    const content = $('composer-emoji-grid');
    if (section && content) {
      const bounds = content.getBoundingClientRect(), scale = content.offsetWidth ? bounds.width / content.offsetWidth : 1;
      content.scrollTop += (section.getBoundingClientRect().top - bounds.top) / scale;
    }
  }; });
  $('composer-emoji-search').oninput = render;
  $('composer-emoji-close').onclick = () => { closeComposerEmoji(); input.focus(); };
  picker.addEventListener('keydown', event => { if (event.key === 'Enter' && event.target instanceof HTMLInputElement) event.preventDefault(); if (event.key === 'Escape') { event.stopPropagation(); closeComposerEmoji(); input.focus(); } });
  $('emoji-button').setAttribute('aria-expanded', 'true'); render();
}
document.addEventListener('pointerdown', event => { if (event.target instanceof Element && !event.target.closest('#emoji-button,#composer-emoji-picker,#composer button.primary')) closeComposerEmoji(); });
document.addEventListener('keydown', event => { if (event.key === 'Escape' && document.getElementById('composer-emoji-picker')) { event.stopPropagation(); closeComposerEmoji(); } });

async function takeChatScreenshot() {
  if ($('message-input')?.disabled) return;
  if (!state.active) { composerFeedback('请先选择会话。'); return; }
  const captureScreenshot = desktop.captureScreenshot || window.PulseBrowser?.captureScreenshot;
  if (!captureScreenshot) { composerFeedback('当前浏览器不支持屏幕截图，可使用图片按钮上传图片。'); return; }
  if (state.screenshotBusy || state.imageDraft?.sending) return;
  const context = captureSendContext();
  const conversationId = Number(state.active.id); state.screenshotBusy = true;
  composerFeedback('');
  closeComposerEmoji(); closeFeatureModal(); $('image-button').disabled = true;
  try {
    const result = await captureScreenshot();
    if (!result) return;
    if (result.error) throw Error(result.error);
    if (!sameSendAccount(context) || Number(state.active?.id) !== conversationId) return;
    const blob = await (await fetch(result.dataUrl)).blob();
    if (sameSendAccount(context) && Number(state.active?.id) === conversationId) openImageSendPreview(new File([blob], `截图-${Date.now()}.png`, { type: 'image/png' }));
  } catch (error) { composerFeedback(mediaErrorText(error, '截图')); }
  finally { state.screenshotBusy = false; if ($('image-button')) $('image-button').disabled = false; }
}

function resetComposerForNavigation() {
  closeComposerEmoji(); state.emojiSelection = null;
  cancelComposerRecording();
  if (state.screenshotBusy) { desktop.cancelScreenshot?.(); window.PulseBrowser?.cancelScreenshot(); }
  if (state.cameraSession || state.audioDeviceSession || state.voiceDraft) closeFeatureModal();
}
function stopTracks(stream) { stream?.getTracks().forEach(track => track.stop()); }
function disposeComposerModal() {
  closeComposerEmoji();
  if (state.cameraSession) { state.cameraSession.generation++; stopTracks(state.cameraSession.stream); state.cameraSession = null; }
  if (state.audioDeviceSession) { stopAudioDeviceTest(state.audioDeviceSession); state.audioDeviceSession = null; }
  if (state.voiceDraft) { state.voiceDraft.modal?.querySelector('audio')?.pause(); URL.revokeObjectURL(state.voiceDraft.previewUrl); state.voiceDraft = null; }
}
function cancelComposerRecording() {
  const wasRecording = Boolean(state.voiceRecording || state.recordingOpening);
  state.recordingOpening = null;
  const recording = state.voiceRecording;
  if (recording) {
    recording.cancelled = true; clearTimeout(recording.timer);
    if (recording.recorder.state !== 'inactive') recording.recorder.stop();
    stopTracks(recording.stream); recording.audioContext?.close?.().catch(() => {}); state.voiceRecording = null; state.recorder = null;
  }
  updateRecordingButton(false);
  if (wasRecording) composerFeedback('');
}
function updateRecordingButton(recording) {
  const button = $('record-button'); if (!button) return;
  button.classList.toggle('is-recording', recording); button.setAttribute('aria-pressed', String(recording));
  button.title = recording ? '停止录音并预览' : '录音'; button.setAttribute('aria-label', button.title);
}
async function toggleComposerRecording() {
  if ($('message-input')?.disabled) return;
  if (state.voiceRecording) { if (state.voiceRecording.recorder.state !== 'inactive') state.voiceRecording.recorder.stop(); return; }
  if (state.recordingOpening || state.voiceDraft?.sending) return;
  if (!state.active || !navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) { composerFeedback('请先选择会话；当前环境需要支持麦克风录音。'); return; }
  const opening = { id: Number(state.active.id), context: captureSendContext() }; state.recordingOpening = opening; let stream; let inputContext = null;
  try {
    const deviceId = localStorage.getItem('pulse_audio_input');
    stream = await navigator.mediaDevices.getUserMedia({ audio: deviceId ? { deviceId: { exact: deviceId } } : true });
    if (state.recordingOpening !== opening || !sameSendAccount(opening.context) || Number(state.active?.id) !== opening.id) { stopTracks(stream); return; }
    const mime = ['audio/webm;codecs=opus','audio/webm','audio/ogg;codecs=opus','audio/mp4'].find(type => MediaRecorder.isTypeSupported(type));
    if (!mime) throw Error('当前环境不支持语音录制格式。');
    let recorderStream = stream;
    const inputVolume = typeof mediaInputVolume === 'function' ? mediaInputVolume() : Number(localStorage.getItem('pulse_input_volume') || 100);
    if (inputVolume < 100 && (window.AudioContext || window.webkitAudioContext)) {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      inputContext = new AudioContextClass();
      await inputContext.resume();
      const source = inputContext.createMediaStreamSource(stream);
      const gain = inputContext.createGain();
      const destination = inputContext.createMediaStreamDestination();
      gain.gain.value = Math.max(0, Math.min(1, inputVolume / 100));
      source.connect(gain).connect(destination);
      recorderStream = destination.stream;
    }
    if (state.recordingOpening !== opening || !sameSendAccount(opening.context) || Number(state.active?.id) !== opening.id) {
      stopTracks(stream); stopTracks(recorderStream); inputContext?.close?.().catch(() => {}); return;
    }
    const recorder = new MediaRecorder(recorderStream, { mimeType: mime });
    const recording = { id: opening.id, context: opening.context, stream, recorder, recorderStream, audioContext: inputContext, chunks: [], mime: mime.split(';')[0], startedAt: Date.now(), cancelled: false };
    state.voiceRecording = recording; state.recorder = recorder;
    recorder.ondataavailable = event => { if (event.data.size) recording.chunks.push(event.data); };
    recorder.onerror = () => { cancelComposerRecording(); composerFeedback('录音中断，请检查麦克风后重试。'); };
    recorder.onstop = () => {
      clearTimeout(recording.timer); stopTracks(stream); stopTracks(recording.recorderStream); recording.audioContext?.close?.().catch(() => {});
      if (state.voiceRecording === recording) { state.voiceRecording = null; state.recorder = null; updateRecordingButton(false); composerFeedback(''); }
      if (recording.cancelled || !sameSendAccount(recording.context) || Number(state.active?.id) !== recording.id) return;
      const blob = new Blob(recording.chunks, { type: recording.mime });
      if (!blob.size) { composerFeedback('没有录到有效声音，请重试。'); return; }
      if (blob.size > 10 * 1024 * 1024) { composerFeedback('语音文件超过10MB，请缩短录音。'); return; }
      openComposerVoicePreview(blob, Math.min(300000, Math.max(1, Date.now() - recording.startedAt)), recording.id, recording.context);
    };
    recorder.start(1000); updateRecordingButton(true); composerFeedback('正在录音，再点麦克风停止；最长5分钟。');
    recording.timer = setTimeout(() => { if (recorder.state !== 'inactive') recorder.stop(); }, 300000);
  } catch (error) { stopTracks(stream); inputContext?.close?.().catch(() => {}); composerFeedback(mediaErrorText(error, '麦克风')); }
  finally { if (state.recordingOpening === opening) state.recordingOpening = null; }
}
function openComposerVoicePreview(blob, duration, conversationId, context = captureSendContext()) {
  closeFeatureModal();
  const extension = blob.type === 'audio/wav' ? 'wav' : blob.type === 'audio/mp4' ? 'm4a' : blob.type === 'audio/ogg' ? 'ogg' : 'webm';
  const draft = { conversationId, context, file: new File([blob], `voice-${Date.now()}.${extension}`, { type: blob.type }), duration, previewUrl: URL.createObjectURL(blob), sending: false, uploaded: null, requestId: `pc-voice-${crypto.randomUUID()}` };
  state.voiceDraft = draft;
  document.body.insertAdjacentHTML('beforeend', `<div class="modal-backdrop feature-modal" data-feature-modal><section class="feature-card classic-media-tool-dialog" role="dialog" aria-modal="true" aria-label="发送语音消息"><header><h2>语音消息</h2><button type="button" id="voice-cancel" aria-label="取消语音">×</button></header><p>录音时长：${Math.ceil(duration / 1000)}秒</p><audio controls src="${escapeHtml(draft.previewUrl)}"></audio><p id="voice-send-feedback" class="form-feedback" role="status"></p><footer><button type="button" id="voice-send">发送语音</button></footer></section></div>`);
  const modal = document.querySelector('[data-feature-modal]'); draft.modal = modal;
  if (typeof applyMediaOutputSettings === 'function') applyMediaOutputSettings(modal);
  const cancel = () => { if (!draft.sending) closeFeatureModal(); };
  $('voice-cancel').onclick = cancel; modal.onclick = event => { if (event.target === modal) cancel(); };
  modal.onkeydown = event => { if (event.key === 'Escape') { event.stopPropagation(); cancel(); } };
  $('voice-send').onclick = () => submitComposerVoice(draft);
}
async function submitComposerVoice(draft) {
  if (state.voiceDraft !== draft || !sameSendAccount(draft.context) || draft.sending || Number(state.active?.id) !== draft.conversationId) return;
  draft.sending = true; $('voice-send').disabled = true; $('voice-cancel').disabled = true;
  const feedback = $('voice-send-feedback');
  try {
    assertSendAccount(draft.context);
    feedback.textContent = '正在处理语音…';
    if (!draft.compatible) {
      const compatible = await PulseVoiceFormat.prepare(draft.file);
      if (state.voiceDraft !== draft || !sameSendAccount(draft.context) || Number(state.active?.id) !== draft.conversationId) return;
      draft.file = new File([compatible.blob], `voice-${Date.now()}.wav`, { type: 'audio/wav' });
      draft.duration = compatible.durationMilliseconds; draft.compatible = true;
    }
    assertSendAccount(draft.context);
    feedback.textContent = '正在发送语音…';
    if (!draft.uploaded) draft.uploaded = await uploadMedia('voice', draft.file, draft.context.token);
    if (state.voiceDraft !== draft || !sameSendAccount(draft.context) || Number(state.active?.id) !== draft.conversationId) return;
    const message = await api('/messages', { method: 'POST', authToken: draft.context.token, body: JSON.stringify({ conversation_id: draft.conversationId, type: 'voice', body: messageBodyWithReply({ url: mediaUrl(draft.uploaded.url), mime: draft.uploaded.mime, size: draft.uploaded.size, duration_ms: draft.duration }, draft.context), request_id: draft.requestId }) });
    if (sameSendAccount(draft.context) && Number(state.active?.id) === draft.conversationId) appendMessage(message);
    completeReplySend(draft.context);
    if (state.voiceDraft === draft) closeFeatureModal();
    loadConversations().catch(() => {});
  } catch (error) { if (state.voiceDraft === draft) feedback.textContent = error.message || '语音发送失败，请重试。'; }
  finally { draft.sending = false; if (state.voiceDraft === draft) { $('voice-send').disabled = false; $('voice-cancel').disabled = false; } }
}

async function openComposerCamera() {
  if ($('message-input')?.disabled) return;
  if (!state.active) { composerFeedback('请先选择会话。'); return; }
  composerFeedback('');
  closeFeatureModal();
  document.body.insertAdjacentHTML('beforeend', '<div class="modal-backdrop feature-modal" data-feature-modal><section class="feature-card classic-media-tool-dialog" role="dialog" aria-modal="true" aria-label="拍照发送"><header><h2>拍照发送</h2><button type="button" data-close-modal aria-label="关闭摄像头">×</button></header><select id="camera-select" aria-label="选择摄像头"><option value="">系统默认摄像头</option></select><video id="camera-preview" autoplay muted playsinline></video><p id="camera-feedback" class="form-feedback" role="status"></p><footer><button type="button" id="camera-retry">重新检测</button><button type="button" id="camera-capture" disabled>拍照</button></footer></section></div>');
  const camera = { id: Number(state.active.id), modal: document.querySelector('[data-feature-modal]'), generation: 0, stream: null }; state.cameraSession = camera;
  bindFeatureModal(); camera.modal.onkeydown = event => { if (event.key === 'Escape') { event.stopPropagation(); closeFeatureModal(); } };
  $('camera-retry').onclick = () => loadComposerCamera(camera);
  $('camera-select').onchange = () => { localStorage.setItem('pulse_video_input', $('camera-select').value); return loadComposerCamera(camera); };
  $('camera-capture').onclick = async () => {
    const video = $('camera-preview'); if (!video?.videoWidth || !video.videoHeight) return;
    const canvas = document.createElement('canvas'); canvas.width = video.videoWidth; canvas.height = video.videoHeight; canvas.getContext('2d').drawImage(video, 0, 0);
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
    if (state.cameraSession !== camera || Number(state.active?.id) !== camera.id) return;
    if (!blob) { $('camera-feedback').textContent = '拍照失败，请重试。'; return; }
    closeFeatureModal(); openImageSendPreview(new File([blob], `拍照-${Date.now()}.png`, { type: 'image/png' }));
  };
  await loadComposerCamera(camera);
}
async function loadComposerCamera(camera) {
  if (state.cameraSession !== camera) return;
  const generation = ++camera.generation; stopTracks(camera.stream); camera.stream = null;
  $('camera-capture').disabled = true; $('camera-feedback').textContent = '正在检测摄像头…';
  try {
    if (!navigator.mediaDevices?.getUserMedia) throw Error('当前环境不支持摄像头。');
    const deviceId = localStorage.getItem('pulse_video_input');
    const stream = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 1280 }, height: { ideal: 720 }, ...(deviceId ? { deviceId: { exact: deviceId } } : {}) }, audio: false });
    if (state.cameraSession !== camera || generation !== camera.generation) { stopTracks(stream); return; }
    camera.stream = stream;
    const devices = (await navigator.mediaDevices.enumerateDevices()).filter(device => device.kind === 'videoinput');
    if (state.cameraSession !== camera || generation !== camera.generation) return;
    const selected = stream.getVideoTracks()[0]?.getSettings().deviceId || deviceId || devices[0]?.deviceId;
    $('camera-select').innerHTML = devices.map(device => `<option value="${escapeHtml(device.deviceId)}" ${device.deviceId === selected ? 'selected' : ''}>${escapeHtml(device.label || '摄像头')}</option>`).join('') || '<option value="">系统默认摄像头</option>';
    const video = $('camera-preview'); video.srcObject = stream;
    video.onloadedmetadata = () => { if (state.cameraSession === camera && generation === camera.generation) $('camera-capture').disabled = !video.videoWidth; };
    await video.play();
    if (state.cameraSession === camera && generation === camera.generation) { $('camera-feedback').textContent = ''; $('camera-capture').disabled = !video.videoWidth; }
  } catch (error) { if (state.cameraSession === camera && generation === camera.generation) {
    stopTracks(camera.stream); camera.stream = null;
    if (error.name === 'OverconstrainedError') { localStorage.removeItem('pulse_video_input'); $('camera-feedback').textContent = '已选择的摄像头不可用，已恢复默认，请点击重新检测。'; }
    else $('camera-feedback').textContent = mediaErrorText(error, '摄像头');
  } }
}

function stopAudioDeviceTest(audio) {
  audio.generation++; stopTracks(audio.stream); audio.stream = null;
  clearInterval(audio.timer); clearTimeout(audio.stopTimer);
  if (audio.context) { audio.context.close().catch(() => {}); audio.context = null; }
}
async function openComposerAudioDevices() {
  closeFeatureModal();
  document.body.insertAdjacentHTML('beforeend', '<div class="modal-backdrop feature-modal" data-feature-modal><section class="feature-card classic-media-tool-dialog" role="dialog" aria-modal="true" aria-label="音频设备检测"><header><h2>音频设备检测</h2><button type="button" data-close-modal aria-label="关闭音频设备检测">×</button></header><p>本项目不启用实时通话；这里检测本机麦克风及扬声器。</p><label>麦克风<select id="audio-test-input"></select></label><label>扬声器／耳机<select id="audio-test-output"></select></label><meter id="audio-test-meter" min="0" max="100" value="0" aria-label="麦克风音量"></meter><p id="audio-test-feedback" class="form-feedback" role="status"></p><footer><button type="button" id="audio-test-detect">重新检测</button><button type="button" id="audio-test-mic">测试麦克风</button><button type="button" id="audio-test-speaker">测试扬声器</button></footer></section></div>');
  const audio = { modal: document.querySelector('[data-feature-modal]'), generation: 0, stream: null, context: null }; state.audioDeviceSession = audio;
  $('audio-test-mic').disabled = true; $('audio-test-speaker').disabled = true;
  bindFeatureModal(); audio.modal.onkeydown = event => { if (event.key === 'Escape') { event.stopPropagation(); closeFeatureModal(); } };
  const enumerate = async () => {
    try {
      if (!navigator.mediaDevices?.enumerateDevices) throw Error('当前环境不支持读取音频设备。');
      const devices = await navigator.mediaDevices.enumerateDevices(); if (state.audioDeviceSession !== audio) return;
      for (const [id, kind, key] of [['audio-test-input','audioinput','pulse_audio_input'],['audio-test-output','audiooutput','pulse_audio_output']]) {
        const items = devices.filter(device => device.kind === kind), selected = localStorage.getItem(key);
        $(id).innerHTML = items.map(device => `<option value="${escapeHtml(device.deviceId)}" ${selected === device.deviceId ? 'selected' : ''}>${escapeHtml(device.label || '系统默认设备')}</option>`).join('') || '<option value="">未检测到设备</option>';
        $(id).disabled = !items.length; $(id).onchange = () => localStorage.setItem(key, $(id).value);
        if (!items.some(device => device.deviceId === selected)) localStorage.setItem(key, items[0]?.deviceId || '');
      }
      $('audio-test-mic').disabled = $('audio-test-input').disabled; $('audio-test-speaker').disabled = $('audio-test-output').disabled;
    } catch (error) { if (state.audioDeviceSession === audio) $('audio-test-feedback').textContent = mediaErrorText(error, '音频设备'); }
  };
  $('audio-test-detect').onclick = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true }); stopTracks(stream);
      if (state.audioDeviceSession === audio) $('audio-test-feedback').textContent = '';
    } catch (error) { if (state.audioDeviceSession === audio) $('audio-test-feedback').textContent = mediaErrorText(error, '麦克风'); }
    if (state.audioDeviceSession === audio) await enumerate();
  };
  $('audio-test-mic').onclick = async () => {
    stopAudioDeviceTest(audio); const generation = audio.generation;
    try {
      const deviceId = $('audio-test-input').value;
      const stream = await navigator.mediaDevices.getUserMedia({ audio: deviceId ? { deviceId: { exact: deviceId } } : true });
      if (state.audioDeviceSession !== audio || generation !== audio.generation) { stopTracks(stream); return; }
      audio.stream = stream; audio.context = new AudioContext(); await audio.context.resume();
      if (state.audioDeviceSession !== audio || generation !== audio.generation) return;
      const source = audio.context.createMediaStreamSource(stream), analyser = audio.context.createAnalyser(), silent = audio.context.createGain();
      silent.gain.value = 0; source.connect(analyser).connect(silent).connect(audio.context.destination); analyser.fftSize = 256;
      const samples = new Uint8Array(analyser.fftSize); $('audio-test-feedback').textContent = '请说话，下面显示真实音量；5秒后停止。';
      audio.timer = setInterval(() => { if (state.audioDeviceSession !== audio) return; analyser.getByteTimeDomainData(samples); const rms = Math.sqrt(samples.reduce((sum, value) => sum + ((value - 128) / 128) ** 2, 0) / samples.length); $('audio-test-meter').value = Math.min(100, rms * 300); }, 100);
      audio.stopTimer = setTimeout(() => { stopAudioDeviceTest(audio); if (state.audioDeviceSession === audio) $('audio-test-feedback').textContent = '麦克风测试结束。'; }, 5000);
      await enumerate();
    } catch (error) { if (state.audioDeviceSession === audio && generation === audio.generation) { stopAudioDeviceTest(audio); $('audio-test-feedback').textContent = mediaErrorText(error, '麦克风'); } }
  };
  $('audio-test-speaker').onclick = async () => {
    stopAudioDeviceTest(audio); const generation = audio.generation;
    try {
      audio.context = new AudioContext(); const context = audio.context, sink = $('audio-test-output').value;
      if (sink && sink !== 'default') {
        if (!context.setSinkId) throw Error('当前系统不支持选择输出设备，请选择系统默认扬声器。');
        await context.setSinkId(sink);
      }
      await context.resume(); if (state.audioDeviceSession !== audio || generation !== audio.generation) return;
      const oscillator = context.createOscillator(), gain = context.createGain(); const volume = typeof mediaOutputVolume === 'function' ? mediaOutputVolume() / 100 : Number(localStorage.getItem('pulse_output_volume') || 100) / 100; gain.gain.value = .04 * Math.max(0, Math.min(1, volume)); oscillator.frequency.value = 440; oscillator.connect(gain).connect(context.destination); oscillator.start(); oscillator.stop(context.currentTime + .5);
      $('audio-test-feedback').textContent = '正在播放测试音；无声时请检查系统音量及输出设备。';
      audio.stopTimer = setTimeout(() => stopAudioDeviceTest(audio), 800);
    } catch (error) { if (state.audioDeviceSession === audio && generation === audio.generation) { stopAudioDeviceTest(audio); $('audio-test-feedback').textContent = mediaErrorText(error, '扬声器'); } }
  };
  await enumerate();
}
