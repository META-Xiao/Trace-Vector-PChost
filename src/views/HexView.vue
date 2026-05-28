<template>
  <div class="hex-page">
    <div class="hex-header">
      <p class="hex-hello">Binary file inspector</p>
      <h1>Hex Editor</h1>
    </div>

    <div class="hex-card">
      <div class="hex-toolbar">
        <button class="open-btn" @click="openFile">
          <Icon icon="lucide:folder-open" />
          <span>Open .bin file</span>
        </button>
        <input ref="fileInput" type="file" accept=".bin" style="display:none" @change="onFileSelected" />
        <template v-if="fileName">
          <span class="file-info">{{ fileName }}</span>
          <span class="file-info">{{ formatSize(fileSize) }}</span>
          <span class="file-info">{{ frameCount }} frames</span>
          <span v-if="baud" class="file-info">{{ baud }} baud</span>
        </template>
        <em v-if="!fileName" class="no-file">No file loaded</em>
      </div>

      <div class="hex-legend" v-if="fileName">
        <span class="legend-item"><span class="swatch img"></span> Image (0xCC)</span>
        <span class="legend-item"><span class="swatch log"></span> Log (0xDD)</span>
        <span class="legend-item"><span class="swatch res"></span> Resource (0xEE)</span>
        <span class="legend-item"><span class="swatch hdr"></span> Header</span>
        <span class="legend-item"><span class="swatch cs"></span> Checksum</span>
      </div>

      <div
        v-if="fileName"
        ref="gridWrap"
        class="hex-grid-wrap"
        @scroll="onScroll"
        @mousemove="onMouseMove"
        @mouseleave="tooltipVisible = false"
      >
        <div class="hex-spacer" :style="{ height: spacerHeight }">
          <div :style="{ transform: `translateY(${scrollOffset}px)` }">
            <div
              v-for="row in visibleRows"
              :key="row.key"
              class="hex-row"
              v-html="row.html"
            ></div>
          </div>
        </div>
      </div>
      <Teleport to="body">
        <div
          v-if="tooltipVisible"
          class="hex-tooltip"
          :style="{ top: tooltipY + 'px', left: tooltipX + 'px' }"
        >{{ tooltipText }}</div>
      </Teleport>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, shallowRef } from 'vue';
import { Icon } from '@iconify/vue';

// ── Constants ──
const BYTES_PER_ROW = 16;
const ROW_HEIGHT = 19.2;
const ROW_BUFFER = 10;
const MAGIC = new Uint8Array([0x54, 0x56, 0x42, 0x49, 0x4E, 0x32]); // "TVBIN2"

const SEC_NONE = 0, SEC_HEADER = 1, SEC_DATA = 2, SEC_CHECKSUM = 3;
const FT_NONE = 0, FT_IMAGE = 1, FT_LOG = 2, FT_RESOURCE = 3;

const PIX_NAMES = ['Binary1','Gray8','RGB565','RGB888','YUV422','JPEG','PNG','User'];
const CODEC_NAMES = ['RAW','RLE','HeatShrink','Tile','Patch','TileHS','PatchHS'];
const FT_LABELS = ['', 'IMAGE', 'LOG', 'RESOURCE'];

// ── Non-reactive data (never goes through Vue reactivity) ──
let rawData: Uint8Array = new Uint8Array(0);
let ftMap: Uint8Array = new Uint8Array(0);
let secMap: Uint8Array = new Uint8Array(0);

interface FrameInfo {
  start: number; end: number;
  ft: number;
  idx: number;
  ts: number;
  detail: string;
}
let frameInfos: FrameInfo[] = [];
let frameStarts: number[] = [];
let totalRows = 0;

// ── Reactive UI ──
const fileInput = ref<HTMLInputElement>();
const gridWrap = ref<HTMLElement>();
const fileName = ref('');
const fileSize = ref(0);
const baud = ref(0);
const frameCount = ref(0);

