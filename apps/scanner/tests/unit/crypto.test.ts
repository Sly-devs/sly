import { describe, it, expect } from 'vitest';
import {
  generateScannerKey,
  hashScannerKey,
  getScannerKeyPrefix,
  verifyScannerKey,
  maskScannerKey,
} from '../../src/utils/crypto.js';

describe('scanner crypto', () => {
  it('generateScannerKey produces the expected prefix', () => {
    const liveKey = generateScannerKey('live');
    const testKey = generateScannerKey('test');
    expect(liveKey.startsWith('psk_live_')).toBe(true);
    expect(testKey.startsWith('psk_test_')).toBe(true);
    expect(liveKey.length).toBeGreaterThanOrEqual(40);
  });

  it('generates unique keys', () => {
    const keys = new Set(Array.from({ length: 100 }, () => generateScannerKey('test')));
    expect(keys.size).toBe(100);
  });

  it('hashScannerKey returns a 64-char hex SHA-256 digest', () => {
    const hash = hashScannerKey('psk_test_abc');
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('getScannerKeyPrefix returns the first 12 chars', () => {
    const key = 'psk_live_abcdefghij';
    expect(getScannerKeyPrefix(key)).toBe('psk_live_abc');
    expect(getScannerKeyPrefix(key).length).toBe(12);
  });

  it('verifyScannerKey matches against the correct hash', () => {
    const key = generateScannerKey('live');
    const hash = hashScannerKey(key);
    expect(verifyScannerKey(key, hash)).toBe(true);
    expect(verifyScannerKey(key, hash.replace(/^./, '0'))).toBe(false);
    expect(verifyScannerKey('psk_live_wrong', hash)).toBe(false);
  });

  it('verifyScannerKey is resilient to malformed hashes', () => {
    const key = generateScannerKey('test');
    expect(verifyScannerKey(key, '')).toBe(false);
    expect(verifyScannerKey(key, 'notahex')).toBe(false);
    expect(verifyScannerKey(key, 'abc')).toBe(false);
  });

  it('maskScannerKey keeps prefix and last 4', () => {
    const key = 'psk_test_abcdefghijklmnop';
    const masked = maskScannerKey(key);
    expect(masked.startsWith('psk_test_abc')).toBe(true);
    expect(masked.endsWith('mnop')).toBe(true);
    expect(masked).toContain('...');
  });

  it('maskScannerKey handles short inputs safely', () => {
    expect(maskScannerKey('short')).toBe('***');
  });
});
