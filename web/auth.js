/* Authentication view shared by the desktop and Web clients. Session storage stays in app.js. */
(() => {
  const pulseIcon = '<img src="./app-icon.png" alt="" aria-hidden="true" class="pc-auth-brand-image">';
  const eyeIcon = '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6Z" stroke="currentColor" stroke-width="1.5"/><circle cx="12" cy="12" r="2.5" stroke="currentColor" stroke-width="1.5"/></svg>';
  let currentDispose = null;

  function mount(options) {
    currentDispose?.();
    let registering = false;
    let busy = false;
    let disposed = false;
    let challenge = null;
    let challengeRequest = null;
    let challengeSequence = 0;
    let expiryTimer = null;
    let challengeLoading = false;
    document.body.classList.add('pc-auth-open');
    document.body.innerHTML = `
      <main class="login-shell pc-auth-shell">
        <div class="pc-auth-frame">
          <aside class="pc-auth-story" aria-label="小猿答疑">
            <div class="pc-auth-brand"><span class="pc-auth-mark">${pulseIcon}</span><span>小猿答疑<span class="pc-auth-brand-sub">XIAOYUAN</span></span></div>
            <div class="pc-auth-story-copy"><span class="pc-auth-kicker">连接，从这里开始</span><h2>让交流更近，<br>让协作更轻松。</h2><p>与你在意的人，保持连接。</p></div>
            <div class="pc-auth-scene" aria-hidden="true">
              <div class="pc-auth-orbit"></div><div class="pc-auth-orbit pc-auth-orbit-inner"></div>
              <div class="pc-auth-chat-card"><div class="pc-auth-chat-person"><span class="pc-auth-mini-avatar">${pulseIcon}</span><span><strong>小猿答疑</strong><small>开启新的对话</small></span><i></i></div><div class="pc-auth-message">你好，欢迎来到小猿答疑 👋</div><div class="pc-auth-message pc-auth-message-mine">很高兴在这里遇见你<span>✓✓</span></div></div>
              <span class="pc-auth-float pc-auth-float-one">${pulseIcon}<span>每一条消息，都有回应</span></span>
              <span class="pc-auth-float pc-auth-float-two"><i></i>在线，随时连接</span>
            </div>
            <div class="pc-auth-story-footer"><span>即时消息</span><i></i><span>群组协作</span><i></i><span>多端连接</span></div>
          </aside>
          <section class="login-card pc-auth-card" aria-labelledby="auth-title">
            <div class="pc-auth-card-top"><span class="pc-auth-compact-brand">${pulseIcon} 小猿答疑</span><span id="auth-client-label" class="pc-auth-client">电脑端</span></div>
            <div class="pc-auth-tabs" role="tablist" aria-label="账号访问方式"><button id="auth-login-tab" type="button" role="tab" aria-controls="auth-panel" aria-selected="true">登录</button><button id="auth-register-tab" type="button" role="tab" aria-controls="auth-panel" aria-selected="false" tabindex="-1">注册</button></div>
            <div id="auth-panel" role="tabpanel" aria-labelledby="auth-login-tab">
              <h1 id="auth-title">欢迎回来</h1><p id="auth-description" class="pc-auth-description">登录账号，继续你的对话。</p>
              <form id="login-form" novalidate>
                <div class="pc-auth-identity-row">
                  <label id="nickname-field" hidden>昵称<input id="nickname" autocomplete="nickname" maxlength="32" placeholder="怎么称呼你" aria-describedby="nickname-error"><span id="nickname-error" class="pc-auth-field-error"></span></label>
                  <label><span id="phone-label">用户名 / 手机号</span><input id="phone" required autocomplete="username" autocapitalize="none" spellcheck="false" maxlength="32" placeholder="请输入用户名或手机号" aria-describedby="phone-error account-hint"><span id="account-hint" class="pc-auth-field-hint" hidden>用户名为5–32位字母或数字，以字母开头；也可使用手机号注册</span><span id="phone-error" class="pc-auth-field-error"></span></label>
                </div>
                <label>密码<span class="pc-auth-password"><input id="password" required type="password" autocomplete="current-password" maxlength="128" placeholder="请输入密码" aria-describedby="password-error password-hint"><button id="password-toggle" type="button" aria-label="显示密码" aria-pressed="false">${eyeIcon}</button></span><span id="password-hint" class="pc-auth-field-hint" hidden>用户名注册：8–16位，须含字母和数字且不能有空格；手机号注册：至少8位</span><span id="password-error" class="pc-auth-field-error"></span></label>
                <label id="confirm-password-field" hidden>确认密码<span class="pc-auth-password"><input id="confirm-password" type="password" autocomplete="new-password" maxlength="128" placeholder="请再次输入密码" aria-describedby="confirm-password-error"><button id="confirm-password-toggle" type="button" aria-label="显示确认密码" aria-pressed="false">${eyeIcon}</button></span><span id="confirm-password-error" class="pc-auth-field-error"></span></label>
                <label id="captcha-field" hidden><span class="pc-auth-label-row"><span>图形验证码</span><span id="captcha-status" role="status" aria-live="polite"></span></span><span class="pc-auth-captcha-row"><input id="captcha-code" autocomplete="off" autocapitalize="characters" spellcheck="false" maxlength="5" placeholder="输入图中字符" aria-describedby="captcha-error captcha-hint"><button id="captcha-refresh" type="button" aria-label="加载验证码，点击刷新"><img id="captcha-image" alt="注册验证码图片" hidden><span id="captcha-placeholder">加载验证码</span><svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M15.6 7a6 6 0 1 0 .2 5M15.6 3.5V7h-3.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg></button></span><span id="captcha-hint" class="pc-auth-field-hint">不区分大小写，点击图片可换一张</span><span id="captcha-error" class="pc-auth-field-error"></span></label>
                <label id="two-step-field" hidden>两步验证密码或恢复码<input id="two-step-code" type="password" autocomplete="off" maxlength="128" placeholder="请输入两步验证密码或恢复码" aria-describedby="two-step-code-error"><span id="two-step-code-error" class="pc-auth-field-error"></span></label>
                <p id="login-error" class="error pc-auth-error" role="alert" aria-live="polite"></p>
                <button id="auth-submit" class="primary pc-auth-submit" type="submit"><span>登录</span><span aria-hidden="true">→</span></button>
              </form>
            </div>
            <div class="pc-auth-switch"><span id="auth-switch-copy">还没有账号？</span><button id="mode-toggle" class="mode-toggle" type="button">创建账号</button></div>
            <p class="pc-auth-bottom-note">小猿答疑 · 让沟通自然发生</p>
          </section>
        </div>
      </main>`;
    const root = document.querySelector('.pc-auth-shell');
    root.querySelector('#auth-client-label').textContent = `${options.clientLabel || (options.localPreview ? '本地测试' : options.isDesktop ? '电脑端' : '网页版')}${options.appVersion ? ` ${options.appVersion}` : ''}`;
    const byId = id => root.querySelector(`#${id}`);
    const live = () => !disposed && root.isConnected;

    function setFieldError(id, message = '') {
      const input = byId(id);
      const feedback = byId(id === 'captcha-code' ? 'captcha-error' : `${id}-error`);
      if (!input || !feedback) return;
      input.setAttribute('aria-invalid', message ? 'true' : 'false');
      feedback.textContent = message;
      feedback.hidden = !message;
    }
    function syncControls() {
      if (!live()) return;
      for (const node of root.querySelectorAll('button')) node.disabled = busy;
      byId('captcha-refresh').disabled = busy || challengeLoading;
      for (const node of root.querySelectorAll('input')) node.readOnly = busy;
      byId('auth-submit').disabled = busy || (registering && (challengeLoading || !challenge || challenge.deadline <= Date.now()));
      byId('auth-submit').classList.toggle('is-loading', busy);
      byId('auth-submit').setAttribute('aria-busy', busy ? 'true' : 'false');
      byId('auth-submit').firstElementChild.textContent = busy ? (registering ? '正在创建账号…' : '正在登录…') : (registering ? '创建账号并登录' : '登录');
    }
    function clearChallenge() {
      challengeSequence++;
      challengeRequest?.abort(); challengeRequest = null;
      clearTimeout(expiryTimer); expiryTimer = null;
      challenge = null; challengeLoading = false;
      byId('captcha-code').value = '';
    }
    async function refreshChallenge() {
      if (!live() || !registering || busy) return;
      clearChallenge();
      const sequence = challengeSequence;
      const controller = new AbortController(); challengeRequest = controller;
      const requestedAt = Date.now();
      const timeout = setTimeout(() => controller.abort(), 12000);
      challengeLoading = true;
      byId('captcha-image').hidden = true;
      byId('captcha-placeholder').hidden = false;
      byId('captcha-placeholder').textContent = '正在加载…';
      byId('captcha-status').textContent = '';
      setFieldError('captcha-code'); syncControls();
      try {
        const data = await options.request('/auth/register-challenge', { signal: controller.signal, cache: 'no-store' });
        if (!live() || !registering || sequence !== challengeSequence) return;
        if (!data || !/^[A-Za-z0-9_-]{24,128}$/.test(data.challenge_id || '') || typeof data.image_data_url !== 'string' || data.image_data_url.length > 200000 || !/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(data.image_data_url) || Number(data.code_length) !== 5) throw new Error('验证码暂时不可用，请点击重试');
        const ttl = Number(data.expires_in);
        if (!Number.isFinite(ttl) || ttl <= 0 || ttl > 600) throw new Error('验证码暂时不可用，请点击重试');
        const deadline = requestedAt + ttl * 1000;
        if (deadline <= Date.now()) throw new Error('验证码已过期，请点击刷新');
        // Do not unlock submission before the actual image has decoded.
        const decodedImage = new Image(); decodedImage.src = data.image_data_url;
        await decodedImage.decode();
        if (!live() || !registering || sequence !== challengeSequence) return;
        if (!decodedImage.naturalWidth || !decodedImage.naturalHeight || deadline <= Date.now()) throw new Error('验证码图片加载失败，请点击重试');
        challenge = { id: data.challenge_id, deadline };
        const image = byId('captcha-image');
        image.onerror = () => {
          if (!live() || sequence !== challengeSequence) return;
          challenge = null; image.hidden = true;
          byId('captcha-placeholder').hidden = false; byId('captcha-placeholder').textContent = '点击重试';
          setFieldError('captcha-code', '验证码图片加载失败，请点击重试'); syncControls();
        };
        image.src = data.image_data_url; image.hidden = false;
        byId('captcha-placeholder').hidden = true;
        byId('captcha-status').textContent = '2 分钟内有效';
        expiryTimer = setTimeout(() => {
          if (!live() || sequence !== challengeSequence) return;
          challenge = null; byId('captcha-status').textContent = '已过期';
          setFieldError('captcha-code', '验证码已过期，请点击图片刷新'); syncControls();
        }, Math.max(0, deadline - Date.now()));
      } catch (error) {
        if (!live() || !registering || sequence !== challengeSequence) return;
        byId('captcha-placeholder').textContent = '点击重试';
        setFieldError('captcha-code', error.name === 'AbortError' ? '验证码加载超时，请点击重试' : (error.message || '验证码加载失败，请点击重试'));
      } finally {
        clearTimeout(timeout);
        if (live() && sequence === challengeSequence) { challengeRequest = null; challengeLoading = false; syncControls(); }
      }
    }
    function setMode(next, focus = true) {
      if (busy || !live()) return;
      registering = Boolean(next); clearChallenge();
      root.dataset.authMode = registering ? 'register' : 'login';
      byId('auth-title').textContent = registering ? '创建你的账号' : '欢迎回来';
      byId('auth-description').textContent = registering ? '几步简单填写，开启新的对话。' : '登录账号，继续你的对话。';
      for (const id of ['nickname-field', 'confirm-password-field', 'captcha-field', 'password-hint', 'account-hint']) byId(id).hidden = !registering;
      byId('nickname').required = registering;
      byId('confirm-password').required = registering;
      byId('captcha-code').required = registering;
      byId('phone-label').textContent = '用户名 / 手机号';
      byId('phone').placeholder = '请输入用户名或手机号';
      byId('phone').inputMode = 'text';
      byId('password').autocomplete = registering ? 'new-password' : 'current-password';
      byId('password').placeholder = registering ? '设置登录密码' : '请输入密码';
      byId('password').value = ''; byId('confirm-password').value = '';
      for (const [inputId, toggleId] of [['password', 'password-toggle'], ['confirm-password', 'confirm-password-toggle']]) {
        byId(inputId).type = 'password'; byId(toggleId).setAttribute('aria-pressed', 'false');
        byId(toggleId).setAttribute('aria-label', inputId === 'password' ? '显示密码' : '显示确认密码');
      }
      byId('two-step-field').hidden = true; byId('two-step-code').value = '';
      byId('login-error').textContent = '';
      for (const id of ['nickname', 'phone', 'password', 'confirm-password', 'captcha-code', 'two-step-code']) setFieldError(id);
      byId('auth-login-tab').setAttribute('aria-selected', registering ? 'false' : 'true');
      byId('auth-register-tab').setAttribute('aria-selected', registering ? 'true' : 'false');
      byId('auth-login-tab').tabIndex = registering ? -1 : 0;
      byId('auth-register-tab').tabIndex = registering ? 0 : -1;
      byId('auth-panel').setAttribute('aria-labelledby', registering ? 'auth-register-tab' : 'auth-login-tab');
      byId('auth-switch-copy').textContent = registering ? '已经有账号？' : '还没有账号？';
      byId('mode-toggle').textContent = registering ? '立即登录' : '创建账号';
      syncControls();
      if (registering) refreshChallenge();
      if (focus) byId(registering ? 'nickname' : 'phone').focus();
    }
    function validate() {
      const errors = [];
      const phone = byId('phone').value.trim();
      const password = byId('password').value;
      const usernameRegistration = registering && /^[A-Za-z][A-Za-z0-9]{4,31}$/.test(phone);
      const passwordLength = usernameRegistration ? new TextEncoder().encode(password).length : password.length;
      if (registering && (Array.from(byId('nickname').value.trim()).length < 2 || Array.from(byId('nickname').value.trim()).length > 32)) errors.push(['nickname', '请输入 2–32 个字符的昵称']);
      if (!phone) errors.push(['phone', '请输入用户名或手机号']);
      else if (registering && !usernameRegistration && !/^[0-9+ -]{6,32}$/.test(phone)) errors.push(['phone', '用户名需5–32位，以字母开头，只含字母和数字；也可填写有效手机号']);
      if (!password) errors.push(['password', '请输入密码']);
      else if (usernameRegistration && (passwordLength < 8 || passwordLength > 16 || !/[A-Za-z]/.test(password) || !/[0-9]/.test(password) || /\s/.test(password))) errors.push(['password', '密码需8–16位，包含字母和数字，不能有空格']);
      else if (registering && password.length < 8) errors.push(['password', '密码至少需要 8 位']);
      if (registering && byId('confirm-password').value !== byId('password').value) errors.push(['confirm-password', '两次输入的密码不一致']);
      if (registering && !/^[A-Za-z0-9]{5}$/.test(byId('captcha-code').value.trim())) errors.push(['captcha-code', '请输入图中的 5 位字符']);
      if (!registering && !byId('two-step-field').hidden && !byId('two-step-code').value.trim()) errors.push(['two-step-code', '请输入两步验证密码或恢复码']);
      for (const id of ['nickname', 'phone', 'password', 'confirm-password', 'captcha-code', 'two-step-code']) setFieldError(id);
      for (const [id, message] of errors) setFieldError(id, message);
      if (errors.length) byId(errors[0][0]).focus();
      return errors.length === 0;
    }
    byId('auth-login-tab').onclick = () => setMode(false);
    byId('auth-register-tab').onclick = () => setMode(true);
    byId('mode-toggle').onclick = () => setMode(!registering);
    for (const tab of [byId('auth-login-tab'), byId('auth-register-tab')]) tab.onkeydown = event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault(); if (busy) return;
      const next = event.key === 'Home' ? false : event.key === 'End' ? true : !registering;
      setMode(next, false); byId(next ? 'auth-register-tab' : 'auth-login-tab').focus();
    };
    for (const [inputId, toggleId] of [['password', 'password-toggle'], ['confirm-password', 'confirm-password-toggle']]) byId(toggleId).onclick = () => {
      const input = byId(inputId); const visible = input.type === 'password'; input.type = visible ? 'text' : 'password';
      byId(toggleId).setAttribute('aria-pressed', visible ? 'true' : 'false');
      byId(toggleId).setAttribute('aria-label', `${visible ? '隐藏' : '显示'}${inputId === 'password' ? '密码' : '确认密码'}`);
    };
    for (const input of root.querySelectorAll('input')) input.addEventListener('input', () => setFieldError(input.id));
    byId('captcha-code').addEventListener('input', () => { byId('captcha-code').value = byId('captcha-code').value.replace(/[^a-z0-9]/gi, '').toUpperCase().slice(0, 5); });
    byId('captcha-refresh').onclick = () => refreshChallenge();
    byId('login-form').onsubmit = async event => {
      event.preventDefault(); if (busy || !live()) return;
      byId('login-error').textContent = '';
      if (!validate()) return;
      if (registering && (!challenge || challenge.deadline <= Date.now())) { setFieldError('captcha-code', '请刷新验证码后再提交'); refreshChallenge(); return; }
      const submittedMode = registering;
      const account = byId('phone').value.trim();
      const identityField = submittedMode && /^[A-Za-z][A-Za-z0-9]{4,31}$/.test(account) ? 'username' : 'phone';
      const payload = { [identityField]: account, password: byId('password').value, device_type: options.isDesktop ? 'pc' : 'web' };
      if (submittedMode) { payload.nickname = byId('nickname').value.trim(); payload.captcha_id = challenge.id; payload.captcha_code = byId('captcha-code').value.trim(); }
      else payload.two_step_code = byId('two-step-code').value;
      busy = true; syncControls();
      let submitted = false;
      try {
        if (!(await options.clientReady())) return;
        if (!live()) return;
        if (submittedMode && (!challenge || challenge.id !== payload.captcha_id || challenge.deadline <= Date.now())) throw new Error('验证码已过期，请使用新验证码重试');
        submitted = true;
        const result = await options.request(submittedMode ? '/auth/register' : '/auth/login', { method: 'POST', body: JSON.stringify(payload), signal: AbortSignal.timeout(20000) });
        if (!live()) return;
        if (!result || typeof result.access_token !== 'string' || !result.access_token) throw new Error('登录状态获取失败，请稍后重试');
        dispose();
        await options.onAuthenticated(result);
      } catch (error) {
        if (!live()) return;
        byId('login-error').textContent = error.name === 'TimeoutError' || error.name === 'AbortError'
          ? (submittedMode ? '请求超时。如账号已创建，请尝试直接登录；否则刷新验证码后重试。' : '登录请求超时，请稍后重试。')
          : (error.message || '网络连接异常，请稍后重试');
        if (!submittedMode && /两步验证/.test(error.message || '')) { byId('two-step-field').hidden = false; byId('two-step-code').focus(); }
      } finally {
        if (live()) {
          busy = false;
          if (submittedMode && (submitted || !challenge || challenge.deadline <= Date.now())) { clearChallenge(); syncControls(); refreshChallenge(); }
          else syncControls();
        }
      }
    };
    function dispose() {
      if (disposed) return;
      clearChallenge(); disposed = true;
      document.body.classList.remove('pc-auth-open');
      if (currentDispose === dispose) currentDispose = null;
    }
    currentDispose = dispose;
    setMode(false, false);
    return dispose;
  }
  window.PulseAuthView = Object.freeze({ mount });
})();
