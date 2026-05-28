<template>
  <div class="hex-page">
    <div class="hex-header">
      <p class="hex-hello">Binary file inspector</p>
      <h1>Hex Editor</h1>
    </div>

    <div class="hex-layout">
      <div class="hex-card">
        <div class="hex-toolbar">
          <button class="open-btn" @click="openFile" title="Open .bin file">
            <Icon icon="lucide:folder-open" />
          </button>
          <input ref="fileInput" type="file" accept=".bin" style="display:none" @change="onFileSelected" />
          <template v-if="fileName">
            <span class="file-info">{{ fileName }}</span>
            <span class="file-info">{{ formatSize(fileSize) }}</span>
            <span class="file-info">{{ frameCount }} frames</span>
          </template>
          <em v-if="!fileName" class="no-file">No file loaded</em>
          <button
            v-if="fileName"
            class="lock-btn"
            :class="{ on: lockMode }"
            @click="lockMode = !lockMode"
            :title="lockMode ? 'Click-to-lock (ON)' : 'Hover preview (OFF)'"
          >
            <Icon :icon="lockMode ? 'lucide:lock' : 'lucide:lock-open'" />
          </button>
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
          :class="{ 'lock-cursor': lockMode }"
          @scroll="onScroll"
          @mousemove="onMouseMove"
          @click="onClick"
          @mouseleave="onMouseLeave"
        >
          <div class="hex-spacer" :style="{ height: spacerHeight }">
            <div :style="{ transform: `translateY(${scrollOffset}px)` }">
              <div
                v-for="row in visibleRows"
                :key="row.key"
                class="hex-row"
                :class="{ 'hex-row-collapsed': row.collapsed }"
                v-html="row.html"
              ></div>
            </div>
          </div>
        </div>
      </div>

      <!-- Preview card -->
      <div v-if="previewData" class="hex-preview">
        <div class="preview-head">
          <Icon icon="lucide:image" />
          <span>Image Frame #{{ previewData.frameNum }}</span>
          <span v-if="lockMode" class="lock-badge">LOCKED</span>
        </div>
        <div class="preview-meta">
          <span>{{ previewData.width }}x{{ previewData.height }}</span>
          <span>{{ previewData.pixelFormat }}</span>
          <span>{{ previewData.codec }}</span>
          <span>{{ previewData.payloadLen }}B</span>
        </div>
        <div class="preview-body">
          <div class="preview-canvas-wrap">
            <canvas
              v-if="previewData.type === 'raw'"
              ref="previewCanvas"
              class="preview-canvas"
            ></canvas>
            <img
              v-else-if="previewData.type === 'blob'"
              :src="previewSrc"
              class="preview-img"
            />
            <div v-else class="preview-unsupported">{{ previewData.reason }}</div>
          </div>
          <div v-if="payloadHex" class="preview-payload-hex" v-html="payloadHex"></div>
        </div>
      </div>
      <div v-else-if="fileName" class="hex-preview hex-preview-empty">
        <Icon icon="lucide:mouse-pointer-click" class="empty-icon" />
        <span>Hover over an image frame to preview</span>
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
</template>

<script setup lang="ts">
import { nextTick, ref, shallowRef, watch } from 'vue';
import { Icon } from '@iconify/vue';
import { PixelFormat, Codec, parseFormat } from '../serial/protocol';
import { ImageFrameProcessor } from '../serial/image-processor';

// ── Constants ──
const BYTES_PER_ROW = 16;
const ROW_HEIGHT = 19.2;
const ROW_BUFFER = 10;
const MAGIC = new Uint8Array([0x54, 0x48, 0x45, 0x49, 0x41, 0x76, 0x31]); // "THEIAv1"
const HEADER_LEN = 13 + MAGIC.length; // owner + magic

const SEC_HEADER = 1, SEC_DATA = 2, SEC_CHECKSUM = 3;
const FT_IMAGE = 1, FT_LOG = 2, FT_RESOURCE = 3;

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

interface RowEntry { byteOff: number; label?: string }
let rowMap: RowEntry[] = [];

// ── Reactive UI ──
const fileInput = ref<HTMLInputElement>();
const gridWrap = ref<HTMLElement>();
const fileName = ref('');
const fileSize = ref(0);
const frameCount = ref(0);

const visibleRows = shallowRef<{ key: number; html: string; collapsed?: boolean }[]>([]);
const spacerHeight = ref('0px');
const scrollOffset = ref(0);
let viewportH = 600;
let resizeObs: ResizeObserver | null = null;

const tooltipVisible = ref(false);
const tooltipX = ref(0);
const tooltipY = ref(0);
const tooltipText = ref('');

