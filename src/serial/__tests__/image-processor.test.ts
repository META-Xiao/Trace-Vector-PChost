import { describe, it, expect, beforeEach } from 'vitest';
import {
  ImageFrameProcessor,
  ImageDataStore,
  ProcessedImageData,
} from '../image-processor';
import { ImageFrame, PixelFormat, Codec, makeFormat } from '../protocol';

function makeFrame(
  frameId: number,
  width: number,
  height: number,
  pixelFormat: PixelFormat,
  payload: Uint8Array,
): ImageFrame {
  const format = makeFormat(pixelFormat, Codec.RAW);
  return {
    type: 'IMAGE',
    frameId,
    length: 5 + payload.length,
    width,
    height,
    format,
    pixelFormat,
    codec: Codec.RAW,
    payload,
    checksum: 0,
  };
}

describe('ImageFrameProcessor', () => {
  const WIDTH = 188;
  const HEIGHT = 120;
  const TOTAL_PIXELS = WIDTH * HEIGHT;

  let processor: ImageFrameProcessor;

  beforeEach(() => {
    processor = new ImageFrameProcessor({
      imageWidth: WIDTH,
      imageHeight: HEIGHT,
      fps: 25,
    });
  });

  it('should process a valid grayscale image frame', () => {
    const payload = new Uint8Array(TOTAL_PIXELS);
    for (let i = 0; i < TOTAL_PIXELS; i++) {
      payload[i] = i % 256;
    }

    const frame = makeFrame(100, WIDTH, HEIGHT, PixelFormat.Gray8, payload);
    const processed = processor.process(frame);

    expect(processed.frameId).toBe(100);
    expect(processed.width).toBe(WIDTH);
    expect(processed.height).toBe(HEIGHT);
    expect(processed.pixelData.length).toBe(TOTAL_PIXELS * 4);
  });

  it('should correctly convert grayscale to RGBA', () => {
    const payload = new Uint8Array(TOTAL_PIXELS);
    payload[0] = 128;
    payload[1] = 255;

    const frame = makeFrame(1, WIDTH, HEIGHT, PixelFormat.Gray8, payload);
    const processed = processor.process(frame);
    const pixels = processed.pixelData;

    expect(pixels[0]).toBe(128);
    expect(pixels[1]).toBe(128);
    expect(pixels[2]).toBe(128);
    expect(pixels[3]).toBe(255);

    expect(pixels[4]).toBe(255);
    expect(pixels[5]).toBe(255);
    expect(pixels[6]).toBe(255);
    expect(pixels[7]).toBe(255);
  });

  it('should process a valid RGB565 image frame', () => {
    const RGB565_SIZE = TOTAL_PIXELS * 2;
    const payload = new Uint8Array(RGB565_SIZE);
    for (let i = 0; i < TOTAL_PIXELS; i++) {
      payload[i * 2]     = 0x07;
      payload[i * 2 + 1] = 0xE0;
    }

    const frame = makeFrame(200, WIDTH, HEIGHT, PixelFormat.RGB565, payload);
    const processed = processor.process(frame);

    expect(processed.frameId).toBe(200);
    expect(processed.width).toBe(WIDTH);
    expect(processed.height).toBe(HEIGHT);
    expect(processed.pixelData.length).toBe(TOTAL_PIXELS * 4);
  });

  it('should correctly convert RGB565 to RGBA', () => {
    const RGB565_SIZE = TOTAL_PIXELS * 2;
    const payload = new Uint8Array(RGB565_SIZE);

    payload[0] = 0xF8; payload[1] = 0x00; // red
    payload[2] = 0x07; payload[3] = 0xE0; // green
    payload[4] = 0x00; payload[5] = 0x1F; // blue

    const frame = makeFrame(1, WIDTH, HEIGHT, PixelFormat.RGB565, payload);
    const processed = processor.process(frame);
    const pixels = processed.pixelData;

    expect(pixels[0]).toBe(255);  // red R
    expect(pixels[1]).toBe(0);
    expect(pixels[2]).toBe(0);
    expect(pixels[3]).toBe(255);

    expect(pixels[4]).toBe(0);
    expect(pixels[5]).toBe(255);  // green G
    expect(pixels[6]).toBe(0);
    expect(pixels[7]).toBe(255);

    expect(pixels[8]).toBe(0);
    expect(pixels[9]).toBe(0);
    expect(pixels[10]).toBe(255); // blue B
    expect(pixels[11]).toBe(255);
  });

  it('should reject invalid image data size for fixed-size pixel formats', () => {
    const payload = new Uint8Array(TOTAL_PIXELS - 1); // wrong size for Gray8

    const frame: ImageFrame = {
      type: 'IMAGE',
      frameId: 1,
      length: 5 + TOTAL_PIXELS, // length says TOTAL_PIXELS
      width: WIDTH,
      height: HEIGHT,
      format: makeFormat(PixelFormat.Gray8, Codec.RAW),
      pixelFormat: PixelFormat.Gray8,
      codec: Codec.RAW,
      payload,
      checksum: 0,
    };

    expect(() => processor.process(frame)).toThrow('Invalid raw data size');
  });

  it('should cache the last processed frame', () => {
    const payload1 = new Uint8Array(TOTAL_PIXELS);
    payload1.fill(128);
    const frame1 = makeFrame(1, WIDTH, HEIGHT, PixelFormat.Gray8, payload1);
    const processed1 = processor.process(frame1);
    expect(processor.getLastFrame()).toBe(processed1);

    const payload2 = new Uint8Array(TOTAL_PIXELS);
    payload2.fill(255);
    const frame2 = makeFrame(2, WIDTH, HEIGHT, PixelFormat.Gray8, payload2);
    const processed2 = processor.process(frame2);
    expect(processor.getLastFrame()).toBe(processed2);
    expect(processor.getLastFrame()).not.toBe(processed1);
  });

  it('should clear cached frame', () => {
    const payload = new Uint8Array(TOTAL_PIXELS);
    const frame = makeFrame(1, WIDTH, HEIGHT, PixelFormat.Gray8, payload);
    processor.process(frame);
    expect(processor.getLastFrame()).not.toBeNull();

    processor.clear();
    expect(processor.getLastFrame()).toBeNull();
  });

  it('should handle Binary1 pixel format', () => {
    const payload = new Uint8Array(Math.ceil(TOTAL_PIXELS / 8));
    payload[0] = 0xFF; // first 8 pixels all on
    const frame = makeFrame(1, WIDTH, HEIGHT, PixelFormat.Binary1, payload);
    const processed = processor.process(frame);
    const pixels = processed.pixelData;

    expect(pixels[0]).toBe(255); // white
    expect(pixels[1]).toBe(255);
    expect(pixels[2]).toBe(255);
    expect(pixels[3]).toBe(255);
  });

  it('should handle RGB888 pixel format', () => {
    const payload = new Uint8Array(TOTAL_PIXELS * 3);
    payload[0] = 255; payload[1] = 0; payload[2] = 0; // red pixel
    const frame = makeFrame(1, WIDTH, HEIGHT, PixelFormat.RGB888, payload);
    const processed = processor.process(frame);
    const pixels = processed.pixelData;

    expect(pixels[0]).toBe(255);
    expect(pixels[1]).toBe(0);
    expect(pixels[2]).toBe(0);
    expect(pixels[3]).toBe(255);
  });

  it('should throw for unsupported codec', () => {
    const payload = new Uint8Array(TOTAL_PIXELS);
    const frame: ImageFrame = {
      type: 'IMAGE',
      frameId: 1,
      length: 5 + TOTAL_PIXELS,
      width: WIDTH,
      height: HEIGHT,
      format: makeFormat(PixelFormat.Gray8, Codec.HEATSHRINK),
      pixelFormat: PixelFormat.Gray8,
      codec: Codec.HEATSHRINK,
      payload,
      checksum: 0,
    };

    expect(() => processor.process(frame)).toThrow('not yet implemented');
  });
});

