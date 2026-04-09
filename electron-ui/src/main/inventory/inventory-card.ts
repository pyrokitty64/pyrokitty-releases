/**
 * Monopoly-style inventory card renderer.
 *
 * Composites an asset-type color band, content image, item name, detail line,
 * and permission badges into a 512×512 PNG with embedded `pyrokitty:item`
 * tEXt metadata.  The card layout deliberately echoes a Monopoly property
 * card so it's instantly recognizable as "a thing I own."
 *
 * Uses sharp for image compositing and SVG for text/vector elements.
 * No extra native dependencies beyond what the project already has.
 */

import sharp from 'sharp';
import { readFile } from 'fs/promises';
import { join } from 'path';

// ── Asset-type color bands (Monopoly-style) ─────────────────────────────────

export const CARD_COLORS: Record<string, string> = {
  landmark:  '#2E7D32', // green  — property!
  clothing:  '#C62828', // red
  bodypart:  '#C62828', // red    — same family as clothing
  object:    '#1565C0', // blue
  animation: '#F9A825', // yellow
  sound:     '#EF6C00', // orange
  gesture:   '#6A1B9A', // purple
  notecard:  '#ECEFF1', // white-ish
  script:    '#ECEFF1', // white-ish
  texture:   '#00838F', // teal
  unknown:   '#616161', // grey
};

// ── Card dimensions ─────────────────────────────────────────────────────────

const CARD_W = 512;
const CARD_H = 640;          // portrait like a real Monopoly card
const BAND_H = 56;           // color band at top
const IMAGE_Y = BAND_H;
const IMAGE_H = 360;         // content image area (inner 456x336 ≈ 4:3)
const INFO_Y = IMAGE_Y + IMAGE_H;
const CARD_RADIUS = 16;
const CARD_BORDER = 3;
const CARD_BG = '#FFFDE7';  // warm cream, like aged card stock
const CARD_BORDER_COLOR = '#37474F'; // dark border

// ── Types ───────────────────────────────────────────────────────────────────

export interface CardMetadata {
  itemId: string;
  assetId: string;
  assetType: string;
  name: string;
  permissions?: { copy?: boolean; modify?: boolean; transfer?: boolean };
  attachmentPoint?: string;
  createdBy?: string;
  createdAt?: string;
  /** Extra detail for the card (region name, bone count, etc.) */
  detail?: string;
}

export interface CardOptions {
  /** The content image (parcel photo, mannequin render, map crop, etc.).
   *  If null, a placeholder silhouette is used. */
  contentImage?: Buffer | null;
  /** Metadata embedded in the PNG tEXt chunk and used for card text. */
  metadata: CardMetadata;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** Truncate text to fit roughly within a pixel width at a given font size. */
function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars - 1) + '\u2026';
}

function permissionLine(perms?: { copy?: boolean; modify?: boolean; transfer?: boolean }): string {
  if (!perms) return '';
  const flags: string[] = [];
  if (perms.copy) flags.push('Copy');
  if (perms.modify) flags.push('Modify');
  if (perms.transfer) flags.push('Transfer');
  return flags.join(' \u00b7 ') || 'No Permissions';
}

/** Human-friendly label for an asset type. */
function assetTypeLabel(type: string): string {
  const labels: Record<string, string> = {
    landmark: '\ud83c\udfe0 Landmark',
    clothing: '\ud83d\udc55 Clothing',
    bodypart: '\ud83e\uddd1 Body Part',
    object: '\ud83d\udce6 Object',
    animation: '\ud83c\udfac Animation',
    sound: '\ud83d\udd0a Sound',
    gesture: '\ud83d\udc4b Gesture',
    notecard: '\ud83d\udcdd Notecard',
    script: '\ud83d\udcdc Script',
    texture: '\ud83d\uddbc\ufe0f Texture',
  };
  return labels[type] || type.charAt(0).toUpperCase() + type.slice(1);
}

// ── SVG templates ───────────────────────────────────────────────────────────

