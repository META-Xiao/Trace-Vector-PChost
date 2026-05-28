<template>
  <div class="bin-output" :style="props.status === 'live' ? { maxHeight: 'none', height: '340px' } : undefined">
    <div class="bin-head">
      <span>MCU Binout</span>
      <span class="bin-legend">
        <span class="legend-dot cc" />0xCC Image
        <span class="legend-dot dd" />0xDD Log
        <span class="legend-dot ee" />0xEE Resource
      </span>
      <button
        class="ctrl-btn"
        :class="{ on: autoScroll }"
        @click="autoScroll = !autoScroll"
        title="Auto-scroll"
      >
        <Icon icon="lucide:arrow-down-to-line" />
      </button>
      <button class="ctrl-btn" @click="clearOutput" title="Clear">
        <Icon icon="lucide:trash-2" />
      </button>
      <em :class="status">{{ statusText }}</em>
    </div>
    <div ref="bodyEl" class="bin-body">
      <!-- ═══ Live mode: minimal innerHTML render, no Vue per-byte diff ═══ -->
      <template v-if="props.status === 'live'">
        <div v-if="!liveChunk" class="bin-empty">Waiting for data...</div>
        <template v-else>
          <div class="chunk-header" :class="chunkHeaderClass(liveChunk)">
            <span>{{ chunkLabel(liveChunk) }}</span>
            <span>{{ liveChunk.bytes.length }} bytes</span>
          </div>
          <div ref="liveBodyEl" class="bin-live-hex" />
        </template>
      </template>

      <!-- ═══ Replay / offline: full Vue-rendered display with tooltips ═══ -->
      <template v-else>
        <div v-if="!displays.length" class="bin-empty">Waiting for data...</div>
        <div
          v-for="chunk in displays"
          :key="chunk.id"
          class="bin-chunk"
        >
          <div class="chunk-header" :class="chunkHeaderClass(chunk)">
            <span>{{ chunkLabel(chunk) }}</span>
            <span>{{ chunk.bytes.length }} bytes</span>
          </div>
          <div
            v-for="line in chunk.lines"
            :key="line.offset"
            class="bin-line"
            :class="lineClass(line.offset, chunk)"
            @mouseenter="hoveredLine = line"
            @mouseleave="hoveredLine = null"
          >
            <span class="bin-offset">{{ hex(line.offset, 6) }}</span>
            <span class="bin-hex">
              <span
                v-for="b in line.bytes"
                :key="b.offset"
                class="bin-byte"
                :class="byteClass(b.offset, chunk)"
                :title="byteTitle(b.offset, chunk)"
              >{{ hex(b.value, 2) }}</span>
            </span>
            <span class="bin-ascii">{{ line.ascii }}</span>
          </div>
        </div>
        <div v-if="hoveredLine" class="bin-tooltip">
          <div v-for="info in hoveredLine.tooltips" :key="info.offset">{{ info.label }}: {{ info.value }}</div>
        </div>
      </template>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onUnmounted, ref, shallowRef, watch } from 'vue';
import { Icon } from '@iconify/vue';
import { calculateChecksum } from '../serial/protocol';
import type { TelemetryFrame } from '../serial/protocol';

interface Chunk {
  bytes: Uint8Array;
  type: number;
  id: number;
}

interface LineInfo {
  offset: number;
  bytes: { offset: number; value: number }[];
  ascii: string;
  tooltips: { offset: number; label: string; value: string }[];
}

const props = defineProps<{
  status: 'offline' | 'live' | 'replay';
}>();

const statusText = computed(() => {
  if (props.status === 'replay') return 'REPLAY';
  if (props.status === 'live') return 'LIVE';
  return 'OFFLINE';
});

// ── Chunk buffer (batched via rAF) ──
const chunks = shallowRef<Chunk[]>([]);
const displays = shallowRef<ChunkDisplay[]>([]);
const liveChunk = ref<ChunkDisplay | null>(null);

let pending: Uint8Array[] = [];
let rafId = 0;
let nextId = 0;

const autoScroll = ref(true);
const bodyEl = ref<HTMLElement>();
const liveBodyEl = ref<HTMLElement>();

