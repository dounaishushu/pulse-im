<script setup lang="ts">
import { ref, shallowRef, onMounted, onBeforeUnmount } from "vue";
import { get, post } from "../api/client";
import { can } from "../stores/session";
import { useAction } from "../composables/useAction";
import type { RecordData, FormField } from "../domain/types";
import { platforms } from "../domain/catalog";
import PageHeader from "../components/PageHeader.vue";
import SchemaForm from "../components/SchemaForm.vue";
import ArtIcon from "../components/ArtIcon.vue";
import LinkListEditor from "../features/config/LinkListEditor.vue";
const draft = ref<RecordData>({ platform_updates: {}, mall_links: [] }),
  navigation = ref<{ name: string; url: string }[]>([]),
  tab = shallowRef("registration"),
  loading = shallowRef(false),
  error = shallowRef(""),
  action = useAction();
const { busy: saving, error: saveError } = action;
const controller = new AbortController();
const registration: FormField[] = [
  {
    key: "show_group_member_count",
    label: "客户端显示群成员人数",
    type: "switch",
    wide: true,
  },
  {
    key: "register_require_avatar",
    label: "注册必须上传头像",
    type: "switch",
    wide: true,
  },
  {
    key: "max_register_accounts_per_ip",
    label: "每个 IP 可注册的账号数量",
    type: "number",
    min: 0,
    max: 100000,
    help: "0 表示不限制；防滥用的速率限制仍由服务端执行。",
    wide: true,
  },
];
async function load() {
  loading.value = true;
  error.value = "";
  try {
    const [config, links] = await Promise.all([
      get("/admin/client-config", controller.signal),
      get("/admin/client-navigation", controller.signal),
    ]);
    if (controller.signal.aborted) return;
    draft.value = {
      ...config,
      mall_links: config.mall_links || [],
      platform_updates: Object.fromEntries(
        Object.keys(platforms).map((key) => [
          key,
          {
            latest_version: "",
            minimum_version: "",
            force_update: false,
            ...config.platform_updates?.[key],
          },
        ]),
      ),
    };
    navigation.value = links.explore_links || [];
  } catch (e: any) {
    if (e.name !== "AbortError") error.value = e.message;
  } finally {
    loading.value = false;
  }
}
function validateLinks(rows: { name: string; url: string }[]) {
  for (const row of rows) {
    if (!row.name.trim() || !row.url.trim())
      throw new Error("请完整填写入口名称和地址");
    let url: URL;
    try {
      url = new URL(row.url);
    } catch {
      throw new Error("入口地址格式不正确");
    }
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password
    )
      throw new Error("入口地址需为无嵌入凭据的 HTTP / HTTPS 链接");
  }
}
async function save() {
  if (!can("client-config", true)) return;
  await action.run(async (assertCurrent) => {
    validateLinks(draft.value.mall_links);
    validateLinks(navigation.value);
    const pc = draft.value.platform_updates.pc;
    await post("/admin/client-config", {
      ...draft.value,
      latest_version: pc.latest_version,
      force_update: pc.force_update,
      request_id: crypto.randomUUID(),
    });
    assertCurrent();
    await post("/admin/client-navigation", { explore_links: navigation.value });
    await load();
  }, "客户端配置已保存");
}
onMounted(load);
onBeforeUnmount(() => controller.abort());
</script>
<template>
  <PageHeader title="客户端配置"
    ><el-button :loading="loading" @click="load">重新加载</el-button
    ><el-button
      v-if="can('client-config', true)"
      type="primary"
      :loading="saving"
      :disabled="loading"
      @click="save"
      >保存配置</el-button
    ></PageHeader
  ><el-alert
    v-if="error"
    :title="error"
    type="error"
    :closable="false"
    class="mb-5"
  />
  <section v-loading="loading" class="art-card section-card">
    <el-tabs v-model="tab"
      ><el-tab-pane label="注册与展示" name="registration" /><el-tab-pane
        label="客户端更新"
        name="updates" /><el-tab-pane label="探索与商城" name="links"
    /></el-tabs>
    <div v-if="tab === 'registration'" class="config-registration">
      <SchemaForm
        v-model="draft"
        :fields="registration"
        :disabled="!can('client-config', true) || saving"
      />
    </div>
    <div v-else-if="tab === 'updates'">
      <div class="platform-grid">
        <article
          v-for="(label, key) in platforms"
          :key="key"
          class="platform-config"
        >
          <div class="platform-title">
            <span class="platform-icon"
              ><ArtIcon
                :name="
                  key === 'pc'
                    ? 'Monitor'
                    : key === 'web'
                      ? 'ChromeFilled'
                      : 'Iphone'
                "
                :size="22"
            /></span>
            <h3>{{ label }}</h3>
          </div>
          <el-form
            v-if="draft.platform_updates[key]"
            label-position="top"
            :disabled="!can('client-config', true) || saving"
            ><el-form-item label="最新版本号"
              ><el-input
                v-model="draft.platform_updates[key].latest_version"
                maxlength="32" /></el-form-item
            ><el-form-item label="最低兼容版本"
              ><el-input
                v-model="draft.platform_updates[key].minimum_version"
                placeholder="不强制更新可留空"
                maxlength="32" /></el-form-item
            ><el-form-item v-if="key !== 'web'" label="安装包下载地址"
              ><el-input
                v-model="draft[`${key}_download_url`]"
                placeholder="https://…"
                maxlength="2048" /></el-form-item
            ><el-form-item label="强制更新"
              ><el-switch
                v-model="
                  draft.platform_updates[key].force_update
                " /></el-form-item
          ></el-form>
        </article>
      </div>
      <el-form
        label-position="top"
        :disabled="!can('client-config', true) || saving"
        ><el-form-item label="更新说明"
          ><el-input
            v-model="draft.update_description"
            type="textarea"
            :rows="5"
            maxlength="4000"
            show-word-limit /></el-form-item
      ></el-form>
    </div>
    <div v-else>
      <LinkListEditor
        v-model="navigation"
        title="探索入口"
        :disabled="!can('client-config', true) || saving"
      /><el-divider /><LinkListEditor
        v-model="draft.mall_links"
        title="商城 / 值得买"
        :disabled="!can('client-config', true) || saving"
      />
    </div>
    <el-alert
      v-if="saveError"
      :title="saveError"
      type="error"
      :closable="false"
      class="mt-5"
    />
  </section>
</template>
<style scoped>
.config-registration {
  max-width: 650px;
  padding-top: 15px;
}
.platform-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 25px;
  margin: 25px 0;
}
.platform-config {
  padding-right: 23px;
  border-right: 1px solid var(--hairline);
}
.platform-config:last-child {
  border: 0;
  padding-right: 0;
}
.platform-title {
  display: flex;
  align-items: center;
  gap: 11px;
  margin-bottom: 25px;
}
.platform-title h3 {
  font-size: 15px;
  font-weight: 500;
}
.platform-icon {
  width: 38px;
  height: 38px;
  display: grid;
  place-items: center;
  background: var(--el-color-primary-light-9);
  color: var(--main-color);
  border-radius: 10px;
}
@media (max-width: 1250px) {
  .platform-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
  .platform-config:nth-child(2) {
    border: 0;
  }
}
@media (max-width: 600px) {
  .platform-grid {
    grid-template-columns: 1fr;
  }
  .platform-config {
    border: 0;
    border-bottom: 1px solid var(--hairline);
    padding-right: 0;
  }
}
</style>
