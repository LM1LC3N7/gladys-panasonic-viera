// -----------------------------------------------------------------------------
// The remote control keys and the application ids of the Viera TVs, from
// florianholzapfel/panasonic-viera (MIT, see THIRD_PARTY_NOTICES.md). The
// names on the left are this integration's own, frozen once released: they
// are the values users store in their scenes.
// -----------------------------------------------------------------------------

/** Key name -> NRC key code (sent as `X_KeyEvent`). */
export const KEYS = Object.freeze({
  power: 'NRC_POWER-ONOFF',
  volume_up: 'NRC_VOLUP-ONOFF',
  volume_down: 'NRC_VOLDOWN-ONOFF',
  mute: 'NRC_MUTE-ONOFF',
  channel_up: 'NRC_CH_UP-ONOFF',
  channel_down: 'NRC_CH_DOWN-ONOFF',
  last_view: 'NRC_R_TUNE-ONOFF',
  up: 'NRC_UP-ONOFF',
  down: 'NRC_DOWN-ONOFF',
  left: 'NRC_LEFT-ONOFF',
  right: 'NRC_RIGHT-ONOFF',
  enter: 'NRC_ENTER-ONOFF',
  back: 'NRC_RETURN-ONOFF',
  exit: 'NRC_CANCEL-ONOFF',
  home: 'NRC_HOME-ONOFF',
  menu: 'NRC_MENU-ONOFF',
  option: 'NRC_SUBMENU-ONOFF',
  info: 'NRC_INFO-ONOFF',
  guide: 'NRC_EPG-ONOFF',
  apps: 'NRC_APPS-ONOFF',
  input: 'NRC_CHG_INPUT-ONOFF',
  tv: 'NRC_TV-ONOFF',
  hdmi1: 'NRC_HDMI1-ONOFF',
  hdmi2: 'NRC_HDMI2-ONOFF',
  hdmi3: 'NRC_HDMI3-ONOFF',
  hdmi4: 'NRC_HDMI4-ONOFF',
  play: 'NRC_PLAY-ONOFF',
  pause: 'NRC_PAUSE-ONOFF',
  stop: 'NRC_STOP-ONOFF',
  rewind: 'NRC_REW-ONOFF',
  fast_forward: 'NRC_FF-ONOFF',
  skip_previous: 'NRC_SKIP_PREV-ONOFF',
  skip_next: 'NRC_SKIP_NEXT-ONOFF',
  record: 'NRC_REC-ONOFF',
  red: 'NRC_RED-ONOFF',
  green: 'NRC_GREEN-ONOFF',
  yellow: 'NRC_YELLOW-ONOFF',
  blue: 'NRC_BLUE-ONOFF',
  text: 'NRC_TEXT-ONOFF',
  subtitles: 'NRC_STTL-ONOFF',
  aspect: 'NRC_ASPECT-ONOFF',
  off_timer: 'NRC_OFFTIMER-ONOFF',
  num_0: 'NRC_D0-ONOFF',
  num_1: 'NRC_D1-ONOFF',
  num_2: 'NRC_D2-ONOFF',
  num_3: 'NRC_D3-ONOFF',
  num_4: 'NRC_D4-ONOFF',
  num_5: 'NRC_D5-ONOFF',
  num_6: 'NRC_D6-ONOFF',
  num_7: 'NRC_D7-ONOFF',
  num_8: 'NRC_D8-ONOFF',
  num_9: 'NRC_D9-ONOFF',
});

/** Labels of the "Remote key" dropdown (Gladys option labels are plain strings). */
export const KEY_LABELS = Object.freeze({
  power: 'Power',
  volume_up: 'Volume +',
  volume_down: 'Volume -',
  mute: 'Mute',
  channel_up: 'Channel +',
  channel_down: 'Channel -',
  last_view: 'Last view',
  up: 'Up',
  down: 'Down',
  left: 'Left',
  right: 'Right',
  enter: 'OK',
  back: 'Back',
  exit: 'Exit',
  home: 'Home',
  menu: 'Menu',
  option: 'Option',
  info: 'Info',
  guide: 'Guide',
  apps: 'Apps',
  input: 'Input',
  tv: 'TV',
  hdmi1: 'HDMI 1',
  hdmi2: 'HDMI 2',
  hdmi3: 'HDMI 3',
  hdmi4: 'HDMI 4',
  play: 'Play',
  pause: 'Pause',
  stop: 'Stop',
  rewind: 'Rewind',
  fast_forward: 'Fast forward',
  skip_previous: 'Skip back',
  skip_next: 'Skip forward',
  record: 'Record',
  red: 'Red',
  green: 'Green',
  yellow: 'Yellow',
  blue: 'Blue',
  text: 'Teletext',
  subtitles: 'Subtitles',
  aspect: 'Aspect',
  off_timer: 'Off timer',
  num_0: '0',
  num_1: '1',
  num_2: '2',
  num_3: '3',
  num_4: '4',
  num_5: '5',
  num_6: '6',
  num_7: '7',
  num_8: '8',
  num_9: '9',
});

/** The sources of the "Source" dropdown: each one is a direct key. */
export const SOURCES = Object.freeze([
  { value: 'tv', label: 'TV', key: 'tv' },
  { value: 'hdmi1', label: 'HDMI 1', key: 'hdmi1' },
  { value: 'hdmi2', label: 'HDMI 2', key: 'hdmi2' },
  { value: 'hdmi3', label: 'HDMI 3', key: 'hdmi3' },
  { value: 'hdmi4', label: 'HDMI 4', key: 'hdmi4' },
]);

/**
 * Applications known to the library, launched by product id. The TV's own
 * list (`X_GetAppList`, read once paired) is added to these.
 */
export const KNOWN_APPS = Object.freeze([
  { id: '0010000200000001', name: 'Netflix' },
  { id: '0070000200180001', name: 'YouTube' },
  { id: '0010000100180001', name: 'Prime Video' },
  { id: '0077777700160002', name: 'Web browser' },
  { id: '0387878700000013', name: 'Recorded TV' },
  { id: '0387878700000050', name: 'Multi window' },
  { id: '0070000C00000001', name: 'Weather' },
]);

/** A product id: 16 hexadecimal characters. */
export const isProductId = (value) => /^[0-9A-F]{16}$/i.test(String(value ?? ''));
