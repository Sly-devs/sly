/**
 * Bazaar extension validator + builder tests.
 *
 * Coverage targets (the only behavior worth pinning):
 *  - description bounds (≥20, ≤280)
 *  - POST/PUT/PATCH require bodyType:json + input schema + example
 *  - JSON-Schema validity check (rejects nonsense)
 *  - example must validate against the inputSchema/outputSchema
 *  - GET path produces a clean extension envelope
 */
import { describe, it, expect } from 'vitest';
import {
  buildBazaarExtension,
  validateBazaarExtension,
} from '../../src/services/bazaar-extension.js';
import { BazaarValidationError } from '../../src/middleware/error.js';

const goodOutputSchema = {
  type: 'object',
  properties: { temp: { type: 'number' } },
  required: ['temp'],
};
const goodOutputExample = { temp: 72 };

const goodInputSchema = {
  type: 'object',
  properties: { city: { type: 'string' } },
  required: ['city'],
};
const goodInputExample = { city: 'New York' };

describe('validateBazaarExtension', () => {
  describe('description bounds', () => {
    it('rejects descriptions shorter than 20 characters', () => {
      const errs = validateBazaarExtension({
        endpoint: { method: 'GET' },
        description: 'too short',
      });
      const desc = errs.find((e) => e.field === 'description');
      expect(desc).toBeDefined();
      expect(desc!.reason).toMatch(/at least 20 characters/);
    });

    it('rejects descriptions longer than 280 characters', () => {
      const errs = validateBazaarExtension({
        endpoint: { method: 'GET' },
        description: 'a'.repeat(281),
      });
      const desc = errs.find((e) => e.field === 'description');
      expect(desc).toBeDefined();
      expect(desc!.reason).toMatch(/at most 280 characters/);
    });

    it('accepts a 20-character description', () => {
      const errs = validateBazaarExtension({
        endpoint: { method: 'GET' },
        description: 'Twenty char descriptn',
      });
      expect(errs.find((e) => e.field === 'description')).toBeUndefined();
    });
  });

  describe('GET endpoint', () => {
    it('passes with description + output schema/example', () => {
      const errs = validateBazaarExtension({
        endpoint: { method: 'GET' },
        description: 'Returns a weather forecast for the requested city.',
        schemas: { output: goodOutputSchema },
        examples: { output: goodOutputExample },
      });
      expect(errs).toEqual([]);
    });

    it('does not require an input schema', () => {
      const errs = validateBazaarExtension({
        endpoint: { method: 'GET' },
        description: 'Returns a weather forecast for the requested city.',
      });
      expect(errs).toEqual([]);
    });

    it('rejects an output example that does not match the output schema', () => {
      const errs = validateBazaarExtension({
        endpoint: { method: 'GET' },
        description: 'Returns a weather forecast for the requested city.',
        schemas: { output: goodOutputSchema },
        examples: { output: { wrongField: 'oops' } },
      });
      expect(errs.some((e) => e.field === 'examples.output')).toBe(true);
    });
  });

  describe('POST endpoint', () => {
    it('requires bodyType:"json"', () => {
      const errs = validateBazaarExtension({
        endpoint: { method: 'POST' },
        description: 'Submits a city to look up its weather forecast.',
        schemas: { input: goodInputSchema },
        examples: { input: goodInputExample },
      });
      expect(errs.some((e) => e.field === 'bodyType')).toBe(true);
    });

    it('requires an input schema', () => {
      const errs = validateBazaarExtension({
        endpoint: { method: 'POST' },
        description: 'Submits a city to look up its weather forecast.',
        bodyType: 'json',
        examples: { input: goodInputExample },
      });
      expect(errs.some((e) => e.field === 'schemas.input')).toBe(true);
    });

    it('requires an input example', () => {
      const errs = validateBazaarExtension({
        endpoint: { method: 'POST' },
        description: 'Submits a city to look up its weather forecast.',
        bodyType: 'json',
        schemas: { input: goodInputSchema },
      });
      expect(errs.some((e) => e.field === 'examples.input')).toBe(true);
    });

    it('passes with all required fields', () => {
      const errs = validateBazaarExtension({
        endpoint: { method: 'POST' },
        description: 'Submits a city to look up its weather forecast.',
        bodyType: 'json',
        schemas: { input: goodInputSchema },
        examples: { input: goodInputExample },
      });
      expect(errs).toEqual([]);
    });

    it('rejects an input example that does not match the input schema', () => {
      const errs = validateBazaarExtension({
        endpoint: { method: 'POST' },
        description: 'Submits a city to look up its weather forecast.',
        bodyType: 'json',
        schemas: { input: goodInputSchema },
        examples: { input: { wrongField: 'oops' } },
      });
      expect(errs.some((e) => e.field === 'examples.input')).toBe(true);
    });
  });

  describe('schema validity', () => {
    it('flags a malformed JSON Schema', () => {
      const errs = validateBazaarExtension({
        endpoint: { method: 'GET' },
        description: 'Returns a weather forecast for the requested city.',
        schemas: { output: { type: 'not-a-real-type' } },
      });
      expect(errs.some((e) => e.field === 'schemas.output')).toBe(true);
    });
  });
});

describe('buildBazaarExtension', () => {
  it('emits a Bazaar envelope for a GET endpoint', () => {
    const ext = buildBazaarExtension({
      endpoint: { method: 'GET', name: 'Weather' },
      description: 'Returns a weather forecast for the requested city.',
      category: 'data',
      schemas: { output: goodOutputSchema },
      examples: { output: goodOutputExample },
    });
    expect(ext.bazaar.description).toMatch(/Returns a weather forecast/);
    expect(ext.bazaar.category).toBe('data');
    expect(ext.bazaar.outputSchema).toEqual(goodOutputSchema);
    expect(ext.bazaar.output).toEqual(goodOutputExample);
    expect(ext.bazaar.bodyType).toBeUndefined();
  });

  it('emits bodyType:json for a POST endpoint', () => {
    const ext = buildBazaarExtension({
      endpoint: { method: 'POST', name: 'Search' },
      description: 'Submits a city to look up its weather forecast.',
      bodyType: 'json',
      schemas: { input: goodInputSchema, output: goodOutputSchema },
      examples: { input: goodInputExample, output: goodOutputExample },
    });
    expect(ext.bazaar.bodyType).toBe('json');
    expect(ext.bazaar.inputSchema).toEqual(goodInputSchema);
    expect(ext.bazaar.input).toEqual(goodInputExample);
  });

  it('throws BazaarValidationError on bad input', () => {
    expect(() =>
      buildBazaarExtension({
        endpoint: { method: 'POST' },
        description: 'too short',
      })
    ).toThrow(BazaarValidationError);
  });

  it('error.details carries field-level reasons', () => {
    try {
      buildBazaarExtension({
        endpoint: { method: 'POST' },
        description: 'too short',
      });
      throw new Error('should have thrown');
    } catch (err: any) {
      expect(err).toBeInstanceOf(BazaarValidationError);
      const details = err.details as Array<{ field: string; reason: string }>;
      expect(details.length).toBeGreaterThanOrEqual(2);
      expect(details.some((d) => d.field === 'description')).toBe(true);
      expect(details.some((d) => d.field === 'bodyType')).toBe(true);
    }
  });
});
