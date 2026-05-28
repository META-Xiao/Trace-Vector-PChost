/**
 * 将 MCU 输出的 out.bin 喂给真实的 FrameParser，验证解析行为
 * 运行: npx vitest src/serial/__tests__/outbin.test.ts
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { FrameParser, FrameParseError } from '../parser';
import {
  FRAME_TYPE,
  calculateChecksum,
} from '../protocol';

const OUT_BIN_PATH = 'E:/SkFSTC32G144K256/out.bin';

function loadOutBin(): Uint8Array {
  const buf = readFileSync(OUT_BIN_PATH);
  return new Uint8Array(buf);
}

interface FrameStats {
  total: number;
  ok: number;
  fail: number;
  parseErrors: string[];
  firstOkDetails: string;
  firstFailDetails: string;
}

function analyzeOutBin(): FrameStats {
  const data = loadOutBin();
  const parser = new FrameParser();
  const results = parser.parse(data);

  const stats: FrameStats = {
    total: 0,
    ok: 0,
    fail: 0,
    parseErrors: [],
    firstOkDetails: '',
    firstFailDetails: '',
  };

  for (const r of results) {
    if (r instanceof FrameParseError) {
      stats.fail++;
      stats.parseErrors.push(`${r.code}: ${r.message}`);
      if (!stats.firstFailDetails) {
        stats.firstFailDetails = `${r.code}: ${r.message}`;
      }
    } else {
      stats.ok++;
      if (!stats.firstOkDetails) {
        stats.firstOkDetails = JSON.stringify({
          type: r.type,
          ...(r.type === 'IMAGE'
            ? { frameId: r.frameId, width: r.width, height: r.height, length: r.length }
            : {}),
          ...(r.type === 'LOG' ? { length: r.length, logData: r.logData.slice(0, 80) } : {}),
          ...(r.type === 'RESOURCE' ? { length: r.length } : {}),
        });
      }
    }
    stats.total++;
  }

  return stats;
}

// ── V2 格式工具 ──

const MAGIC = new Uint8Array([0x54, 0x48, 0x45, 0x49, 0x41, 0x76, 0x31]); // "THEIAv1"

/** 构造一个 V2 chunk（delta + len + data） */
function makeV2Chunk(deltaMs: number, data: Uint8Array): Uint8Array {
  const buf = new Uint8Array(4 + data.length);
  const view = new DataView(buf.buffer);
  view.setUint16(0, deltaMs, true);
  view.setUint16(2, data.length, true);
  buf.set(data, 4);
  return buf;
}

/** 构造完整的 V2 .bin 文件 */
function makeBin(_baud: number, chunks: { deltaMs: number; data: Uint8Array }[]): Uint8Array {
  const owner = new TextEncoder().encode('Theia Monitor');

  const totalLen = owner.length + MAGIC.length + chunks.reduce((sum, c) => sum + 4 + c.data.length, 0);
  const buf = new Uint8Array(totalLen);
  let off = 0;
  buf.set(owner, off); off += owner.length;
  buf.set(MAGIC, off); off += MAGIC.length;
  for (const c of chunks) {
    const ch = makeV2Chunk(c.deltaMs, c.data);
    buf.set(ch, off); off += ch.length;
  }
  return buf;
}

/** 构造一个有效的日志帧原始数据 */
function makeLogFrameData(text: string): Uint8Array {
  const logBytes = new TextEncoder().encode(text);
  const frame = new Uint8Array(1 + 2 + logBytes.length + 1);
  frame[0] = FRAME_TYPE.LOG;
  frame[1] = (logBytes.length >> 8) & 0xFF;
  frame[2] = logBytes.length & 0xFF;
  frame.set(logBytes, 3);
  frame[3 + logBytes.length] = calculateChecksum(frame.slice(0, 3 + logBytes.length));
  return frame;
}