function flush() {
  rafId = 0;
  if (!pending.length) return;

  const batch = pending;
  pending = [];
  const newChunks: Chunk[] = batch.map(data => {
    const type = classifyFrame(data);
    return { bytes: data, type, id: nextId++ };
  });

  if (props.status === 'live') {
    const latest = newChunks[newChunks.length - 1];
    const display = buildChunkDisplay(latest);
    chunks.value = [latest];
    liveChunk.value = display;
  } else {
    chunks.value = [...chunks.value, ...newChunks];
    const rebuilt = [...displays.value];
    for (const nc of newChunks) {
      rebuilt.push(buildChunkDisplay(nc));
    }
    displays.value = rebuilt;
  }
}

function clearOutput() {
  chunks.value = [];
  displays.value = [];
  liveChunk.value = null;
}

// ── Live-mode innerHTML render (skips Vue per-byte diff entirely) ──
function buildLiveHexHTML(c: ChunkDisplay): string {
  const parts: string[] = [];
  for (const line of c.lines) {
    const off = line.offset.toString(16).toUpperCase().padStart(6, '0');
    const hexStr = line.bytes.map(b => b.value.toString(16).toUpperCase().padStart(2, '0')).join(' ');
    // Use same CSS classes for visual consistency
    const cls = lineClass(line.offset, c);
    parts.push(`<div class="bin-line ${cls}"><span class="bin-offset">${off}</span><span class="bin-hex">${hexStr}</span></div>`);
  }
  return parts.join('');
}

watch(liveChunk, () => {
  if (props.status === 'live' && liveChunk.value) {
    nextTick(() => {
      if (liveBodyEl.value) {
        liveBodyEl.value.innerHTML = buildLiveHexHTML(liveChunk.value!);
      }
      if (autoScroll.value && bodyEl.value) {
        bodyEl.value.scrollTop = bodyEl.value.scrollHeight;
      }
    });
  }
});

// Live-mode scroll on new data
watch(
  () => displays.value.length,
  () => {
    if (props.status !== 'live' && autoScroll.value) {
      nextTick(() => {
        const el = bodyEl.value;
        if (el) el.scrollTop = el.scrollHeight;
      });
    }
  },
);

// ── Frame assembly buffer ──
// Serial data arrives in arbitrary chunks (USB packets).  Accumulate bytes,
// detect complete frames by parsing the sync + 2-byte BE length header, and only
// enqueue whole frames for display.  This prevents partial-frame flicker in live mode.
const FRAME_MAX = 65536;
let frameBuffer: number[] = [];

function pushRawData(data: Uint8Array) {
  for (let i = 0; i < data.length; i++) {
    frameBuffer.push(data[i]);
  }

  let extracted = false;
  while (frameBuffer.length >= 3) {
    const sync = frameBuffer[0];
    if (sync !== 0xCC && sync !== 0xDD && sync !== 0xEE) {
      frameBuffer.shift();
      continue;
    }

    const frameLen = (frameBuffer[1] << 8) | frameBuffer[2];
    const maxLen = sync === 0xDD ? 260 : FRAME_MAX;
    if (frameLen <= 0 || frameLen > maxLen) {
      frameBuffer.shift();
      continue;
    }

    const totalLen = 3 + frameLen + 1;
    if (frameBuffer.length < totalLen) {
      break;
    }

    const frameData = new Uint8Array(frameBuffer.slice(0, totalLen));
    frameBuffer = frameBuffer.slice(totalLen);
    pending.push(frameData);
    extracted = true;
  }

  if (frameBuffer.length > 131072) {
    frameBuffer = [];
  }

  if (extracted && !rafId) {
    rafId = requestAnimationFrame(flush);
  }
}

