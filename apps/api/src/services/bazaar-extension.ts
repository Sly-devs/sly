/**
 * Bazaar extension builder + validators.
 *
 * Mirrors the shape Coinbase indexes when the CDP Facilitator settles a
 * payment for an x402 endpoint (`declareDiscoveryExtension({ input,
 * inputSchema, output, bodyType? })`). Validators run before any settle so
 * the dashboard can surface field-level errors without burning a payment.
 *
 * Pure functions — no IO, safe to import from route handlers, the publish
 * service, the auto-republish hook, and unit tests.
 */
import Ajv from 'ajv';
import type { ErrorObject, ValidateFunction } from 'ajv';
import { BazaarValidationError } from '../middleware/error.js';

// ────────────────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────────────────

export type JSONSchema = Record<string, unknown>;

export interface BazaarExtensionInput {
  endpoint: {
    id?: string;
    name?: string;
    method: string;
    path?: string;
  };
  description: string;
  category?: string;
  schemas?: {
    input?: JSONSchema;
    output?: JSONSchema;
  };
  examples?: {
    input?: unknown;
    output?: unknown;
  };
  bodyType?: 'json';
}

export interface BazaarExtension {
  bazaar: {
    description: string;
    category?: string;
    input?: unknown;
    inputSchema?: JSONSchema;
    output?: unknown;
    outputSchema?: JSONSchema;
    bodyType?: 'json';
  };
}

export interface FieldError {
  field: string;
  reason: string;
}

// Methods that send a request body (and therefore need an inputSchema +
// example + bodyType: "json").
const BODY_METHODS = new Set(['POST', 'PUT', 'PATCH']);

const DESCRIPTION_MIN = 20;
const DESCRIPTION_MAX = 280;

// ────────────────────────────────────────────────────────────────────────────
// AJV — single instance, per-schema cache. Strict mode off because Bazaar
// schemas often use loose patterns (e.g. `additionalProperties: true`).
// ────────────────────────────────────────────────────────────────────────────

const ajv = new Ajv({
  allErrors: true,
  strict: false,
  validateFormats: true,
});

function compile(schema: JSONSchema): ValidateFunction | null {
  try {
    return ajv.compile(schema);
  } catch {
    return null;
  }
}

function ajvErrorsToReason(errors: ErrorObject[] | null | undefined): string {
  if (!errors || errors.length === 0) return 'unknown validation error';
  return errors
    .map((e) => `${e.instancePath || '/'} ${e.message}`)
    .slice(0, 3)
    .join('; ');
}

// ────────────────────────────────────────────────────────────────────────────
// Public API
// ────────────────────────────────────────────────────────────────────────────

/**
 * Validate the inputs for a Bazaar extension. Returns a list of field-level
 * errors (empty when ok). Does not throw — callers can choose between
 * surfacing errors via API response or escalating to a thrown error.
 */
export function validateBazaarExtension(input: BazaarExtensionInput): FieldError[] {
  const errors: FieldError[] = [];
  const method = (input.endpoint?.method || 'GET').toUpperCase();
  const description = (input.description || '').trim();

  // Description bounds
  if (description.length < DESCRIPTION_MIN) {
    errors.push({
      field: 'description',
      reason: `must be at least ${DESCRIPTION_MIN} characters (got ${description.length})`,
    });
  } else if (description.length > DESCRIPTION_MAX) {
    errors.push({
      field: 'description',
      reason: `must be at most ${DESCRIPTION_MAX} characters (got ${description.length})`,
    });
  }

  const inputSchema = input.schemas?.input;
  const outputSchema = input.schemas?.output;
  const inputExample = input.examples?.input;
  const outputExample = input.examples?.output;

  // POST/PUT/PATCH require bodyType: 'json' + non-empty input example +
  // input schema. GET endpoints can omit input entirely.
  if (BODY_METHODS.has(method)) {
    if (input.bodyType !== 'json') {
      errors.push({
        field: 'bodyType',
        reason: `must be "json" for ${method} endpoints`,
      });
    }
    if (!inputSchema || typeof inputSchema !== 'object') {
      errors.push({
        field: 'schemas.input',
        reason: `inputSchema is required for ${method} endpoints`,
      });
    }
    if (inputExample === undefined || inputExample === null) {
      errors.push({
        field: 'examples.input',
        reason: `input example is required for ${method} endpoints`,
      });
    }
  }

  // If schemas present, ensure they compile under JSON Schema. Then verify
  // the matching example actually validates against the schema.
  if (inputSchema) {
    const validate = compile(inputSchema);
    if (!validate) {
      errors.push({
        field: 'schemas.input',
        reason: 'is not a valid JSON Schema',
      });
    } else if (inputExample !== undefined) {
      const ok = validate(inputExample);
      if (!ok) {
        errors.push({
          field: 'examples.input',
          reason: `does not match input schema: ${ajvErrorsToReason(validate.errors)}`,
        });
      }
    }
  }

  if (outputSchema) {
    const validate = compile(outputSchema);
    if (!validate) {
      errors.push({
        field: 'schemas.output',
        reason: 'is not a valid JSON Schema',
      });
    } else if (outputExample !== undefined) {
      const ok = validate(outputExample);
      if (!ok) {
        errors.push({
          field: 'examples.output',
          reason: `does not match output schema: ${ajvErrorsToReason(validate.errors)}`,
        });
      }
    }
  }

  return errors;
}

/**
 * Build the Bazaar extension envelope. Throws BazaarValidationError if the
 * inputs would be rejected — call validateBazaarExtension first if you need
 * non-throwing semantics.
 */
export function buildBazaarExtension(input: BazaarExtensionInput): BazaarExtension {
  const errors = validateBazaarExtension(input);
  if (errors.length > 0) {
    throw new BazaarValidationError('Bazaar extension validation failed', errors);
  }

  const method = (input.endpoint?.method || 'GET').toUpperCase();
  const bazaar: BazaarExtension['bazaar'] = {
    description: input.description.trim(),
  };
  if (input.category) bazaar.category = input.category;

  if (input.schemas?.input) bazaar.inputSchema = input.schemas.input;
  if (input.examples?.input !== undefined) bazaar.input = input.examples.input;
  if (input.schemas?.output) bazaar.outputSchema = input.schemas.output;
  if (input.examples?.output !== undefined) bazaar.output = input.examples.output;

  if (BODY_METHODS.has(method) || input.bodyType === 'json') {
    bazaar.bodyType = 'json';
  }

  return { bazaar };
}
