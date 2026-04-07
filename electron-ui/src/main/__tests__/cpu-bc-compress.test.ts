import { describe, it, expect } from 'vitest';
import { cpuBcCompress } from '../assets/cpu-bc-compress';
import { decodeBctexHeader, BctexFormat, BCTEX_MAGIC, BCTEX_VERSION, computeMipChain } from '../../gpu-compress/bctex-format';

/** Create a solid-color RGBA buffer. */
function solidRgba(w: number, h: number, r: number, g: number, b: number, a = 255): Buffer {
  const buf = Buffer.alloc(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    buf[i * 4] = r;
    buf[i * 4 + 1] = g;
    buf[i * 4 + 2] = b;
    buf[i * 4 + 3] = a;
  }
  return buf;
}

describe('cpuBcCompress', () => {
  it('produces valid BC1 bctex for an opaque texture', () => {
    const rgba = solidRgba(8, 8, 200, 100, 50);
    const { bctexBuf, hasAlpha, mipCount } = cpuBcCompress(rgba, 8, 8);

    expect(hasAlpha).toBe(false);

    const header = decodeBctexHeader(bctexBuf);
    expect(header).not.toBeNull();
    expect(header!.width).toBe(8);
    expect(header!.height).toBe(8);
    expect(header!.format).toBe(BctexFormat.BC1);
    expect(header!.hasAlpha).toBe(false);
    expect(header!.mipCount).toBe(mipCount);

    // Verify total data size matches expected mip chain
    const chain = computeMipChain(8, 8, BctexFormat.BC1);
    expect(header!.dataSize).toBe(chain.totalSize);
    expect(bctexBuf.length).toBe(32 + chain.totalSize);
  });

  it('produces valid BC3 bctex for a texture with alpha', () => {
    const rgba = solidRgba(16, 16, 100, 150, 200, 128);
    const { bctexBuf, hasAlpha, mipCount } = cpuBcCompress(rgba, 16, 16);

    expect(hasAlpha).toBe(true);

    const header = decodeBctexHeader(bctexBuf);
    expect(header).not.toBeNull();
    expect(header!.width).toBe(16);
    expect(header!.height).toBe(16);
    expect(header!.format).toBe(BctexFormat.BC3);
    expect(header!.hasAlpha).toBe(true);
    expect(header!.mipCount).toBe(mipCount);

    const chain = computeMipChain(16, 16, BctexFormat.BC3);
    expect(header!.dataSize).toBe(chain.totalSize);
  });

  it('handles non-power-of-two dimensions', () => {
    const rgba = solidRgba(6, 10, 255, 0, 0);
    const { bctexBuf, hasAlpha } = cpuBcCompress(rgba, 6, 10);

    expect(hasAlpha).toBe(false);
    const header = decodeBctexHeader(bctexBuf);
    expect(header).not.toBeNull();
    expect(header!.width).toBe(6);
    expect(header!.height).toBe(10);
  });

  it('handles 1x1 texture', () => {
    const rgba = solidRgba(1, 1, 0, 255, 0);
    const { bctexBuf, mipCount } = cpuBcCompress(rgba, 1, 1);

    expect(mipCount).toBe(1);
    const header = decodeBctexHeader(bctexBuf);
    expect(header).not.toBeNull();
    expect(header!.width).toBe(1);
    expect(header!.height).toBe(1);
    // 1x1 = 1 block = 8 bytes BC1
    expect(header!.dataSize).toBe(8);
  });

  it('handles 4x4 texture (single block)', () => {
    const rgba = solidRgba(4, 4, 128, 128, 128);
    const { bctexBuf } = cpuBcCompress(rgba, 4, 4);

    const header = decodeBctexHeader(bctexBuf);
    expect(header).not.toBeNull();
    // 4x4 → mips: 4x4, 2x2, 1x1 = 3 mips, each 1 block = 8 bytes BC1
    expect(header!.mipCount).toBe(3);
    expect(header!.dataSize).toBe(8 * 3);
  });

  it('detects alpha threshold at 250', () => {
    // Alpha 250 = opaque
    const opaque = solidRgba(4, 4, 100, 100, 100, 250);
    expect(cpuBcCompress(opaque, 4, 4).hasAlpha).toBe(false);

    // Alpha 249 = has alpha
    const transparent = solidRgba(4, 4, 100, 100, 100, 249);
    expect(cpuBcCompress(transparent, 4, 4).hasAlpha).toBe(true);
  });

  it('produces correct mip chain for 512x512', () => {
    const rgba = solidRgba(512, 512, 50, 100, 150);
    const { bctexBuf, mipCount } = cpuBcCompress(rgba, 512, 512);

    // 512 → 256 → 128 → 64 → 32 → 16 → 8 → 4 → 2 → 1 = 10 mips
    expect(mipCount).toBe(10);

    const header = decodeBctexHeader(bctexBuf);
    const chain = computeMipChain(512, 512, BctexFormat.BC1);
    expect(header!.dataSize).toBe(chain.totalSize);
  });
});