// ── Replay: accept a parsed TelemetryFrame, serialize back to raw bytes ──
function pushFrame(frame: TelemetryFrame) {
  if (props.status === 'live') return;

  let bytes: Uint8Array;

  if (frame.type === 'IMAGE') {
    const payloadLen = frame.payload.length;
    const length = 5 + payloadLen;
    bytes = new Uint8Array(4 + length);
    bytes[0] = 0xCC;
    bytes[1] = (length >> 8) & 0xFF;
    bytes[2] = length & 0xFF;
    bytes[3] = (frame.frameId >> 8) & 0xFF;
    bytes[4] = frame.frameId & 0xFF;
    bytes[5] = frame.width;
    bytes[6] = frame.height;
    bytes[7] = frame.format;
    bytes.set(frame.payload, 8);
    bytes[bytes.length - 1] = calculateChecksum(bytes.slice(0, -1));
  } else if (frame.type === 'LOG') {
    const encoder = new TextEncoder();
    const logBytes = encoder.encode(frame.logData);
    const length = logBytes.length;
    bytes = new Uint8Array(4 + length);
    bytes[0] = 0xDD;
    bytes[1] = (length >> 8) & 0xFF;
    bytes[2] = length & 0xFF;
    bytes.set(logBytes, 3);
    bytes[bytes.length - 1] = calculateChecksum(bytes.slice(0, -1));
  } else if (frame.type === 'RESOURCE') {
    const length = frame.resData.length;
    bytes = new Uint8Array(4 + length);
    bytes[0] = 0xEE;
    bytes[1] = (length >> 8) & 0xFF;
    bytes[2] = length & 0xFF;
    bytes.set(frame.resData, 3);
    bytes[bytes.length - 1] = calculateChecksum(bytes.slice(0, -1));
  } else {
    return;
  }

  pending.push(bytes);
  if (!rafId) {
    rafId = requestAnimationFrame(flush);
  }
}

onUnmounted(() => {
  if (rafId) cancelAnimationFrame(rafId);
});

function classifyFrame(data: Uint8Array): number {
  const b = data[0];
  if (b === 0xCC || b === 0xDD || b === 0xEE) return b;
  return 0;
}

// ── Build lines for each chunk ──
interface ChunkDisplay {
  id: number;
  bytes: Uint8Array;
  type: number;
  frameNum: number;
  lines: LineInfo[];
  headerOffset: number;
  dataStart: number;
  dataEnd: number;
  checksumOffset: number;
}

function buildChunkDisplay(c: Chunk): ChunkDisplay {
  const bytes = c.bytes;
  const lines: LineInfo[] = [];

  const sync = bytes[0];
  let frameLen = 0;
  let frameNum = 0;
  let checksumOffset = -1;
  let headerEnd = 0;

  if (bytes.length >= 4 && (sync === 0xCC || sync === 0xDD || sync === 0xEE)) {
    frameLen = (bytes[1] << 8) | bytes[2];
    headerEnd = sync === 0xCC ? 8 : 3;
    if (bytes.length >= frameLen + 4 && frameLen > 0) {
      checksumOffset = frameLen + 3;
    }
    if (sync === 0xCC && bytes.length >= 5) {
      frameNum = (bytes[3] << 8) | bytes[4];
    }
  }

  const dataStart = headerEnd;
  const dataEnd = checksumOffset >= 0 ? checksumOffset : bytes.length;

  const BYTES_PER_LINE = 16;
  for (let off = 0; off < bytes.length; off += BYTES_PER_LINE) {
    const lineBytes: LineInfo['bytes'] = [];
    const tooltips: LineInfo['tooltips'] = [];
    let ascii = '';

    for (let i = 0; i < BYTES_PER_LINE && off + i < bytes.length; i++) {
      const absOff = off + i;
      const val = bytes[absOff];
      lineBytes.push({ offset: absOff, value: val });
      ascii += (val >= 0x20 && val < 0x7f) ? String.fromCharCode(val) : '.';

      if (absOff === 0 && (val === 0xCC || val === 0xDD || val === 0xEE)) {
        tooltips.push({ offset: absOff, label: 'Sync', value: `0x${val.toString(16).toUpperCase()} (${syncLabel(val)})` });
      } else if (absOff === 1 || absOff === 2) {
        tooltips.push({ offset: absOff, label: `Len[${absOff - 1}]`, value: `0x${val.toString(16).toUpperCase().padStart(2, '0')}` });
      } else if (sync === 0xCC && (absOff === 3 || absOff === 4)) {
        tooltips.push({ offset: absOff, label: `Frame[${absOff - 3}]`, value: `0x${val.toString(16).toUpperCase().padStart(2, '0')}` });
      } else if (sync === 0xCC && absOff === 5) {
        tooltips.push({ offset: absOff, label: 'Width', value: `${val}` });
      } else if (sync === 0xCC && absOff === 6) {
        tooltips.push({ offset: absOff, label: 'Height', value: `${val}` });
      } else if (sync === 0xCC && absOff === 7) {
        tooltips.push({ offset: absOff, label: 'Format', value: `0x${val.toString(16).toUpperCase().padStart(2, '0')}` });
      } else if (absOff === checksumOffset) {
        tooltips.push({ offset: absOff, label: 'Checksum', value: `0x${val.toString(16).toUpperCase().padStart(2, '0')}` });
      }
    }

    lines.push({ offset: off, bytes: lineBytes, ascii, tooltips });
  }

  return {
    id: c.id,
    bytes,
    type: sync,
    frameNum,
    lines,
    headerOffset: 0,
    dataStart,
    dataEnd,
    checksumOffset,
  };
}

