import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { distanceMatrixUrl } from '../../src/adapters/real.js';

describe('Distance Matrix request (D-11)', () => {
  it('is byte-identical to legacy google-distance-matrix 1.1.1 (captured from its qs output)', () => {
    expect(distanceMatrixUrl('KEY', '36.7,3.05', '36.75,3.06')).toBe(
      'https://maps.googleapis.com/maps/api/distancematrix/json?origins=36.7%2C3.05&destinations=36.75%2C3.06&mode=driving&units=metric&language=en&avoid=&key=KEY',
    );
  });
});

describe('file URLs (F-1)', () => {
  // Legacy @parse/s3-files-adapter 1.4.0 getFileLocation, directAccess + baseUrl, bucketPrefix ''.
  const legacyUrl = (baseUrl: string, filename: string) =>
    `${baseUrl}/${'' + filename.split('/').map(encodeURIComponent).join('/')}`;

  it('the v5 adapter builds the same URL as 1.4.0 for tricky names', async () => {
    const require = createRequire(import.meta.url);
    const S3Adapter = require('@parse/s3-files-adapter') as new (o: Record<string, unknown>) => {
      getFileLocation(config: unknown, name: string): Promise<string>;
    };
    const baseUrl = 'https://switchfood.fra1.cdn.digitaloceanspaces.com';
    const adapter = new S3Adapter({
      bucket: 'switchfood',
      baseUrl,
      directAccess: true,
      region: 'us-east-1',
      s3overrides: {
        endpoint: 'https://fra1.digitaloceanspaces.com',
        credentials: { accessKeyId: 'x', secretAccessKey: 'y' },
      },
    });
    const names = [
      '0f1e2d3c4b5a69788796a5b4c3d2e1f0__Profile.jpeg',
      'a1b2_photo de profil.jpg',
      'a1b2_plus+sign.png',
      'a1b2_صورة.webp',
      'a1b2_é à ü.gif',
      'a1b2_100%.jpg',
      'dir/sub/a b.jpg',
      "a1b2_it's#1?.png",
    ];
    for (const name of names) {
      expect(await adapter.getFileLocation({ mount: 'x', applicationId: 'switchApp' }, name)).toBe(
        legacyUrl(baseUrl, name),
      );
    }
  });
});
