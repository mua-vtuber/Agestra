export abstract class ProviderError extends Error {
  abstract readonly code: string;
  abstract readonly retryable: boolean;
  constructor(public readonly providerId: string, message: string) {
    super(`[${providerId}] ${message}`);
    this.name = this.constructor.name;
  }
}

export class ProviderNotFoundError extends ProviderError {
  readonly code = "PROVIDER_NOT_FOUND";
  readonly retryable = false;
  constructor(providerId: string) {
    super(providerId, `Provider not found: ${providerId}`);
  }
}

export class ProviderUnavailableError extends ProviderError {
  readonly code = "PROVIDER_UNAVAILABLE";
  readonly retryable = false;
  constructor(providerId: string, reason?: string) {
    super(providerId, `Provider unavailable: ${reason || "not installed or not running"}`);
  }
}

export class ProviderAuthError extends ProviderError {
  readonly code = "PROVIDER_AUTH_ERROR";
  readonly retryable = false;
  constructor(providerId: string, reason?: string) {
    super(providerId, `Authentication failed: ${reason || "missing or invalid credentials"}`);
  }
}

export class ProviderTimeoutError extends ProviderError {
  readonly code = "PROVIDER_TIMEOUT";
  readonly retryable = true;
  constructor(providerId: string, public readonly timeoutMs: number) {
    super(providerId, `Timeout after ${timeoutMs}ms`);
  }
}

export class ProviderExecutionError extends ProviderError {
  readonly code = "PROVIDER_EXECUTION_ERROR";
  readonly retryable = true;
  constructor(providerId: string, reason: string) {
    super(providerId, `Execution error: ${reason}`);
  }
}

export function isProviderError(err: unknown): err is ProviderError {
  return err instanceof ProviderError;
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  maxRetries = 1,
  baseDelayMs = 1000,
  maxBackoffMs = 30_000,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt < maxRetries && isProviderError(err) && err.retryable) {
        const raw = baseDelayMs * Math.pow(2, attempt);
        const jittered = raw * (0.5 + Math.random() * 0.5);
        const delay = Math.min(jittered, maxBackoffMs);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      throw err;
    }
  }
  throw lastError;
}
