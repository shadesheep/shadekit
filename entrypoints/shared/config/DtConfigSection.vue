<script setup lang="ts">
defineProps<{
  title: string;
  description?: string;
  icon?: string;
}>();
</script>

<template>
  <section class="dt-config-section" :aria-label="title">
    <div class="dt-section-header">
      <h4 class="dt-section-title">
        <span v-if="icon" :class="[icon, 'dt-section-icon']" aria-hidden="true" />
        {{ title }}
      </h4>
      <p v-if="description" class="dt-section-description">{{ description }}</p>
    </div>
    <div class="dt-section-body"><slot /></div>
  </section>
</template>

<style scoped>
.dt-config-section {
  background: var(--config-surface);
  border: 1px solid var(--config-line);
  border-radius: 12px;
  margin-bottom: 16px;
}

.dt-section-header {
  padding: 18px 20px 14px;
  border-bottom: 1px solid var(--config-line);
}

.dt-section-title {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0;
  font-size: 14px;
  font-weight: 600;
  color: var(--config-ink);
}

.dt-section-icon {
  width: 16px;
  height: 16px;
  color: var(--config-accent);
  flex-shrink: 0;
}

.dt-section-description {
  margin: 5px 0 0;
  color: var(--config-secondary);
  font-size: 13px;
  line-height: 1.6;
}

.dt-section-body {
  padding: 0 20px;
}

@container dt-config (max-width: 560px) {
  .dt-section-header { padding: 16px; }
  .dt-section-body { padding: 0 16px; }
}
</style>
