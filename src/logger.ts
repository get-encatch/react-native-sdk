/**
 * Internal logger for @encatch/react-native.
 * Uses react-native-logs when installed and debugMode is enabled; falls back to console.
 */

export interface EncatchLogger {
  debug: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
}

const noop = () => {};

function createFallbackLogger(debugMode: boolean): EncatchLogger {
  return {
    debug: debugMode ? (...args: unknown[]) => console.log('[Encatch]', ...args) : noop,
    warn: (...args: unknown[]) => console.warn('[Encatch]', ...args),
  };
}

/**
 * Beautifies JSON when stringifying for logs.
 */
function prettyStringify(msg: unknown): string {
  if (msg === null) return 'null';
  if (msg === undefined) return 'undefined';
  if (typeof msg === 'string') {
    try {
      const parsed = JSON.parse(msg);
      return JSON.stringify(parsed, null, 2);
    } catch {
      return msg;
    }
  }
  if (typeof msg === 'object') {
    return JSON.stringify(msg, null, 2);
  }
  return String(msg);
}

/**
 * Creates the Encatch SDK logger. Uses react-native-logs when available and debugMode,
 * otherwise falls back to console.log/warn.
 */
export function createEncatchLogger(debugMode: boolean): EncatchLogger {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const rnLogs = require('../optional/react-native-logs.js');
    if (!rnLogs) return createFallbackLogger(debugMode);
    const { logger, consoleTransport } = rnLogs;
    const encatchLog = logger.createLogger({
      levels: { debug: 0, info: 1, warn: 2, error: 3 },
      severity: debugMode ? 'debug' : 'warn',
      transport: consoleTransport,
      transportOptions: {
        colors: {
          debug: 'cyan',
          info: 'blueBright',
          warn: 'yellowBright',
          error: 'redBright',
        },
      },
      stringifyFunc: (msg: unknown) => {
        if (Array.isArray(msg)) {
          return msg.map((m) => prettyStringify(m)).join('\n');
        }
        return prettyStringify(msg);
      },
      dateFormat: 'time',
      printLevel: true,
      printDate: true,
      enabled: true,
    });
    const ext = encatchLog.extend('Encatch');
    return {
      debug: (...args: unknown[]) => ext.debug(...args),
      warn: (...args: unknown[]) => ext.warn(...args),
    };
  } catch {
    return createFallbackLogger(debugMode);
  }
}
