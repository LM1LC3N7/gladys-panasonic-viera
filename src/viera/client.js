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
//
// `withBudget(ms)` returns a view of the same client (same credentials, same
// session) whose requests all fit in `ms`: a Gladys command is acked within
// 5 seconds, so a command never waits longer than its budget.
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
// What an explicit refusal of the stored keys looks like (anything else is
// treated as a passing failure, counted by the app).
const EXPLICIT_REFUSAL = /unauthori[sz]ed|forbidden|not\s+(?:paired|registered)|authenticat/i;
const MIN_REQUEST_MS = 50;
const NO_SUCH_SESSION = /no\s+such\s+session/i;

/** The TV explicitly says the session is gone (so it did not run the command). */
export function isSessionExpired(err) {
  return (
    (err?.kind === ERROR_KINDS.FAULT || err?.kind === ERROR_KINDS.HTTP) &&
    err.status === 500 &&
    (NO_SUCH_SESSION.test(err.statusMessage ?? '') || NO_SUCH_SESSION.test(err.description ?? ''))
  );
}

export class VieraClient {
  /**
   * @param {{ host: string, port?: number, encrypted?: boolean,
   *   credentials?: { appId: string, encKey: string },
   *   request?: typeof defaultRequest, timeoutMs?: number,
   *   random?: (size: number) => Buffer, onSession?: () => void,
   *   now?: () => number }} options
   */
  constructor({
    host,
    port = DEFAULT_PORT,
    encrypted = false,
    credentials,
    request = defaultRequest,
    timeoutMs = 4000,
    random,
    onSession,
    now = Date.now,
  }) {
    this.host = host;
    this.port = port;
    this.request = request;
    this.timeoutMs = timeoutMs;
    this.random = random;
    this.onSession = onSession;
    this.now = now;
    this.deadline = undefined;
    // Shared by every budgeted view of this client.
    this.shared = { encrypted, appId: undefined, keys: undefined, session: undefined };
    this.setCredentials(credentials);
  }

  get encrypted() {
    return this.shared.encrypted;
  }

  set encrypted(value) {
    this.shared.encrypted = value;
  }

  get appId() {
    return this.shared.appId;
  }

  get session() {
    return this.shared.session;
  }

  setCredentials(credentials) {
    this.shared.session = undefined;
    if (credentials?.appId && credentials?.encKey) {
      this.shared.appId = credentials.appId;
      this.shared.keys = deriveSessionKeys(credentials.encKey);
    } else {
      this.shared.appId = undefined;
      this.shared.keys = undefined;
    }
  }

  get paired() {
    return Boolean(this.shared.appId && this.shared.keys);
  }

  /** The same client, every request of which ends within `ms` from now. */
  withBudget(ms) {
    const view = Object.create(this);
    view.deadline = this.now() + ms;
    return view;
  }

  requestTimeout() {
    if (this.deadline === undefined) {
      return this.timeoutMs;
    }
    const left = this.deadline - this.now();
    if (left < MIN_REQUEST_MS) {
      // Not "unreachable": nothing was asked, so nothing is known of the TV.
      throw new TvError(ERROR_KINDS.BUDGET, 'No time left for this command');
    }
    return Math.min(this.timeoutMs, left);
  }

  async get(path) {
    const res = await this.request({
      host: this.host,
      port: this.port,
      path,
      timeoutMs: this.requestTimeout(),
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
      timeoutMs: this.requestTimeout(),
    });
    if (res.status >= 200 && res.status < 300) {
      return res.body;
    }
    const statusMessage = res.statusMessage ?? '';
    const fault = parseFault(res.body);
    if (fault) {
      throw new TvError(
        ERROR_KINDS.FAULT,
        `${action} refused: ${fault.code ?? '?'} ${fault.description ?? ''}`.trim(),
        { status: res.status, statusMessage, code: fault.code, description: fault.description },
      );
    }
    throw new TvError(ERROR_KINDS.HTTP, `${action}: HTTP ${res.status} ${statusMessage}`.trim(), {
      status: res.status,
      statusMessage,
    });
  }

  // --- Encrypted session ------------------------------------------------------

