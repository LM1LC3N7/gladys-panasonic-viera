// -----------------------------------------------------------------------------
// The configuration: the manifest `config_schema` values, normalized so the
// rest of the code never deals with strings typed in a form.
// -----------------------------------------------------------------------------

import { isIP } from 'node:net';
import { LIMITS, POLL_INTERVAL } from './constants.js';

/** Defaults, mirrored by the manifest (checked by test/manifest.test.js). */
export const DEFAULT_CONFIG = {
  addresses: '',
  mac_addresses: '',
  poll_interval: POLL_INTERVAL.default,
};

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;

/**
 * The address of a TV typed by the user: an IPv4 address or a host name (a
 * pasted URL is reduced to its host; the port is always 55000).
 * @returns {string | undefined} undefined when invalid or empty.
 */
export function parseHost(raw) {
  const text = String(raw ?? '')
    .trim()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')
    .replace(/[/?#].*$/, '')
    .replace(/:\d{1,5}$/, '')
    .toLowerCase();
  if (text === '' || text.length > 253) {
    return undefined;
  }
  if (isIP(text) === 4) {
    return text;
  }
  if (/^[\d.]+$/.test(text)) {
    return undefined;
  }
  return text.split('.').every((label) => LABEL.test(label)) ? text : undefined;
}

/** A MAC address, normalized to `aa:bb:cc:dd:ee:ff`; undefined when invalid. */
export function parseMac(raw) {
  const hex = String(raw ?? '')
    .trim()
    .replace(/[:.-]/g, '')
    .toLowerCase();
  if (!/^[0-9a-f]{12}$/.test(hex) || /^0{12}$|^f{12}$/.test(hex)) {
    return undefined;
  }
  return hex.match(/../g).join(':');
}

const entries = (raw) =>
  String(raw ?? '')
    .split(/[\s,;]+/)
    .filter((entry) => entry !== '');

export function normalizeConfig(raw = {}) {
  const c = {
    ...DEFAULT_CONFIG,
    ...Object.fromEntries(Object.entries(raw ?? {}).filter(([, v]) => v != null)),
  };
  const addresses = [];
  const invalid = [];
  for (const entry of entries(c.addresses)) {
    const host = parseHost(entry);
    if (!host) {
      invalid.push(entry.slice(0, 100));
    } else if (!addresses.includes(host) && addresses.length < LIMITS.addresses) {
      addresses.push(host);
    }
  }
  // "192.168.1.40=a8:13:74:12:34:56": the MAC a TV is woken with.
  const macs = {};
  for (const entry of entries(c.mac_addresses)) {
    const [hostPart, macPart] = entry.split('=');
    const host = parseHost(hostPart);
    const mac = parseMac(macPart);
    if (host && mac) {
      macs[host] = mac;
    } else {
      invalid.push(entry.slice(0, 100));
    }
  }
  const interval = Number(c.poll_interval);
  return {
    addresses,
    macs,
    invalid,
    pollInterval: Number.isFinite(interval)
      ? Math.min(POLL_INTERVAL.max, Math.max(POLL_INTERVAL.min, Math.round(interval)))
      : POLL_INTERVAL.default,
  };
}