/** 构造一个有效的资源帧原始数据 */
function makeResourceFrameData(cpu: number, ram: number, rom: number, speed: number, servo: number): Uint8Array {
  const resData = new Uint8Array(9);
  resData[0] = cpu;
  const ramBuf = new Uint8Array(new Uint16Array([ram]).buffer);
  resData[1] = ramBuf[0]; resData[2] = ramBuf[1];
  const romBuf = new Uint8Array(new Uint16Array([rom]).buffer);
  resData[3] = romBuf[0]; resData[4] = romBuf[1];
  const speedBuf = new Uint8Array(new Int16Array([speed]).buffer);
  resData[5] = speedBuf[0]; resData[6] = speedBuf[1];
  const servoBuf = new Uint8Array(new Int16Array([servo]).buffer);
  resData[7] = servoBuf[0]; resData[8] = servoBuf[1];

  const payload = new Uint8Array(2 + 9);
  payload[0] = 0; payload[1] = 9;
  payload.set(resData, 2);

  const csData = new Uint8Array(1 + payload.length);
  csData[0] = FRAME_TYPE.RESOURCE;
  csData.set(payload, 1);
  const checksum = calculateChecksum(csData);

  const frame = new Uint8Array(1 + payload.length + 1);
  frame[0] = FRAME_TYPE.RESOURCE;
  frame.set(payload, 1);
  frame[frame.length - 1] = checksum;
  return frame;
}

