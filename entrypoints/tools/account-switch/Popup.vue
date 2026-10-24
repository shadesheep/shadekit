<script setup lang="ts">
// Popup 入口：复用 SwitcherPanel 的所有逻辑
// 环境差异由 utils/env.ts 自动检测（chrome-extension: protocol）
import SwitcherPanel from './SwitcherPanel.vue';
</script>

<template>
  <SwitcherPanel />
</template>
