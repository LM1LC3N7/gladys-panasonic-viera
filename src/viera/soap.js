// -----------------------------------------------------------------------------
// The UPnP/SOAP vocabulary of the Viera TVs (port 55000): service URLs and
// URNs, the envelope, and a tolerant reading of the answers (namespace
// prefixes ignored, entities decoded). No XML library: the answers are a few
// flat elements. Pure functions.
// -----------------------------------------------------------------------------

export const DEFAULT_PORT = 55000;

export const URL_DESCRIPTION = '/nrc/ddd.xml';
export const URL_NRC_SERVICE = '/nrc/sdd_0.xml';
export const URL_NRC = '/nrc/control_0';
export const URL_DMR = '/dmr/control_0';

export const URN_REMOTE_CONTROL = 'panasonic-com:service:p00NetworkControl:1';
export const URN_RENDERING_CONTROL = 'schemas-upnp-org:service:RenderingControl:1';

/** The SSDP search target of the TVs' remote control service. */
export const SSDP_ST = 'urn:panasonic-com:device:p00RemoteController:1';
/** Some models answer only for the service they publish. */
export const SSDP_ST_SERVICE = 'urn:panasonic-com:service:p00NetworkControl:1';

const ENTITIES = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

/** Escapes a value placed inside an XML element. */
export function escapeXml(value) {
  return String(value).replace(
    /[<>&"']/g,
    (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c],
  );
}

/** Decodes the five XML entities and the numeric ones. */
export function decodeXml(value) {
  return String(value).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity) => {
    if (entity[0] === '#') {
      const code =
        entity[1] === 'x' || entity[1] === 'X'
          ? parseInt(entity.slice(2), 16)
          : parseInt(entity.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : match;
    }
    return ENTITIES[entity.toLowerCase()] ?? match;
  });
}

const NAME_CHAR = /[\w.-]/;
const SPACE = /\s/;
const MAX_PREFIX = 64;

/** Index of the `<` of `<name` or `<prefix:name` ending right before `index`, or -1. */
function tagOpenBefore(text, index, slash) {
  let i = index - 1;
  if (text[i] === ':') {
    let length = 0;
    i -= 1;
    while (i >= 0 && length <= MAX_PREFIX && NAME_CHAR.test(text[i])) {
      i -= 1;
      length += 1;
    }
    if (length === 0 || length > MAX_PREFIX) {
      return -1;
    }
  }
  if (slash) {
    if (text[i] !== '/') {
      return -1;
    }
    i -= 1;
  }
  return text[i] === '<' ? i : -1;
}

/**
 * The text of the first element named `name`, whatever its namespace prefix,
 * entities decoded; undefined when absent. Linear in the size of the answer
 * (indexOf for the opening tag, then for the closing one), whatever it holds.
 */
export function tagText(xml, name) {
  const text = String(xml ?? '');
  const length = name.length;
  let nextGt = -1;
  let from = 0;
  for (;;) {
    const index = text.indexOf(name, from);
    if (index === -1) {
      return undefined;
    }
    from = index + 1;
    const after = text[index + length];
    if ((after !== '>' && !SPACE.test(after ?? '')) || tagOpenBefore(text, index, false) === -1) {
      continue;
    }
    let gt = index + length;
    if (after !== '>') {
      if (nextGt < gt) {
        nextGt = text.indexOf('>', gt);
      }
      if (nextGt === -1) {
        return undefined;
      }
      gt = nextGt;
      if (text[gt - 1] === '/') {
        return '';
      }
    }
    const start = gt + 1;
    let search = start;
    for (;;) {
      const close = text.indexOf(name, search);
      if (close === -1) {
        return undefined;
      }
      search = close + 1;
      let end = close + length;
      let spaces = 0;
      while (spaces < 16 && SPACE.test(text[end] ?? '')) {
        end += 1;
        spaces += 1;
      }
      if (text[end] === '>') {
        const open = tagOpenBefore(text, close, true);
        if (open !== -1) {
          return decodeXml(text.slice(start, open)).trim();
        }
      }
    }
  }
}

/** The SOAP envelope of one action; `params` is already-escaped XML. */
export function envelope(urn, action, params = '', prefix = 'm') {
  return (
    '<?xml version="1.0" encoding="utf-8"?>' +
    '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"' +
    ' s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">' +
    '<s:Body>' +
    `<${prefix}:${action} xmlns:${prefix}="urn:${urn}">${params}</${prefix}:${action}>` +
    '</s:Body>' +
    '</s:Envelope>'
  );
}

/** The inner command wrapped by `X_EncryptedCommand` on the encrypted models. */
export function encryptedInner(sessionId, sequence, urn, action, params = '') {
  return (
    `<X_SessionId>${escapeXml(sessionId)}</X_SessionId>` +
    `<X_SequenceNumber>${String(sequence).padStart(8, '0')}</X_SequenceNumber>` +
    '<X_OriginalCommand>' +
    `<u:${action} xmlns:u="urn:${urn}">${params}</u:${action}>` +
    '</X_OriginalCommand>'
  );
}

/** The SOAP fault of an error answer: `{ code, description }`, or undefined. */
export function parseFault(xml) {
  const code = tagText(xml, 'errorCode');
  const description = tagText(xml, 'errorDescription');
  if (code === undefined && description === undefined) {
    return undefined;
  }
  return { code, description };
}

/**
 * The UPnP description of a TV (`/nrc/ddd.xml`): its UDN (the stable id),
 * name, model and manufacturer. Undefined when it is not a Panasonic device
 * or has no UDN.
 */
export function parseDescription(xml) {
  const manufacturer = tagText(xml, 'manufacturer');
  const udn = tagText(xml, 'UDN');
  if (!manufacturer || !/panasonic/i.test(manufacturer) || !udn) {
    return undefined;
  }
  const id = udn.replace(/^uuid:/i, '').toLowerCase();
  if (!/^[0-9a-z-]{8,64}$/.test(id)) {
    return undefined;
  }
  return {
    udn: id,
    name: (tagText(xml, 'friendlyName') || 'Panasonic TV').slice(0, 64),
    model: (tagText(xml, 'modelNumber') || tagText(xml, 'modelName') || '').slice(0, 64),
    manufacturer,
  };
}

/** Whether the NRC service description lists the encrypted session action. */
export function needsEncryption(serviceXml) {
  return /<(?:[\w.-]+:)?name>\s*X_GetEncryptSessionId\s*</.test(String(serviceXml ?? ''));
}

/**
 * The applications of `X_GetAppList`: entries such as
 * `vc_app'product_id=0010000200000001'Netflix'<icon url>`, separated by
 * `vc_app`. Returns `[{ id, name }]`, without duplicates.
 */
export function parseAppList(text) {
  const decoded = decodeXml(String(text ?? ''));
  const apps = [];
  const seen = new Set();
  for (const entry of decoded.split('vc_app').slice(1)) {
    const match = /^'?product_id=([0-9A-Fa-f]{16})'([^'\n]*)'/.exec(entry);
    if (!match) {
      continue;
    }
    const id = match[1].toUpperCase();
    const name = match[2].trim().slice(0, 48);
    if (name && !seen.has(id)) {
      seen.add(id);
      apps.push({ id, name });
    }
  }
  return apps;
}