  async requestSession() {
    const { appId, keys } = this.shared;
    if (!this.paired) {
      throw new TvError(ERROR_KINDS.PAIRING_REQUIRED, 'This TV must be paired first');
    }
    const encInfo = encryptPayload(
      `<X_ApplicationId>${escapeXml(appId)}</X_ApplicationId>`,
      keys,
      this.random,
    );
    let body;
    try {
      body = await this.soap(
        URL_NRC,
        URN_REMOTE_CONTROL,
        'X_GetEncryptSessionId',
        `<X_ApplicationId>${escapeXml(appId)}</X_ApplicationId><X_EncInfo>${encInfo}</X_EncInfo>`,
        'u',
      );
    } catch (err) {
      if (
        err.status === 401 ||
        err.status === 403 ||
        (err.kind === ERROR_KINDS.FAULT && EXPLICIT_REFUSAL.test(err.description ?? ''))
      ) {
        throw new TvError(ERROR_KINDS.KEYS_REFUSED, 'The TV refused the stored keys', {
          code: err.code,
        });
      }
      if (err.kind === ERROR_KINDS.FAULT || err.kind === ERROR_KINDS.HTTP) {
        // A busy or confused TV: not a proof that the keys are gone.
        throw new TvError(ERROR_KINDS.SESSION_REFUSED, 'The TV did not open a session', {
          status: err.status,
          code: err.code,
          description: err.description,
        });
      }
      throw err;
    }
    const sessionId = this.decrypted(body, 'X_EncResult', 'X_SessionId', keys);
    this.shared.session = { id: sessionId, sequence: 1 };
    this.onSession?.();
    return this.shared.session;
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
   * the encrypted ones.
   *
   * Any HTTP error or SOAP fault of the encrypted command drops the session,
   * so the next command opens a new one. The command is sent again (once, the
   * power toggle included) only when the TV explicitly says the session is
   * gone: HTTP 500 with "No such session" in the reason phrase or the fault.
   * It then did not run it. A timeout or any other error is ambiguous (the TV
   * may have run it): never sent again.
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
      if (!isSessionExpired(err)) {
        throw err;
      }
      return this.encryptedCommand(action, params);
    }
  }

  async encryptedCommand(action, params) {
    if (!this.shared.session) {
      await this.requestSession();
    }
    const session = this.shared.session;
    const { appId, keys } = this.shared;
    session.sequence += 1;
    const encInfo = encryptPayload(
      encryptedInner(session.id, session.sequence, URN_REMOTE_CONTROL, action, params),
      keys,
      this.random,
    );
    let body;
    try {
      body = await this.soap(
        URL_NRC,
        URN_REMOTE_CONTROL,
        'X_EncryptedCommand',
        `<X_ApplicationId>${escapeXml(appId)}</X_ApplicationId><X_EncInfo>${encInfo}</X_EncInfo>`,
        'u',
      );
    } catch (err) {
      if (err.kind === ERROR_KINDS.FAULT || err.kind === ERROR_KINDS.HTTP) {
        // An explicit HTTP error: the TV did not take the number (restored as
        // the library does on HTTPError), and whatever it disliked, the next
        // command starts a new session.
        session.sequence -= 1;
        if (this.shared.session === session) {
          this.shared.session = undefined;
        }
      }
      // A timeout or a lost connection: the TV may have used the number, it
      // is not given back (the library does not either).
      throw err;
    }
    return this.decrypted(body, 'X_EncResult', undefined, keys);
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
   * success keeps and returns the credentials. The session is opened by the
   * caller once they are saved.
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
    return { appId, encKey };
  }

  // --- Commands ---------------------------------------------------------------

  async sendKey(name) {
    const code = Object.hasOwn(KEYS, name) ? KEYS[name] : undefined;
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
    // The library sends Python's None as the (empty) argument: kept as is.
    return parseAppList(await this.nrc('X_GetAppList', 'None'));
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
    return value;
  }

  async getMute() {
    const body = await this.soap(URL_DMR, URN_RENDERING_CONTROL, 'GetMute', DMR_CHANNEL);
    const mute = tagText(body, 'CurrentMute');
    if (mute !== '0' && mute !== '1' && !/^(true|false)$/i.test(mute ?? '')) {
      throw new TvError(ERROR_KINDS.PROTOCOL, 'CurrentMute missing in the answer');
    }
    return mute === '1' || mute.toLowerCase() === 'true';
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
