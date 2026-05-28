import { describe, it, expect, beforeEach } from 'vitest';
import { ImageFrameProcessor } from '../../serial/image-processor';
import type { ImageFrame } from '../../serial/protocol';
import { PixelFormat, Codec, makeFormat, parseFormat } from '../../serial/protocol';

// ── Helpers mirroring HexView logic ──

function makeImageFrame(
  fb: Uint8Array, bodyLen: number,
  w: number, h: number, fmtByte: number,
  pf: PixelFormat, codec: Codec, payload: Uint8Array,
): ImageFrame {
  return {
    type: 'IMAGE', length: bodyLen,
    frameId: (fb[3] << 8) | fb[4],
    width: w, height: h, format: fmtByte,
    pixelFormat: pf, codec, payload,
    checksum: fb[fb.length - 1],
  };
}

/** Build a complete image frame byte array (0xCC + len + fid + w + h + fmt + payload + cs) */
function buildImageFrameBytes(
  frameId: number, w: number, h: number,
  pf: PixelFormat, codec: Codec, payload: Uint8Array,
): Uint8Array {
  const bodyLen = 5 + payload.length;
  const fmt = makeFormat(pf, codec);
  const buf = new Uint8Array(4 + bodyLen); // sync(1) + len(2) + body + cs(1)
  buf[0] = 0xCC;
  buf[1] = (bodyLen >> 8) & 0xFF;
  buf[2] = bodyLen & 0xFF;
  buf[3] = (frameId >> 8) & 0xFF;
  buf[4] = frameId & 0xFF;
  buf[5] = w;
  buf[6] = h;
  buf[7] = fmt;
  buf.set(payload, 8);
  let cs = 0;
  for (let i = 1; i < buf.length - 1; i++) cs += buf[i];
  buf[buf.length - 1] = cs & 0xFF;
  return buf;
}

// ── Tests ──

