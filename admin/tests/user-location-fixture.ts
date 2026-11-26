import { createApp, h } from "vue";
import ElementPlus from "element-plus";
import "element-plus/dist/index.css";
import "../src/styles/theme.css";
import UsersView from "../src/views/UsersView.vue";
import { useSession } from "../src/stores/session";

sessionStorage.setItem("pulse.go.admin.entry", "a".repeat(64));
await useSession().login("location_fixture", "LocationFixture888");
createApp({ render: () => h("main", { style: "padding:20px" }, h(UsersView)) })
  .use(ElementPlus).mount("#app");
