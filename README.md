# gladys-panasonic-viera

[Gladys Assistant](https://gladysassistant.com) external integration for
**Panasonic Viera** TVs, on the local network: power, volume, mute, remote
keys, source (TV, HDMI 1 to 4) and application launch, through the UPnP/SOAP
network remote control of the TV (port 55000), without any cloud. The
encrypted models (2018 and later) are paired with the PIN the TV displays.
Unofficial, not affiliated with Panasonic.

User documentation: [docs/en.md](docs/en.md) · [docs/fr.md](docs/fr.md).

> **Work in progress.** First milestone, tested against a fake TV only, never
> against a real Viera TV.

## How it works

```
Gladys ⇄ SDK ⇄ src/handlers.js ⇄ src/app.js (VieraApp)
                                   ├─ src/viera/client.js   one TV: description, DMR volume/mute, NRC keys/apps, pairing
                                   ├─ src/viera/crypto.js   AES-128-CBC + HMAC-SHA-256, key schedules (pure)
                                   ├─ src/viera/soap.js     envelopes, answers, UPnP description, app list (pure)
                                   ├─ src/viera/http.js     node:http, no keep-alive, bounded time and size
                                   ├─ src/viera/keys.js     remote key codes, sources, known application ids
                                   ├─ src/model.js          known TVs -> Gladys devices and states (pure)
                                   └─ src/store.js          /data/viera.json: known TVs, MAC, pairing keys
```

- **TVs** are added by IP address (configuration), or found with
  `gladys.scanNetwork('ssdp')` (search target
  `urn:panasonic-com:device:p00RemoteController:1`): the container cannot
  hear multicast on its bridge network. Each TV is identified by the UDN of
  `GET /nrc/ddd.xml` (external id `tv:<UDN>`), its model by
  `GET /nrc/sdd_0.xml` (an `X_GetEncryptSessionId` action means the encrypted
  protocol). The SSDP `LOCATION` header is not followed; the `source_mac` of
  the answer is kept for Wake-on-LAN.
- **Polling** (own timer, 5 to 300 s): `GetMute` and `GetVolume` on
  `/dmr/control_0` (RenderingControl, never encrypted). An answer means "on",
  no answer "off", any other answer "unknown" (nothing published).
- **Commands**: serialized per TV, each within a 4.2 s budget (Gladys acks in
  5 s). Keys (`X_SendKey`) and applications (`X_LaunchApp`) on
  `/nrc/control_0`, wrapped in `X_EncryptedCommand` with a session id and a
  sequence number on the encrypted models. Power and mute are toggles: the
  state is read from the TV just before, never acted on when unknown. Power on
  with a MAC: `gladys.wakeOnLan(mac)` (manifest `network_wake: true`), acked at
  once, the TV waited for in the background; never a power key after a
  Wake-on-LAN.
- **Pairing**: `X_DisplayPinCode` returns a challenge, the PIN goes back
  encrypted with keys derived from it (`X_RequestAuth`), the TV answers an
  application id and a key, kept in `/data` (mode 0600), never logged. Keys
  explicitly refused (or refused 3 times while the TV is on) pause the NRC
  requests to that TV, tried again every 30 minutes.

## Development

```bash
npm install
npm test                                        # node --test, loopback only (fake TV)
npm run lint && npm run format:check
npm run audit
npm run cover                                   # regenerates cover.png (800×534, no dependency)
npx github:GladysAssistant/integration-store .  # store admission checks
```

`test/fixtures/fakeTv.js` is a fake Viera TV on 127.0.0.1: UPnP description,
DMR, and the TV side of the PIN pairing and of the encrypted session (it checks
the HMAC, the session and the sequence numbers). The end-to-end tests run the
real handlers against the SDK's fake Gladys.

## Credits

- [`panasonic-viera`](https://github.com/florianholzapfel/panasonic-viera) by
  Florian Holzapfel (MIT), the library behind the Home Assistant Panasonic
  Viera integration: the SOAP requests, the PIN pairing, the AES/HMAC
  encryption and its key schedules, the key codes and application ids are
  ported from it to JavaScript.
- The app structure follows
  [LM1LC3N7/gladys-mystrom](https://github.com/LM1LC3N7/gladys-mystrom) and
  [LM1LC3N7/gladys-denon-avr](https://github.com/LM1LC3N7/gladys-denon-avr)
  (same author, Apache-2.0).

Panasonic and Viera are trademarks of Panasonic Holdings Corporation, used here
only to name the compatible products.

## Releasing

**Actions → Release → Run workflow** (patch / minor / major): bumps the
version in `package.json` and the manifest, rolls `CHANGELOG.md`, tags, builds
the multi-arch image to GHCR and publishes the GitHub Release. The
`gladys-assistant-integration` topic is added at the first real release.

## License

Apache-2.0, see [LICENSE](LICENSE). Third-party notices (panasonic-viera, MIT):
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
