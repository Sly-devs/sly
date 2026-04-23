import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export function generateScannerKey(environment: 'test' | 'live' = 'test'): string {
  const randomPart = randomBytes(24).toString('base64url');
  return `psk_${environment}_${randomPart}`;
}

export function hashScannerKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

export function getScannerKeyPrefix(key: string): string {
  return key.slice(0, 12);
}

export function verifyScannerKey(providedKey: string, storedHash: string): boolean {
  try {
    const providedBuffer = Buffer.from(hashScannerKey(providedKey), 'hex');
    const storedBuffer = Buffer.from(storedHash, 'hex');
    if (providedBuffer.length !== storedBuffer.length) return false;
    return timingSafeEqual(providedBuffer, storedBuffer);
  } catch {
    return false;
  }
}

export function maskScannerKey(key: string): string {
  if (key.length < 16) return '***';
  return `${key.slice(0, 12)}...${key.slice(-4)}`;
}