describe('HexView image preview', () => {
  let processor: ImageFrameProcessor;

  beforeEach(() => {
    processor = new ImageFrameProcessor({ imageWidth: 0, imageHeight: 0, fps: 0 });
  });

  describe('Frame construction', () => {
    it('should build a valid ImageFrame from raw bytes', () => {
      const payload = new Uint8Array([0xAA, 0xBB, 0xCC]);
      const bytes = buildImageFrameBytes(1, 16, 8, PixelFormat.Gray8, Codec.RAW, payload);
      const bodyLen = (bytes[1] << 8) | bytes[2];
      const fmt = bytes[7];
      const { pixelFormat, codec } = parseFormat(fmt);
      const pl = bytes.slice(8, 8 + bodyLen - 5);

      const frame = makeImageFrame(bytes, bodyLen, bytes[5], bytes[6], fmt, pixelFormat as PixelFormat, codec as Codec, pl);

      expect(frame.type).toBe('IMAGE');
      expect(frame.frameId).toBe(1);
      expect(frame.width).toBe(16);
      expect(frame.height).toBe(8);
      expect(frame.pixelFormat).toBe(PixelFormat.Gray8);
      expect(frame.codec).toBe(Codec.RAW);
      expect(frame.payload).toEqual(payload);
    });
  });

  describe('RAW codec decoding', () => {
    it('decodes Gray8', () => {
      const w = 4, h = 2;
      const payload = new Uint8Array([0, 64, 128, 192, 255, 200, 100, 50]);
      const bytes = buildImageFrameBytes(0, w, h, PixelFormat.Gray8, Codec.RAW, payload);
      const frame = makeImageFrame(bytes, (bytes[1] << 8) | bytes[2], w, h, bytes[7],
        PixelFormat.Gray8, Codec.RAW, payload);

      const result = processor.process(frame);
      expect(result.width).toBe(w);
      expect(result.height).toBe(h);
      expect(result.pixelData[0]).toBe(0);   // pixel 0: 0
      expect(result.pixelData[4]).toBe(64);  // pixel 1: 64
      expect(result.pixelData[16]).toBe(255); // pixel 4: 255
    });

    it('decodes RGB565', () => {
      const w = 2, h = 1;
      // Red (0xF800), Blue (0x001F)
      const payload = new Uint8Array([0xF8, 0x00, 0x00, 0x1F]);
      const bytes = buildImageFrameBytes(0, w, h, PixelFormat.RGB565, Codec.RAW, payload);
      const frame = makeImageFrame(bytes, (bytes[1] << 8) | bytes[2], w, h, bytes[7],
        PixelFormat.RGB565, Codec.RAW, payload);

      const result = processor.process(frame);
      // Red pixel (0xF800 → R=255, G=0, B=0)
      expect(result.pixelData[0]).toBe(255);
      expect(result.pixelData[1]).toBe(0);
      expect(result.pixelData[2]).toBe(0);
      // Blue pixel (0x001F → R=0, G=0, B=255)
      expect(result.pixelData[4]).toBe(0);
      expect(result.pixelData[6]).toBe(255);
    });

    it('decodes RGB888', () => {
      const w = 1, h = 1;
      const payload = new Uint8Array([255, 128, 64]);
      const bytes = buildImageFrameBytes(0, w, h, PixelFormat.RGB888, Codec.RAW, payload);
      const frame = makeImageFrame(bytes, (bytes[1] << 8) | bytes[2], w, h, bytes[7],
        PixelFormat.RGB888, Codec.RAW, payload);

      const result = processor.process(frame);
      expect(result.pixelData[0]).toBe(255);
      expect(result.pixelData[1]).toBe(128);
      expect(result.pixelData[2]).toBe(64);
    });

    it('decodes YUV422 (Y-only as grayscale)', () => {
      const w = 2, h = 1;
      const payload = new Uint8Array([100, 128, 200, 64]);
      const bytes = buildImageFrameBytes(0, w, h, PixelFormat.YUV422, Codec.RAW, payload);
      const frame = makeImageFrame(bytes, (bytes[1] << 8) | bytes[2], w, h, bytes[7],
        PixelFormat.YUV422, Codec.RAW, payload);

      const result = processor.process(frame);
      expect(result.pixelData[0]).toBe(100); // Y0
      expect(result.pixelData[4]).toBe(200); // Y1
    });
  });

  describe('Compressed codec decoding', () => {
    it('decodes RLE', () => {
      const w = 4, h = 1;
      // RLE: [value, count] pairs
      const payload = new Uint8Array([0xAA, 2, 0x55, 2]);
      const bytes = buildImageFrameBytes(0, w, h, PixelFormat.Gray8, Codec.RLE, payload);
      const frame = makeImageFrame(bytes, (bytes[1] << 8) | bytes[2], w, h, bytes[7],
        PixelFormat.Gray8, Codec.RLE, payload);

      const result = processor.process(frame);
      expect(result.pixelData[0]).toBe(0xAA);  // pixel 0 R
      expect(result.pixelData[4]).toBe(0xAA);  // pixel 1 R
      expect(result.pixelData[8]).toBe(0x55);  // pixel 2 R
      expect(result.pixelData[12]).toBe(0x55); // pixel 3 R
    });

    it('decodes Patch after RAW I-frame', () => {
      const w = 4, h = 2; // 8 bytes
      // I-frame: all zeros
      const iPayload = new Uint8Array(8);
      const iBytes = buildImageFrameBytes(0, w, h, PixelFormat.Gray8, Codec.RAW, iPayload);
      const iFrame = makeImageFrame(iBytes, (iBytes[1] << 8) | iBytes[2], w, h, iBytes[7],
        PixelFormat.Gray8, Codec.RAW, iPayload);
      processor.process(iFrame); // build cache

      // Patch: change rectangle (1,0)-(2,1) to [0xFF, 0xFF]
      const pPayload = new Uint8Array([1, 0, 2, 1, 0xFF, 0xFF]);
      const pBytes = buildImageFrameBytes(1, w, h, PixelFormat.Gray8, Codec.Patch, pPayload);
      const pFrame = makeImageFrame(pBytes, (pBytes[1] << 8) | pBytes[2], w, h, pBytes[7],
        PixelFormat.Gray8, Codec.Patch, pPayload);

      const result = processor.process(pFrame);
      // Row 0: 0, FF, FF, 0  → pixel offsets 0,4,8,12
      expect(result.pixelData[0]).toBe(0);
      expect(result.pixelData[4]).toBe(0xFF);
      expect(result.pixelData[8]).toBe(0xFF);
      expect(result.pixelData[12]).toBe(0);
    });

    it('throws for Patch without I-frame cache', () => {
      const w = 4, h = 2;
      const pPayload = new Uint8Array([1, 0, 2, 1, 0xFF, 0xFF]);
      const pBytes = buildImageFrameBytes(0, w, h, PixelFormat.Gray8, Codec.Patch, pPayload);
      const pFrame = makeImageFrame(pBytes, (pBytes[1] << 8) | pBytes[2], w, h, pBytes[7],
        PixelFormat.Gray8, Codec.Patch, pPayload);

      expect(() => processor.process(pFrame)).toThrow(/without I-frame cache/);
    });
  });

  describe('Edge cases', () => {
    it('handles mismatched payload size (validation throws)', () => {
      const w = 4, h = 2; // expects 8 bytes
      const payload = new Uint8Array([1, 2, 3]); // only 3 bytes
      const bytes = buildImageFrameBytes(0, w, h, PixelFormat.Gray8, Codec.RAW, payload);
      const bodyLen = (bytes[1] << 8) | bytes[2];
      const actualPayload = bytes.slice(8, 8 + bodyLen - 5);
      const frame = makeImageFrame(bytes, bodyLen, w, h, bytes[7],
        PixelFormat.Gray8, Codec.RAW, actualPayload);
      expect(() => processor.process(frame)).toThrow();
    });

    it('handles Binary1 format', () => {
      const w = 8, h = 1;
      // 8 pixels: 10101010
      const payload = new Uint8Array([0xAA]);
      const bytes = buildImageFrameBytes(0, w, h, PixelFormat.Binary1, Codec.RAW, payload);
      const frame = makeImageFrame(bytes, (bytes[1] << 8) | bytes[2], w, h, bytes[7],
        PixelFormat.Binary1, Codec.RAW, payload);

      const result = processor.process(frame);
      // Pixel 0 = 1 → 255, Pixel 1 = 0 → 0
      expect(result.pixelData[0]).toBe(255);
      expect(result.pixelData[4]).toBe(0);
      expect(result.pixelData[8]).toBe(255);
      expect(result.pixelData[12]).toBe(0);
    });
  });

  describe('real bin file Patch decoding', () => {
    // Simulates the HexView cache-rebuild logic:
    // process frames in order, skip failing ones (Patch before first RAW),
    // then verify that a Patch frame after RAW decodes correctly.

    it('decodes Patch after RAW by rebuilding cache skipping early failures', () => {
      // Build a mini stream: 2 Patch (garbage), 1 RAW, 1 Patch (real)
      const w = 4, h = 2; // 8 bytes for Gray8
      const rawPayload = new Uint8Array([10, 20, 30, 40, 50, 60, 70, 80]);

      // Patch that modifies pixel (1,0) to [99]
      const patchPayload = new Uint8Array([1, 0, 1, 0, 99]);

      // Frame 0: Patch (can't decode - no I-frame)
      const bytes0 = buildImageFrameBytes(0, w, h, PixelFormat.Gray8, Codec.Patch, patchPayload);
      // Frame 1: Patch (also can't decode)
      const bytes1 = buildImageFrameBytes(1, w, h, PixelFormat.Gray8, Codec.Patch, patchPayload);
      // Frame 2: RAW I-frame
      const bytes2 = buildImageFrameBytes(2, w, h, PixelFormat.Gray8, Codec.RAW, rawPayload);
      // Frame 3: Patch target
      const bytes3 = buildImageFrameBytes(3, w, h, PixelFormat.Gray8, Codec.Patch, patchPayload);

      const frames = [bytes0, bytes1, bytes2, bytes3];

      // Simulate HexView's cache rebuild: skip failures, process all up to target
      let lastResult: any = null;
      for (let i = 0; i < frames.length; i++) {
        const fb = frames[i];
        const bl = (fb[1] << 8) | fb[2];
        const pl = fb.slice(8, 8 + bl - 5);
        const { pixelFormat, codec } = parseFormat(fb[7]);
        const frame = makeImageFrame(fb, bl, fb[5], fb[6], fb[7],
          pixelFormat as PixelFormat, codec as Codec, pl);

        try {
          lastResult = processor.process(frame);
        } catch {
          continue; // skip Patch frames before first RAW
        }
      }
      // Target frame (#3 Patch) should have decoded after RAW cache built
      expect(lastResult).not.toBeNull();
      expect(lastResult!.pixelData[4]).toBe(99); // patched pixel
    });
  });
});
