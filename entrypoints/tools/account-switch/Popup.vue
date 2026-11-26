<script setup lang="ts">
// Popup 入口：复用 SwitcherPanel 的所有逻辑
// 当前网页由 utils/env.ts 查询；后台也按活动标签页返回公共账号投影。
import SwitcherPanel from './SwitcherPanel.vue';
</script>

<template>
  <SwitcherPanel class="account-popup-panel" />
</template>

<style scoped>
.account-popup-panel {
  box-sizing: border-box;
  margin: 0 4px;
  padding: 8px;
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
}
</style>
