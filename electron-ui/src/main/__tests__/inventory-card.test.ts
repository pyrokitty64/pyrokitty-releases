import { describe, it, expect, afterAll } from 'vitest';
import { writeFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import { renderInventoryCard, readCardMetadata, type CardMetadata } from '../inventory/inventory-card';

const TEST_DIR = __dirname;
const testFiles: string[] = [];

function writeTestCard(name: string, buf: Buffer) {
  const path = join(TEST_DIR, "img", name);
  writeFileSync(path, buf);
  testFiles.push(path);
}

afterAll(() => {
  for (const f of testFiles) {
    // try { unlinkSync(f); } catch { /* already gone */ }
  }
});

describe('inventory-card', () => {
  const landmarkMeta: CardMetadata = {
    itemId: '11111111-2222-3333-4444-555555555555',
    assetId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    assetType: 'landmark',
    name: 'Cool Beach House',
    detail: 'Bellisseria (128, 64, 24)',
    permissions: { copy: true, modify: true, transfer: false },
  };

  it('renders a landmark card PNG', async () => {
    const png = await renderInventoryCard({ metadata: landmarkMeta });
    expect(png.length).toBeGreaterThan(1000);
    expect(png[0]).toBe(0x89);
    expect(png.subarray(1, 4).toString('ascii')).toBe('PNG');
    writeTestCard('test-card-landmark.png', png);
  });

  it('round-trips metadata through tEXt chunk', async () => {
    const png = await renderInventoryCard({ metadata: landmarkMeta });
    const read = readCardMetadata(png);
    expect(read).not.toBeNull();
    expect(read!.name).toBe('Cool Beach House');
    expect(read!.assetType).toBe('landmark');
    expect(read!.detail).toBe('Bellisseria (128, 64, 24)');
    expect(read!.permissions).toEqual({ copy: true, modify: true, transfer: false });
    expect(read!.itemId).toBe('11111111-2222-3333-4444-555555555555');
  });

  it('renders all asset type color variants', async () => {
    const types = ['landmark', 'clothing', 'object', 'animation', 'sound', 'gesture', 'notecard', 'texture'];
    for (const assetType of types) {
      const meta: CardMetadata = {
        itemId: '00000000-0000-0000-0000-000000000000',
        assetId: '00000000-0000-0000-0000-000000000001',
        assetType,
        name: `Test ${assetType}`,
        detail: 'Detail line',
        permissions: { copy: true, modify: true, transfer: true },
      };
      const png = await renderInventoryCard({ metadata: meta });
      expect(png.length).toBeGreaterThan(1000);
      writeTestCard(`test-card-${assetType}.png`, png);
    }
  });

  it('handles missing permissions gracefully', async () => {
    const meta: CardMetadata = {
      itemId: '00000000-0000-0000-0000-000000000000',
      assetId: '00000000-0000-0000-0000-000000000001',
      assetType: 'object',
      name: 'No Perms Object',
    };
    const png = await renderInventoryCard({ metadata: meta });
    const read = readCardMetadata(png);
    expect(read).not.toBeNull();
    expect(read!.name).toBe('No Perms Object');
    expect(read!.permissions).toBeUndefined();
  });

  it('truncates long names', async () => {
    const meta: CardMetadata = {
      itemId: '00000000-0000-0000-0000-000000000000',
      assetId: '00000000-0000-0000-0000-000000000001',
      assetType: 'clothing',
      name: 'This Is An Extremely Long Item Name That Should Be Truncated On The Card',
      detail: 'But metadata preserves the full name',
    };
    const png = await renderInventoryCard({ metadata: meta });
    const read = readCardMetadata(png);
    expect(read!.name).toBe(meta.name);
    writeTestCard('test-card-longname.png', png);
  });

  it('returns null for a PNG without metadata', async () => {
    const sharp = (await import('sharp')).default;
    const plainPng = await sharp({ create: { width: 1, height: 1, channels: 3, background: '#fff' } })
      .png()
      .toBuffer();
    const read = readCardMetadata(plainPng);
    expect(read).toBeNull();
  });
});