const visibleRows = shallowRef<{ key: number; html: string }[]>([]);
const spacerHeight = ref('0px');
const scrollOffset = ref(0);
let viewportH = 600;
let resizeObs: ResizeObserver | null = null;

const tooltipVisible = ref(false);
const tooltipX = ref(0);
const tooltipY = ref(0);
const tooltipText = ref('');

// ── Byte → CSS class span ──
function byteSpan(val: number, off: number): string {
  const ft = ftMap[off], sec = secMap[off];
  let cls = 'hb';
  if (ft === FT_IMAGE) cls += ' fi';
  else if (ft === FT_LOG) cls += ' fl';
  else if (ft === FT_RESOURCE) cls += ' fr';
  if (sec === SEC_HEADER) cls += ' sh';
  else if (sec === SEC_DATA) cls += ' sd';
  else if (sec === SEC_CHECKSUM) cls += ' sc';
  return `<span class="${cls}" data-o="${off}">${val.toString(16).toUpperCase().padStart(2, '0')}</span>`;
}

function renderRow(rowIdx: number): string {
  const base = rowIdx * BYTES_PER_ROW;
  let h = `<span class="ho">${base.toString(16).toUpperCase().padStart(8, '0')}</span>`;
  const end = Math.min(base + BYTES_PER_ROW, rawData.length);
  for (let i = base; i < end; i++) h += byteSpan(rawData[i], i);
  return h;
}

function updateVisible(scrollTop: number) {
  const first = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - ROW_BUFFER);
  const last = Math.min(totalRows, Math.ceil((scrollTop + viewportH) / ROW_HEIGHT) + ROW_BUFFER);
  const rows: { key: number; html: string }[] = [];
  for (let i = first; i < last; i++) rows.push({ key: i, html: renderRow(i) });
  visibleRows.value = rows;
  scrollOffset.value = first * ROW_HEIGHT;
}

function onScroll() {
  if (!gridWrap.value) return;
  updateVisible(gridWrap.value.scrollTop);
}

function findFrame(off: number): FrameInfo | null {
  let lo = 0, hi = frameStarts.length - 1;
  while (lo <= hi) {
    const m = (lo + hi) >>> 1;
    const f = frameInfos[m];
    if (off < f.start) hi = m - 1;
    else if (off >= f.end) lo = m + 1;
    else return f;
  }
  return null;
}

function secLabel(off: number): string {
  const s = secMap[off];
  if (s === SEC_HEADER) return 'Header';
  if (s === SEC_DATA) return 'Data';
  if (s === SEC_CHECKSUM) return 'Checksum';
  return '';
}

function onMouseMove(e: MouseEvent) {
  const t = e.target as HTMLElement;
  if (!t.classList.contains('hb')) { tooltipVisible.value = false; return; }
  const os = t.getAttribute('data-o');
  if (os === null) return;
  const off = parseInt(os, 10);
  const val = rawData[off], hex = val.toString(16).toUpperCase().padStart(2, '0');
  const offH = off.toString(16).toUpperCase();
  const info = findFrame(off);

  let text: string;
  if (info) {
    text = `[${FT_LABELS[info.ft]}] Frame #${info.idx + 1}  ${secLabel(off)}\nOffset 0x${offH}  |  ${hex}  (${val})\n${info.detail}`;
  } else {
    text = `No frame\nOffset 0x${offH}  |  ${hex}  (${val})`;
  }
  tooltipText.value = text;

  let tx = e.clientX + 12, ty = e.clientY - 40;
  if (tx + 340 > window.innerWidth) tx = e.clientX - 340;
  if (ty < 4) ty = e.clientY + 14;
  tooltipX.value = tx;
  tooltipY.value = ty;
  tooltipVisible.value = true;
}

