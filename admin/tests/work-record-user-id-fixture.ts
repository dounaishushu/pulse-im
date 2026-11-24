// Production records page and admin transport; isolated HTTP responses only.
import { createApp, h } from "vue";
import ElementPlus from "element-plus";
import "element-plus/dist/index.css";
import "../src/styles/theme.css";
import RecordsView from "../src/views/RecordsView.vue";
import { useSession } from "../src/stores/session";

sessionStorage.setItem("pulse.go.admin.entry", "1".repeat(64));
localStorage.setItem("pulse.go.admin.id.user.7762e6a7-684e-401b-b979-5c42ae528303", "517");
localStorage.setItem("pulse.go.admin.wire.user.517", "7762e6a7-684e-401b-b979-5c42ae528303");
const session = useSession();
await session.login("recordfixture", "AdminFixture888");
createApp({ render: () => h("main", { style: "padding:24px;max-width:100%;box-sizing:border-box" }, [h(RecordsView)]) })
  .use(ElementPlus)
  .mount("#app");
