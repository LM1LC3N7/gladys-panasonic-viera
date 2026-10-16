// -----------------------------------------------------------------------------
// Frozen keys (external ids, features, manifest actions), limits and timings.
// Every key here is stored by Gladys or by its users: never rename one.
// -----------------------------------------------------------------------------

import { DEVICE_FEATURE_TYPES } from '@gladysassistant/integration-sdk';

/** `gladys.externalIds(DEVICE_TYPE, <UDN of the TV>)`. */
export const DEVICE_TYPE = 'tv';

export const FEATURES = Object.freeze({
  POWER: 'power',
  VOLUME: 'volume',
  MUTE: 'mute',
  SOURCE: 'source',
  APP: 'app',
  KEY: 'key',
});

const TV = DEVICE_FEATURE_TYPES.TELEVISION;

/**
 * One-shot remote buttons: feature key (frozen), Gladys type, remote key and
 * name. The Gladys television types render as push buttons: the value they
 * send means "pressed", never a target state.
 */
export const BUTTONS = Object.freeze([
  { feature: 'volume_up', type: TV.VOLUME_UP, key: 'volume_up', name: 'Volume up' },
  { feature: 'volume_down', type: TV.VOLUME_DOWN, key: 'volume_down', name: 'Volume down' },
  { feature: 'channel_up', type: TV.CHANNEL_UP, key: 'channel_up', name: 'Channel up' },
  { feature: 'channel_down', type: TV.CHANNEL_DOWN, key: 'channel_down', name: 'Channel down' },
  { feature: 'last_view', type: TV.CHANNEL_PREVIOUS, key: 'last_view', name: 'Last view' },
  { feature: 'up', type: TV.UP, key: 'up', name: 'Up' },
  { feature: 'down', type: TV.DOWN, key: 'down', name: 'Down' },
  { feature: 'left', type: TV.LEFT, key: 'left', name: 'Left' },
  { feature: 'right', type: TV.RIGHT, key: 'right', name: 'Right' },
  { feature: 'enter', type: TV.ENTER, key: 'enter', name: 'OK' },
  { feature: 'back', type: TV.RETURN, key: 'back', name: 'Back' },
  { feature: 'exit', type: TV.EXIT, key: 'exit', name: 'Exit' },
  { feature: 'menu', type: TV.MENU, key: 'menu', name: 'Menu' },
  { feature: 'option', type: TV.TOOLS, key: 'option', name: 'Option' },
  { feature: 'info', type: TV.INFO, key: 'info', name: 'Info' },
  { feature: 'guide', type: TV.GUIDE, key: 'guide', name: 'Guide' },
  { feature: 'input', type: TV.SOURCE, key: 'input', name: 'Input' },
  { feature: 'play', type: TV.PLAY, key: 'play', name: 'Play' },
  { feature: 'pause', type: TV.PAUSE, key: 'pause', name: 'Pause' },
  { feature: 'stop', type: TV.STOP, key: 'stop', name: 'Stop' },
  { feature: 'rewind', type: TV.REWIND, key: 'rewind', name: 'Rewind' },
  { feature: 'fast_forward', type: TV.FORWARD, key: 'fast_forward', name: 'Fast forward' },
  { feature: 'skip_previous', type: TV.PREVIOUS, key: 'skip_previous', name: 'Skip back' },
  { feature: 'skip_next', type: TV.NEXT, key: 'skip_next', name: 'Skip forward' },
  { feature: 'record', type: TV.RECORD, key: 'record', name: 'Record' },
]);

export const ACTIONS = Object.freeze({
  FIND: 'find_tvs',
  START_PAIRING: 'start_pairing',
  FINISH_PAIRING: 'finish_pairing',
  CHECK: 'check_tvs',
});

export const POLL_INTERVAL = Object.freeze({ min: 5, max: 300, default: 10 });

export const TIMINGS = Object.freeze({
  /** One HTTP exchange with a TV. */
  httpTimeout: 4000,
  /** A typed address that did not answer is asked again after this. */
  probeRetry: 60_000,
  /** The PIN displayed by the TV is accepted for this long. */
  pairingTtl: 5 * 60_000,
  /** After a Wake-on-LAN packet, how long the TV is waited for, and how often asked. */
  wakeWait: 20_000,
  wakeStep: 2_000,
  /** After a power key, the state is read again this much later. */
  recheckDelay: 3_000,
  /** Writes to /data are grouped. */
  persistDelay: 1_000,
  /** SSDP listening time of a search. */
  scanSeconds: 5,
});

export const LIMITS = Object.freeze({ tvs: 20, addresses: 20, apps: 60 });

/** Name the TVs show for the paired remote (in their "TV Remote" settings). */
export const REMOTE_NAME = 'Gladys';
