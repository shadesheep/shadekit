<script setup lang="ts">
import { computed } from 'vue';
import { normalizeEnvTag } from '../account-env-view';
import type { DomainConfig } from '../types';

const props = withDefaults(defineProps<{
  env: DomainConfig;
  envKey: string;
  showAddress?: boolean;
  compact?: boolean;
}>(), { showAddress: true, compact: false });

const type = computed(() => props.env.tags?.map(normalizeEnvTag).find(Boolean));
const typeLabel = computed(() => type.value ? {
  local: '本地', test: '测试', uat: '预发', prod: '生产',
}[type.value] : '');

// 展示配置 key，保留通配符、端口和路径，不通过 URL 解析器重写匹配范围。
const address = computed(() => {
  const key = props.envKey.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
  const path = props.env.matchPath;
  return path && !key.includes('/') ? `${key}${path}` : key;
});
</script>

<template>
  <span class="env-identity" :class="{ compact }" :title="`${env.name} · ${typeLabel ? typeLabel + ' · ' : ''}${envKey}`">
    <span class="identity-heading">
      <span class="identity-name">{{ env.name }}</span>
      <span v-if="typeLabel" class="identity-type" :class="{ 'is-prod': type === 'prod' }">{{ typeLabel }}</span>
    </span>
    <span v-if="showAddress" class="identity-address">{{ address }}</span>
  </span>
</template>

<style scoped>
.env-identity {
  display: inline-flex;
  flex: 1;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
  max-width: 100%;
  line-height: 1.5;
}

.identity-heading {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: 4px 6px;
}

.identity-name {
  overflow-wrap: anywhere;
}

.identity-type {
  flex-shrink: 0;
  padding: 0 5px;
  border-radius: 4px;
  font-size: 11px;
  background: var(--identity-tag-bg, var(--surface-hover));
  color: var(--identity-secondary, var(--account-secondary));
}

.identity-type.is-prod {
  color: var(--identity-production, #b91c1c);
  background: var(--identity-tag-bg, #fef2f2);
}

[data-dt-dark] .identity-type.is-prod {
  color: var(--identity-production, #fca5a5);
  background: var(--identity-tag-bg, #3f1a1a);
}

.identity-address {
  font-size: 11px;
  color: var(--identity-secondary, var(--account-secondary));
  overflow-wrap: anywhere;
}

.compact .identity-heading { flex-wrap: nowrap; }
.compact .identity-name,
.compact .identity-address {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
