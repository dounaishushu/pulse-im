(() => {
  'use strict';
  const get = id => document.getElementById(id), bridge = window.pulseNotification;
  bridge.onContent(value => {
    get('title').textContent = value.title; get('title').classList.toggle('group', value.group === true);
    get('body').textContent = value.body; get('letter').textContent = [...value.title][0] || '聊';
    const image = get('image'); image.hidden = true; image.onload = () => { image.hidden = false; }; image.onerror = () => { image.hidden = true; };
    if (value.avatarUrl) image.src = value.avatarUrl; else image.removeAttribute('src');
  });
  for (const action of ['open', 'reply', 'close']) get(action).onclick = () => bridge.act(action);
  document.body.onmouseenter = () => bridge.act('hover'); document.body.onmouseleave = () => bridge.act('leave');
})();
