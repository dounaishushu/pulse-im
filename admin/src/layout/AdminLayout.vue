<script setup lang="ts">
import {
  computed,
  shallowRef,
  watch,
  onBeforeUnmount,
  useTemplateRef,
} from "vue";
import { useRoute, useRouter } from "vue-router";
import { pages } from "../domain/catalog";
import { useSession } from "../stores/session";
import ArtIcon from "../components/ArtIcon.vue";
import { useAction } from "../composables/useAction";
const session = useSession(),
  route = useRoute(),
  router = useRouter();
const action = useAction();
const workspaceScroll = useTemplateRef<HTMLElement>("workspaceScroll");
const navigation = useTemplateRef<HTMLElement>("navigation");
const workTabs = useTemplateRef<HTMLElement>("workTabs");
const collapsed = shallowRef(false),
  mobileOpen = shallowRef(false),
  searchOpen = shallowRef(false),
  search = shallowRef(""),
  refreshKey = shallowRef(0);
const dark = shallowRef(localStorage.getItem("pulse.admin.theme") === "dark");
watch(
  dark,
  (value) => {
    document.documentElement.classList.toggle("dark", value);
    localStorage.setItem("pulse.admin.theme", value ? "dark" : "light");
  },
  { immediate: true },
);
const allowed = computed(() => pages.filter((p) => session.can(p.key)));
const groups = computed(() =>
  [...new Set(allowed.value.map((p) => p.group))].map((name) => ({
    name,
    pages: allowed.value.filter((p) => p.group === name),
  })),
);
const results = computed(() =>
  allowed.value.filter((p) =>
    (p.title + p.description).includes(search.value.trim()),
  ),
);
const tabs = shallowRef<string[]>([]);
watch(
  () => route.name,
  (name) => {
    if (name && !tabs.value.includes(String(name)))
      tabs.value = [...tabs.value, String(name)];
    mobileOpen.value = false;
  },
  { immediate: true },
);
const visibleTabs = computed(() =>
  tabs.value
    .map((key) => allowed.value.find((p) => p.key === key))
    .filter(Boolean),
);
watch(
  [() => route.name, refreshKey],
  () => {
    workspaceScroll.value?.scrollTo({ top: 0, left: 0, behavior: "instant" });
    navigation.value?.querySelector('[aria-current="page"]')?.scrollIntoView({
      block: "nearest",
      inline: "nearest",
      behavior: "instant",
    });
    workTabs.value?.querySelector(".work-tab.active")?.scrollIntoView({
      block: "nearest",
      inline: "nearest",
      behavior: "instant",
    });
  },
  { flush: "post" },
);
function navigate(key: string) {
  void router.push({ name: key });
  mobileOpen.value = false;
  searchOpen.value = false;
  search.value = "";
}
function closeTab(key: string) {
  const remaining = tabs.value.filter((t) => t !== key);
  if (!remaining.length) return;
  tabs.value = remaining;
  if (route.name === key) navigate(remaining[remaining.length - 1]);
}
function shortcut(event: KeyboardEvent) {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
    event.preventDefault();
    searchOpen.value = !searchOpen.value;
  }
}
window.addEventListener("keydown", shortcut);
onBeforeUnmount(() => window.removeEventListener("keydown", shortcut));
</script>
<template>
  <div class="admin-shell" :class="{ collapsed, 'mobile-open': mobileOpen }">
    <button
      v-if="mobileOpen"
      class="sidebar-scrim"
      aria-label="关闭导航"
      @click="mobileOpen = false"
    />
    <aside class="admin-sidebar">
      <a
        class="brand"
        href="#/dashboard"
        aria-label="脉冲管理后台"
        @click="mobileOpen = false"
        ><img src="/favicon.svg" alt="" width="34" height="34" /><span
          >脉冲</span
        ></a
      >
      <nav ref="navigation" class="side-nav" aria-label="管理导航">
        <section v-for="group in groups" :key="group.name" class="nav-group">
          <p class="nav-group-label">{{ collapsed ? "·" : group.name }}</p>
          <a
            v-for="page in group.pages"
            :key="page.key"
            :href="`#/${page.key}`"
            class="side-link"
            :class="{ active: route.name === page.key }"
            :title="collapsed ? page.title : undefined"
            :aria-current="route.name === page.key ? 'page' : undefined"
            @click="mobileOpen = false"
            ><ArtIcon :name="page.icon" /><span>{{ page.title }}</span
            ><i v-if="route.name === page.key" class="nav-current"
          /></a>
        </section>
      </nav>
    </aside>
    <div class="workspace">
      <header class="workspace-header">
        <div class="header-left">
          <el-button
            text
            circle
            class="desktop-collapse"
            aria-label="折叠导航"
            @click="collapsed = !collapsed"
            ><ArtIcon :name="collapsed ? 'Expand' : 'Fold'" /></el-button
          ><el-button
            text
            circle
            class="mobile-menu"
            aria-label="打开导航"
            @click="mobileOpen = !mobileOpen"
            ><ArtIcon name="Operation"
          /></el-button>
          <div class="breadcrumb">
            <strong>{{ route.meta.title }}</strong>
          </div>
        </div>
        <div class="header-right">
          <button
            class="global-search"
            aria-label="搜索页面"
            @click="searchOpen = true"
          >
            <ArtIcon name="Search" :size="16" /><span>搜索</span
            ><kbd>⌘ K</kbd></button
          ><span class="header-divider" /><el-tooltip content="刷新当前页面"
            ><el-button
              text
              circle
              aria-label="刷新当前页面"
              @click="refreshKey++"
              ><ArtIcon name="Refresh" /></el-button></el-tooltip
          ><el-tooltip :content="dark ? '切换浅色' : '切换深色'"
            ><el-button
              text
              circle
              :aria-label="dark ? '切换浅色' : '切换深色'"
              @click="dark = !dark"
              ><ArtIcon
                :name="dark ? 'Sunny' : 'Moon'" /></el-button></el-tooltip
          ><el-dropdown trigger="click"
            ><button class="account-button" aria-label="账号菜单">
              <el-avatar :size="34">{{
                session.account.value?.username?.slice(0, 1).toUpperCase()
              }}</el-avatar><ArtIcon name="ArrowDown" :size="12" /></button
            ><template #dropdown
              ><el-dropdown-menu
                ><el-dropdown-item disabled>{{
                  session.account.value?.username
                }}</el-dropdown-item
                ><el-dropdown-item
                  v-if="session.isSuper.value"
                  @click="navigate('admin-accounts')"
                  >后台账号管理</el-dropdown-item
                ><el-dropdown-item divided @click="action.run(session.logout)"
                  >退出登录</el-dropdown-item
                ></el-dropdown-menu
              ></template
            ></el-dropdown
          >
        </div>
      </header>
      <div ref="workTabs" class="work-tabs" aria-label="已打开页面">
        <div
          v-for="tab in visibleTabs"
          :key="tab!.key"
          class="work-tab"
          :class="{ active: route.name === tab!.key }"
        >
          <button class="work-tab-link" @click="navigate(tab!.key)">
            <ArtIcon :name="tab!.icon" :size="14" /><span>{{
              tab!.title
            }}</span>
          </button>
          <button
            v-if="visibleTabs.length > 1"
            :aria-label="`关闭${tab!.title}标签`"
            class="tab-close"
            @click="closeTab(tab!.key)"
          >
            ×
          </button>
        </div>
      </div>
      <div
        ref="workspaceScroll"
        class="workspace-scroll"
        role="region"
        aria-label="页面内容"
        tabindex="0"
      >
        <main class="workspace-main">
          <RouterView
            v-if="session.can(String(route.name))"
            v-slot="{ Component }"
            ><component
              :is="Component"
              :key="`${String(route.name)}-${refreshKey}`" /></RouterView
          ><el-empty
            v-else
            description="当前账号暂无已授权页面，请联系超级管理员分配权限"
          />
        </main>
      </div>
    </div>
    <el-dialog
      v-model="searchOpen"
      title="快速跳转"
      width="520px"
      class="command-dialog"
      ><el-input
        v-model="search"
        placeholder="搜索用户、群组、任务…"
        autofocus
        clearable
        ><template #prefix><ArtIcon name="Search" :size="17" /></template
      ></el-input>
      <div class="command-results">
        <button
          v-for="page in results"
          :key="page.key"
          @click="navigate(page.key)"
        >
          <ArtIcon :name="page.icon" />
          <div>
            <strong>{{ page.title }}</strong>
          </div>
          <ArtIcon name="ArrowRight" :size="13" /></button
        ><el-empty
          v-if="!results.length"
          description="没有找到相关页面"
          :image-size="60"
        /></div
    ></el-dialog>
  </div>
