import { createApp, h, shallowRef } from "vue";
import "./styles/theme.css";
const status = shallowRef("正在打开专属入口…");
function openEntry() {
  const fragment = location.hash.slice(1);
  const token = fragment.startsWith("entry=") ? fragment.slice(6) : fragment;
  history.replaceState(null, "", "/entry/");
  if (!/^[a-f0-9]{64}$/.test(token)) {
    status.value = "入口无效，请使用机器人提供的完整专属链接。";
    return;
  }
  try {
    sessionStorage.setItem("pulse.go.admin.entry", token);
    location.replace("/");
  } catch {
    status.value = "浏览器未允许保存入口，请检查隐私设置后重试。";
  }
}
createApp({
  setup: () => () =>
    h("main", { class: "entry-page" }, [
      h("section", { class: "art-card" }, [
        h("h1", "验证后台入口"),
        h("p", { role: "status" }, status.value),
      ]),
    ]),
}).mount("#app");
window.addEventListener("hashchange", openEntry);
openEntry();
