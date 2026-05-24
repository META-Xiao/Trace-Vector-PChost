import { ResourceFrame } from './protocol';
import { resourceSlots, evalExpr } from '../stores/resourceSlots';

export interface ProcessedResourceData {
  res: number[];
  values: number[];   // evalExpr 结果，与 resourceSlots 一一对应
  timestamp: number;
}

export type ResourceStats = Record<string, never>;

export class ResourceFrameProcessor {
  process(frame: ResourceFrame): ProcessedResourceData {
    const values = resourceSlots.map(slot => evalExpr(slot.expr, frame.res));
    return { res: frame.res, values, timestamp: Date.now() };
  }
  clear(): void {}
}

export class ResourceDataStore {
  private buf: ProcessedResourceData[] = [];
  private readonly max: number;
  constructor(max = 300) { this.max = max; }

  storeData(d: ProcessedResourceData): void {
    this.buf.push(d);
    if (this.buf.length > this.max) this.buf.shift();
  }
  getCurrentData(): ProcessedResourceData | null {
    return this.buf.length ? this.buf[this.buf.length - 1] : null;
  }
  getAllData(): ProcessedResourceData[] { return [...this.buf]; }
  getDataSince(ts: number): ProcessedResourceData[] { return this.buf.filter(d => d.timestamp >= ts); }
  getStats(): ResourceStats { return {}; }
  getBufferSize(): number { return this.buf.length; }
  getBufferUtilization(): number { return (this.buf.length / this.max) * 100; }
  clear(): void { this.buf = []; }
}