// Template loading — checks process.resourcesPath (packaged) then __dirname relative (dev)
let frameTemplate = '';
let placeholderTemplate = '';

async function loadTemplates(): Promise<void> {
  if (frameTemplate) return;
  const candidates = [
    ...((process as any).resourcesPath ? [join((process as any).resourcesPath, 'shared')] : []),
    join(__dirname, '..', '..', '..', '..', 'shared'),
    join(__dirname, '..', '..', '..', 'shared'),
  ];
  for (const dir of candidates) {
    try {
      frameTemplate = await readFile(join(dir, 'card-frame.svg'), 'utf-8');
      placeholderTemplate = await readFile(join(dir, 'card-placeholder.svg'), 'utf-8');
      return;
    } catch { /* try next */ }
  }
  throw new Error('Could not find card SVG templates in shared/');
}

/** Fill {{key}} placeholders and {{#key}}...{{/key}} conditional blocks. */
function fillTemplate(template: string, vars: Record<string, string | number>): string {
  // Conditional blocks: {{#key}}content{{/key}} — kept if key is truthy, removed otherwise
  let result = template.replace(/\{\{#(\w+)\}\}([\s\S]*?)\{\{\/\1\}\}/g, (_, key, content) => {
    return vars[key] ? content : '';
  });
  // Simple substitution: {{key}}
  result = result.replace(/\{\{(\w+)\}\}/g, (_, key) => String(vars[key] ?? ''));
  return result;
}

/** Build the card frame SVG (everything except the content image). */
async function buildFrameSvg(meta: CardMetadata): Promise<Buffer> {
  await loadTemplates();
  const bandColor = CARD_COLORS[meta.assetType] || CARD_COLORS.unknown;
  const name = escapeXml(truncate(meta.name, 30));
  const typeLabel = escapeXml(assetTypeLabel(meta.assetType));
  const detail = meta.detail ? escapeXml(truncate(meta.detail, 40)) : '';
  const perms = escapeXml(permissionLine(meta.permissions));
  const bandTextColor = (meta.assetType === 'notecard' || meta.assetType === 'script')
    ? '#37474F' : '#FFFFFF';

  const svg = fillTemplate(frameTemplate, {
    CARD_W, CARD_H, CARD_RADIUS, CARD_BG, CARD_BORDER_COLOR,
    BAND_H,
    bandColor,
    bandTextX: CARD_W / 2,
    bandTextY: BAND_H / 2 + 7,
    bandTextColor,
    typeLabel,
    imageInsetY: IMAGE_Y + 8,
    imageInsetW: CARD_W - 48,
    imageInsetH: IMAGE_H - 16,
    dividerY: INFO_Y + 4,
    dividerX2: CARD_W - 32,
    textCenterX: CARD_W / 2,
    nameY: INFO_Y + 40,
    name,
    detail,
    detailY: INFO_Y + 68,
    perms,
    permsY: INFO_Y + (detail ? 100 : 72),
    borderStrokeW: CARD_BORDER * 2,
  });

  return Buffer.from(svg);
}

/** Placeholder SVG for when there's no content image. */
async function buildPlaceholderSvg(assetType: string): Promise<Buffer> {
  await loadTemplates();
  const color = CARD_COLORS[assetType] || CARD_COLORS.unknown;
  const w = CARD_W - 56;
  const h = IMAGE_H - 24;

  const svg = fillTemplate(placeholderTemplate, {
    w, h,
    cx: w / 2,
    cy: h / 2 + 8,
    color,
  });

  return Buffer.from(svg);
}

// ── PNG tEXt chunk injection ────────────────────────────────────────────────

/**
 * Inject a PNG tEXt chunk with key `pyrokitty:item` before the IEND chunk.
 * PNG spec: tEXt = keyword + null separator + text, wrapped in a chunk with
 * CRC-32.  We use the uncompressed tEXt type for maximum compatibility.
 */
function injectPngTextChunk(png: Buffer, key: string, value: string): Buffer {
  // Find IEND chunk (last 12 bytes of a valid PNG: length(4) + 'IEND'(4) + CRC(4))
  const iendOffset = png.lastIndexOf('IEND') - 4; // back up to the length field
  if (iendOffset < 8) return png; // safety: can't find IEND

  const keyBuf = Buffer.from(key, 'latin1');
  const valBuf = Buffer.from(value, 'latin1');
  const dataBuf = Buffer.concat([keyBuf, Buffer.from([0]), valBuf]);

  // Chunk: length(4) + type(4) + data + crc(4)
  const chunkType = Buffer.from('tEXt', 'ascii');
  const lengthBuf = Buffer.alloc(4);
  lengthBuf.writeUInt32BE(dataBuf.length, 0);

  // CRC-32 over type + data
  const crcData = Buffer.concat([chunkType, dataBuf]);
  const crc = crc32(crcData);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc, 0);

  const chunk = Buffer.concat([lengthBuf, chunkType, dataBuf, crcBuf]);

  // Splice: everything before IEND + our chunk + IEND
  const before = png.subarray(0, iendOffset);
  const iend = png.subarray(iendOffset);
  return Buffer.concat([before, chunk, iend]);
}

