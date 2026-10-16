# TODO — Panasonic Viera v1

Handoff document: what is done, what was decided, what comes next. Keep it
up to date at the end of every milestone.

## Working method

- One milestone at a time, one commit per milestone, tests green before moving on.
- After each milestone: `npm run format:check`, `npm run lint`, `npm test`
  (Node 22 and 24), `npm audit --omit=dev`,
  `npx github:GladysAssistant/integration-store .`, then update README,
  `docs/en.md`, `docs/fr.md`, `CHANGELOG.md` and this file.
- The `gladys-assistant-integration` topic is added at the first real release
  only.

## Status

- [x] **Milestone 1 — local remote control** (2026-10-16): TVs added by IP
      address or found by SSDP (`scanNetwork('ssdp')`), identity by the UDN of
      `/nrc/ddd.xml`, encrypted model detected from `/nrc/sdd_0.xml`; power,
      volume, mute, 25 remote buttons, Source / Application / Remote key
      dropdowns; PIN pairing (two configuration buttons), AES/HMAC session
      ported from panasonic-viera, keys in `/data`; Wake-on-LAN through
      Gladys; "Check the TVs" button; docs en/fr. Tested against a fake TV on
      the loopback interface only, never against a real TV.
- [ ] **Milestone 2 — real TVs** (testers with a Viera TV): record real
      answers as fixtures, fix what differs. To check first:
  - the power state: does a TV in standby with "Powered On by Apps" (or
    network standby) still answer `GetMute` on DMR? Then it shows as on, and
    "turn on" sends nothing;
  - whether the encrypted session expires, and which error the TV answers
    then (renewed once today, on any SOAP fault or HTTP error);
  - the `X_GetAppList` format on 2018+ models, and the product ids of the
    known applications in Europe;
  - the HDMI 1-4 direct keys on each generation (some models may only know
    the input menu key);
  - Wake-on-LAN: which models wake from deep standby, and whether the TV
    switches the screen on (or only the network) after the packet;
  - the MAC in the SSDP answer relayed by Gladys (`source_mac`).
- [ ] **Milestone 3 — more**: the current input and application read back
      (PAC `QMI` on the models that publish it), the UPnP events (state pushed
      instead of polled), "forget a TV" action, picture mode (PAC).
- [ ] **Milestone 4 — first release**: Docker image build check, Release
      workflow, topic, then the store validator once the image is published.

## Decisions

- Forum: no dedicated topic, no post from this module's work; one recap per
  wave in /t/10385, posted by the main session.
- Reuse: florianholzapfel/panasonic-viera (MIT) is Python, so its requests,
  key schedules, encryption, key codes and application ids are ported to
  JavaScript (`src/viera/`), byte for byte for the crypto; MIT notice in
  `THIRD_PARTY_NOTICES.md`, copied into the image. No runtime dependency
  besides the SDK (node:http and node:crypto are built in).
- Version 0.1.0 in `package.json`, `package-lock.json`, the manifest and the
  `docker_image` tag, set by hand at milestone 1: the one exception to
  "versions belong to the Release workflow", because the template's 1.0.0 and
  its image were someone else's. The first patch release gives 0.1.1.
- External ids: `gladys.externalIds('tv', <UDN>)`, the UDN of the UPnP
  description (lower case, without `uuid:`), never the address. Feature keys
  are frozen: `power`, `volume`, `mute`, `source`, `app`, `key`, and the
  buttons of `BUTTONS` in `src/constants.js`.
- Power: "on" means "DMR answers `GetMute`". The power key is a toggle, so the
  state is read from the TV just before acting and nothing is sent when it
  already matches; commands are serialized per TV. Turning on: with a MAC,
  Wake-on-LAN then up to 20 s of waiting, and never a power key after it (a
  TV still booting would be turned off); without a MAC, the power key (works
  from network standby / "Powered On by Apps").
- Mute is a Gladys push button (`television`/`volume-mute`): each press reads
  the mute from the TV and sets the opposite (lesson of gladys-denon-avr).
- Volume and mute use DMR (RenderingControl), never encrypted: they work
  before pairing. Keys and applications use NRC, encrypted on the PIN models.
- Volume has no unit: `television` lists none in
  `DEVICE_FEATURE_UNITS_BY_CATEGORY`.
- Source, application and remote key are `text`/`select` dropdowns (values
  are strings, validated against the options before anything is sent). The
  current source and application are not read back (no state published).
- Pairing: two configuration buttons ("Start pairing" with the address,
  "Finish pairing" with the PIN), one pairing at a time, 5 minutes. A refused
  PIN ends the attempt (the TV drops its challenge); an unreachable TV keeps
  it. The keys are written to `/data` at once (mode 0600), never logged, never
  sent to Gladys (not in device params).
- Keys refused by the TV (`X_GetEncryptSessionId` fault, 401/403): marked
  once, the status asks for a new pairing, and no NRC request goes to that TV
  until then (no renewal loop). An encrypted command refused by a fault or an
  HTTP error renews the session once, the sequence number restored as the
  library does.
- Encrypted answers: the TV's HMAC is not checked (the library does not
  either, and its presence is not certain); the payload is cut at the first
  NUL as the library does. LAN only.
- Addresses are not trusted alone: when a TV comes back online, the UDN at its
  address is read again; another TV there clears the address (found again by
  the next search). A typed address that does not answer is asked again every
  minute.
- SSDP: the `LOCATION` header is not followed; the description is read at the
  answering IPv4 address, on port 55000. The `source_mac` of the answer is
  kept for Wake-on-LAN; a MAC typed in the configuration wins.
- Polling 5 s to 300 s (default 10 s), own timer (`should_poll: false`):
  only the created TVs; states through `publishChangedStates` (only changes).
