/**
 * Base class for timeout errors. Carries `timeoutMs` for unified inspection,
 * so callers can branch on `instanceof BaseTimeoutError` instead of the
 * concrete subclass when they only care that "something timed out".
 */
export class BaseTimeoutError extends Error {
  readonly timeoutMs: number;

  constructor(message: string, timeoutMs: number) {
    super(message);
    this.name = "BaseTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}