</template>
<style scoped>
.admin-shell {
  --sidebar-width: 208px;
  --header-height: 60px;
  position: fixed;
  inset: 0;
  display: flex;
  height: 100dvh;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}
.admin-shell.collapsed {
  --sidebar-width: 64px;
}
.admin-sidebar {
  position: fixed;
  z-index: 30;
  inset: 0 auto 0 0;
  width: var(--sidebar-width);
  background: var(--surface);
  display: flex;
  flex-direction: column;
  border-right: 1px solid var(--hairline);
  min-height: 0;
  overflow: hidden;
}
.brand {
  display: flex;
  align-items: center;
  gap: 10px;
  flex: 0 0 var(--header-height);
  min-height: var(--header-height);
  padding: 0 18px;
  font-size: 19px;
  letter-spacing: 1px;
  font-weight: 650;
  white-space: nowrap;
}
.brand > img {
  width: 30px;
  height: 30px;
  flex-shrink: 0;
}
.brand > span {
  line-height: 1.5;
}
.side-nav {
  padding: 4px 10px 14px;
  min-height: 0;
  overflow-y: auto;
  overflow-x: hidden;
  overscroll-behavior-y: contain;
  scrollbar-width: thin;
  scrollbar-color: transparent transparent;
  flex: 1;
}
.side-nav:hover {
  scrollbar-color: var(--el-border-color) transparent;
}
.nav-group-label {
  padding: 12px 12px 5px;
  color: var(--muted);
  font-size: 10px;
  letter-spacing: 1px;
}
.side-link {
  height: 36px;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 0 12px;
  margin: 1px 0;
  border-radius: 8px;
  color: var(--el-text-color-regular);
  font-size: 13px;
  white-space: nowrap;
  transition:
    background 0.15s,
    color 0.15s;
}
.side-link:hover {
  background: var(--hover);
  color: var(--main-color);
}
.side-link.active {
  background: var(--main-color);
  color: #fff;
  box-shadow: 0 4px 9px #5d87ff29;
}
.nav-current {
  width: 5px;
  height: 5px;
  background: #fff;
  border-radius: 50%;
  margin-left: auto;
  opacity: 0.8;
}
.workspace {
  margin-left: var(--sidebar-width);
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  height: 100%;
  overflow: hidden;
}
.workspace-header {
  flex: 0 0 var(--header-height);
  height: var(--header-height);
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 0 24px;
  background: var(--surface);
  gap: 15px;
}
.header-left,
.header-right,
.breadcrumb {
  display: flex;
  align-items: center;
  gap: 16px;
}
.breadcrumb {
  font-size: 12px;
  gap: 12px;
  color: var(--muted);
}
.breadcrumb strong {
  font-weight: 500;
  color: var(--ink);
}
.header-right {
  gap: 7px;
}
.header-divider {
  height: 22px;
  width: 1px;
  background: var(--hairline);
  margin: 0 8px;
}
.global-search {
  display: flex;
  align-items: center;
  gap: 9px;
  color: var(--muted);
  border: 0;
  background: var(--page-bg);
  padding: 8px 12px;
  font-size: 12px;
  border-radius: 7px;
}
.global-search kbd {
  font-family: inherit;
  font-size: 10px;
  margin-left: 15px;
}
.account-button {
  border: 0;
  background: transparent;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 0 0 12px;
}
.work-tabs {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 24px;
  flex: 0 0 42px;
  height: 42px;
  min-width: 0;
  background: var(--surface);
  border-block: 1px solid var(--hairline);
  overflow-x: auto;
  overflow-y: hidden;
  overscroll-behavior-x: contain;
  scrollbar-width: none;
}
.work-tab {
  border: 0;
  border-radius: 5px;
  background: transparent;
  color: var(--muted);
  font-size: 12px;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 8px 0 0;
  flex-shrink: 0;
}
.work-tab.active {
  color: var(--main-color);
  background: var(--el-color-primary-light-9);
}
.work-tab-link {
  border: 0;
  background: transparent;
  color: inherit;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 9px;
  font: inherit;
}
.tab-close {
  border: 0;
  background: transparent;
  color: inherit;
  line-height: 1;
  padding: 3px;
  font-size: 16px;
  margin-left: 6px;
  opacity: 0.6;
}
.workspace-scroll {
  flex: 1;
  min-width: 0;
  min-height: 0;
  overflow: auto;
  overscroll-behavior: contain;
  scrollbar-gutter: stable;
  outline-offset: -3px;
}
.workspace-main {
  padding: 22px 24px 8px;
  width: 100%;
  min-width: 0;
  max-width: 1840px;
  margin: 0 auto;
  container-type: inline-size;
}
.workspace-main > * {
  min-width: 0;
  max-width: 100%;
}
.mobile-menu {
  display: none;
}
.collapsed .brand {
  justify-content: center;
  padding-inline: 0;
}
.collapsed .brand > span,
.collapsed .side-link > span,
.collapsed .nav-current {
  display: none;
}
.collapsed .side-link {
  justify-content: center;
  padding: 0;
}
.collapsed .nav-group-label {
  text-align: center;
}
.command-results {
  max-height: 420px;
  overflow: auto;
  margin-top: 14px;
}
.command-results button {
  display: flex;
  align-items: center;
  gap: 13px;
  text-align: left;
  width: 100%;
  border: 0;
  border-radius: 8px;
  background: transparent;
  padding: 12px;
  color: var(--ink);
}
.command-results button:hover {
  background: var(--hover);
}
.command-results button > div {
  flex: 1;
}
.command-results strong {
  display: block;
  font-size: 13px;
  font-weight: 500;
}
@media (max-width: 1100px) {
  .admin-shell,
  .admin-shell.collapsed {
    --sidebar-width: 0px;
  }
  .collapsed .brand > span,
  .collapsed .side-link > span {
    display: block;
  }
  .collapsed .brand {
    justify-content: flex-start;
    padding-inline: 18px;
  }
  .collapsed .side-link {
    justify-content: flex-start;
    padding: 0 12px;
  }
  .collapsed .nav-group-label {
    text-align: left;
  }
  .admin-sidebar {
    width: 208px;
    transform: translateX(-100%);
    visibility: hidden;
  }
  .mobile-open .admin-sidebar {
    transform: none;
    visibility: visible;
  }
  .desktop-collapse {
    display: none;
  }
  .mobile-menu {
    display: inline-flex;
  }
  .sidebar-scrim {
    position: fixed;
    inset: 0;
    z-index: 29;
    border: 0;
    background: #101b374d;
  }
  .workspace-main {
    padding: 20px 20px 8px;
  }
  .workspace-header {
    padding: 0 20px;
  }
}
@media (max-width: 600px) {
  .global-search span,
  .global-search kbd,
  .header-divider {
    display: none;
  }
  .workspace-header {
    padding: 0 13px;
  }
  .workspace-main {
    padding: 20px 14px 8px;
  }
  .work-tabs {
    padding-inline: 14px;
  }
}
</style>
