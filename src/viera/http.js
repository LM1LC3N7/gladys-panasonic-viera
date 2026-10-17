// -----------------------------------------------------------------------------
// One plain HTTP/1.1 exchange with a TV (node:http, no keep-alive, bounded
// time and size). A TV in standby simply does not answer: every network
// failure becomes a TvError of kind 'unreachable'.
// -----------------------------------------------------------------------------

import { request as httpRequest } from 'node:http';

// The largest answer of a TV (application list) is a few kilobytes.
export const MAX_BODY = 64 * 1024;

/** The kinds of failure the rest of the code tells apart. */
export const ERROR_KINDS = Object.freeze({
  UNREACHABLE: 'unreachable',
  HTTP: 'http',
  FAULT: 'fault',
  PROTOCOL: 'protocol',
  PAIRING_REQUIRED: 'pairing_required',
  /** An explicit refusal of the stored pairing keys. */
  KEYS_REFUSED: 'keys_refused',
  /** No session this time, for a reason that does not prove the keys are gone. */
  SESSION_REFUSED: 'session_refused',
  /** The time a command was given ran out before this request. */
  BUDGET: 'budget',
  INVALID_PIN: 'invalid_pin',
});

export class TvError extends Error {
  constructor(kind, message, details = {}) {
    super(message);
    this.name = 'TvError';
    this.kind = kind;
    Object.assign(this, details);
  }
}

/**
 * @param {{ host: string, port: number, method?: string, path: string,
 *   headers?: Record<string, string>, body?: string, timeoutMs?: number }} options
 * @returns {Promise<{ status: number, body: string }>}
 */
export function request({
  host,
  port,
  method = 'GET',
  path,
  headers = {},
  body,
  timeoutMs = 4000,
}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : Buffer.from(body, 'utf8');
    let settled = false;
    const finish = (fn, value) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        fn(value);
      }
    };
    const req = httpRequest(
      {
        host,
        port,
        method,
        path,
        agent: false,
        headers: {
          Connection: 'close',
          ...(payload ? { 'Content-Length': String(payload.length) } : {}),
          ...headers,
        },
      },
      (res) => {
        const chunks = [];
        let size = 0;
        res.on('data', (chunk) => {
          size += chunk.length;
          if (size > MAX_BODY) {
            req.destroy();
            finish(reject, new TvError(ERROR_KINDS.PROTOCOL, 'Answer too large'));
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () =>
          finish(resolve, {
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        );
        res.on('error', (err) =>
          finish(
            reject,
            new TvError(ERROR_KINDS.UNREACHABLE, `TV unreachable: ${err.code ?? err.message}`),
          ),
        );
      },
    );
    // A plain (ref'd) timer: the exchange keeps the process alive until it ends.
    const timer = setTimeout(() => {
      req.destroy();
      finish(reject, new TvError(ERROR_KINDS.UNREACHABLE, 'TV unreachable: timeout'));
    }, timeoutMs);
    req.on('error', (err) =>
      finish(
        reject,
        new TvError(ERROR_KINDS.UNREACHABLE, `TV unreachable: ${err.code ?? err.message}`),
      ),
    );
    req.end(payload);
  });
}
