<script setup lang="ts">
/**
 * 设置项动作行容器(ADR-0007):「清空/重置」类按钮的摆放位。
 * 按钮本身复用 shared/components/DtButton。
 *
 * 用法:
 *   <DtConfigItem label="工作状态" hint="…">
 *     <DtConfigActions>
 *       <DtButton @click="resetFields">清空已保存的字段列表</DtButton>
 *     </DtConfigActions>
 *   </DtConfigItem>
 */
</script>

<template>
  <div class="dt-config-actions">
    <slot />
  </div>
</template>

<style scoped>
.dt-config-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
</style>
