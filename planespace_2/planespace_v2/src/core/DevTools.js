/**
 * DevTools — development-mode validation and warnings.
 *
 * In production builds these are tree-shaken to no-ops.
 */

const IS_DEV = typeof process !== 'undefined'
  ? process.env.NODE_ENV !== 'production'
  : !('__PS_PROD__' in globalThis);

/**
 * Emit a development-mode warning.
 * Silenced in production builds.
 *
 * @param {string} message
 */
export function warn(message) {
  if (IS_DEV) {
    console.warn(`[planespace] ${message}`);
  }
}

/**
 * Assert a condition and throw a descriptive error if it fails.
 * In production, throws a terse error without the full message.
 *
 * @param {boolean} condition
 * @param {string} message
 * @throws {Error}
 */
export function validate(condition, message) {
  if (!condition) {
    throw new Error(IS_DEV
      ? `[planespace] Configuration error: ${message}`
      : `[planespace] Invalid configuration.`
    );
  }
}

/**
 * Assert a condition for internal invariants.
 * Always throws in both dev and production.
 *
 * @param {boolean} condition
 * @param {string} message
 */
export function invariant(condition, message) {
  if (!condition) {
    throw new Error(`[planespace] Internal error: ${message}. ` +
      'This is a bug — please report it at https://github.com/planespace/planespace/issues');
  }
}
