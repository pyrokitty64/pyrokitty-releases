import sharp from 'sharp';

// ─── WASM OpenJPEG (replaces native opj_decompress / opj_compress binaries) ──

let wasmModule: any = null;

async function loadWasm() {
  if (wasmModule) return;
  const mod = (await import('@abasb75/jpeg2000-decoder')).default;
  wasmModule = await mod.OpenJPEGWASM();
}

/** Convert a J2C/J2K buffer to WebP via WASM decode + sharp */
export async function j2cToWebp(j2cBuffer: Buffer): Promise<Buffer> {
  const pngBuf = await j2cToPng(j2cBuffer);
  return await sharp(pngBuf).webp({ quality: 80 }).toBuffer();
}

/** Convert a J2C/J2K buffer to PNG via WASM decode + sharp */
export async function j2cToPng(j2cBuffer: Buffer): Promise<Buffer> {
  await loadWasm();
  const decoder = new wasmModule.J2KDecoder();
  try {
    const encoded = j2cBuffer.buffer.slice(j2cBuffer.byteOffset, j2cBuffer.byteOffset + j2cBuffer.byteLength);
    const encodedBuffer = decoder.getEncodedBuffer(encoded.byteLength);
    encodedBuffer.set(new Uint8Array(encoded));
    decoder.decode();

    const frameInfo = decoder.getFrameInfo();
    const { width, height, componentCount } = frameInfo;
    const decodedView = decoder.getDecodedBuffer();
    let pixels = Buffer.from(decodedView);

    // SL bake textures have 5 components (RGBA + bump). Sharp only handles 1-4.
    let channels = componentCount;
    if (componentCount > 4) {
      const pixelCount = width * height;
      const rgba = Buffer.allocUnsafe(pixelCount * 4);
      for (let i = 0; i < pixelCount; i++) {
        rgba[i * 4]     = pixels[i * componentCount];
        rgba[i * 4 + 1] = pixels[i * componentCount + 1];
        rgba[i * 4 + 2] = pixels[i * componentCount + 2];
        rgba[i * 4 + 3] = pixels[i * componentCount + 3];
      }
      pixels = rgba;
      channels = 4;
    }

    return await sharp(pixels, {
      raw: { width, height, channels: channels as 1 | 2 | 3 | 4 },
    }).png().toBuffer();
  } finally {
    decoder.delete();
  }
}

/** Decode a J2C/J2K buffer to raw RGBA pixels (for sculpt maps etc.) */
export async function j2cToRaw(j2cBuffer: Buffer): Promise<{ pixels: Buffer; width: number; height: number; channels: number }> {
  await loadWasm();
  const decoder = new wasmModule.J2KDecoder();
  try {
    const encoded = j2cBuffer.buffer.slice(j2cBuffer.byteOffset, j2cBuffer.byteOffset + j2cBuffer.byteLength);
    const encodedBuffer = decoder.getEncodedBuffer(encoded.byteLength);
    encodedBuffer.set(new Uint8Array(encoded));
    decoder.decode();

    const frameInfo = decoder.getFrameInfo();
    const { width, height, componentCount } = frameInfo;
    const decodedView = decoder.getDecodedBuffer();
    let pixels = Buffer.from(decodedView);
    let channels = componentCount;

    if (componentCount > 4) {
      const pixelCount = width * height;
      const rgba = Buffer.allocUnsafe(pixelCount * 4);
      for (let i = 0; i < pixelCount; i++) {
        rgba[i * 4]     = pixels[i * componentCount];
        rgba[i * 4 + 1] = pixels[i * componentCount + 1];
        rgba[i * 4 + 2] = pixels[i * componentCount + 2];
        rgba[i * 4 + 3] = pixels[i * componentCount + 3];
      }
      pixels = rgba;
      channels = 4;
    }

    return { pixels, width, height, channels };
  } finally {
    decoder.delete();
  }
}

/** Convert a PNG buffer to J2C/J2K via sharp → raw pixels → WASM encode */
export async function pngToJ2c(pngBuffer: Buffer): Promise<Buffer> {
  await loadWasm();
  const { data, info } = await sharp(pngBuffer).raw().toBuffer({ resolveWithObject: true });

  const encoder = new wasmModule.J2KEncoder();
  try {
    const decodedBuffer = encoder.getDecodedBuffer({
      width: info.width,
      height: info.height,
      bitsPerSample: 8,
      componentCount: info.channels,
      isSigned: false,
    });
    decodedBuffer.set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));

    encoder.setDecompositions(5);
    encoder.setQuality(false, 1);
    encoder.setCompressionRatio(0, 1);
    encoder.setProgressionOrder(2); // RPCL

    encoder.encode();

    const encoded = encoder.getEncodedBuffer();
    return Buffer.from(encoded);
  } finally {
    encoder.delete();
  }
}

/** WASM is always available — no binary dependency check needed */
export function isAvailable(): boolean {
  return true;
}
