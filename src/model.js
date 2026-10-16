// -----------------------------------------------------------------------------
// Known TVs -> Gladys devices (pure). One device per TV, keyed by the UDN of
// its UPnP description: the address may change, the UDN does not.
// -----------------------------------------------------------------------------

import { DEVICE_FEATURE_CATEGORIES, DEVICE_FEATURE_TYPES } from '@gladysassistant/integration-sdk';
import { BUTTONS, DEVICE_TYPE, FEATURES, LIMITS } from './constants.js';
import { KEYS, KEY_LABELS, KNOWN_APPS, SOURCES } from './viera/keys.js';

const TV = DEVICE_FEATURE_TYPES.TELEVISION;
const TEXT = DEVICE_FEATURE_CATEGORIES.TEXT;

/** The applications of the "Application" dropdown: the known ones, then the TV's. */
export function appOptions(tv) {
  const options = [];
  const seen = new Set();
  for (const app of [...KNOWN_APPS, ...(tv.apps ?? [])]) {
    const id = String(app.id).toUpperCase();
    if (!seen.has(id) && options.length < LIMITS.apps) {
      seen.add(id);
      options.push({ value: id, label: app.name });
    }
  }
  return options;
}

const feature = (ids, key, name, category, type, extra = {}) => ({
  name,
  external_id: ids.feature(key),
  category,
  type,
  // min/max are NOT NULL in the Gladys database, binary features included.
  min: 0,
  max: 1,
  read_only: false,
  has_feedback: false,
  keep_history: false,
  ...extra,
});

export function buildDevice(gladys, tv) {
  const ids = gladys.externalIds(DEVICE_TYPE, tv.udn);
  const television = DEVICE_FEATURE_CATEGORIES.TELEVISION;
  return {
    name: tv.model ? `${tv.name} (${tv.model})` : tv.name,
    external_id: ids.device,
    should_poll: false,
    params: [{ name: 'IP_ADDRESS', value: tv.host || '' }],
    features: [
      feature(ids, FEATURES.POWER, 'Power', television, TV.BINARY, {
        has_feedback: true,
        keep_history: true,
      }),
      feature(ids, FEATURES.VOLUME, 'Volume', television, TV.VOLUME, {
        max: 100,
        has_feedback: true,
      }),
      // A push button in Gladys: each press toggles the mute read from the TV.
      feature(ids, FEATURES.MUTE, 'Mute', television, TV.VOLUME_MUTE, { has_feedback: true }),
      ...BUTTONS.map((button) =>
        feature(ids, button.feature, button.name, television, button.type),
      ),
      feature(ids, FEATURES.SOURCE, 'Source', TEXT, DEVICE_FEATURE_TYPES.TEXT.SELECT, {
        supported_options: SOURCES.map(({ value, label }) => ({ value, label })),
      }),
      feature(ids, FEATURES.APP, 'Application', TEXT, DEVICE_FEATURE_TYPES.TEXT.SELECT, {
        supported_options: appOptions(tv),
      }),
      feature(ids, FEATURES.KEY, 'Remote key', TEXT, DEVICE_FEATURE_TYPES.TEXT.SELECT, {
        supported_options: Object.keys(KEYS).map((key) => ({ value: key, label: KEY_LABELS[key] })),
      }),
    ],
  };
}

/** The feature key of a feature external id of `device`, or undefined. */
export function featureKey(deviceExternalId, featureExternalId) {
  const prefix = `${deviceExternalId}:`;
  return String(featureExternalId ?? '').startsWith(prefix)
    ? String(featureExternalId).slice(prefix.length)
    : undefined;
}

/** The states of a TV read by polling: power, and volume and mute when on. */
export function stateList(gladys, tv, reading) {
  const ids = gladys.externalIds(DEVICE_TYPE, tv.udn);
  const states = [
    { device_feature_external_id: ids.feature(FEATURES.POWER), state: reading.on ? 1 : 0 },
  ];
  if (reading.on) {
    states.push(
      { device_feature_external_id: ids.feature(FEATURES.VOLUME), state: reading.volume },
      { device_feature_external_id: ids.feature(FEATURES.MUTE), state: reading.muted ? 1 : 0 },
    );
  }
  return states;
}
