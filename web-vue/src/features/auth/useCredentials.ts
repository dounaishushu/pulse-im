import platform from "virtual:pulse-platform";
import { computed, onScopeDispose, reactive, shallowRef, watch } from "vue";
import { messageOf, request } from "../../api/client";
import type { ApiError, Challenge, LoginResult } from "../../api/client";

export function useCredentials(
  requireAvatar: () => boolean,
  accepted: (result: LoginResult) => void,
  sessionBusy: () => boolean = () => false,
) {
  const rememberPassword = shallowRef(true);
  const form = reactive({
    account: "",
    password: "",
    confirm: "",
    nickname: "",
    code: "",
    secondFactor: "",
  });
  const registering = shallowRef(false),
    busy = shallowRef(false),
    error = shallowRef(""),
    showPassword = shallowRef(false),
    showConfirm = shallowRef(false),
    twoStep = shallowRef(false);
  const captcha = shallowRef<Challenge | null>(null),
    captchaBusy = shallowRef(false),
    avatar = shallowRef(""),
    avatarBusy = shallowRef(false);
  const canSubmit = computed(
    () =>
      !busy.value &&
      !sessionBusy() &&
      !avatarBusy.value &&
      (!registering.value || (!captchaBusy.value && !!captcha.value)),
  );
  let captchaController: AbortController | undefined,
    timer: ReturnType<typeof setTimeout> | undefined;
  let active = true,
    avatarRevision = 0,
    deadline = 0;
  async function refreshCaptcha() {
    captchaController?.abort();
    clearTimeout(timer);
    captcha.value = null;
    form.code = "";
    if (!registering.value) return;
    const controller = new AbortController();
    captchaController = controller;
    captchaBusy.value = true;
    try {
      const value = await request<Challenge>("/auth/register-challenge", {
        authToken: "",
        signal: AbortSignal.any([
          controller.signal,
          AbortSignal.timeout(12000),
        ]),
      });
      if (controller.signal.aborted || !active) return;
      if (
        !value.challenge_id ||
        !value.image_data_url.startsWith("data:image/")
      )
        throw Error("验证码加载失败，请重试。");
      captcha.value = value;
      deadline = Date.now() + Math.max(0, value.expires_in * 1000 - 2000);
      timer = setTimeout(
        () => {
          captcha.value = null;
          error.value = "验证码已过期，请刷新后再提交。";
        },
        Math.max(0, deadline - Date.now()),
      );
    } catch (cause) {
      if (active && !controller.signal.aborted) error.value = messageOf(cause);
    } finally {
      if (captchaController === controller) captchaBusy.value = false;
    }
  }
  watch(registering, () => {
    error.value = "";
    twoStep.value = false;
    form.confirm = "";
    form.password = "";
    showPassword.value = false;
    showConfirm.value = false;
    form.secondFactor = "";
    void refreshCaptcha();
  });
  async function chooseAvatar(file?: File) {
    const mine = ++avatarRevision;
    avatar.value = "";
    if (!file) {
      avatarBusy.value = false;
      return;
    }
    avatarBusy.value = true;
    try {
      const result = await window.PulseRegistrationAvatar.prepare(file);
      if (active && mine === avatarRevision) avatar.value = result;
    } catch (cause) {
      if (active && mine === avatarRevision) error.value = messageOf(cause);
    } finally {
      if (mine === avatarRevision) avatarBusy.value = false;
    }
  }
  async function submit() {
    if (!canSubmit.value) return;
    error.value = "";
    if (!form.account.trim() || !form.password) {
      error.value = "请输入账号和密码。";
      return;
    }
    const mode = registering.value;
    const username = /^[A-Za-z][A-Za-z0-9]{4,31}$/.test(form.account.trim());
    if (mode) {
      if (!username && !/^[0-9+ -]{6,32}$/.test(form.account.trim())) {
        error.value =
          "用户名为 5–32 位字母或数字，以字母开头；也可使用手机号。";
        return;
      }
      if (
        Array.from(form.nickname.trim()).length < 2 ||
        Array.from(form.nickname.trim()).length > 32
      ) {
        error.value = "请输入 2–32 个字符的昵称。";
        return;
      }
      if (form.password !== form.confirm) {
        error.value = "两次输入的密码不一致。";
        return;
      }
      if (
        (username
          ? new TextEncoder().encode(form.password).length
          : form.password.length) < 8 ||
        (username &&
          (new TextEncoder().encode(form.password).length > 16 ||
            !/[A-Za-z]/.test(form.password) ||
            !/[0-9]/.test(form.password) ||
            /\s/.test(form.password)))
      ) {
        error.value = "密码至少 8 位；用户名注册须为 8–16 位字母和数字组合。";
        return;
      }
      if (requireAvatar() && !avatar.value) {
        error.value = "请选择头像。";
        return;
      }
      if (!captcha.value || deadline <= Date.now()) {
        error.value = "验证码已过期，请刷新。";
        void refreshCaptcha();
        return;
      }
      if (form.code.trim().length !== 5) {
        error.value = "请输入 5 位验证码。";
        return;
      }
    }
    busy.value = true;
    const submitted = {
      account: form.account.trim(),
      password: form.password,
      remember: rememberPassword.value,
    };
    const body: Record<string, unknown> = {
      [mode && username ? "username" : "phone"]: form.account.trim(),
      password: form.password,
    };
    if (mode)
      Object.assign(body, {
        nickname: form.nickname.trim(),
        captcha_id: captcha.value!.challenge_id,
        captcha_code: form.code.trim(),
        ...(avatar.value ? { avatar_data_url: avatar.value } : {}),
      });
    else body.two_step_code = form.secondFactor;
    try {
      const result = await request<LoginResult>(
        mode ? "/auth/register" : "/auth/login",
        { method: "POST", body, authToken: "" },
      );
      if (!active) return;
      if (!result?.access_token) throw Error("登录状态获取失败，请重试。");
      if (!mode && platform.signIns) {
        void platform.signIns.save({ ...submitted, userId: result.user_id }).catch(() => {});
      }
      form.password = "";
      form.confirm = "";
      form.secondFactor = "";
      accepted(result);
    } catch (cause) {
      if (!active) return;
      error.value = messageOf(cause);
      const apiError = cause as ApiError;
      if (
        /two.?step|second.?factor/.test(apiError.code || "") ||
        /两步验证/.test(error.value)
      )
        twoStep.value = true;
      if (mode) void refreshCaptcha();
    } finally {
      if (active) busy.value = false;
    }
  }
  onScopeDispose(() => {
    active = false;
    avatarRevision++;
    captchaController?.abort();
    clearTimeout(timer);
    form.password = "";
    form.confirm = "";
    form.secondFactor = "";
  });
  return {
    form,
    registering,
    busy,
    error,
    showPassword,
    showConfirm,
    twoStep,
    captcha,
    captchaBusy,
    avatar,
    avatarBusy,
    canSubmit,
    rememberPassword,
    refreshCaptcha,
    chooseAvatar,
    submit,
  };
}
