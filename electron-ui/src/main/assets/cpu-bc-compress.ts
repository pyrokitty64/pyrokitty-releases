/**
 * cpu-bc-compress.ts — Pure TypeScript BC1/BC3 texture compressor.
 * Produces the same .bctex format as the GPU pipeline.
 * Runs in worker threads alongside the WASM J2K decoder.
 */

import {
  BctexFormat,
  computeMipChain,
  encodeBctex,
  type BctexHeader,
} from '../../gpu-compress/bctex-format';

// ─── RGB565 helpers ─────────────────────────────────────────────────

function toRgb565(r: number, g: number, b: number): number {
  return ((r >> 3) << 11) | ((g >> 2) << 5) | (b >> 3);
}

function from565r(c: number): number { return (c >> 11) & 0x1f; }
function from565g(c: number): number { return (c >> 5) & 0x3f; }
function from565b(c: number): number { return c & 0x1f; }

// Expand 565 to 8-bit (matching GPU hardware expansion)
function expand565(c: number): [number, number, number] {
  const r5 = from565r(c);
  const g6 = from565g(c);
  const b5 = from565b(c);
  return [(r5 << 3) | (r5 >> 2), (g6 << 2) | (g6 >> 4), (b5 << 3) | (b5 >> 2)];
}

// ─── BC1 block compression ─────────────────────────────────────────

/**
 * Compress a 4×4 block of RGBA pixels to BC1 (8 bytes).
 * Uses min/max endpoint selection with refinement.
 */
function compressBlockBC1(block: Uint8Array, out: Uint8Array, outOffset: number): void {
  // Extract RGB values for the 16 pixels
  const pixels: number[][] = [];
  for (let i = 0; i < 16; i++) {
    pixels.push([block[i * 4], block[i * 4 + 1], block[i * 4 + 2]]);
  }

  // Find min/max along the principal axis (simplified: use bounding box diagonal)
  let minR = 255, minG = 255, minB = 255;
  let maxR = 0, maxG = 0, maxB = 0;
  for (const [r, g, b] of pixels) {
    if (r < minR) minR = r;
    if (g < minG) minG = g;
    if (b < minB) minB = b;
    if (r > maxR) maxR = r;
    if (g > maxG) maxG = g;
    if (b > maxB) maxB = b;
  }

  // Inset bounding box by 1/16 to improve endpoint selection
  const insetR = (maxR - minR) >> 4;
  const insetG = (maxG - minG) >> 4;
  const insetB = (maxB - minB) >> 4;
  minR = Math.min(255, minR + insetR);
  minG = Math.min(255, minG + insetG);
  minB = Math.min(255, minB + insetB);
  maxR = Math.max(0, maxR - insetR);
  maxG = Math.max(0, maxG - insetG);
  maxB = Math.max(0, maxB - insetB);

  let color0 = toRgb565(maxR, maxG, maxB);
  let color1 = toRgb565(minR, minG, minB);

  // Ensure color0 > color1 for 4-color mode (no transparency)
  if (color0 < color1) {
    const tmp = color0; color0 = color1; color1 = tmp;
  }
  if (color0 === color1) {
    // Solid color block — write endpoints + zero indices
    out[outOffset] = color0 & 0xff;
    out[outOffset + 1] = color0 >> 8;
    out[outOffset + 2] = color1 & 0xff;
    out[outOffset + 3] = color1 >> 8;
    out[outOffset + 4] = 0;
    out[outOffset + 5] = 0;
    out[outOffset + 6] = 0;
    out[outOffset + 7] = 0;
    return;
  }

  // Build the 4 interpolated colors
  const [r0, g0, b0] = expand565(color0);
  const [r1, g1, b1] = expand565(color1);
  const palette = [
    [r0, g0, b0],
    [r1, g1, b1],
    [(2 * r0 + r1 + 1) / 3 | 0, (2 * g0 + g1 + 1) / 3 | 0, (2 * b0 + b1 + 1) / 3 | 0],
    [(r0 + 2 * r1 + 1) / 3 | 0, (g0 + 2 * g1 + 1) / 3 | 0, (b0 + 2 * b1 + 1) / 3 | 0],
  ];

  // Assign each pixel to closest palette entry
  let indices = 0;
  for (let i = 0; i < 16; i++) {
    const [pr, pg, pb] = pixels[i];
    let bestDist = Infinity;
    let bestIdx = 0;
    for (let j = 0; j < 4; j++) {
      const dr = pr - palette[j][0];
      const dg = pg - palette[j][1];
      const db = pb - palette[j][2];
      const dist = dr * dr + dg * dg + db * db;
      if (dist < bestDist) {
        bestDist = dist;
        bestIdx = j;
      }
    }
    indices |= bestIdx << (i * 2);
  }

  // Write output
  out[outOffset] = color0 & 0xff;
  out[outOffset + 1] = color0 >> 8;
  out[outOffset + 2] = color1 & 0xff;
  out[outOffset + 3] = color1 >> 8;
  out[outOffset + 4] = indices & 0xff;
  out[outOffset + 5] = (indices >> 8) & 0xff;
  out[outOffset + 6] = (indices >> 16) & 0xff;
  out[outOffset + 7] = (indices >> 24) & 0xff;
}

