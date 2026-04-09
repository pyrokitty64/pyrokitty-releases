import { describe, it, expect } from 'vitest';
import { parseLandmarkAsset } from '../inventory/landmark-strategy';

describe('landmark-strategy', () => {
  it('parses a standard landmark asset', () => {
    const buf = Buffer.from(
      'Landmark version 2\nregion_id 7020d2b2-7a01-4be2-b6b2-916516cb0844\nlocal_pos 128.3 64.7 24.1\n',
    );
    const result = parseLandmarkAsset(buf);
    expect(result).not.toBeNull();
    expect(result!.regionId).toBe('7020d2b2-7a01-4be2-b6b2-916516cb0844');
    expect(result!.localX).toBeCloseTo(128.3);
    expect(result!.localY).toBeCloseTo(64.7);
    expect(result!.localZ).toBeCloseTo(24.1);
  });

  it('parses landmark without position (defaults to 128,128,0)', () => {
    const buf = Buffer.from('Landmark version 2\nregion_id abcdef01-2345-6789-abcd-ef0123456789\n');
    const result = parseLandmarkAsset(buf);
    expect(result).not.toBeNull();
    expect(result!.regionId).toBe('abcdef01-2345-6789-abcd-ef0123456789');
    expect(result!.localX).toBe(128);
    expect(result!.localY).toBe(128);
    expect(result!.localZ).toBe(0);
  });

  it('returns null for garbage data', () => {
    const buf = Buffer.from('this is not a landmark');
    expect(parseLandmarkAsset(buf)).toBeNull();
  });

  it('handles scientific notation in coordinates', () => {
    const buf = Buffer.from(
      'Landmark version 2\nregion_id 12345678-1234-1234-1234-123456789abc\nlocal_pos 1.5e+2 2.0e+1 0.0e+0\n',
    );
    const result = parseLandmarkAsset(buf);
    expect(result).not.toBeNull();
    expect(result!.localX).toBeCloseTo(150);
    expect(result!.localY).toBeCloseTo(20);
    expect(result!.localZ).toBeCloseTo(0);
  });
});
