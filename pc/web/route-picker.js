/* Route names are text, never HTML. Selection remains available from cached policy. */
(function () {
  'use strict';
  window.PulseRoutePicker = Object.freeze({ open(manager) {
    document.getElementById('pulse-route-picker')?.remove();
    const backdrop = document.createElement('div'); backdrop.id = 'pulse-route-picker'; backdrop.className = 'pulse-route-backdrop';
    backdrop.innerHTML = '<section class="pulse-route-dialog" role="dialog" aria-modal="true" aria-labelledby="pulse-route-title"><header><div><h2 id="pulse-route-title">选择线路</h2><p>优先使用所选线路，连接异常时自动尝试备用线路</p></div><button type="button" data-route-close aria-label="关闭">×</button></header><div class="pulse-route-list"></div><p class="pulse-route-feedback" role="status" aria-live="polite"></p><footer><button type="button" data-route-refresh>更新线路并检测</button><button type="button" data-route-close>完成</button></footer></section>';
    const list = backdrop.querySelector('.pulse-route-list'), feedback = backdrop.querySelector('.pulse-route-feedback');
    let busy = false, closed = false;
    const render = () => {
      if (closed) return;
      const state = manager.snapshot(); list.replaceChildren();
      for (const item of state.routes) {
        const button = document.createElement('button'); button.type = 'button'; button.className = 'pulse-route-option'; button.disabled = busy;
        button.setAttribute('aria-pressed', String(item.id === state.current.id));
        const marker = document.createElement('span'); marker.className = 'pulse-route-marker'; marker.textContent = item.id === state.current.id ? '✓' : '○';
        const copy = document.createElement('span'); copy.className = 'pulse-route-copy';
        const name = document.createElement('strong'); name.textContent = item.name; copy.append(name);
        const detail = document.createElement('small'); detail.textContent = item.id === state.current.id ? '正在使用' : item.id === state.preferred ? '优先线路' : '可选线路'; copy.append(detail);
        const latency = document.createElement('span'); latency.className = 'pulse-route-latency'; latency.textContent = item.latency_ms === null ? '待检测' : item.latency_ms + ' ms';
        button.append(marker, copy, latency);
        button.onclick = async () => { if (busy) return; busy = true; render(); feedback.textContent = '正在检测并切换…'; try { await manager.select(item.id); feedback.textContent = '已切换到' + item.name; } catch (error) { feedback.textContent = error.message || '该线路暂不可用，请选择其他线路'; } finally { busy = false; render(); } };
        list.append(button);
      }
    };
    const changed = manager.onChange(render);
    const close = () => { if (closed) return; closed = true; changed(); document.removeEventListener('keydown', keydown); backdrop.remove(); };
    const keydown = e => { if (e.key === 'Escape') close(); };
    for (const button of backdrop.querySelectorAll('[data-route-close]')) button.onclick = close;
    backdrop.onclick = e => { if (e.target === backdrop) close(); };
    backdrop.querySelector('[data-route-refresh]').onclick = async () => {
      if (busy) return; busy = true; render(); feedback.textContent = '正在更新线路…';
      try { const updated = await manager.refresh(); const candidates = manager.routes.slice();
        for (let i = 0; i < candidates.length; i += 4) await Promise.allSettled(candidates.slice(i, i + 4).map(item => manager.probe(item)));
        feedback.textContent = updated ? '线路已更新，延迟仅供当前网络参考' : '暂时无法更新，仍可选择已保存线路';
      } catch { feedback.textContent = '网络暂不可用，已保留原线路'; } finally { busy = false; render(); }
    };
    document.body.append(backdrop); document.addEventListener('keydown', keydown); render(); backdrop.querySelector('[data-route-close]').focus();
    return close;
  } });
})();
