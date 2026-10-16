// -----------------------------------------------------------------------------
// The client of one Viera TV, ported from the RemoteControl class of
// florianholzapfel/panasonic-viera (MIT, see THIRD_PARTY_NOTICES.md):
//   - the UPnP description and the service list (encrypted model or not);
//   - DMR (RenderingControl) volume and mute, never encrypted;
//   - NRC (network remote control) keys and applications, wrapped in an
//     encrypted session on the PIN models;
//   - the PIN pairing, which returns the application id and the key to keep.
// The session sequence number is restored when a command fails, as the
// library does. Nothing here logs: the keys and the PIN never leave it.
// -----------------------------------------------------------------------------

import { decryptPayload, derivePinKeys, deriveSessionKeys, encryptPayload } from './crypto.js';
import { ERROR_KINDS, TvError, request as defaultRequest } from './http.js';
import { KEYS, isProductId } from './keys.js';
import {
  DEFAULT_PORT,
  URL_DESCRIPTION,
  URL_DMR,
  URL_NRC,
  URL_NRC_SERVICE,
  URN_REMOTE_CONTROL,
  URN_RENDERING_CONTROL,
  encryptedInner,
  envelope,
  escapeXml,
  needsEncryption,
  parseAppList,
  parseDescription,
  parseFault,
  tagText,
} from './soap.js';

const DMR_CHANNEL = '<InstanceID>0</InstanceID><Channel>Master</Channel>';
// NRC actions sent in clear even on the encrypted models.
const CLEAR_ACTIONS = new Set(['X_GetEncryptSessionId', 'X_DisplayPinCode', 'X_RequestAuth']);

export class VieraClient {
  /**
   * @param {{ host: string, port?: number, encrypted?: boolean,
   *   credentials?: { appId: string, encKey: string },
   *   request?: typeof defaultRequest, timeoutMs?: number,
   *   random?: (size: number) => Buffer }} options
   */
  constructor({
    host,
    port = DEFAULT_PORT,
    encrypted = false,
    credentials,
    request = defaultRequest,
    timeoutMs = 4000,
    random,
  }) {
    this.host = host;
    this.port = port;
    this.encrypted = encrypted;
    this.request = request;
    this.timeoutMs = timeoutMs;
    this.random = random;
    this.session = undefined;
    this.setCredentials(credentials);
  }

  setCredentials(credentials) {
    this.session = undefined;
    if (credentials?.appId && credentials?.encKey) {
      this.appId = credentials.appId;
      this.keys = deriveSessionKeys(credentials.encKey);
    } else {
      this.appId = undefined;
      this.keys = undefined;
    }
  }

  get paired() {
    return Boolean(this.appId && this.keys);
  }

  async get(path) {
    const res = await this.request({
      host: this.host,
      port: this.port,
      path,
      timeoutMs: this.timeoutMs,
    });
    if (res.status < 200 || res.status >= 300) {
      throw new TvError(ERROR_KINDS.HTTP, `HTTP ${res.status} on ${path}`, { status: res.status });
    }
    return res.body;
  }

  /** The UPnP description: `{ udn, name, model, manufacturer }`. */
  async describe() {
    const description = parseDescription(await this.get(URL_DESCRIPTION));
    if (!description) {
      throw new TvError(ERROR_KINDS.PROTOCOL, 'Not a Panasonic TV');
    }
    return description;
  }

  /** Whether this model wants the PIN pairing and the encrypted session. */
  async detectEncryption() {
    this.encrypted = needsEncryption(await this.get(URL_NRC_SERVICE));
    return this.encrypted;
  }

  async soap(path, urn, action, params, prefix = 'm') {
    const res = await this.request({
      host: this.host,
      port: this.port,
      method: 'POST',
      path,
      headers: {
        'Content-Type': 'text/xml; charset=utf-8',
        SOAPAction: `"urn:${urn}#${action}"`,
      },
      body: envelope(urn, action, params, prefix),
      timeoutMs: this.timeoutMs,
    });
    if (res.status >= 200 && res.status < 300) {
      return res.body;
    }
    const fault = parseFault(res.body);
    if (fault) {
      throw new TvError(
        ERROR_KINDS.FAULT,
        `${action} refused: ${fault.code ?? '?'} ${fault.description ?? ''}`.trim(),
        { status: res.status, code: fault.code, description: fault.description },
      );
    }
    throw new TvError(ERROR_KINDS.HTTP, `${action}: HTTP ${res.status}`, { status: res.status });
  }

