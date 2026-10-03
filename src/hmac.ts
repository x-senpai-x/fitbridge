const HEADER = /^sha256=([0-9a-f]{64})$/;

export async function verifySignature(secret: string, body: BufferSource, header: string | null): Promise<boolean> {
  const hex = HEADER.exec(header ?? '')?.[1];
  if (hex === undefined) return false;
  const signature = new Uint8Array(32);
  for (let i = 0; i < 32; i++) signature[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  // The exporter keys the HMAC with the secret's UTF-8 bytes, not its hex decoding.
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify'],
  );
  return crypto.subtle.verify('HMAC', key, signature, body);
}
