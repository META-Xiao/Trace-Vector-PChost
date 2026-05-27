<template>
  <div class="log-card">
    <div class="log-title">
      {{ title }}
      <em :class="status">{{ status === 'replay' ? 'REPLAY' : status === 'live' ? 'LIVE' : 'OFFLINE' }}</em>
    </div>
    <div class="log-body">
      <div
        v-for="(log, i) in logs"
        :key="i"
        :class="['log', { warn: log.includes('WARN'), err: log.includes('ERROR') }]"
      >{{ log }}</div>
    </div>
  </div>
</template>

<script setup lang="ts">
defineProps<{ title: string; logs: string[]; status: 'offline' | 'live' | 'replay' }>();
</script>

<style scoped>
.log-card {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
}
.log-title {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
  color: var(--text-muted);
  font-size: 11px;
  font-weight: 900;
  letter-spacing: 0.08em;
  flex-shrink: 0;
}
.log-title em {
  font-style: normal;
  font-size: 9px;
  padding: 1px 6px;
  border-radius: 999px;
}
.log-title em.live    { background: rgba(32,184,166,.15); color: #20b8a6; }
.log-title em.offline { background: rgba(239,68,68,.12);  color: #ef4444; }
.log-title em.replay  { background: rgba(59,130,246,.15); color: #2563eb; }
[data-theme="dark"] .log-title em.live    { background: rgba(74,222,128,.15); color: #4ade80; }
[data-theme="dark"] .log-title em.offline { background: rgba(248,113,113,.15); color: #f87171; }
[data-theme="dark"] .log-title em.replay  { background: rgba(96,165,250,.15); color: #60a5fa; }
.log-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.log {
  padding: 3px 8px;
  border-radius: 4px;
  color: var(--text-muted);
  font-family: "JetBrains Mono", Consolas, monospace;
  font-size: 11px;
  line-height: 1.5;
  flex-shrink: 0;
}
.log.warn { color: var(--log-warn-text); background: var(--log-warn-bg); }
.log.err  { color: var(--log-err-text);  background: var(--log-err-bg); }
</style>
