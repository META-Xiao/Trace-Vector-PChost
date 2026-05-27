/**
 * 原始数据录制控制器
 *
 * 订阅串口原始字节流，保存为带时间戳的 .bin 文件供 ReplayController 回放。
 *
 * V2 格式（TVBIN2）:
 *   Magic:   "TVBIN2"  (6 bytes)
 *   Baud:    uint16 LE (2 bytes, baud rate / 100)
 *   [Chunk]:
 *     delta_ms: uint16 LE (2 bytes)
 *     data_len: uint16 LE (2 bytes)
 *     data:     uint8[data_len]
 *
 * V1 格式（旧）: 纯原始字节拼接，无 header。
 */
import type { TelemetrySerialManager } from './manager';
import { BAUDRATE } from './protocol';

export type RecordState = 'idle' | 'recording' | 'paused';

export interface RecordEvents {
  onStateChange?: (state: RecordState) => void;
  onByteCount?: (bytes: number) => void;
}

interface ChunkEntry {
  deltaMs: number;
  data: Uint8Array;
}

const MAGIC_V2 = new Uint8Array([0x54, 0x56, 0x42, 0x49, 0x4E, 0x32]); // "TVBIN2"

export class RecordController {
  private _state: RecordState = 'idle';
  private chunks: ChunkEntry[] = [];
  private _byteCount = 0;
  private _lastTs = 0;
  private _baud = BAUDRATE;
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
    let total = MAGIC_V2.length + 2; // magic + baud
    for (const c of this.chunks) {
      total += 2 + 2 + c.data.length; // delta + len + data
    }

    const buf = new Uint8Array(total);
    const view = new DataView(buf.buffer);
    let off = 0;

    // magic
    buf.set(MAGIC_V2, off); off += MAGIC_V2.length;

    // baud (uint16 LE)
    view.setUint16(off, Math.round(this._baud / 100), true); off += 2;

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