// ─── BC3 alpha block compression ────────────────────────────────────

/**
 * Compress the alpha channel of a 4×4 block to the BC3 alpha block (8 bytes).
 * Uses min/max endpoints with 8-level interpolation.
 */
function compressAlphaBlockBC3(block: Uint8Array, out: Uint8Array, outOffset: number): void {
  // Find min/max alpha
  let alpha0 = 0, alpha1 = 255;
  for (let i = 0; i < 16; i++) {
    const a = block[i * 4 + 3];
    if (a > alpha0) alpha0 = a;
    if (a < alpha1) alpha1 = a;
  }

  // Build 8-level palette
  const palette = new Uint8Array(8);
  palette[0] = alpha0;
  palette[1] = alpha1;
  if (alpha0 > alpha1) {
    for (let i = 1; i <= 6; i++) {
      palette[i + 1] = ((7 - i) * alpha0 + i * alpha1 + 3) / 7 | 0;
    }
  } else {
    for (let i = 1; i <= 4; i++) {
      palette[i + 1] = ((5 - i) * alpha0 + i * alpha1 + 2) / 5 | 0;
    }
    palette[6] = 0;
    palette[7] = 255;
  }

  // Assign each pixel to closest alpha
  let indices = 0n;
  for (let i = 0; i < 16; i++) {
    const a = block[i * 4 + 3];
    let bestDist = Infinity;
    let bestIdx = 0;
    for (let j = 0; j < 8; j++) {
      const d = Math.abs(a - palette[j]);
      if (d < bestDist) {
        bestDist = d;
        bestIdx = j;
      }
    }
    indices |= BigInt(bestIdx) << BigInt(i * 3);
  }

  // Write: 2 endpoint bytes + 6 index bytes (48 bits)
  out[outOffset] = alpha0;
  out[outOffset + 1] = alpha1;
  out[outOffset + 2] = Number(indices & 0xffn);
  out[outOffset + 3] = Number((indices >> 8n) & 0xffn);
  out[outOffset + 4] = Number((indices >> 16n) & 0xffn);
  out[outOffset + 5] = Number((indices >> 24n) & 0xffn);
  out[outOffset + 6] = Number((indices >> 32n) & 0xffn);
  out[outOffset + 7] = Number((indices >> 40n) & 0xffn);
}

// ─── Mipmap generation ──────────────────────────────────────────────

/** Box-filter downsample RGBA buffer by 2×. */
function downsample2x(
  src: Uint8Array, srcW: number, srcH: number,
): { pixels: Uint8Array; width: number; height: number } {
  const dstW = Math.max(1, srcW >> 1);
  const dstH = Math.max(1, srcH >> 1);
  const dst = new Uint8Array(dstW * dstH * 4);

  for (let y = 0; y < dstH; y++) {
    for (let x = 0; x < dstW; x++) {
      const sx = x * 2;
      const sy = y * 2;
      // Clamp source coords for non-power-of-two
      const sx1 = Math.min(sx + 1, srcW - 1);
      const sy1 = Math.min(sy + 1, srcH - 1);

      for (let c = 0; c < 4; c++) {
        const v =
          src[(sy * srcW + sx) * 4 + c] +
          src[(sy * srcW + sx1) * 4 + c] +
          src[(sy1 * srcW + sx) * 4 + c] +
          src[(sy1 * srcW + sx1) * 4 + c];
        dst[(y * dstW + x) * 4 + c] = (v + 2) >> 2;
      }
    }
  }

  return { pixels: dst, width: dstW, height: dstH };
}

