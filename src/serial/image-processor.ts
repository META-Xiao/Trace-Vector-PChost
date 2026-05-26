import { ImageFrame, PixelFormat, Codec } from './protocol';

/**
 * 图像处理配置
 */
export interface ImageProcessingConfig {
  imageWidth: number;     // 图像宽度（像素）
  imageHeight: number;    // 图像高度（像素）
  fps: number;            // 默认输出帧率（用于配置，非帧头字段）
}

/**
 * 处理后的图像数据
 */
export interface ProcessedImageData {
  frameId: number;        // 帧ID
  width: number;          // 宽度
  height: number;         // 高度
  pixelData: Uint8ClampedArray;  // RGBA 格式像素数据
  timestamp: number;      // 时间戳（ms）
}

/**
 * 图像帧处理器
 *
 * 功能：
 * - 根据 PixelFormat 将二进制 Payload 转换为 RGBA 显示格式
 * - 根据 Codec 解码 Payload（RAW/RLE/HEATSHRINK 等）
 * - 维护 I 帧缓存用于 Tile/Patch 等 P 帧解码
 */
export class ImageFrameProcessor {
  private readonly config: ImageProcessingConfig;
  private lastProcessedFrame: ProcessedImageData | null = null;
  private iFrameCache: Uint8Array | null = null; // RAW I 帧缓存，用于 P 帧解码

  constructor(config: ImageProcessingConfig) {
    this.config = config;
  }

  /**
   * 处理图像帧，转 RGBA 格式
   * @param frame 原始图像帧
   * @returns 处理后的图像数据
   */
  process(frame: ImageFrame): ProcessedImageData {
    const { frameId, width, height, pixelFormat, codec, payload } = frame;

    // 1. 解码 Payload → RAW 像素数据
    let raw: Uint8Array;
    if (codec === Codec.RAW) {
      raw = payload;
    } else {
      raw = this.decodePayload(payload, codec, pixelFormat, width, height);
    }

    // 2. 验证 RAW 数据大小
    const expected = this.expectedRawSize(pixelFormat, width, height);
    if (expected > 0 && raw.length !== expected) {
      throw new Error(
        `Invalid raw data size: expected ${expected} bytes for ${PixelFormat[pixelFormat]}, ` +
        `got ${raw.length}`,
      );
    }

    // 3. 缓存 I 帧（RAW codec 的帧作为参考帧）
    if (codec === Codec.RAW) {
      this.iFrameCache = raw;
    }

    // 4. RAW → RGBA
    const pixelData = this.rawToRGBA(raw, pixelFormat, width, height);

    const processed: ProcessedImageData = {
      frameId,
      width,
      height,
      pixelData,
      timestamp: Date.now(),
    };

    this.lastProcessedFrame = processed;
    return processed;
  }

  /** 解码非 RAW codec 的 Payload */
  private decodePayload(
    _payload: Uint8Array,
    codec: Codec,
    _pixelFormat: PixelFormat,
    _width: number,
    _height: number,
  ): Uint8Array {
    // TODO: 实现 HEATSHRINK / RLE / Tile / Patch 解码
    throw new Error(`Codec ${Codec[codec]} (${codec}) not yet implemented`);
  }

  /** 计算给定 PixelFormat 的 RAW 帧预期字节数 */
  private expectedRawSize(pixelFormat: PixelFormat, width: number, height: number): number {
    switch (pixelFormat) {
      case PixelFormat.Binary1: return Math.ceil((width * height) / 8);
      case PixelFormat.Gray8:   return width * height;
      case PixelFormat.RGB565:  return width * height * 2;
      case PixelFormat.RGB888:  return width * height * 3;
      case PixelFormat.YUV422:  return width * height * 2;
      default: return 0;
    }
  }

  /** RAW 像素数据 → RGBA Uint8ClampedArray */
  private rawToRGBA(
    raw: Uint8Array,
    pixelFormat: PixelFormat,
    width: number,
    height: number,
  ): Uint8ClampedArray {
    const pixelCount = width * height;
    const out = new Uint8ClampedArray(pixelCount * 4);

    switch (pixelFormat) {
      case PixelFormat.Binary1: {
        for (let i = 0; i < pixelCount; i++) {
          const byteIdx = i >> 3;
          const bitIdx = 7 - (i & 7);
          const bit = (raw[byteIdx] >> bitIdx) & 1;
          const v = bit * 255;
          const o = i * 4;
          out[o] = v; out[o + 1] = v; out[o + 2] = v; out[o + 3] = 255;
        }
        break;
      }
      case PixelFormat.Gray8: {
        for (let i = 0; i < pixelCount; i++) {
          const g = raw[i];
          const o = i * 4;
          out[o] = g; out[o + 1] = g; out[o + 2] = g; out[o + 3] = 255;
        }
        break;
      }
      case PixelFormat.RGB565: {
        for (let i = 0; i < pixelCount; i++) {
          const hi = raw[i * 2];
          const lo = raw[i * 2 + 1];
          const rgb565 = (hi << 8) | lo;
          const r5 = (rgb565 >> 11) & 0x1F;
          const g6 = (rgb565 >> 5) & 0x3F;
          const b5 = rgb565 & 0x1F;
          const o = i * 4;
          out[o]     = (r5 << 3) | (r5 >> 2);
          out[o + 1] = (g6 << 2) | (g6 >> 4);
          out[o + 2] = (b5 << 3) | (b5 >> 2);
          out[o + 3] = 255;
        }
        break;
      }
      case PixelFormat.RGB888: {
        for (let i = 0; i < pixelCount; i++) {
          const o = i * 4;
          out[o]     = raw[i * 3];
          out[o + 1] = raw[i * 3 + 1];
          out[o + 2] = raw[i * 3 + 2];
          out[o + 3] = 255;
        }
        break;
      }
      case PixelFormat.YUV422: {
        // 简化：仅取 Y 分量显示为灰度
        for (let i = 0; i < pixelCount; i++) {
          const y = raw[i * 2];
          const o = i * 4;
          out[o] = y; out[o + 1] = y; out[o + 2] = y; out[o + 3] = 255;
        }
        break;
      }
      default:
        throw new Error(`Unsupported PixelFormat: ${PixelFormat[pixelFormat]}`);
    }

    return out;
  }

