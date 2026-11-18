<script setup lang="ts">
import icon from "../../../../web/app-icon.png";
</script>
<template>
  <aside class="pc-auth-story" aria-label="小猿答疑">
    <div class="pc-auth-brand">
      <span class="pc-auth-mark"
        ><img :src="icon" alt="" class="pc-auth-brand-image" /></span
      ><span>小猿答疑<span class="pc-auth-brand-sub">XIAOYUAN</span></span>
    </div>
    <div class="pc-auth-story-copy">
      <span class="pc-auth-kicker">连接，从这里开始</span>
      <h2>让交流更近，<br />让协作更轻松。</h2>
      <p>与你在意的人，保持连接。</p>
    </div>
    <div class="pc-auth-scene" aria-hidden="true">
      <div class="pc-auth-orbit"></div>
      <div class="pc-auth-orbit pc-auth-orbit-inner"></div>
      <div class="pc-auth-chat-card">
        <div class="pc-auth-chat-person">
          <span class="pc-auth-mini-avatar"
            ><img :src="icon" alt="" class="pc-auth-brand-image" /></span
          ><span><strong>小猿答疑</strong><small>开启新的对话</small></span
          ><i></i>
        </div>
        <div class="pc-auth-message">你好，欢迎来到小猿答疑 👋</div>
        <div class="pc-auth-message pc-auth-message-mine">
          很高兴在这里遇见你<span>✓✓</span>
        </div>
      </div>
      <span class="pc-auth-float pc-auth-float-two"><i></i>在线，随时连接</span>
    </div>
    <div class="pc-auth-story-footer">
      <span>即时消息</span><i></i><span>群组协作</span><i></i
      ><span>多端连接</span>
    </div>
  </aside>
</template>