// ─── Full compression pipeline ──────────────────────────────────────

/** Extract a 4×4 block from an RGBA image, clamping at edges. */
function extractBlock(
  src: Uint8Array, srcW: number, srcH: number,
  blockX: number, blockY: number,
): Uint8Array {
  const block = new Uint8Array(16 * 4);
  for (let py = 0; py < 4; py++) {
    for (let px = 0; px < 4; px++) {
      const sx = Math.min(blockX * 4 + px, srcW - 1);
      const sy = Math.min(blockY * 4 + py, srcH - 1);
      const srcIdx = (sy * srcW + sx) * 4;
      const dstIdx = (py * 4 + px) * 4;
      block[dstIdx] = src[srcIdx];
      block[dstIdx + 1] = src[srcIdx + 1];
      block[dstIdx + 2] = src[srcIdx + 2];
      block[dstIdx + 3] = src[srcIdx + 3];
    }
  }
  return block;
}

/** Compress a single mip level to BC1 or BC3. */
function compressMip(
  pixels: Uint8Array, width: number, height: number, format: BctexFormat,
): Uint8Array {
  const blocksX = Math.ceil(width / 4);
  const blocksY = Math.ceil(height / 4);
  const bytesPerBlock = format === BctexFormat.BC1 ? 8 : 16;
  const out = new Uint8Array(blocksX * blocksY * bytesPerBlock);

  for (let by = 0; by < blocksY; by++) {
    for (let bx = 0; bx < blocksX; bx++) {
      const block = extractBlock(pixels, width, height, bx, by);
      const outOffset = (by * blocksX + bx) * bytesPerBlock;

      if (format === BctexFormat.BC3) {
        compressAlphaBlockBC3(block, out, outOffset);
        compressBlockBC1(block, out, outOffset + 8);
      } else {
        compressBlockBC1(block, out, outOffset);
      }
    }
  }

  return out;
}

/** Check if any pixel has alpha < 250. */
function detectAlpha(rgba: Uint8Array): boolean {
  for (let i = 3; i < rgba.length; i += 4) {
    if (rgba[i] < 250) return true;
  }
  return false;
}

/**
 * Full CPU BC compression pipeline: alpha detect → mipmap gen → BC compress → .bctex encode.
 * Returns a Buffer ready to write to disk.
 */
export function cpuBcCompress(
  rgba: Buffer, width: number, height: number,
): { bctexBuf: Buffer; hasAlpha: boolean; mipCount: number } {
  const hasAlpha = detectAlpha(rgba);
  const format = hasAlpha ? BctexFormat.BC3 : BctexFormat.BC1;
  const chain = computeMipChain(width, height, format);

  // Compress each mip level
  const mipBuffers: Uint8Array[] = [];
  let currentPixels: Uint8Array = rgba;
  let currentW = width;
  let currentH = height;

  for (let i = 0; i < chain.widths.length; i++) {
    if (i > 0) {
      const ds = downsample2x(currentPixels, currentW, currentH);
      currentPixels = ds.pixels;
      currentW = ds.width;
      currentH = ds.height;
    }
    mipBuffers.push(compressMip(currentPixels, currentW, currentH, format));
  }

  // Concatenate all mip data
  const compressedData = Buffer.concat(mipBuffers.map(b => Buffer.from(b)));

  const header: BctexHeader = {
    width,
    height,
    format,
    mipCount: chain.widths.length,
    hasAlpha,
    dataSize: compressedData.length,
  };

  return {
    bctexBuf: encodeBctex(header, compressedData),
    hasAlpha,
    mipCount: chain.widths.length,
  };
}
