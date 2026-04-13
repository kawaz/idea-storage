/**
 * PromiseRejectionEvent is available at runtime in Bun but not declared
 * in bun-types or the ESNext lib. Provide a minimal declaration so tests
 * that listen for 'unhandledrejection' can type the handler parameter.
 */
interface PromiseRejectionEvent extends Event {
  readonly promise: Promise<unknown>;
  readonly reason: unknown;
}

/**
 * Augment Bun's EventMap so globalThis.addEventListener('unhandledrejection', ...)
 * is accepted by the type checker.
 */
interface EventMap {
  unhandledrejection: PromiseRejectionEvent;
}
