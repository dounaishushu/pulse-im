<script setup lang="ts">
import { reactive, shallowRef, onBeforeUnmount } from "vue";
import { useSession } from "../stores/session";
import ArtIcon from "../components/ArtIcon.vue";
const session = useSession();
const form = reactive({ username: "", password: "" });
const busy = shallowRef(false),
  error = shallowRef(session.message.value);
const dark = shallowRef(localStorage.getItem("pulse.admin.theme") === "dark");
function theme() {
  dark.value = !dark.value;
  document.documentElement.classList.toggle("dark", dark.value);
  localStorage.setItem("pulse.admin.theme", dark.value ? "dark" : "light");
}
document.documentElement.classList.toggle("dark", dark.value);
async function submit() {
  if (busy.value || !form.username.trim() || !form.password) return;
  busy.value = true;
  error.value = "";
  try {
    await session.login(form.username.trim(), form.password);
    form.password = "";
  } catch (e: any) {
    error.value = e.message;
  } finally {
    busy.value = false;
  }
}
onBeforeUnmount(() => {
  form.password = "";
});
</script>
<template>
  <main class="login-page">
    <aside class="login-art">
      <a class="login-brand" href="/"
        ><img src="/favicon.svg" width="37" height="37" alt="" /><strong
          >脉冲</strong
        ></a
      >
      <div class="login-art-center">
        <div class="connection-art" aria-hidden="true">
          <span class="art-orbit orbit-one" /><span
            class="art-orbit orbit-two"
          /><span class="art-orbit orbit-three" />
          <div class="art-center">
            <ArtIcon name="ChatDotRound" :size="58" />
          </div>
          <span class="art-node node-one"
            ><ArtIcon name="User" :size="24" /></span
          ><span class="art-node node-two"
            ><ArtIcon name="Connection" :size="26" /></span
          ><span class="art-node node-three"
            ><ArtIcon name="Shield" :size="23" /></span
          ><span class="art-node node-four"
            ><ArtIcon name="ChatLineSquare" :size="23"
          /></span>
        </div>
      </div>
    </aside>
    <section class="login-form-side">
      <el-button
        class="login-theme"
        text
        circle
        :aria-label="dark ? '切换浅色' : '切换深色'"
        @click="theme"
        ><ArtIcon :name="dark ? 'Sunny' : 'Moon'"
      /></el-button>
      <div class="login-form-box">
        <img
          class="login-mobile-mark"
          src="/favicon.svg"
          width="40"
          height="40"
          alt="脉冲"
        />
        <h1>管理后台</h1>
        <el-form :model="form" label-position="top" @submit.prevent="submit"
          ><el-form-item label="管理员账号"
            ><el-input
              v-model="form.username"
              name="username"
              autocomplete="username"
              size="large"
              maxlength="64"
              :disabled="busy"
              ><template #prefix
                ><ArtIcon
                  name="User"
                  :size="17" /></template></el-input></el-form-item
          ><el-form-item label="密码"
            ><el-input
              v-model="form.password"
              name="password"
              type="password"
              show-password
              autocomplete="current-password"
              size="large"
              :disabled="busy"
              ><template #prefix
                ><ArtIcon
                  name="Lock"
                  :size="17" /></template></el-input></el-form-item
          ><el-alert
            v-if="error"
            :title="error"
            type="error"
            show-icon
            :closable="false"
            class="mb-5" /><el-button
            native-type="submit"
            type="primary"
            size="large"
            class="login-submit"
            :loading="busy"
            >{{ busy ? "正在验证…" : "登 录"
            }}<ArtIcon v-if="!busy" name="Right" :size="17" /></el-button
        ></el-form>
      </div>
    </section>
  </main>
</template>
<style scoped>
.login-page {
  min-height: 100vh;
  display: grid;
  grid-template-columns: 1.08fr 1fr;
  background: var(--surface);
}
.login-art {
  background: #edf3ff;
  padding: 42px 50px 27px;
  display: flex;
  flex-direction: column;
  min-height: 100vh;
  color: #2a3547;
}
.dark .login-art {
  background: #1e2940;
  color: var(--ink);
}
.login-brand {
  display: flex;
  align-items: center;
  gap: 12px;
  font-size: 23px;
}
.login-brand strong {
  font-weight: 600;
}
.login-art-center {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding-block: 32px;
}
.connection-art {
  width: 350px;
  height: 330px;
  position: relative;
  display: grid;
  place-items: center;
}
.art-orbit {
  position: absolute;
  border: 1px solid #5d87ff26;
  border-radius: 50%;
  width: 270px;
  height: 270px;
}
.orbit-two {
  width: 190px;
  height: 190px;
  border-style: dashed;
}
.orbit-three {
  width: 330px;
  height: 330px;
  opacity: 0.5;
}
.art-center {
  width: 112px;
  height: 112px;
  background: var(--main-color);
  color: white;
  border-radius: 32px;
  display: grid;
  place-items: center;
  transform: rotate(-8deg);
  box-shadow: 0 18px 35px #5d87ff24;
}
.art-node {
  position: absolute;
  display: grid;
  place-items: center;
  width: 52px;
  height: 52px;
  border-radius: 15px;
  background: var(--surface);
  color: var(--main-color);
  box-shadow: 0 5px 18px #36549b09;
}
.node-one {
  left: 40px;
  top: 36px;
}
.node-two {
  right: 6px;
  top: 135px;
  color: #13b89a;
}
.node-three {
  bottom: 10px;
  left: 140px;
  color: #ffae1f;
}
.node-four {
  left: 15px;
  bottom: 75px;
}
.login-form-side {
  display: flex;
  flex-direction: column;
  justify-content: center;
  align-items: center;
  position: relative;
  padding: 40px;
}
.login-form-box {
  width: 100%;
  max-width: 370px;
}
.login-mobile-mark {
  display: none;
}
.login-form-box h1 {
  font-size: 30px;
  font-weight: 600;
  letter-spacing: -0.8px;
  margin-bottom: 28px;
}
.login-form-box :deep(.el-form-item) {
  margin-bottom: 22px;
}
.login-form-box :deep(.el-form-item__label) {
  font-size: 13px;
}
.login-form-box :deep(.el-input__wrapper) {
  height: 45px;
  padding-inline: 13px;
}
.login-submit {
  width: 100%;
  height: 46px;
  margin-top: 8px;
  justify-content: center;
  gap: 15px;
}
.login-theme {
  position: absolute;
  top: 28px;
  right: 30px;
}
@media (max-width: 900px) {
  .login-page {
    grid-template-columns: 1fr;
  }
  .login-art {
    display: none;
  }
  .login-mobile-mark {
    display: block;
    margin-bottom: 20px;
  }
  .login-form-side {
    min-height: 100vh;
    padding: 26px;
  }
}
</style>