describe('out.bin → FrameParser 真实解析', () => {
  it('应能解析出帧（跳过 SEEKFREE banner）', () => {
    const stats = analyzeOutBin();
    console.log('\n=== out.bin 解析结果 ===');
    console.log(`总帧数: ${stats.total}`);
    console.log(`成功: ${stats.ok}, 失败: ${stats.fail}`);
    console.log(`成功率: ${stats.total > 0 ? ((stats.ok / stats.total) * 100).toFixed(1) : 0}%`);
    if (stats.firstOkDetails) console.log(`首个成功帧: ${stats.firstOkDetails}`);
    if (stats.firstFailDetails) console.log(`首个失败帧: ${stats.firstFailDetails}`);

    // 按错误类型分组
    const errorCounts: Record<string, number> = {};
    for (const e of stats.parseErrors) {
      const code = e.split(':')[0];
      errorCounts[code] = (errorCounts[code] || 0) + 1;
    }
    console.log('\n错误分布:');
    for (const [code, count] of Object.entries(errorCounts)) {
      console.log(`  ${code}: ${count}`);
    }

    expect(stats.total).toBeGreaterThan(0);
  });

  it('IMAGE 帧应全部通过 checksum', () => {
    const stats = analyzeOutBin();
    const imageErrors = stats.parseErrors.filter((e) => e.includes('IMAGE'));
    console.log(`\nIMAGE 帧错误数: ${imageErrors.length}`);
    if (imageErrors.length > 0) {
      console.log('前 5 个 IMAGE 错误:');
      imageErrors.slice(0, 5).forEach((e) => console.log(`  ${e}`));
    }
    expect(imageErrors.length).toBe(0);
  });

  it('LOG 帧应正确解析', () => {
    const stats = analyzeOutBin();
    const logErrors = stats.parseErrors.filter((e) => e.includes('LOG'));
    console.log(`LOG 帧错误数: ${logErrors.length}`);
    expect(logErrors.length).toBe(0);
  });

  it('V2 格式应正确解析帧（带时间戳的 chunk）', () => {
    // 模拟录制：3 个 chunk，分别包含 LOG / RESOURCE / LOG帧，各有不同的 delta
    const chunks = [
      { deltaMs: 0,  data: makeLogFrameData('[SYS] Boot OK') },
      { deltaMs: 40, data: makeResourceFrameData(50, 800, 16000, 500, 90) },
      { deltaMs: 25, data: makeLogFrameData('[TRACK] pos=120,80') },
    ];

    const bin = makeBin(115200, chunks);

    // 验证 header
    expect(bin[0]).toBe(0x54); // T
    expect(bin[1]).toBe(0x56); // V
    expect(bin[2]).toBe(0x42); // B
    expect(bin[3]).toBe(0x49); // I
    expect(bin[4]).toBe(0x4E); // N
    expect(bin[5]).toBe(0x32); // 2

    // 验证 baud = 1152 (115200 / 100)
    const baudView = new DataView(bin.buffer, bin.byteOffset + 6, 2);
    expect(baudView.getUint16(0, true)).toBe(1152);

    // 解析帧
    const parser = new FrameParser();
    const results: Array<ReturnType<typeof parser.parse>[number]> = [];

    // 模拟 V2 加载：逐 chunk 跳过 header，提取 raw data 喂给 parser
    let off = 8; // magic(6) + baud(2)
    while (off + 4 <= bin.length) {
      const view = new DataView(bin.buffer, bin.byteOffset + off, 4);
      const deltaMs = view.getUint16(0, true);
      const len = view.getUint16(2, true);
      off += 4;

      expect(deltaMs).toBeGreaterThanOrEqual(0);
      expect(len).toBeGreaterThan(0);

      const rawChunk = bin.slice(off, off + len);
      off += len;
      results.push(...parser.parse(rawChunk));
    }

    const validFrames = results.filter((r) => !(r instanceof FrameParseError));
    expect(validFrames).toHaveLength(3);

    // 帧类型验证
    const types = validFrames.map((f: any) => f.type);
    expect(types).toEqual(['LOG', 'RESOURCE', 'LOG']);

    const log1 = validFrames[0] as any;
    expect(log1.logData).toBe('[SYS] Boot OK');

    const res = validFrames[1] as any;
    expect(res.type).toBe('RESOURCE');
    expect(res.length).toBe(9);
    expect(res.resData?.length).toBe(9);

    const log2 = validFrames[2] as any;
    expect(log2.logData).toBe('[TRACK] pos=120,80');
  });

  it('V2 格式分片帧应正确解析（帧跨 chunk 边界）', () => {
    // 模拟一个帧被拆成两个 chunk（模拟串口分片接收）
    const fullFrame = makeLogFrameData('[SYS] Split frame test OK');
    const splitAt = 5; // 在帧的第5字节处拆分

    const chunk1 = fullFrame.slice(0, splitAt);
    const chunk2 = fullFrame.slice(splitAt);

    const chunks = [
      { deltaMs: 0, data: chunk1 },
      { deltaMs: 15, data: chunk2 },
    ];

    const bin = makeBin(115200, chunks);

    // 解析
    const parser = new FrameParser();
    let off = 8;
    const allResults: Array<ReturnType<typeof parser.parse>[number]> = [];

    while (off + 4 <= bin.length) {
      const view = new DataView(bin.buffer, bin.byteOffset + off, 4);
      const len = view.getUint16(2, true);
      off += 4;
      const rawChunk = bin.slice(off, off + len);
      off += len;
      allResults.push(...parser.parse(rawChunk));
    }

    const validFrames = allResults.filter((r) => !(r instanceof FrameParseError));
    expect(validFrames).toHaveLength(1);

    const log = validFrames[0] as any;
    expect(log.type).toBe('LOG');
    expect(log.logData).toBe('[SYS] Split frame test OK');
  });

  it('V2 格式一个 chunk 含多个帧应正确解析', () => {
    // 一个 chunk 中包含多个帧（模拟串口缓冲区一次读取多个帧）
    const f1 = makeLogFrameData('[SYS] Frame 1');
    const f2 = makeResourceFrameData(30, 512, 8000, 300, 45);
    const f3 = makeLogFrameData('[SYS] Frame 3');

    const combined = new Uint8Array(f1.length + f2.length + f3.length);
    combined.set(f1, 0);
    combined.set(f2, f1.length);
    combined.set(f3, f1.length + f2.length);

    const bin = makeBin(115200, [
      { deltaMs: 0, data: combined },
    ]);

    const parser = new FrameParser();
    let off = 8;
    const view = new DataView(bin.buffer, bin.byteOffset + off, 4);
    const len = view.getUint16(2, true);
    off += 4;
    const rawChunk = bin.slice(off, off + len);
    const results = parser.parse(rawChunk);

    const validFrames = results.filter((r) => !(r instanceof FrameParseError));
    expect(validFrames).toHaveLength(3);

    const types = validFrames.map((f: any) => f.type);
    expect(types).toEqual(['LOG', 'RESOURCE', 'LOG']);
  });

  it('RESOURCE 帧应正确解析', () => {
    const stats = analyzeOutBin();
    const resErrors = stats.parseErrors.filter((e) => e.includes('RESOURCE'));
    console.log(`RESOURCE 帧错误数: ${resErrors.length}`);
    expect(resErrors.length).toBe(0);
  });
});