function syncLabel(b: number): string {
  if (b === 0xCC) return 'Image';
  if (b === 0xDD) return 'Log';
  if (b === 0xEE) return 'Resource';
  return 'Unknown';
}

// ── Styling helpers (shared) ──
function chunkHeaderClass(c: ChunkDisplay): string {
  if (c.type === 0xCC) return 'type-cc';
  if (c.type === 0xDD) return 'type-dd';
  if (c.type === 0xEE) return 'type-ee';
  return '';
}

function chunkLabel(c: ChunkDisplay): string {
  const num = c.frameNum > 0 ? ` #${c.frameNum}` : '';
  if (c.type === 0xCC) return `FRAME 0xCC${num} — Image`;
  if (c.type === 0xDD) return `FRAME 0xDD${num} — Log`;
  if (c.type === 0xEE) return `FRAME 0xEE${num} — Resource`;
  return `RAW — ${c.bytes.length}B`;
}

function lineClass(offset: number, c: ChunkDisplay): string {
  if (offset < c.dataStart) return 'field-header';
  if (c.checksumOffset >= 0 && offset <= c.checksumOffset && offset + 16 > c.checksumOffset) return 'field-checksum';
  if (offset >= c.dataStart && offset < c.dataEnd) return 'field-data';
  return '';
}

function byteClass(offset: number, c: ChunkDisplay): string {
  if (offset === c.checksumOffset) return 'is-checksum';
  if (offset < c.dataStart) return 'is-header';
  if (offset >= c.dataStart && offset < c.dataEnd) return 'is-data';
  return '';
}

function byteTitle(offset: number, c: ChunkDisplay): string {
  if (offset === 0) return `Sync: 0x${c.bytes[0]?.toString(16).toUpperCase()}`;
  if (offset === c.checksumOffset) return 'Checksum';
  if (offset < c.dataStart) return `Header byte ${offset}`;
  if (offset >= c.dataStart && offset < c.dataEnd) return `Data byte ${offset - c.dataStart}`;
  return `Byte ${offset}`;
}

function hex(n: number, w: number): string {
  return n.toString(16).toUpperCase().padStart(w, '0');
}

// ── Tooltip (replay only) ──
const hoveredLine = ref<LineInfo | null>(null);

defineExpose({ pushRawData, pushFrame, clearOutput });
</script>

