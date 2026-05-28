/**
 * 原始数据录制控制器
 *
 * 订阅串口原始字节流，保存为带时间戳的 .bin 文件供 ReplayController 回放。
 *
 * Theia Monitor 录制格式:
 *   Owner:   "Theia Monitor" (13 bytes, UTF-8)
 *   Magic:   "THEIAv1" (7 bytes)
 *   [Chunk]:
 *     delta_ms: uint16 LE (2 bytes)
 *     data_len: uint16 LE (2 bytes)
 *     data:     uint8[data_len]
 */
import type { TelemetrySerialManager } from './manager';
export type RecordState = 'idle' | 'recording' | 'paused';

export interface RecordEvents {
  onStateChange?: (state: RecordState) => void;
  onByteCount?: (bytes: number) => void;
}

interface ChunkEntry {
  deltaMs: number;
  data: Uint8Array;
}

const MAGIC = new Uint8Array([0x54, 0x48, 0x45, 0x49, 0x41, 0x76, 0x31]); // "THEIAv1"
const OWNER = new TextEncoder().encode('Theia Monitor'); // 13 bytes

export class RecordController {
  private _state: RecordState = 'idle';
  private chunks: ChunkEntry[] = [];
  private _byteCount = 0;
  private _lastTs = 0;
  private events: RecordEvents = {};
  private unsubRaw: (() => void) | null = null;
  private serialManager: TelemetrySerialManager;

  constructor(serialManager: TelemetrySerialManager) {
    this.serialManager = serialManager;
  }

  get state(): RecordState { return this._state; }
  get byteCount(): number { return this._byteCount; }

  setEvents(e: RecordEvents) { this.events = e; }

  /** 开始录制 */
  start(): void {
    this._state = 'recording';
    this.chunks = [];
    this._byteCount = 0;
    this._lastTs = performance.now();
    this.unsubRaw = this.serialManager.onRawData((data) => {
      const now = performance.now();
      const delta = Math.round(now - this._lastTs);
      this._lastTs = now;
      this.chunks.push({ deltaMs: Math.min(delta, 65535), data: new Uint8Array(data) });
      this._byteCount += data.length;
      this.events.onByteCount?.(this._byteCount);
    });
    this.events.onStateChange?.('recording');
  }

  /** 暂停录制 */
  pause(): void {
    if (this._state !== 'recording') return;
    this._state = 'paused';
    this.unsubRaw?.();
    this.unsubRaw = null;
    this.events.onStateChange?.('paused');
  }

  /** 恢复录制 */
  resume(): void {
    if (this._state !== 'paused') return;
    this._state = 'recording';
    this._lastTs = performance.now();
    this.unsubRaw = this.serialManager.onRawData((data) => {
      const now = performance.now();
      const delta = Math.round(now - this._lastTs);
      this._lastTs = now;
      this.chunks.push({ deltaMs: Math.min(delta, 65535), data: new Uint8Array(data) });
      this._byteCount += data.length;
      this.events.onByteCount?.(this._byteCount);
    });
    this.events.onStateChange?.('recording');
  }

  /** 停止录制并保存文件 */
  stop(): void {
    if (this._state !== 'recording' && this._state !== 'paused') return;
    this.unsubRaw?.();
    this.unsubRaw = null;
    this._saveFile();
    this._state = 'idle';
    this.chunks = [];
    this._byteCount = 0;
    this.events.onStateChange?.('idle');
  }

  // ── 内部 ──

  private _saveFile(): void {
    if (this.chunks.length === 0) return;

    // 计算总大小
    let total = OWNER.length + MAGIC.length; // owner + magic
    for (const c of this.chunks) {
      total += 2 + 2 + c.data.length; // delta + len + data
    }

    const buf = new Uint8Array(total);
    const view = new DataView(buf.buffer);
    let off = 0;

    // owner signature
    buf.set(OWNER, off); off += OWNER.length;
    // magic
    buf.set(MAGIC, off); off += MAGIC.length;

    // chunks
    for (const c of this.chunks) {
      view.setUint16(off, c.deltaMs, true); off += 2;
      view.setUint16(off, c.data.length, true); off += 2;
      buf.set(c.data, off); off += c.data.length;
    }

    const blob = new Blob([buf], { type: 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    a.href = url;
    a.download = `mcu-record-${ts}.bin`;
    a.click();
    URL.revokeObjectURL(url);
  }
}
