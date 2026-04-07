/**
 * texture-decode-worker.ts — Runs in a worker thread.
 * Uses WASM OpenJPEG decoder (cross-platform, no native binary needed).
 * Outputs raw RGBA for GPU compression, or CPU-compressed BC1/BC3 .bctex.
 */
import { parentPort } from 'worker_threads';
import sharp from 'sharp';
import { cpuBcCompress } from './cpu-bc-compress';

// ─── WASM decoder ────────────────────────────────────────────────────

let wasmModule: any = null;

async function loadWasmDecoder() {
  if (wasmModule) return;
  const mod = (await import('@abasb75/jpeg2000-decoder')).default;
  wasmModule = await mod.OpenJPEGWASM();
}

// ─── Raw RGBA decode ────────────────────────────────────────────────

async function decodeWasmRaw(j2cBuffer: Buffer): Promise<{ rgbaPixels: Buffer; width: number; height: number }> {
  await loadWasmDecoder();
  const decoder = new wasmModule.J2KDecoder();
  try {
    const encoded = j2cBuffer.buffer.slice(j2cBuffer.byteOffset, j2cBuffer.byteOffset + j2cBuffer.byteLength);
    const encodedBuffer = decoder.getEncodedBuffer(encoded.byteLength);
    encodedBuffer.set(new Uint8Array(encoded));

    decoder.decode();

    const frameInfo = decoder.getFrameInfo();
    const { width, height, componentCount } = frameInfo;
    if (!width || !height || !componentCount) {
      throw new Error(`J2C decode returned invalid frameInfo: ${width}x${height} ch=${componentCount} (input=${j2cBuffer.length} bytes, hdr=${j2cBuffer.slice(0,12).toString('hex')})`);
    }
    const decodedView = decoder.getDecodedBuffer();
    const pixels = Buffer.from(decodedView);

    // Fast path: pad RGB→RGBA or pass through RGBA without sharp overhead
    let rgbaPixels: Buffer;
    if (componentCount >= 4) {
      // 4 channels = RGBA. 5+ channels (SL bakes have 5 = RGBA+bump): take first 4.
      if (componentCount === 4) {
        rgbaPixels = pixels;
      } else {
        const pixelCount = width * height;
        rgbaPixels = Buffer.allocUnsafe(pixelCount * 4);
        for (let i = 0; i < pixelCount; i++) {
          rgbaPixels[i * 4]     = pixels[i * componentCount];
          rgbaPixels[i * 4 + 1] = pixels[i * componentCount + 1];
          rgbaPixels[i * 4 + 2] = pixels[i * componentCount + 2];
          rgbaPixels[i * 4 + 3] = pixels[i * componentCount + 3];
        }
      }
    } else if (componentCount === 3) {
      const pixelCount = width * height;
      rgbaPixels = Buffer.allocUnsafe(pixelCount * 4);
      for (let i = 0, j = 0; i < pixelCount; i++, j += 3) {
        rgbaPixels[i * 4]     = pixels[j];
        rgbaPixels[i * 4 + 1] = pixels[j + 1];
        rgbaPixels[i * 4 + 2] = pixels[j + 2];
        rgbaPixels[i * 4 + 3] = 255;
      }
    } else {
      // Grayscale (1-2 channels) — fall back to sharp
      rgbaPixels = await sharp(pixels, {
        raw: { width, height, channels: componentCount as 1 | 2 },
      }).ensureAlpha().raw().toBuffer();
    }

    return { rgbaPixels, width, height };
  } finally {
    decoder.delete();
  }
}

// ─── Message handler ────────────────────────────────────────────────

parentPort!.on('message', async (msg: { id: number; j2cBuffer: Buffer; mode?: 'raw' | 'bctex' }) => {
  try {
    const buf = Buffer.from(msg.j2cBuffer);

    if (msg.mode === 'bctex') {
      // CPU BC1/BC3 compression (fallback for no-GPU systems)
      const { rgbaPixels, width, height } = await decodeWasmRaw(buf);
      const { bctexBuf, hasAlpha, mipCount } = cpuBcCompress(rgbaPixels, width, height);
      parentPort!.postMessage(
        { id: msg.id, bctexBuf, hasAlpha, mipCount, width, height },
        [bctexBuf.buffer as ArrayBuffer],
      );
    } else {
      // Raw RGBA output for GPU compression pipeline
      const { rgbaPixels, width, height } = await decodeWasmRaw(buf);
      parentPort!.postMessage(
        { id: msg.id, rgbaPixels, width, height },
        [rgbaPixels.buffer as ArrayBuffer],
      );
    }
  } catch (err) {
    parentPort!.postMessage({ id: msg.id, error: (err as Error).message || String(err) });
  }
});