// ── Single-pass frame scanner (zero per-byte allocations) ──
function scanFrames(raw: Uint8Array) {
  const len = raw.length;
  const ft = new Uint8Array(len);
  const sc = new Uint8Array(len);
  const infos: FrameInfo[] = [];
  const starts: number[] = [];
  let i = 0, idx = 0;

  while (i < len) {
    const sync = raw[i];
    let ftc: number;
    if (sync === 0xCC) ftc = FT_IMAGE;
    else if (sync === 0xDD) ftc = FT_LOG;
    else if (sync === 0xEE) ftc = FT_RESOURCE;
    else { i++; continue; }

    if (i + 4 > len) break;
    const bodyLen = (raw[i + 1] << 8) | raw[i + 2];
    const fsz = 4 + bodyLen; // sync(1)+len(2)+body+cs(1)
    if (bodyLen < 1 || i + fsz > len) { i++; continue; }

    // header: sync + length(2)
    ft[i] = ftc; sc[i] = SEC_HEADER;
    ft[i + 1] = ftc; sc[i + 1] = SEC_HEADER;
    ft[i + 2] = ftc; sc[i + 2] = SEC_HEADER;

    let detail = '';
    if (ftc === FT_IMAGE && bodyLen >= 5) {
      // frame#(2) + W(1) + H(1) + Fmt(1)
      for (let j = 3; j < 8; j++) { ft[i + j] = ftc; sc[i + j] = SEC_HEADER; }
      for (let j = 8; j < 3 + bodyLen; j++) { ft[i + j] = ftc; sc[i + j] = SEC_DATA; }
      const fid = (raw[i + 3] << 8) | raw[i + 4];
      const w = raw[i + 5], h = raw[i + 6], fmt = raw[i + 7];
      const pn = PIX_NAMES[(fmt >> 4) & 0xF] ?? String((fmt >> 4) & 0xF);
      const cn = CODEC_NAMES[fmt & 0xF] ?? String(fmt & 0xF);
      detail = `Image #${fid}  ${w}×${h}  ${pn}/${cn}  len=${bodyLen}`;
    } else if (ftc === FT_LOG) {
      for (let j = 3; j < 3 + bodyLen; j++) { ft[i + j] = ftc; sc[i + j] = SEC_DATA; }
      try {
        const txt = new TextDecoder('utf-8').decode(raw.subarray(i + 3, i + 3 + bodyLen));
        detail = `Log len=${bodyLen}: "${txt.slice(0, 60)}${txt.length > 60 ? '…' : ''}"`;
      } catch { detail = `Log len=${bodyLen}`; }
    } else {
      for (let j = 3; j < 3 + bodyLen; j++) { ft[i + j] = ftc; sc[i + j] = SEC_DATA; }
      detail = `Resource len=${bodyLen}`;
    }

    // checksum
    const cso = i + 3 + bodyLen;
    ft[cso] = ftc; sc[cso] = SEC_CHECKSUM;

    starts.push(i);
    infos.push({ start: i, end: i + fsz, ft: ftc, idx, ts: 0, detail });
    idx++;
    i += fsz;
  }

  return { ftMap: ft, secMap: sc, frameInfos: infos, frameStarts: starts, frameCount: idx };
}

// ── Timestamp assignment ──
interface ChunkMeta { byteStart: number; deltaMs: number }
function assignTS(infos: FrameInfo[], chunks: ChunkMeta[]) {
  if (chunks.length === 0) return;
  // Build cumulative time at start of each chunk
  // chunks[k].byteStart = offset in raw where chunk k starts
  // chunks[k].deltaMs = delta since previous chunk
  let ci = 0, cts = 0;
  for (const info of infos) {
    while (ci < chunks.length && info.start >= chunks[ci].byteStart) {
      cts += chunks[ci].deltaMs;
      ci++;
    }
    info.ts = cts;
    info.detail += `  @${(cts / 1000).toFixed(3)}s`;
  }
}

// ── File loading ──
function openFile() { fileInput.value?.click(); }

function onFileSelected(e: Event) {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  fileName.value = file.name;
  fileSize.value = file.size;
  const reader = new FileReader();
  reader.onload = () => parseAndDisplay(new Uint8Array(reader.result as ArrayBuffer));
  reader.readAsArrayBuffer(file);
}

