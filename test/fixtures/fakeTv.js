// -----------------------------------------------------------------------------
// A fake Panasonic Viera TV on the loopback interface (127.0.0.1, random
// port): the UPnP description, the NRC service list, DMR volume and mute, and
// for the encrypted models the TV side of the PIN pairing and of the
// encrypted session (it checks the HMAC, the session id and the sequence
// numbers the client sends). The answers are shaped like the ones
// florianholzapfel/panasonic-viera reads. Never the outside network.
// -----------------------------------------------------------------------------

import { createServer } from 'node:http';
import { createHmac, randomBytes } from 'node:crypto';
import {
  decryptPayload,
  derivePinKeys,
  deriveSessionKeys,
  encryptPayload,
} from '../../src/viera/crypto.js';
import { tagText } from '../../src/viera/soap.js';

export const UDN = '4d454930-0200-1000-8001-a81374123456';
export const OTHER_UDN = '4d454930-0200-1000-8001-a81374abcdef';
export const PIN = '4821';
export const APP_LIST =
  "vc_app'product_id=0387878700000003'Media Player'http://x/icon1.png'" +
  "vc_app'product_id=0010000200000001'Netflix'http://x/icon2.png'" +
  "vc_app'product_id=0020009300000001'Demand 5'http://x/icon3.png'";

export function description({ udn = UDN, name = 'Living room TV', model = 'TX-55GZ950' } = {}) {
  return (
    '<?xml version="1.0" encoding="utf-8"?>' +
    '<root xmlns="urn:schemas-upnp-org:device-1-0">' +
    '<specVersion><major>1</major><minor>0</minor></specVersion>' +
    '<device><deviceType>urn:panasonic-com:device:p00RemoteController:1</deviceType>' +
    `<friendlyName>${name}</friendlyName><manufacturer>Panasonic</manufacturer>` +
    `<modelName>Panasonic VIErA</modelName><modelNumber>${model}</modelNumber>` +
    `<UDN>uuid:${udn}</UDN></device></root>`
  );
}

export function serviceList(encrypted) {
  const actions = ['X_SendKey', 'X_LaunchApp', 'X_GetAppList', 'X_DisplayPinCode', 'X_RequestAuth'];
  if (encrypted) {
    actions.push('X_GetEncryptSessionId', 'X_EncryptedCommand');
  }
  return (
    '<?xml version="1.0"?><scpd xmlns="urn:schemas-upnp-org:service-1-0"><actionList>' +
    actions.map((name) => `<action><name>${name}</name></action>`).join('') +
    '</actionList></scpd>'
  );
}

const envelope = (inner) =>
  '<?xml version="1.0" encoding="utf-8"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"' +
  ` s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body>${inner}</s:Body></s:Envelope>`;

const response = (action, content = '', urn = 'panasonic-com:service:p00NetworkControl:1') =>
  envelope(`<u:${action}Response xmlns:u="urn:${urn}">${content}</u:${action}Response>`);

const fault = (code, description) =>
  envelope(
    '<s:Fault><faultcode>s:Client</faultcode><faultstring>UPnPError</faultstring><detail>' +
      `<UPnPError xmlns="urn:schemas-upnp-org:control-1-0"><errorCode>${code}</errorCode>` +
      `<errorDescription>${description}</errorDescription></UPnPError></detail></s:Fault>`,
  );

/** Checks the HMAC-SHA-256 the client appends to an encrypted payload. */
function checkHmac(base64, hmacKey) {
  const data = Buffer.from(base64, 'base64');
  const ciphertext = data.subarray(0, data.length - 32);
  const signature = data.subarray(data.length - 32);
  return createHmac('sha256', hmacKey).update(ciphertext).digest().equals(signature);
}

/**
 * @param {{ encrypted?: boolean, udn?: string, name?: string, model?: string }} options
 */
