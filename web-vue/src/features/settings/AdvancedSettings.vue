<script setup lang="ts">
import { shallowRef } from "vue";
import type { DesktopDownloadPreferences } from "../../platform/contracts";
import DesktopDownloads from "./DesktopDownloads.vue";
import DesktopRouteSettings from "../desktop/DesktopRouteSettings.vue";
import DesktopProxySettings from "../desktop/DesktopProxySettings.vue";
import DesktopUpdateSettings from "./DesktopUpdateSettings.vue";
import LegacyPreferencesImport from "./LegacyPreferencesImport.vue";
import LegacyChatImport from "./LegacyChatImport.vue";
import DesktopSystemSettings from "./DesktopSystemSettings.vue";
import { CLIENT_PLATFORM, CLIENT_VERSION } from "../../api/client";
import { useSettingsContext } from "./useSettings";
const restoredDownloads = shallowRef<DesktopDownloadPreferences>();
const {
  open,
  busy,
  location,
  local,
  toggles,
  downloads,
  limits,
  toggle,
  saveDownloads,
  exportData,
  clearCache,
} = useSettingsContext();
</script>
<template>
  <div class="vue-settings-section">
    <h3>网络与代理</h3>
    <p v-if="CLIENT_PLATFORM === 'web'">网页使用浏览器或系统的网络代理，下载位置由浏览器下载设置管理。</p>
    <template v-else>
      <DesktopRouteSettings />
      <DesktopProxySettings />
    </template>
    <button :disabled="busy" @click="clearCache">清理本地缓存</button
    ><button @click="exportData">导出本机已加载的消息和设置</button>
    <template v-if="CLIENT_PLATFORM === 'pc'">
      <LegacyPreferencesImport @download-restored="restoredDownloads = $event" />
      <LegacyChatImport />
      <DesktopDownloads :restored="restoredDownloads" />
    </template>
    <h3>自动下载媒体文件</h3>
    <fieldset v-for="scope in ['private', 'group', 'channel']" :key="scope">
      <legend>
        {{ { private: "私聊", group: "群组", channel: "频道" }[scope] }}
      </legend>
      <label
        v-for="[category, label] in [
          ['photos', '照片'],
          ['videos', '视频'],
          ['files', '文件'],
        ]"
        :key="category"
        ><input
          v-model="downloads[scope + '_' + category]"
          type="checkbox"
          @change="saveDownloads"
        />{{ label }}</label
      ><label
        >大小限制<select v-model.number="limits[scope]" @change="saveDownloads">
          <option
            v-for="value in [1, 5, 10, 50, 100, 200, 500]"
            :key="value"
            :value="value"
          >
            {{ value }} MB
          </option>
        </select></label
      >
    </fieldset>
    <label
      v-for="[key, label] in toggles.advanced"
      :key="key"
      class="vue-toggle"
      ><input
        :checked="local[key]"
        type="checkbox"
        @change="toggle(key, ($event.target as HTMLInputElement).checked)"
      /><span>{{ label }}</span></label
    >
    <DesktopSystemSettings v-if="CLIENT_PLATFORM === 'pc'" />
    <section v-else>
      <h3>系统集成</h3>
      <label
        v-for="label in [
          '显示托盘图标',
          '显示任务栏图标',
          '开机自动启动',
          '在发送到菜单显示',
          '自动更新客户端',
        ]"
        :key="label"
        ><input type="checkbox" disabled />{{
          label
        }}（适用于电脑安装版）</label
      ><label
        ><input
          type="checkbox"
          disabled
        />下载前询问保存目录（由浏览器下载设置管理）</label
      >
    </section>
    <button @click="open('media')">音频设备设置</button>
    <DesktopUpdateSettings v-if="CLIENT_PLATFORM === 'pc'" />
    <template v-else>
      <p>版本 {{ CLIENT_VERSION }} · 浏览器自动加载已发布网页</p>
      <button type="button" @click="location.reload()">检查并加载新版</button>
    </template>
  </div>
</template>
