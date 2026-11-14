import { createApp } from "vue";
import "element-plus/es/components/message/style/css";
import "element-plus/es/components/message-box/style/css";
import "element-plus/es/components/loading/style/css";
import "element-plus/theme-chalk/dark/css-vars.css";
import "./styles/theme.css";
import { router } from "./router";
import App from "./App.vue";

for (const key of ["pulse_admin_key", "pulse_admin_id", "pulse_admin_token"])
  localStorage.removeItem(key);
sessionStorage.removeItem("pulse_admin_token");
createApp(App).use(router).mount("#app");