// ── Preview state ──
interface PreviewData {
  type: 'raw' | 'blob' | 'unsupported';
  frameNum: number;
  width: number;
  height: number;
  pixelFormat: string;
  codec: string;
  payloadLen: number;
  reason?: string;
}
const previewData = ref<PreviewData | null>(null);
const previewSrc = ref('');
const previewCanvas = ref<HTMLCanvasElement>();
const payloadHex = ref('');
let lastPreviewFid = -1;
let previewBlobUrl: string | null = null;
let previewCache: Map<number, Uint8ClampedArray> = new Map();
let previewBlobFrames: Map<number, { mime: string; payload: Uint8Array }> = new Map();

const lockMode = ref(false);

function onMouseLeave() {
  tooltipVisible.value = false;
  if (!lockMode.value) {
    previewData.value = null;
    payloadHex.value = '';
    lastPreviewFid = -1;
  }
}

function onClick(e: MouseEvent) {
  if (!lockMode.value) return;
  const t = e.target as HTMLElement;
  if (!t.classList.contains('hb')) return;
  const os = t.getAttribute('data-o');
  if (os === null) return;
  const off = parseInt(os, 10);
  const info = findFrame(off);
  if (!info || info.ft !== FT_IMAGE) return;
  if (info.idx === lastPreviewFid && previewData.value) {
    // Click same frame again → unlock
    previewData.value = null;
    payloadHex.value = '';
    lastPreviewFid = -1;
    return;
  }
  lastPreviewFid = info.idx;
  updatePreview(info);
}

watch(lockMode, (on) => {
  if (!on) {
    previewData.value = null;
    payloadHex.value = '';
    lastPreviewFid = -1;
  }
});

// ── Image preview helpers ──

function buildPayloadHex(payload: Uint8Array): string {
  const rows: string[] = [];
  for (let i = 0; i < payload.length; i += 8) {
    const off = i.toString(16).toUpperCase().padStart(4, '0');
    const hexParts: string[] = [];
    for (let j = 0; j < 8 && i + j < payload.length; j++) {
      hexParts.push(payload[i + j].toString(16).toUpperCase().padStart(2, '0'));
    }
    rows.push(`<span class="ph-off">${off}</span> ${hexParts.join(' ')}`);
  }
  return rows.join('\n');
}

function renderToCanvas(rgba: Uint8ClampedArray, w: number, h: number) {
  nextTick(() => {
    const cvs = previewCanvas.value;
    if (!cvs) return;
    cvs.width = w; cvs.height = h;
    const ctx = cvs.getContext('2d');
    if (ctx) {
      const imgData = ctx.createImageData(w, h);
      imgData.data.set(rgba);
      ctx.putImageData(imgData, 0, 0);
    }
  });
}

function updatePreview(info: FrameInfo) {
  if (previewBlobUrl) { URL.revokeObjectURL(previewBlobUrl); previewBlobUrl = null; }

  const frameBytes = rawData.slice(info.start, info.end);
  if (frameBytes.length < 9) { previewData.value = null; payloadHex.value = ''; return; }
  const bodyLen = (frameBytes[1] << 8) | frameBytes[2];
  if (bodyLen < 5) { previewData.value = null; payloadHex.value = ''; return; }
  const w = frameBytes[5], h = frameBytes[6], fmtByte = frameBytes[7];
  const { pixelFormat, codec } = parseFormat(fmtByte);
  const pn = PIX_NAMES[pixelFormat] ?? String(pixelFormat);
  const cn = CODEC_NAMES[codec] ?? String(codec);
  const payload = frameBytes.slice(8, 8 + bodyLen - 5);
  const payloadLen = payload.length;

  payloadHex.value = buildPayloadHex(payload);

  // JPEG/PNG → blob URL (on-the-fly, small payloads)
  if (pixelFormat === PixelFormat.JPEG || pixelFormat === PixelFormat.PNG) {
    const mime = pixelFormat === PixelFormat.JPEG ? 'image/jpeg' : 'image/png';
    const blob = new Blob([payload], { type: mime });
    previewBlobUrl = URL.createObjectURL(blob);
    previewSrc.value = previewBlobUrl;
    previewData.value = { type: 'blob', frameNum: info.idx + 1, width: w, height: h, pixelFormat: pn, codec: cn, payloadLen };
    return;
  }

  // Read from pre-decode cache
  const cached = previewCache.get(info.idx);
  if (cached) {
    previewData.value = { type: 'raw', frameNum: info.idx + 1, width: w, height: h, pixelFormat: pn, codec: cn, payloadLen };
    renderToCanvas(cached, w, h);
    return;
  }

  // Try blob cache
  const blobCached = previewBlobFrames.get(info.idx);
  if (blobCached) {
    const blob = new Blob([blobCached.payload as BlobPart], { type: blobCached.mime });
    previewBlobUrl = URL.createObjectURL(blob);
    previewSrc.value = previewBlobUrl;
    previewData.value = { type: 'blob', frameNum: info.idx + 1, width: w, height: h, pixelFormat: pn, codec: cn, payloadLen };
    return;
  }

  previewData.value = {
    type: 'unsupported',
    frameNum: info.idx + 1, width: w, height: h,
    pixelFormat: pn, codec: cn, payloadLen,
    reason: `Preview not available`,
  };
}

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