<style scoped>
.bin-output {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  background: var(--card-bg);
  border: 1px solid var(--card-border);
  box-shadow: var(--card-shadow);
  backdrop-filter: blur(22px);
  border-radius: 24px;
  padding: 18px;
  max-height: 220px;
  position: relative;
}
.bin-head {
  display: flex;
  align-items: center;
  gap: 18px;
  margin-bottom: 8px;
  color: var(--text-muted);
  font-size: 11px;
  font-weight: 900;
  letter-spacing: 0.08em;
  flex-shrink: 0;
}
.bin-head em {
  font-style: normal;
  font-size: 9px;
  padding: 1px 6px;
  border-radius: 999px;
  margin-left: auto;
}
.bin-head em.live    { background: rgba(32,184,166,.15); color: #20b8a6; }
.bin-head em.offline { background: rgba(239,68,68,.12);  color: #ef4444; }
.bin-head em.replay  { background: rgba(59,130,246,.15); color: #2563eb; }
[data-theme="dark"] .bin-head em.live    { background: rgba(74,222,128,.15); color: #4ade80; }
[data-theme="dark"] .bin-head em.offline { background: rgba(248,113,113,.15); color: #f87171; }
[data-theme="dark"] .bin-head em.replay  { background: rgba(96,165,250,.15); color: #60a5fa; }

.bin-legend {
  display: flex;
  align-items: center;
  gap: 10px;
  font-weight: 600;
  font-size: 10px;
}
.legend-dot {
  width: 8px;
  height: 8px;
  border-radius: 2px;
  display: inline-block;
  margin-right: 3px;
}
.legend-dot.cc { background: #6366f1; }
.legend-dot.dd { background: #f59e0b; }
.legend-dot.ee { background: #22c55e; }

.ctrl-btn {
  width: 22px;
  height: 22px;
  display: grid;
  place-items: center;
  border: 1px solid var(--card-border);
  border-radius: 6px;
  background: transparent;
  color: var(--text-dim);
  cursor: pointer;
  font-size: 12px;
  transition: background 150ms, color 150ms, border-color 150ms;
  flex-shrink: 0;
}
.ctrl-btn:hover { background: var(--surface); color: var(--text); }
.ctrl-btn.on { background: rgba(32,184,166,.15); color: #20b8a6; border-color: rgba(32,184,166,.3); }
[data-theme="dark"] .ctrl-btn.on { background: rgba(74,222,128,.15); color: #4ade80; border-color: rgba(74,222,128,.3); }

.bin-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  font-family: "JetBrains Mono", Consolas, monospace;
  font-size: 11px;
  line-height: 1.6;
}
.bin-empty {
  color: var(--text-dim);
  padding: 16px;
  text-align: center;
}

/* ── Live hex (innerHTML render, no Vue diff) ── */
.bin-live-hex {
  line-height: 1.6;
}

/* ── Chunk / replay display ── */
.bin-chunk {
  margin-bottom: 4px;
}
.chunk-header {
  display: flex;
  justify-content: space-between;
  padding: 2px 6px;
  border-radius: 4px;
  font-weight: 700;
  font-size: 10px;
  margin-bottom: 2px;
}
.chunk-header.type-cc { background: rgba(99,102,241,.12);  color: #6366f1; }
.chunk-header.type-dd { background: rgba(245,158,11,.12);  color: #f59e0b; }
.chunk-header.type-ee { background: rgba(34,197,94,.12);  color: #16a34a; }
[data-theme="dark"] .chunk-header.type-cc { color: #818cf8; }
[data-theme="dark"] .chunk-header.type-dd { color: #fbbf24; }
[data-theme="dark"] .chunk-header.type-ee { color: #4ade80; }

.bin-line {
  display: flex;
  gap: 12px;
  padding: 0 6px;
  border-radius: 2px;
  white-space: nowrap;
}
.bin-line.field-header  { background: rgba(99,102,241,.06); }
.bin-line.field-data    { background: transparent; }
.bin-line.field-checksum { background: rgba(239,68,68,.06); }

.bin-offset { color: var(--text-dim); min-width: 54px; flex-shrink: 0; }
.bin-hex { display: flex; gap: 2px; flex: 1; }
.bin-byte { cursor: default; min-width: 16px; text-align: center; }
.bin-byte.is-header   { color: #6366f1; font-weight: 700; }
.bin-byte.is-data     { color: var(--text); }
.bin-byte.is-checksum { color: #ef4444; font-weight: 700; }
[data-theme="dark"] .bin-byte.is-header { color: #818cf8; }
.bin-ascii { color: var(--text-dim); min-width: 120px; letter-spacing: 0.5px; }

.bin-tooltip {
  position: absolute;
  bottom: 8px;
  left: 8px;
  background: var(--card-bg);
  border: 1px solid var(--card-border);
  border-radius: 8px;
  padding: 6px 10px;
  font-size: 10px;
  font-family: "JetBrains Mono", Consolas, monospace;
  color: var(--text);
  box-shadow: var(--card-shadow);
  z-index: 10;
  pointer-events: none;
}
.bin-tooltip > div { padding: 1px 0; }
</style>