  /**
   * 获取最后处理的图像帧
   */
  getLastFrame(): ProcessedImageData | null {
    return this.lastProcessedFrame;
  }

  /**
   * 清空缓存
   */
  clear(): void {
    this.lastProcessedFrame = null;
  }
}

/**
 * 图像数据存储
 *
 * 功能：
 * - 维护当前显示的图像帧
 * - 帧缓冲（可选双缓冲）
 * - 统计信息（FPS、丢帧数）
 */
export class ImageDataStore {
  private currentFrame: ProcessedImageData | null = null;
  private frameBuffer: Map<number, ProcessedImageData> = new Map();
  private readonly maxBufferSize: number;

  // 统计
  private totalFrames: number = 0;
  private droppedFrames: number = 0;
  private lastFrameId: number = -1;
  private frameTimeHistory: number[] = [];
  private readonly maxHistorySize: number = 60; // 保留最近60帧的时间戳

  constructor(maxBufferSize: number = 2) {
    this.maxBufferSize = maxBufferSize;
  }

  /**
   * 存储新的图像帧
   */
  storeFrame(frame: ProcessedImageData): void {
    this.totalFrames++;

    // 检测丢帧
    if (this.lastFrameId !== -1) {
      const expectedNextId = (this.lastFrameId + 1) & 0xFFFF;
      if (frame.frameId !== expectedNextId) {
        this.droppedFrames += (frame.frameId - expectedNextId + 0x10000) & 0xFFFF;
      }
    }
    this.lastFrameId = frame.frameId;

    // 更新当前帧
    this.currentFrame = frame;

    // 缓冲管理
    this.frameBuffer.set(frame.frameId, frame);
    if (this.frameBuffer.size > this.maxBufferSize) {
      const oldestKey = this.frameBuffer.keys().next().value;
      this.frameBuffer.delete(oldestKey);
    }

    // 记录帧时间戳用于FPS计算
    this.frameTimeHistory.push(frame.timestamp);
    if (this.frameTimeHistory.length > this.maxHistorySize) {
      this.frameTimeHistory.shift();
    }
  }

  /**
   * 获取当前帧
   */
  getCurrentFrame(): ProcessedImageData | null {
    return this.currentFrame;
  }

  /**
   * 获取指定ID的帧（如果在缓冲中）
   */
  getFrame(frameId: number): ProcessedImageData | null {
    return this.frameBuffer.get(frameId) ?? null;
  }

  /**
   * 计算实时FPS（基于最近帧的时间戳）
   */
  calculateFps(): number {
    if (this.frameTimeHistory.length < 2) {
      return 0;
    }

    const oldestTime = this.frameTimeHistory[0];
    const newestTime = this.frameTimeHistory[this.frameTimeHistory.length - 1];
    const timeDelta = newestTime - oldestTime;

    if (timeDelta === 0) {
      return 0;
    }

    return (this.frameTimeHistory.length - 1) / (timeDelta / 1000);
  }

  /**
   * 获取统计信息
   */
  getStats(): {
    totalFrames: number;
    droppedFrames: number;
    currentFps: number;
    dropRate: string;
  } {
    const dropRate =
      this.totalFrames > 0
        ? ((this.droppedFrames / this.totalFrames) * 100).toFixed(2)
        : '0.00';

    return {
      totalFrames: this.totalFrames,
      droppedFrames: this.droppedFrames,
      currentFps: this.calculateFps(),
      dropRate: `${dropRate}%`,
    };
  }

  /**
   * 清空所有数据
   */
  clear(): void {
    this.currentFrame = null;
    this.frameBuffer.clear();
    this.totalFrames = 0;
    this.droppedFrames = 0;
    this.lastFrameId = -1;
    this.frameTimeHistory = [];
  }

  /**
   * 重置统计信息
   */
  resetStats(): void {
    this.totalFrames = 0;
    this.droppedFrames = 0;
    this.frameTimeHistory = [];
  }
}