function buildRowMap() {
  const entries: RowEntry[] = [];
  let byteOff = 0;

  while (byteOff < rawData.length) {
    const rowOff = Math.floor(byteOff / BYTES_PER_ROW) * BYTES_PER_ROW;
    const endOff = Math.min(rowOff + BYTES_PER_ROW, rawData.length);

    // Check if this row starts a collapsible image payload section
    const info = findFrame(rowOff);
    if (info && info.ft === FT_IMAGE) {
      const dataStart = info.start + 8;
      const dataEnd = info.end - 1;
      const dataLen = dataEnd - dataStart;
      if (dataLen > 8 && rowOff >= dataStart && rowOff + BYTES_PER_ROW <= dataEnd) {
        entries.push({ byteOff: rowOff, label: `Image payload (${dataLen} bytes)` });
        byteOff = dataEnd; // skip to checksum byte
        continue;
      }
    }

    entries.push({ byteOff: rowOff });
    byteOff = endOff;
  }

  rowMap = entries;
  totalRows = entries.length;
}

function preDecodeAllFrames() {
  previewCache = new Map();
  previewBlobFrames = new Map();
  const processor = new ImageFrameProcessor({ imageWidth: 0, imageHeight: 0, fps: 0 });

  for (let fi = 0; fi < frameInfos.length; fi++) {
    const info = frameInfos[fi];
    if (info.ft !== FT_IMAGE) continue;

    const fb = rawData.slice(info.start, info.end);
    if (fb.length < 9) continue;
    const bl = (fb[1] << 8) | fb[2];
    if (bl < 5) continue;
    const fmtByte = fb[7];
    const { pixelFormat, codec } = parseFormat(fmtByte);
    const payload = fb.slice(8, 8 + bl - 5);

    // JPEG/PNG: store payload for blob URL
    if (pixelFormat === PixelFormat.JPEG || pixelFormat === PixelFormat.PNG) {
      const mime = pixelFormat === PixelFormat.JPEG ? 'image/jpeg' : 'image/png';
      previewBlobFrames.set(info.idx, { mime, payload });
      continue;
    }

    // All other codecs: sequential decode through processor
    try {
      const result = processor.process({
        type: 'IMAGE', length: bl,
        frameId: (fb[3] << 8) | fb[4],
        width: fb[5], height: fb[6], format: fmtByte,
        pixelFormat: pixelFormat as PixelFormat,
        codec: codec as Codec, payload,
        checksum: fb[fb.length - 1],
      });
      previewCache.set(info.idx, result.pixelData);
    } catch {
      // Skip undecodable frames (e.g. Patch before first RAW, corrupted data)
    }
  }
}

function renderRow(rowIdx: number): { html: string; collapsed: boolean } {
  const entry = rowMap[rowIdx];
  if (!entry) return { html: '', collapsed: false };

  if (entry.label) {
    const offStr = entry.byteOff.toString(16).toUpperCase().padStart(8, '0');
    return {
      html: `<span class="ho">${offStr}</span><span class="hc">··· ${entry.label} ···</span>`,
      collapsed: true,
    };
  }

  const base = entry.byteOff;
  const end = Math.min(base + BYTES_PER_ROW, rawData.length);
  let h = `<span class="ho">${base.toString(16).toUpperCase().padStart(8, '0')}</span>`;
  for (let i = base; i < end; i++) h += byteSpan(rawData[i], i);
  return { html: h, collapsed: false };
}