  // --- Encrypted session ------------------------------------------------------

  async requestSession() {
    if (!this.paired) {
      throw new TvError(ERROR_KINDS.PAIRING_REQUIRED, 'This TV must be paired first');
    }
    const encInfo = encryptPayload(
      `<X_ApplicationId>${escapeXml(this.appId)}</X_ApplicationId>`,
      this.keys,
      this.random,
    );
    let body;
    try {
      body = await this.soap(
        URL_NRC,
        URN_REMOTE_CONTROL,
        'X_GetEncryptSessionId',
        `<X_ApplicationId>${escapeXml(this.appId)}</X_ApplicationId><X_EncInfo>${encInfo}</X_EncInfo>`,
        'u',
      );
    } catch (err) {
      if (err.kind === ERROR_KINDS.FAULT || err.status === 401 || err.status === 403) {
        // The TV no longer knows this application (reset, or pairing removed).
        throw new TvError(ERROR_KINDS.KEYS_REFUSED, 'The TV refused the stored keys', {
          code: err.code,
        });
      }
      throw err;
    }
    const sessionId = this.decrypted(body, 'X_EncResult', 'X_SessionId', this.keys);
    this.session = { id: sessionId, sequence: 1 };
    return this.session;
  }

  /** Decrypts `outer` of a SOAP answer and reads `inner` from it. */
  decrypted(body, outer, inner, keys) {
    const encrypted = tagText(body, outer);
    if (!encrypted) {
      throw new TvError(ERROR_KINDS.PROTOCOL, `${outer} missing in the answer`);
    }
    let plain;
    try {
      plain = decryptPayload(encrypted, keys);
    } catch {
      throw new TvError(ERROR_KINDS.PROTOCOL, `${outer} could not be decrypted`);
    }
    if (!inner) {
      return plain;
    }
    const value = tagText(`<X_Data>${plain}</X_Data>`, inner);
    if (!value) {
      throw new TvError(ERROR_KINDS.PROTOCOL, `${inner} missing in ${outer}`);
    }
    return value;
  }

  /**
   * One NRC command: in clear on the older models, wrapped in the session on
   * the encrypted ones. A refused encrypted command renews the session once
   * (it may have expired), never more.
   */
  async nrc(action, params = '') {
    if (!this.encrypted || CLEAR_ACTIONS.has(action)) {
      return this.soap(URL_NRC, URN_REMOTE_CONTROL, action, params, 'm');
    }
    if (!this.paired) {
      throw new TvError(ERROR_KINDS.PAIRING_REQUIRED, 'This TV must be paired first');
    }
    try {
      return await this.encryptedCommand(action, params);
    } catch (err) {
      if (err.kind !== ERROR_KINDS.FAULT && err.kind !== ERROR_KINDS.HTTP) {
        throw err;
      }
      this.session = undefined;
      return this.encryptedCommand(action, params);
    }
  }

  async encryptedCommand(action, params) {
    if (!this.session) {
      await this.requestSession();
    }
    const session = this.session;
    session.sequence += 1;
    const encInfo = encryptPayload(
      encryptedInner(session.id, session.sequence, URN_REMOTE_CONTROL, action, params),
      this.keys,
      this.random,
    );
    let body;
    try {
      body = await this.soap(
        URL_NRC,
        URN_REMOTE_CONTROL,
        'X_EncryptedCommand',
        `<X_ApplicationId>${escapeXml(this.appId)}</X_ApplicationId><X_EncInfo>${encInfo}</X_EncInfo>`,
        'u',
      );
    } catch (err) {
      session.sequence -= 1;
      throw err;
    }
    return this.decrypted(body, 'X_EncResult', undefined, this.keys);
  }

  // --- Pairing ----------------------------------------------------------------

  /** Asks the TV to display a PIN; returns the challenge (base64) to keep. */
  async requestPin(deviceName = 'Gladys') {
    const body = await this.soap(
      URL_NRC,
      URN_REMOTE_CONTROL,
      'X_DisplayPinCode',
      `<X_DeviceName>${escapeXml(deviceName)}</X_DeviceName>`,
      'u',
    );
    const challenge = tagText(body, 'X_ChallengeKey');
    if (!challenge || Buffer.from(challenge, 'base64').length !== 16) {
      throw new TvError(ERROR_KINDS.PROTOCOL, 'X_ChallengeKey missing in the answer');
    }
    return challenge;
  }

