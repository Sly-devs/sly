/**
 * endpoint-probe tests.
 *
 *  - schema inference is sane for primitives, objects, arrays, and
 *    heterogeneous arrays
 *  - non-GET methods short-circuit with requires_manual_metadata
 *  - probe failure modes (bad URL, non-JSON content type) surface clearly
 */
import { describe, it, expect } from 'vitest';
import {
  probeEndpoint,
  __testing,
} from '../../src/services/endpoint-probe.js';

const { inferSchema, truncate } = __testing;

describe('inferSchema', () => {
  it('infers primitive types', () => {
    expect(inferSchema('hello')).toEqual({ type: 'string' });
    expect(inferSchema(42)).toEqual({ type: 'integer' });
    expect(inferSchema(3.14)).toEqual({ type: 'number' });
    expect(inferSchema(true)).toEqual({ type: 'boolean' });
    expect(inferSchema(null)).toEqual({ type: 'null' });
  });

  it('infers an object schema with required keys', () => {
    const schema = inferSchema({ city: 'NYC', temp: 72 });
    expect(schema.type).toBe('object');
    const props = (schema as any).properties;
    expect(props.city).toEqual({ type: 'string' });
    expect(props.temp).toEqual({ type: 'integer' });
    expect((schema as any).required).toEqual(expect.arrayContaining(['city', 'temp']));
    expect((schema as any).additionalProperties).toBe(true);
  });

  it('infers a homogeneous array as a single items schema', () => {
    const schema = inferSchema([1, 2, 3]);
    expect(schema).toEqual({ type: 'array', items: { type: 'integer' } });
  });

  it('infers a heterogeneous array with anyOf', () => {
    const schema = inferSchema([1, 'two']);
    expect((schema as any).type).toBe('array');
    expect((schema as any).items.anyOf).toEqual([
      { type: 'integer' },
      { type: 'string' },
    ]);
  });

  it('deduplicates identical inferred shapes when arrays repeat them', () => {
    // Two slides with the same structure should collapse to a single items
    // schema rather than `anyOf: [shape, shape]`.
    const schema = inferSchema([
      { title: 'A', type: 'all' },
      { title: 'B', type: 'all' },
    ]);
    expect((schema as any).type).toBe('array');
    // dedup → only one branch → no anyOf wrapper
    expect((schema as any).items.anyOf).toBeUndefined();
    expect((schema as any).items.type).toBe('object');
  });

  it('uses anyOf (not oneOf) for objects with additionalProperties:true so permissive shapes do not become ambiguous', () => {
    // Regression: the httpbin /json shape — slide #1 lacks `items`, slide #2
    // has it. With additionalProperties:true and oneOf, slide #2 matches both
    // branches and AJV correctly rejects (must match exactly one). anyOf is
    // the correct semantic for permissive heterogeneous arrays.
    const schema = inferSchema([
      { title: 'a', type: 'all' },
      { title: 'b', type: 'all', items: ['x'] },
    ]);
    expect((schema as any).items.anyOf).toBeDefined();
    expect((schema as any).items.oneOf).toBeUndefined();
  });

  it('infers an empty array as a typed array with no items', () => {
    expect(inferSchema([])).toEqual({ type: 'array' });
  });
});

describe('truncate', () => {
  it('truncates arrays to 5 elements', () => {
    const out = truncate([1, 2, 3, 4, 5, 6, 7]) as number[];
    expect(out).toEqual([1, 2, 3, 4, 5]);
  });

  it('recurses into objects', () => {
    const input = { items: [1, 2, 3, 4, 5, 6] };
    const out = truncate(input) as any;
    expect(out.items).toEqual([1, 2, 3, 4, 5]);
  });

  it('preserves primitives', () => {
    expect(truncate('hello')).toBe('hello');
    expect(truncate(42)).toBe(42);
    expect(truncate(null)).toBe(null);
  });
});

describe('probeEndpoint — non-GET path', () => {
  it('returns requires_manual_metadata for POST', async () => {
    const result = await probeEndpoint({
      method: 'POST',
      backendUrl: 'https://example.com/api',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.requiresManualMetadata).toBe(true);
      expect(result.reason).toMatch(/POST/);
    }
  });

  it('returns requires_manual_metadata for PUT', async () => {
    const result = await probeEndpoint({
      method: 'PUT',
      backendUrl: 'https://example.com/api',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.requiresManualMetadata).toBe(true);
  });

  it('returns requires_manual_metadata for PATCH', async () => {
    const result = await probeEndpoint({
      method: 'PATCH',
      backendUrl: 'https://example.com/api',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.requiresManualMetadata).toBe(true);
  });
});

describe('probeEndpoint — input validation', () => {
  it('rejects an invalid URL', async () => {
    const result = await probeEndpoint({
      method: 'GET',
      backendUrl: 'not-a-url',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/not a valid URL/);
  });

  it('rejects a non-http protocol', async () => {
    const result = await probeEndpoint({
      method: 'GET',
      backendUrl: 'ftp://example.com',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/protocol/);
  });
});
