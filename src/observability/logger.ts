import { type DestinationStream, pino, type Logger as PinoLogger } from 'pino';

export type Logger = PinoLogger;

/** Never log these (plan §11). Paths are pino redaction paths. */
const REDACT = [
  'sessionToken',
  '*.sessionToken',
  'password',
  '*.password',
  'masterKey',
  '*.masterKey',
  'authData',
  '*.authData',
  'pushToken',
  '*.pushToken',
  'phone',
  '*.phone',
  'email',
  '*.email',
  'code',
  '*.code',
  'token',
  '*.token',
  'effect.args',
  'req.headers["x-parse-master-key"]',
  'req.headers["x-parse-session-token"]',
  'req.headers["x-parse-maintenance-key"]',
];

/** JSON logs on stdout (Cloud Logging), or on `destination` (tests). */
export function createLogger(level: string, destination?: DestinationStream): Logger {
  const options = {
    level,
    redact: { paths: REDACT, censor: '[redacted]' },
    // Cloud Logging reads `severity`.
    formatters: { level: (label: string) => ({ severity: label.toUpperCase() }) },
  };
  return destination ? pino(options, destination) : pino(options);
}