function updateVisible(scrollTop: number) {
  const first = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - ROW_BUFFER);
  const last = Math.min(totalRows, Math.ceil((scrollTop + viewportH) / ROW_HEIGHT) + ROW_BUFFER);
  const rows: { key: number; html: string; collapsed?: boolean }[] = [];
  for (let i = first; i < last; i++) {
    const r = renderRow(i);
    rows.push({ key: i, html: r.html, collapsed: r.collapsed });
  }
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

  // Update image preview (hover mode only)
  if (!lockMode.value && info && info.ft === FT_IMAGE && info.idx !== lastPreviewFid) {
    lastPreviewFid = info.idx;
    updatePreview(info);
  }
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

  // ── Theia Monitor format check ──
  if (buf.length >= HEADER_LEN && MAGIC.every((m, i) => buf[13 + i] === m)) {
    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);

    // Scan chunks: compute total raw size
    let total = 0, off = HEADER_LEN;
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
    off = HEADER_LEN; let wp = 0;
    for (let ci = 0; ci < sizes.length; ci++) {
      off += 4; // skip delta(2) + len(2)
      chunks.push({ byteStart: wp, deltaMs: deltas[ci] });
      raw.set(buf.subarray(off, off + sizes[ci]), wp);
      wp += sizes[ci];
      off += sizes[ci];
    }
  } else {
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
  buildRowMap();
  preDecodeAllFrames();
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

.hex-layout {
  flex: 1; min-height: 0; display: flex; gap: 18px;
}

.hex-card {
  width: 520px; min-height: 0; display: flex; flex-direction: column;
  background: var(--card-bg); border: 1px solid var(--card-border);
  box-shadow: var(--card-shadow); backdrop-filter: blur(22px);
  border-radius: 26px; padding: 18px;
  flex-shrink: 0;
}

/* Preview card */
.hex-preview {
  flex: 1; min-height: 0; min-width: 280px; display: flex; flex-direction: column;
  background: var(--card-bg); border: 1px solid var(--card-border);
  box-shadow: var(--card-shadow); backdrop-filter: blur(22px);
  border-radius: 26px; padding: 18px; gap: 10px;
}
.hex-preview-empty {
  display: flex; align-items: center; justify-content: center;
  gap: 12px; color: var(--text-dim); font-size: 14px; font-weight: 700;
  min-width: 240px;
}
.empty-icon { font-size: 24px; opacity: .5; }
.preview-head {
  display: flex; align-items: center; gap: 8px;
  font-size: 13px; font-weight: 800; flex-shrink: 0;
}
.lock-badge {
  font-size: 9px; font-weight: 900; letter-spacing: .1em;
  padding: 2px 8px; border-radius: 999px;
  background: rgba(239,68,68,.15); color: #ef4444;
}
.preview-meta {
  display: flex; gap: 10px; flex-shrink: 0;
  font-size: 10px; font-weight: 700; color: var(--text-muted);
}
.preview-body {
  flex: 1; min-height: 0; display: flex; gap: 10px;
}
.preview-payload-hex {
  font-family: "JetBrains Mono", Consolas, monospace;
  font-size: 10px; line-height: 1.45; color: var(--text-dim);
  background: var(--surface); border-radius: 8px;
  padding: 6px 10px; white-space: pre; overflow-y: auto;
  flex-shrink: 0;
}
.preview-canvas-wrap {
  flex: 1; min-height: 0; min-width: 0; display: flex; align-items: center;
  justify-content: center; background: var(--surface);
  border-radius: 12px; overflow: hidden;
}
.preview-canvas {
  width: 100%; height: 100%; object-fit: contain;
  image-rendering: pixelated;
}
.preview-img {
  width: 100%; height: 100%; object-fit: contain;
}
.preview-unsupported {
  color: var(--text-dim); font-size: 13px; font-weight: 600;
  text-align: center; padding: 24px;
}

/* Lock button */
.lock-btn {
  width: 28px; height: 28px; display: grid; place-items: center;
  border: 1px solid var(--card-border); border-radius: 8px;
  background: transparent; color: var(--text-dim); cursor: pointer;
  font-size: 14px; transition: background 150ms, color 150ms;
  margin-left: auto; flex-shrink: 0;
}
.lock-btn:hover { background: var(--surface); color: var(--text); }
.lock-btn.on { background: rgba(239,68,68,.12); color: #ef4444; border-color: rgba(239,68,68,.3); }
.lock-cursor { cursor: crosshair; }

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
.hex-row-collapsed { opacity: .45; }
</style>

<style>
/* Unscoped — innerHTML rendered byte spans */
.ho { color: var(--hex-offset, #6b7280); margin-right: 16px; user-select: none; }
.hb { display: inline-block; width: 2ch; text-align: center; margin: 0 1px; border-radius: 2px; cursor: default; color: #6b7280; }
.hc { color: var(--text-dim, #6b7280); font-style: italic; user-select: none; }
.ph-off { color: var(--hex-offset, #6b7280); margin-right: 10px; user-select: none; }

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
