<!-- 极简 MCU 二进制输出：仅显示最近 8 字节，零交互，innerHTML 直绘 -->
<template>
  <div class="bin-simple">
    <div class="bin-simple-head">
      <span>MCU Binout</span>
      <em :class="status">{{ statusText }}</em>
    </div>
    <div ref="hexEl" class="bin-simple-hex">-- -- -- -- -- -- -- --<br/>-- -- -- -- -- -- -- --</div>
  </div>
</template>

<script setup lang="ts">
import { computed, onUnmounted, ref } from 'vue';
import type { TelemetryFrame } from '../serial/protocol';

const props = defineProps<{
  status: 'offline' | 'live' | 'replay';
}>();

const statusText = computed(() => {
  if (props.status === 'replay') return 'REPLAY';
  if (props.status === 'live') return 'LIVE';
  return 'OFFLINE';
});

const hexEl = ref<HTMLElement>();

const WINDOW = 16;
const ring: number[] = new Array(WINDOW).fill(0);
let pos = 0;
let rafId = 0;
let dirty = false;

function pushRawData(data: Uint8Array) {
  for (let i = 0; i < data.length; i++) {
    ring[pos] = data[i];
    pos = (pos + 1) % WINDOW;
  }
  if (!dirty) {
    dirty = true;
    rafId = requestAnimationFrame(paint);
  }
}

function paint() {
  rafId = 0;
  dirty = false;
  if (!hexEl.value) return;

  // Build the 8-byte hex string in sliding-window order
  const parts: string[] = new Array(WINDOW);
  for (let i = 0; i < WINDOW; i++) {
    const idx = (pos + i) % WINDOW;
    parts[i] = ring[idx].toString(16).toUpperCase().padStart(2, '0');
  }
  hexEl.value.innerHTML = parts.slice(0, 8).join(' ') + '<br/>' + parts.slice(8, 16).join(' ');
}

function pushFrame(frame: TelemetryFrame) {
  const bytes = serializeFrame(frame);
  pushRawData(bytes);
}

function serializeFrame(frame: TelemetryFrame): Uint8Array {
  if (frame.type === 'IMAGE') {
    const payloadLen = frame.payload.length;
    const length = 5 + payloadLen;
    const buf = new Uint8Array(1 + 2 + length + 1);
    buf[0] = 0xCC;
    buf[1] = (length >> 8) & 0xFF;
    buf[2] = length & 0xFF;
    buf[3] = (frame.frameId >> 8) & 0xFF;
    buf[4] = frame.frameId & 0xFF;
    buf[5] = frame.width;
    buf[6] = frame.height;
    buf[7] = frame.format;
    buf.set(frame.payload, 8);
    let cs = 0;
    for (let i = 1; i < buf.length - 1; i++) cs += buf[i];
    buf[buf.length - 1] = cs & 0xFF;
    return buf;
  }
  if (frame.type === 'LOG') {
    const logBytes = new TextEncoder().encode(frame.logData);
    const length = logBytes.length;
    const buf = new Uint8Array(1 + 2 + length + 1);
    buf[0] = 0xDD;
    buf[1] = (length >> 8) & 0xFF;
    buf[2] = length & 0xFF;
    buf.set(logBytes, 3);
    let cs = 0;
    for (let i = 1; i < buf.length - 1; i++) cs += buf[i];
    buf[buf.length - 1] = cs & 0xFF;
    return buf;
  }
  // RESOURCE
  const resLen = frame.resData.length;
  const buf = new Uint8Array(1 + 2 + resLen + 1);
  buf[0] = 0xEE;
  buf[1] = (resLen >> 8) & 0xFF;
  buf[2] = resLen & 0xFF;
  buf.set(frame.resData, 3);
  let cs = 0;
  for (let i = 1; i < buf.length - 1; i++) cs += buf[i];
  buf[buf.length - 1] = cs & 0xFF;
  return buf;
}

onUnmounted(() => {
  if (rafId) cancelAnimationFrame(rafId);
});

defineExpose({ pushRawData, pushFrame });
</script>

<style scoped>
.bin-simple {
  display: flex;
  flex-direction: column;
  background: var(--card-bg);
  border: 1px solid var(--card-border);
  box-shadow: var(--card-shadow);
  backdrop-filter: blur(22px);
  border-radius: 24px;
  padding: 18px;
}
.bin-simple-head {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 10px;
  color: var(--text-muted);
  font-size: 11px;
  font-weight: 900;
  letter-spacing: 0.08em;
}
.bin-simple-head em {
  font-style: normal;
  font-size: 9px;
  padding: 1px 6px;
  border-radius: 999px;
  margin-left: auto;
}
.bin-simple-head em.live    { background: rgba(32,184,166,.15); color: #20b8a6; }
.bin-simple-head em.offline { background: rgba(239,68,68,.12);  color: #ef4444; }
.bin-simple-head em.replay  { background: rgba(59,130,246,.15); color: #2563eb; }
[data-theme="dark"] .bin-simple-head em.live    { background: rgba(74,222,128,.15); color: #4ade80; }
[data-theme="dark"] .bin-simple-head em.offline { background: rgba(248,113,113,.15); color: #f87171; }
[data-theme="dark"] .bin-simple-head em.replay  { background: rgba(96,165,250,.15); color: #60a5fa; }

.bin-simple-hex {
  font-family: "JetBrains Mono", Consolas, monospace;
  font-size: 28px;
  font-weight: 700;
  letter-spacing: 0.06em;
  color: var(--text);
  line-height: 1;
}
</style>
