/**
 * Typed error hierarchy. Catch the base `ScannerError` to handle anything
 * the SDK throws, or narrow on the subclass for actionable handling.
 */

export class ScannerError extends Error {
  readonly status: number;
  readonly requestId?: string;
  readonly body: unknown;

  constructor(message: string, status: number, body: unknown, requestId?: string) {
    super(message);
    this.name = 'ScannerError';
    this.status = status;
    this.body = body;
    this.requestId = requestId;
  }
}

/** 402 — tenant doesn't have enough credits to satisfy the request. */
export class InsufficientCreditsError extends ScannerError {
  readonly balance: number;
  readonly required: number;
  readonly docs: string;

  constructor(body: { balance: number; required: number; docs?: string }, requestId?: string) {
    super(
      `Insufficient credits — have ${body.balance}, need ${body.required}`,
      402,
      body,
      requestId,
    );
    this.name = 'InsufficientCreditsError';
    this.balance = body.balance;
    this.required = body.required;
    this.docs = body.docs ?? 'https://docs.getsly.ai/scanner/credits-and-billing';
  }
}

/** 429 — over the per-minute request limit. `retryAfterSeconds` mirrors the Retry-After header. */
export class RateLimitError extends ScannerError {
  readonly retryAfterSeconds: number;
  readonly limit: number;

  constructor(body: { limit?: number; reset_seconds?: number }, retryAfter: number, requestId?: string) {
    super(`Rate limit exceeded — retry after ${retryAfter}s`, 429, body, requestId);
    this.name = 'RateLimitError';
    this.retryAfterSeconds = retryAfter;
    this.limit = body.limit ?? 0;
  }
}

/** 400 — request body failed validation. `fieldErrors` echoes Zod's flatten() shape. */
export class ValidationError extends ScannerError {
  readonly fieldErrors: Record<string, string[]>;
  readonly formErrors: string[];

  constructor(
    body: { error: string; details?: { fieldErrors?: Record<string, string[]>; formErrors?: string[] } },
    requestId?: string,
  ) {
    super(body.error, 400, body, requestId);
    this.name = 'ValidationError';
    this.fieldErrors = body.details?.fieldErrors ?? {};
    this.formErrors = body.details?.formErrors ?? [];
  }
}

/** 401 — missing/invalid API key or expired session. */
export class AuthenticationError extends ScannerError {
  constructor(body: unknown, requestId?: string) {
    super('Authentication failed — check your API key', 401, body, requestId);
    this.name = 'AuthenticationError';
  }
}

/** 403 — authenticated but the operation isn't permitted (e.g. live key by non-admin). */
export class ForbiddenError extends ScannerError {
  constructor(body: unknown, requestId?: string) {
    super('Operation not permitted', 403, body, requestId);
    this.name = 'ForbiddenError';
  }
}

/** 404 — requested resource doesn't exist. */
export class NotFoundError extends ScannerError {
  constructor(resource: string, requestId?: string) {
    super(`${resource} not found`, 404, { resource }, requestId);
    this.name = 'NotFoundError';
  }
}

/** 5xx — server error; usually transient and worth retrying. */
export class ServerError extends ScannerError {
  constructor(status: number, body: unknown, requestId?: string) {
    super(`Scanner server error (${status})`, status, body, requestId);
    this.name = 'ServerError';
  }
}