  /**
   * Sends the PIN typed by the user, encrypted with the challenge keys; on
   * success keeps and returns the credentials, after opening a session.
   * @returns {Promise<{ appId: string, encKey: string }>}
   */
  async authorizePin(challenge, pin) {
    const keys = derivePinKeys(challenge);
    const authInfo = encryptPayload(`<X_PinCode>${escapeXml(pin)}</X_PinCode>`, keys, this.random);
    let body;
    try {
      body = await this.soap(
        URL_NRC,
        URN_REMOTE_CONTROL,
        'X_RequestAuth',
        `<X_AuthInfo>${authInfo}</X_AuthInfo>`,
        'u',
      );
    } catch (err) {
      if (err.kind === ERROR_KINDS.FAULT && err.code === '600') {
        throw new TvError(ERROR_KINDS.INVALID_PIN, 'Invalid PIN');
      }
      throw err;
    }
    const plain = this.decrypted(body, 'X_AuthResult', undefined, keys);
    const appId = tagText(`<X_Data>${plain}</X_Data>`, 'X_ApplicationId');
    const encKey = tagText(`<X_Data>${plain}</X_Data>`, 'X_Keyword');
    if (!appId || !encKey || Buffer.from(encKey, 'base64').length !== 16) {
      throw new TvError(ERROR_KINDS.PROTOCOL, 'X_AuthResult incomplete');
    }
    this.encrypted = true;
    this.setCredentials({ appId, encKey });
    await this.requestSession();
    return { appId, encKey };
  }

  // --- Commands ---------------------------------------------------------------

  async sendKey(name) {
    const code = KEYS[name];
    if (!code) {
      throw new TvError(ERROR_KINDS.PROTOCOL, `Unknown key "${String(name).slice(0, 32)}"`);
    }
    await this.nrc('X_SendKey', `<X_KeyEvent>${code}</X_KeyEvent>`);
  }

  async launchApp(id) {
    const value = String(id ?? '');
    let keyword;
    if (isProductId(value)) {
      keyword = `product_id=${value.toUpperCase()}`;
    } else if (/^\d{1,10}$/.test(value)) {
      keyword = `resource_id=${value}`;
    } else {
      throw new TvError(ERROR_KINDS.PROTOCOL, 'Invalid application id');
    }
    await this.nrc(
      'X_LaunchApp',
      `<X_AppType>vc_app</X_AppType><X_LaunchKeyword>${keyword}</X_LaunchKeyword>`,
    );
  }

  async getApps() {
    return parseAppList(await this.nrc('X_GetAppList', ''));
  }

  async getVolume() {
    const body = await this.soap(URL_DMR, URN_RENDERING_CONTROL, 'GetVolume', DMR_CHANNEL);
    const volume = Number(tagText(body, 'CurrentVolume'));
    if (!Number.isInteger(volume)) {
      throw new TvError(ERROR_KINDS.PROTOCOL, 'CurrentVolume missing in the answer');
    }
    return Math.min(100, Math.max(0, volume));
  }

  async setVolume(volume) {
    const value = Math.round(Number(volume));
    if (!Number.isFinite(value) || value < 0 || value > 100) {
      throw new TvError(ERROR_KINDS.PROTOCOL, 'The volume goes from 0 to 100');
    }
    await this.soap(
      URL_DMR,
      URN_RENDERING_CONTROL,
      'SetVolume',
      `${DMR_CHANNEL}<DesiredVolume>${value}</DesiredVolume>`,
    );
  }

  async getMute() {
    const body = await this.soap(URL_DMR, URN_RENDERING_CONTROL, 'GetMute', DMR_CHANNEL);
    const mute = tagText(body, 'CurrentMute');
    if (mute === undefined) {
      throw new TvError(ERROR_KINDS.PROTOCOL, 'CurrentMute missing in the answer');
    }
    return mute !== '0' && mute.toLowerCase() !== 'false';
  }

  async setMute(muted) {
    await this.soap(
      URL_DMR,
      URN_RENDERING_CONTROL,
      'SetMute',
      `${DMR_CHANNEL}<DesiredMute>${muted ? 1 : 0}</DesiredMute>`,
    );
  }
}