export async function startFakeTv({ encrypted = false, udn = UDN, name, model } = {}) {
  const tv = {
    encrypted,
    udn,
    name,
    model,
    on: true,
    /** When false, the TV closes every connection (standby). */
    reachable: true,
    /** Some TVs in network standby answer NRC but not DMR. */
    dmrReachable: true,
    volume: 12,
    muted: false,
    keys: [],
    apps: [],
    calls: [],
    challenge: undefined,
    /** appId -> keyword (the pairings this TV accepted) */
    pairings: new Map(),
    sessions: new Map(),
    lastSequence: 0,
    /** Number of encrypted commands to refuse (an expired session). */
    refuseCommands: 0,
    /** Wake-on-LAN simulation: the TV switches on when woken. */
    wake() {
      this.reachable = true;
      this.dmrReachable = true;
      this.on = true;
    },
  };

  function handleKey(code) {
    tv.keys.push(code);
    if (code === 'NRC_POWER-ONOFF') {
      tv.on = !tv.on;
      tv.dmrReachable = tv.on;
    }
  }

  function inner(action, body) {
    if (action === 'X_SendKey') {
      handleKey(tagText(body, 'X_KeyEvent'));
      return '';
    }
    if (action === 'X_LaunchApp') {
      tv.apps.push(tagText(body, 'X_LaunchKeyword'));
      return '';
    }
    if (action === 'X_GetAppList') {
      return `<X_AppList>${APP_LIST.replace(/'/g, '&apos;')}</X_AppList>`;
    }
    return undefined;
  }

  function nrc(action, body) {
    if (action === 'X_DisplayPinCode') {
      tv.challenge = randomBytes(16).toString('base64');
      return [200, response(action, `<X_ChallengeKey>${tv.challenge}</X_ChallengeKey>`)];
    }
    if (action === 'X_RequestAuth') {
      if (!tv.challenge) {
        return [500, fault(401, 'No challenge')];
      }
      const keys = derivePinKeys(tv.challenge);
      const authInfo = tagText(body, 'X_AuthInfo');
      if (!checkHmac(authInfo, keys.hmacKey)) {
        return [500, fault(402, 'Bad signature')];
      }
      const pin = tagText(`<x>${decryptPayload(authInfo, keys)}</x>`, 'X_PinCode');
      tv.challenge = undefined;
      if (pin !== PIN) {
        return [500, fault(600, 'Invalid PIN Code')];
      }
      const appId = `APP${randomBytes(6).toString('hex').toUpperCase()}`;
      const keyword = randomBytes(16).toString('base64');
      tv.pairings.set(appId, keyword);
      const result = encryptPayload(
        `<X_ApplicationId>${appId}</X_ApplicationId><X_Keyword>${keyword}</X_Keyword>`,
        keys,
      );
      return [200, response(action, `<X_AuthResult>${result}</X_AuthResult>`)];
    }
    if (action === 'X_GetEncryptSessionId') {
      const appId = tagText(body, 'X_ApplicationId');
      const keyword = tv.pairings.get(appId);
      if (!keyword) {
        return [500, fault(401, 'Unauthorized')];
      }
      const keys = deriveSessionKeys(keyword);
      const encInfo = tagText(body, 'X_EncInfo');
      const plain = decryptPayload(encInfo, keys);
      if (
        !checkHmac(encInfo, keys.hmacKey) ||
        tagText(`<x>${plain}</x>`, 'X_ApplicationId') !== appId
      ) {
        return [500, fault(402, 'Bad session request')];
      }
      const sessionId = String(100 + tv.sessions.size);
      tv.sessions.set(sessionId, appId);
      tv.lastSequence = 1;
      const result = encryptPayload(
        `<X_SessionId>${sessionId}</X_SessionId><X_EncryptSessionIdResult>OK</X_EncryptSessionIdResult>`,
        keys,
      );
      return [200, response(action, `<X_EncResult>${result}</X_EncResult>`)];
    }
    if (action === 'X_EncryptedCommand') {
      const appId = tagText(body, 'X_ApplicationId');
      const keyword = tv.pairings.get(appId);
      if (!keyword) {
        return [500, fault(401, 'Unauthorized')];
      }
      const keys = deriveSessionKeys(keyword);
      const encInfo = tagText(body, 'X_EncInfo');
      if (!checkHmac(encInfo, keys.hmacKey)) {
        return [500, fault(402, 'Bad signature')];
      }
      const plain = decryptPayload(encInfo, keys);
      const sessionId = tagText(plain, 'X_SessionId');
      const sequence = Number(tagText(plain, 'X_SequenceNumber'));
      tv.calls.push({ sessionId, sequence });
      if (tv.refuseCommands > 0) {
        tv.refuseCommands -= 1;
        return [500, fault(403, 'Session expired')];
      }
      if (tv.sessions.get(sessionId) !== appId || !(sequence > tv.lastSequence)) {
        return [500, fault(403, 'Bad session')];
      }
      tv.lastSequence = sequence;
      const original = /<u:(\w+) xmlns:u="[^"]*">([\s\S]*)<\/u:\1>/.exec(plain);
      const result = original && inner(original[1], original[2]);
      if (result === undefined) {
        return [500, fault(401, 'Invalid action')];
      }
      const encrypted = encryptPayload(
        `<u:${original[1]}Response xmlns:u="urn:panasonic-com:service:p00NetworkControl:1">${result}</u:${original[1]}Response>`,
        keys,
      );
      return [200, response(action, `<X_EncResult>${encrypted}</X_EncResult>`)];
    }
    if (tv.encrypted) {
      return [500, fault(401, 'Encryption required')];
    }
    const result = inner(action, body);
    return result === undefined
      ? [500, fault(401, 'Invalid action')]
      : [200, response(action, result)];
  }

  function dmr(action, body) {
    const urn = 'schemas-upnp-org:service:RenderingControl:1';
    if (action === 'GetVolume') {
      return [200, response(action, `<CurrentVolume>${tv.volume}</CurrentVolume>`, urn)];
    }
    if (action === 'GetMute') {
      return [200, response(action, `<CurrentMute>${tv.muted ? 1 : 0}</CurrentMute>`, urn)];
    }
    if (action === 'SetVolume') {
      tv.volume = Number(tagText(body, 'DesiredVolume'));
      return [200, response(action, '', urn)];
    }
    if (action === 'SetMute') {
      tv.muted = tagText(body, 'DesiredMute') === '1';
      return [200, response(action, '', urn)];
    }
    return [500, fault(401, 'Invalid action')];
  }

  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      const isDmr = req.url === '/dmr/control_0';
      if (!tv.reachable || (isDmr && !tv.dmrReachable)) {
        req.socket.destroy();
        return;
      }
      let status = 200;
      let text = '';
      if (req.method === 'GET' && req.url === '/nrc/ddd.xml') {
        text = description({ udn: tv.udn, name: tv.name, model: tv.model });
      } else if (req.method === 'GET' && req.url === '/nrc/sdd_0.xml') {
        text = serviceList(tv.encrypted);
      } else if (req.method === 'POST' && (req.url === '/nrc/control_0' || isDmr)) {
        const action = /#(\w+)"?$/.exec(req.headers.soapaction ?? '')?.[1];
        [status, text] = isDmr ? dmr(action, body) : nrc(action, body);
      } else {
        status = 404;
      }
      res.writeHead(status, { 'Content-Type': 'text/xml; charset="utf-8"' });
      res.end(text);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  tv.port = server.address().port;
  tv.close = () =>
    new Promise((resolve) => {
      server.closeAllConnections?.();
      server.close(() => resolve());
    });
  return tv;
}
