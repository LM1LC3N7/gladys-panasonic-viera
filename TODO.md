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
    "turn on" sends nothing (but Wake-on-LAN). And the other way: a TV on
    whose DMR does not answer shows as off. A better source to evaluate:
    `X_ScreenState` through a UPnP event subscription (the reference library
    subscribes to the NRC service events);
  - whether the encrypted session expires, and which error the TV answers
    then (renewed once today, only on HTTP 500 "No such session"); what an
    explicit refusal of the keys looks like (401/403, "Unauthorized"?);
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
- Power: "on" means "DMR answers `GetMute`", "off" means "nothing answers"
  (connection refused, reset or timeout); an HTTP error, a SOAP fault or an
  unreadable answer is **unknown**: nothing published, no toggle sent. The
  power key is a toggle, so the state is read from the TV just before acting
  (1.5 s at most) and nothing is sent when it already matches; commands are
  serialized per TV.
- Gladys acks a command within 5 s: every command has a 4.2 s budget counted
  from the request of Gladys (the wait in the per-TV queue included), shared
  by all its requests (`VieraClient.withBudget`); a request with no time left
  is "budget", read as an unknown state, never as "off". Background work in
  the queue (application list, slow key retry) gets 1.5 s.
- Turning on with a MAC: Wake-on-LAN always (unknown state included); if the
  state is off but port 55000 answers (network standby), the power key first,
  then the packet. The command is acked right after the packet; the TV is
  then waited for 20 s in the background, the packet sent again every 2.5 s
  (Gladys allows one per 2 s, a 429 is left to the next try), never a power
  key after it. Without a MAC: the power key when off, an error when unknown
  or unreachable. Optional subnet broadcast (`wake_broadcast`). `stop()`
  cancels the waits and rechecks.
- Workaround for a wrong state, documented: the "Remote key" dropdown, value
  `power`, sends the raw key without reading the state.
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
  "Finish pairing" with the PIN, 4 to 8 digits), one pairing at a time, 5
  minutes. A refused PIN ends the attempt (the TV drops its challenge); an
  unreachable TV keeps it. The keys are written to `/data` at once (mode 0600) and before the first session is asked, never logged, never sent to
  Gladys (not in device params). They stay in `/data` when the device is
  deleted: a "forget a TV" action is planned for milestone 3. A Gladys that
  sends no `fields` gets "update Gladys".
- Keys refused: only on an explicit refusal (HTTP 401/403, or a fault saying
  unauthorized / forbidden / not paired / authentication) or after 3 session
  refusals at least 1 minute apart while the TV is surely on; anything else
  (e.g. "Action failed") is a passing error. Any session obtained clears the
  mark. Marked keys are tried again every 30 minutes (on a command or while
  polling a TV that is on), never in a loop. The application list is only
  asked of a TV surely on, and asked again after 10 minutes when it failed.
- Encrypted session: renewed once, only on HTTP 500 "No such session"; the
  power key is never sent twice; the sequence number is restored on failure
  as the library does. `X_GetAppList` is sent with `None` as its argument,
  like the library.
- An unreadable `/data/viera.json` is renamed `viera.json.bad` (0600) and
  reported in the status; the TVs are found again from the addresses and the
  search.
- Answers are capped at 64 KB and read with a linear `tagText` (indexOf of the
  opening then the closing tag), no backtracking regular expression.
- Crypto checked against fixed vectors computed in Python 3.13 from a hand
  port of the library's functions over a pure-Python AES-128 (verified with
  the FIPS-197 vector): pycryptodome is not installed here.
- SSDP: both search targets are declared (`p00RemoteController` device and
  `p00NetworkControl` service).
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