/** CRC-32 (PNG uses the same polynomial as zlib). */
function crc32(buf: Buffer): number {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let j = 0; j < 8; j++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xEDB88320 : 0);
    }
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Render a Monopoly-style inventory card PNG with embedded metadata.
 *
 * @returns A 512×640 PNG buffer with a `pyrokitty:item` tEXt chunk.
 */
export async function renderInventoryCard(options: CardOptions): Promise<Buffer> {
  const { metadata, contentImage } = options;

  // 1. Prepare the content image (resize/crop to fit the card's image area)
  const imgW = CARD_W - 56;   // 28px padding each side
  const imgH = IMAGE_H - 24;  // 12px padding top/bottom within the dark inset

  let contentBuf: Buffer;
  if (contentImage && contentImage.length > 0) {
    contentBuf = await sharp(contentImage)
      .resize(imgW, imgH, { fit: 'cover', position: 'centre' })
      .png()
      .toBuffer();
  } else {
    contentBuf = await buildPlaceholderSvg(metadata.assetType);
  }

  // 2. Build the card frame SVG
  const frameSvg = await buildFrameSvg(metadata);

  // 3. Composite: start with the frame, overlay the content image
  const composited = await sharp(frameSvg, { density: 72 })
    .resize(CARD_W, CARD_H)  // ensure SVG rasterizes at card size
    .composite([
      {
        input: contentBuf,
        left: 28,
        top: IMAGE_Y + 12,
      },
    ])
    .png()
    .toBuffer();

  // 4. Inject tEXt metadata
  const metaJson = JSON.stringify(metadata);
  const finalPng = injectPngTextChunk(composited, 'pyrokitty:item', metaJson);

  return finalPng;
}

/**
 * Read the `pyrokitty:item` tEXt chunk from a PNG buffer.
 * Returns the parsed metadata, or null if not found.
 */
export function readCardMetadata(png: Buffer): CardMetadata | null {
  const key = 'pyrokitty:item';
  const keyBuf = Buffer.from(key + '\0', 'latin1');

  // Walk PNG chunks looking for tEXt with our key
  let offset = 8; // skip PNG signature
  while (offset + 8 < png.length) {
    const chunkLen = png.readUInt32BE(offset);
    const chunkType = png.subarray(offset + 4, offset + 8).toString('ascii');

    if (chunkType === 'tEXt') {
      const data = png.subarray(offset + 8, offset + 8 + chunkLen);
      if (data.subarray(0, keyBuf.length).equals(keyBuf)) {
        const json = data.subarray(keyBuf.length).toString('latin1');
        try {
          return JSON.parse(json);
        } catch {
          return null;
        }
      }
    }

    offset += 12 + chunkLen; // length(4) + type(4) + data + crc(4)
  }
  return null;
}
