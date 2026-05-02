import { describe, expect, it, vi } from 'vitest';
import {
  AuthenticationError,
  InsufficientCreditsError,
  RateLimitError,
  Scanner,
  ScannerError,
  ValidationError,
} from '../src/index.js';

function mockJsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

describe('Scanner SDK', () => {
  describe('construction', () => {
    it('throws if apiKey is missing', () => {
      expect(() => new Scanner({ apiKey: '' })).toThrow(/apiKey is required/);
    });

    it('infers environment=live from psk_live_* prefix', async () => {
      const fetchSpy = vi.fn().mockResolvedValue(mockJsonResponse(200, {}));
      const scanner = new Scanner({ apiKey: 'psk_live_abc', fetch: fetchSpy as any });
      await scanner.getBalance().catch(() => {});
      const headers = (fetchSpy.mock.calls[0]![1] as RequestInit).headers as Record<string, string>;
      expect(headers['X-Environment']).toBe('live');
    });

    it('infers environment=test from psk_test_* prefix', async () => {
      const fetchSpy = vi.fn().mockResolvedValue(mockJsonResponse(200, {}));
      const scanner = new Scanner({ apiKey: 'psk_test_xyz', fetch: fetchSpy as any });
      await scanner.getBalance().catch(() => {});
      const headers = (fetchSpy.mock.calls[0]![1] as RequestInit).headers as Record<string, string>;
      expect(headers['X-Environment']).toBe('test');
    });
  });

  describe('scan()', () => {
    it('POSTs to /v1/scanner/scan with the domain body', async () => {
      const fetchSpy = vi.fn().mockResolvedValue(
        mockJsonResponse(200, {
          id: 'scan_1',
          domain: 'shopify.com',
          readiness_score: 38,
          scan_status: 'completed',
        }),
      );
      const scanner = new Scanner({ apiKey: 'psk_test_x', fetch: fetchSpy as any });
      const result = await scanner.scan({ domain: 'shopify.com' });

      expect(result.readiness_score).toBe(38);
      const [url, init] = fetchSpy.mock.calls[0]!;
      expect(String(url)).toContain('/v1/scanner/scan');
      expect((init as RequestInit).method).toBe('POST');
      expect((init as RequestInit).body).toBe(JSON.stringify({ domain: 'shopify.com' }));
    });

    it('throws InsufficientCreditsError on 402', async () => {
      // mockImplementation returns a fresh Response each call (the body stream
      // can only be read once, so mockResolvedValue would burn after the first).
      const fetchSpy = vi.fn().mockImplementation(() =>
        Promise.resolve(
          mockJsonResponse(402, {
            error: 'insufficient_credits',
            balance: 0,
            required: 1,
            docs: 'https://docs.getsly.ai/scanner/credits-and-billing',
          }),
        ),
      );
      const scanner = new Scanner({ apiKey: 'psk_test_x', fetch: fetchSpy as any });

      try {
        await scanner.scan({ domain: 'a.com' });
        throw new Error('expected scan() to throw');
      } catch (err) {
        expect(err).toBeInstanceOf(InsufficientCreditsError);
        const e = err as InsufficientCreditsError;
        expect(e.balance).toBe(0);
        expect(e.required).toBe(1);
        expect(e.docs).toContain('docs.getsly.ai');
      }
    });

    it('throws ValidationError on 400 with field errors', async () => {
      const fetchSpy = vi.fn().mockResolvedValue(
        mockJsonResponse(400, {
          error: 'Validation error',
          details: { fieldErrors: { domain: ['Required'] }, formErrors: [] },
        }),
      );
      const scanner = new Scanner({ apiKey: 'psk_test_x', fetch: fetchSpy as any });

      try {
        await scanner.scan({ domain: '' });
      } catch (err) {
        expect(err).toBeInstanceOf(ValidationError);
        expect((err as ValidationError).fieldErrors.domain).toEqual(['Required']);
      }
    });

    it('throws AuthenticationError on 401', async () => {
      const fetchSpy = vi.fn().mockResolvedValue(mockJsonResponse(401, { error: 'unauthorized' }));
      const scanner = new Scanner({ apiKey: 'psk_test_bogus', fetch: fetchSpy as any });
      await expect(scanner.scan({ domain: 'a.com' })).rejects.toThrow(AuthenticationError);
    });
  });

  describe('balance tracking', () => {
    it('updates .balance from X-Credits-Remaining response header', async () => {
      const fetchSpy = vi.fn().mockResolvedValue(
        mockJsonResponse(
          200,
          { id: 'scan_1', domain: 'a.com', readiness_score: 50, scan_status: 'completed' },
          { 'x-credits-remaining': '99' },
        ),
      );
      const scanner = new Scanner({ apiKey: 'psk_test_x', fetch: fetchSpy as any });

      expect(scanner.balance).toBeNull();
      await scanner.scan({ domain: 'a.com' });
      expect(scanner.balance).toBe(99);
    });
  });

  describe('retry', () => {
    it('retries on 429 honoring Retry-After', async () => {
      let calls = 0;
      const fetchSpy = vi.fn().mockImplementation(() => {
        calls++;
        if (calls === 1) {
          return Promise.resolve(
            mockJsonResponse(
              429,
              { error: 'rate_limit_exceeded', limit: 60 },
              { 'retry-after': '0' },
            ),
          );
        }
        return Promise.resolve(
          mockJsonResponse(200, { id: 's', domain: 'a.com', scan_status: 'completed', readiness_score: 1 }),
        );
      });
      const scanner = new Scanner({
        apiKey: 'psk_test_x',
        fetch: fetchSpy as any,
        retry: { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 10 },
      });

      const result = await scanner.scan({ domain: 'a.com' });
      expect(result.readiness_score).toBe(1);
      expect(calls).toBe(2);
    });

    it('does NOT retry on 402 (deterministic)', async () => {
      let calls = 0;
      const fetchSpy = vi.fn().mockImplementation(() => {
        calls++;
        return Promise.resolve(mockJsonResponse(402, { balance: 0, required: 1 }));
      });
      const scanner = new Scanner({
        apiKey: 'psk_test_x',
        fetch: fetchSpy as any,
        retry: { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 10 },
      });

      await expect(scanner.scan({ domain: 'a.com' })).rejects.toThrow(InsufficientCreditsError);
      expect(calls).toBe(1);
    });

    it('throws RateLimitError after exhausting retries', async () => {
      const fetchSpy = vi.fn().mockResolvedValue(
        mockJsonResponse(429, { error: 'rate_limit_exceeded', limit: 60 }, { 'retry-after': '0' }),
      );
      const scanner = new Scanner({
        apiKey: 'psk_test_x',
        fetch: fetchSpy as any,
        retry: { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 10 },
      });

      await expect(scanner.scan({ domain: 'a.com' })).rejects.toThrow(RateLimitError);
    });
  });

  describe('ledger pagination', () => {
    it('iterateLedger() walks across pages', async () => {
      let call = 0;
      const fetchSpy = vi.fn().mockImplementation((url: any) => {
        call++;
        const u = new URL(String(url));
        const page = Number(u.searchParams.get('page') ?? '1');
        const data = page === 1 ? [{ id: '1' }, { id: '2' }] : [{ id: '3' }];
        return Promise.resolve(
          mockJsonResponse(200, {
            data,
            pagination: { page, limit: 2, total: 3, totalPages: 2 },
          }),
        );
      });
      const scanner = new Scanner({ apiKey: 'psk_test_x', fetch: fetchSpy as any });

      const ids: string[] = [];
      for await (const entry of scanner.iterateLedger({ limit: 2 })) {
        ids.push(entry.id);
      }
      expect(ids).toEqual(['1', '2', '3']);
      expect(call).toBe(2);
    });
  });

  describe('error hierarchy', () => {
    it('all typed errors extend ScannerError', async () => {
      const fetchSpy = vi.fn().mockResolvedValue(mockJsonResponse(500, { error: 'boom' }));
      const scanner = new Scanner({
        apiKey: 'psk_test_x',
        fetch: fetchSpy as any,
        retry: { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 10 },
      });

      try {
        await scanner.scan({ domain: 'a.com' });
      } catch (err) {
        expect(err).toBeInstanceOf(ScannerError);
        expect((err as ScannerError).status).toBe(500);
      }
    });
  });
});
