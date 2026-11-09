(() => {
  'use strict';
  const bridge = window.pulseImageWindow;
  let current = null;
  const clipboard = PulseImageClipboard.create({ context: () => ({ key: current?.id, accountId: current?.accountId, allowed: !!current }),
    write: value => bridge.copy({ ...value, id: current?.id }) });
  const viewer = PulseImageViewer.create({ context: () => ({ key: current?.id, accountId: current?.accountId,
    conversationId: current?.conversationId, messageId: current?.messageId, allowed: !!current }), listen: false,
    copyImage: (image, valid) => clipboard.copy(image, valid), canCopyImage: () => clipboard.available(), onClose: () => { void bridge.close(); } });
  function show(value) {
    if (!value?.id || value.id === current?.id) return;
    current = value;
    document.title = (value.name || '图片预览') + ' - 小猿口算';
    viewer.open(document.getElementById('image-window-origin'), { currentSrc: value.url, alt: value.name });
  }
  let incoming = 0;
  bridge.onImage(value => { incoming++; show(value); });
  const initial = incoming;
  bridge.content().then(value => { if (incoming === initial) show(value); }).catch(() => { void bridge.close(); });
})();
