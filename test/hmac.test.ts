import { describe, expect, it } from 'vitest';
import syncMin from './fixtures/ldc-payload-sync.composed.min.json?raw';
import syncSig from './fixtures/ldc-payload-sync.composed.min.json.sig?raw';
import { verifySignature } from '../src/hmac';

const SECRET = '3f9a1c0e5b7d2e4f6a8c0b1d3e5f7a9c2b4d6e8f0a1c3e5b7d9f1a2c4e6b8d0f';
const body = new TextEncoder().encode(syncMin);
const header = /X-Signature: (sha256=[0-9a-f]{64})/.exec(syncSig)?.[1] ?? '';

describe('verifySignature', () => {
  it('accepts the exporter signature over the exact bytes, keyed with the secret as UTF-8', async () => {
    expect(header).toBe('sha256=bf67586097ef76882ff79f175e2a9b5bedcbcb57901d1b4c72f77bcca8cdcc2c');
    expect(await verifySignature(SECRET, body, header)).toBe(true);
  });

  it('refuses a changed byte, a hex-decoded key, and malformed headers', async () => {
    const changed = new TextEncoder().encode(syncMin.replace('"count":38', '"count":39'));
    expect(await verifySignature(SECRET, changed, header)).toBe(false);
    const hexKey = String.fromCharCode(...(SECRET.match(/../g) ?? []).map((h) => parseInt(h, 16)));
    expect(await verifySignature(hexKey, body, header)).toBe(false);
    for (const bad of [null, '', header.slice(7), header.toUpperCase(), `${header}0`, 'sha1=' + header.slice(7)]) {
      expect(await verifySignature(SECRET, body, bad)).toBe(false);
    }
  });
});