function parseAndDisplay(buf: Uint8Array) {
  let raw: Uint8Array;
  const chunks: ChunkMeta[] = [];

  // ── TVBIN2 check ──
  if (buf.length >= 8 && MAGIC.every((m, i) => buf[i] === m)) {
    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    baud.value = view.getUint16(6, true) * 100;

    // Scan chunks: compute total raw size
    let total = 0, off = 8;
    const deltas: number[] = [], sizes: number[] = [];
    while (off + 4 <= buf.length) {
      const d = view.getUint16(off, true); off += 2;
      const s = view.getUint16(off, true); off += 2;
      if (off + s > buf.length) break;
      deltas.push(d); sizes.push(s);
      total += s;
      off += s;
    }

    // Concatenate chunk data
    raw = new Uint8Array(total);
    off = 8; let wp = 0;
    for (let ci = 0; ci < sizes.length; ci++) {
      off += 4; // skip delta(2) + len(2)
      chunks.push({ byteStart: wp, deltaMs: deltas[ci] });
      raw.set(buf.subarray(off, off + sizes[ci]), wp);
      wp += sizes[ci];
      off += sizes[ci];
    }
  } else {
    baud.value = 0;
    raw = buf;
  }

  // ── Frame scanning ──
  const r = scanFrames(raw);
  rawData = raw;
  ftMap = r.ftMap;
  secMap = r.secMap;
  frameInfos = r.frameInfos;
  frameStarts = r.frameStarts;
  frameCount.value = r.frameCount;
  assignTS(r.frameInfos, chunks);

  // ── Virtual scroll setup ──
  totalRows = Math.ceil(raw.length / BYTES_PER_ROW);
  const el = gridWrap.value!;
  viewportH = el.clientHeight;

  if (resizeObs) resizeObs.disconnect();
  resizeObs = new ResizeObserver(() => {
    if (gridWrap.value) {
      viewportH = gridWrap.value.clientHeight;
      updateVisible(gridWrap.value.scrollTop);
    }
  });
  resizeObs.observe(el);

  spacerHeight.value = `${totalRows * ROW_HEIGHT}px`;
  el.scrollTop = 0;
  updateVisible(0);
}

function formatSize(b: number): string {
  if (b >= 1e6) return `${(b / 1e6).toFixed(1)} MB`;
  if (b >= 1e3) return `${(b / 1e3).toFixed(1)} KB`;
  return `${b} B`;
}
</script>

<style scoped>
.hex-page {
  display: flex;
  flex-direction: column;
  gap: 18px;
  padding: 0 28px 72px;
  height: calc(100vh - 58px);
  color: var(--text);
  font-family: Inter, "Segoe UI", sans-serif;
}
.hex-header { flex-shrink: 0; }
.hex-hello { margin: 0 0 8px; color: var(--text-muted); font-size: 14px; font-weight: 800; }
.hex-header h1 { margin: 0; font-size: clamp(32px, 4vw, 48px); line-height: 1.04; letter-spacing: -0.045em; }

.hex-card {
  flex: 1; min-height: 0; display: flex; flex-direction: column;
  background: var(--card-bg); border: 1px solid var(--card-border);
  box-shadow: var(--card-shadow); backdrop-filter: blur(22px);
  border-radius: 26px; padding: 18px;
}