describe('ImageDataStore', () => {
  let store: ImageDataStore;
  let processor: ImageFrameProcessor;

  beforeEach(() => {
    store = new ImageDataStore(2);
    processor = new ImageFrameProcessor({
      imageWidth: 188,
      imageHeight: 120,
      fps: 25,
    });
  });

  const createProcessedFrame = (frameId: number): ProcessedImageData => {
    return {
      frameId,
      width: 188,
      height: 120,
      pixelData: new Uint8ClampedArray(188 * 120 * 4),
      timestamp: Date.now(),
    };
  };

  it('should store and retrieve current frame', () => {
    const frame = createProcessedFrame(1);
    store.storeFrame(frame);

    expect(store.getCurrentFrame()).toBe(frame);
  });

  it('should maintain buffer with max size limit', () => {
    const frame1 = createProcessedFrame(1);
    const frame2 = createProcessedFrame(2);
    const frame3 = createProcessedFrame(3);

    store.storeFrame(frame1);
    store.storeFrame(frame2);
    store.storeFrame(frame3);

    // 缓冲大小为2，所以应该只有frame2和frame3
    expect(store.getFrame(1)).toBeNull();
    expect(store.getFrame(2)).toBeTruthy();
    expect(store.getFrame(3)).toBeTruthy();
  });

  it('should detect dropped frames', () => {
    const frame1 = createProcessedFrame(1);
    const frame5 = createProcessedFrame(5); // 跳过 2, 3, 4

    store.storeFrame(frame1);
    store.storeFrame(frame5);

    const stats = store.getStats();
    expect(stats.droppedFrames).toBe(3); // 丢失帧 2, 3, 4
  });

  it('should handle frame ID wraparound', () => {
    const frame1 = createProcessedFrame(0xFFFF);
    const frame2 = createProcessedFrame(0); // 环绕回 0

    store.storeFrame(frame1);
    store.storeFrame(frame2);

    const stats = store.getStats();
    expect(stats.totalFrames).toBe(2);
    // 0xFFFF -> 0 应该被识别为连续，无丢帧
    expect(stats.droppedFrames).toBe(0);
  });

  it('should calculate FPS correctly', (done) => {
    let timestamp = Date.now();

    const frame1: ProcessedImageData = {
      frameId: 1,
      width: 188,
      height: 120,
      pixelData: new Uint8ClampedArray(188 * 120 * 4),
      timestamp,
    };
    store.storeFrame(frame1);

    // 模拟时间推进，添加多个帧
    setTimeout(() => {
      for (let i = 2; i <= 10; i++) {
        const frame: ProcessedImageData = {
          frameId: i,
          width: 188,
          height: 120,
          pixelData: new Uint8ClampedArray(188 * 120 * 4),
          timestamp: Date.now(),
        };
        store.storeFrame(frame);
      }

      const fps = store.calculateFps();
      // 应该接近 1000/100 = 10 FPS（10帧在100ms内）
      expect(fps).toBeGreaterThan(0);
      expect(fps).toBeLessThan(100); // 合理范围
      done();
    }, 100);
  });

  it('should track total frames and stats', () => {
    for (let i = 1; i <= 5; i++) {
      store.storeFrame(createProcessedFrame(i));
    }

    const stats = store.getStats();
    expect(stats.totalFrames).toBe(5);
  });

  it('should clear all data', () => {
    store.storeFrame(createProcessedFrame(1));
    store.storeFrame(createProcessedFrame(2));

    expect(store.getCurrentFrame()).not.toBeNull();

    store.clear();

    expect(store.getCurrentFrame()).toBeNull();
    expect(store.getFrame(1)).toBeNull();
    expect(store.getFrame(2)).toBeNull();

    const stats = store.getStats();
    expect(stats.totalFrames).toBe(0);
  });

  it('should reset stats', () => {
    for (let i = 1; i <= 5; i++) {
      store.storeFrame(createProcessedFrame(i));
    }

    let stats = store.getStats();
    expect(stats.totalFrames).toBe(5);

    store.resetStats();

    stats = store.getStats();
    expect(stats.totalFrames).toBe(0);
    expect(stats.droppedFrames).toBe(0);
  });

  it('should handle empty state gracefully', () => {
    expect(store.getCurrentFrame()).toBeNull();

    const stats = store.getStats();
    expect(stats.totalFrames).toBe(0);
    expect(stats.currentFps).toBe(0);
    expect(stats.dropRate).toBe('0.00%');
  });
});