/* Toolbar */
.hex-toolbar { display: flex; align-items: center; gap: 12px; flex-shrink: 0; margin-bottom: 10px; }
.open-btn {
  display: flex; align-items: center; gap: 6px;
  padding: 8px 16px; border: 1px solid var(--card-border); border-radius: 10px;
  background: var(--surface); color: var(--text); font-size: 13px; font-weight: 700;
  cursor: pointer; transition: background 150ms;
}
.open-btn:hover { background: rgba(32,184,166,.12); color: #20b8a6; }
.file-info {
  font-size: 12px; font-weight: 700; color: var(--text-muted);
  background: var(--surface); padding: 3px 10px; border-radius: 999px;
}
.no-file { font-size: 12px; color: var(--text-dim); font-style: italic; margin-left: auto; }

/* Legend */
.hex-legend { display: flex; gap: 14px; flex-shrink: 0; margin-bottom: 8px; padding-bottom: 8px; border-bottom: 1px solid var(--card-border); }
.legend-item { display: flex; align-items: center; gap: 5px; font-size: 10px; font-weight: 800; color: var(--text-muted); }
.swatch { width: 12px; height: 12px; border-radius: 3px; flex-shrink: 0; }
.swatch.img { background: rgba(59,130,246,.45); }
.swatch.log { background: rgba(32,184,166,.45); }
.swatch.res { background: rgba(245,158,11,.45); }
.swatch.hdr { background: rgba(255,255,255,.18); border: 1px dashed var(--text-dim); }
.swatch.cs  { background: rgba(239,68,68,.35); }

/* Virtual scroll grid */
.hex-grid-wrap {
  flex: 1; min-height: 0; overflow: auto; border-radius: 12px;
  background: var(--surface); position: relative;
}
.hex-spacer { width: 100%; font-family: "JetBrains Mono", Consolas, monospace; font-size: 12px; line-height: 1.6; }
.hex-row { white-space: nowrap; height: 19.2px; }
</style>

<style>
/* Unscoped — innerHTML rendered byte spans */
.ho { color: var(--hex-offset, #6b7280); margin-right: 16px; user-select: none; }
.hb { display: inline-block; width: 2ch; text-align: center; margin: 0 1px; border-radius: 2px; cursor: default; color: #6b7280; }

/* Image */
.hb.fi.sh { background: rgba(59,130,246,.32); color: #bfdbfe; }
.hb.fi.sd { background: rgba(59,130,246,.14); color: #93c5fd; }
.hb.fi.sc { background: rgba(239,68,68,.30); color: #fca5a5; }
/* Log */
.hb.fl.sh { background: rgba(32,184,166,.35); color: #99f6e4; }
.hb.fl.sd { background: rgba(32,184,166,.14); color: #5eead4; }
.hb.fl.sc { background: rgba(239,68,68,.30); color: #fca5a5; }
/* Resource */
.hb.fr.sh { background: rgba(245,158,11,.35); color: #fde68a; }
.hb.fr.sd { background: rgba(245,158,11,.14); color: #fcd34d; }
.hb.fr.sc { background: rgba(239,68,68,.30); color: #fca5a5; }

.hb:hover { outline: 2px solid #fff; outline-offset: -1px; z-index: 1; position: relative; }

.hex-tooltip {
  position: fixed; background: rgba(15,23,42,.94); border: 1px solid rgba(255,255,255,.15);
  border-radius: 8px; padding: 8px 12px; color: #e2e8f0;
  font-family: "JetBrains Mono", Consolas, monospace; font-size: 11px; line-height: 1.5;
  white-space: pre; pointer-events: none; z-index: 10; max-width: 420px;
  backdrop-filter: blur(12px); box-shadow: 0 8px 24px rgba(0,0,0,.4);
}

[data-theme="dark"] .hb.fi.sh { background: rgba(96,165,250,.35); color: #dbeafe; }
[data-theme="dark"] .hb.fi.sd { background: rgba(96,165,250,.16); color: #93c5fd; }
[data-theme="dark"] .hb.fl.sh { background: rgba(74,222,128,.32); color: #bbf7d0; }
[data-theme="dark"] .hb.fl.sd { background: rgba(74,222,128,.14); color: #86efac; }
[data-theme="dark"] .hb.fr.sh { background: rgba(251,191,36,.35); color: #fef3c7; }
[data-theme="dark"] .hb.fr.sd { background: rgba(251,191,36,.16); color: #fde68a; }
</style>
