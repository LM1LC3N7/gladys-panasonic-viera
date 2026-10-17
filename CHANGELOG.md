# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

## [0.1.1] - 2026-10-17

### Added

- Panasonic Viera TVs over their local UPnP/SOAP remote control (port 55000),
  without any cloud: added by IP address, or found with an SSDP search through
  Gladys, and kept by the UDN of the TV when its address changes.
- Power (the power key, sent only when the state read from the TV just before
  differs, never on an unknown state; every command answered to Gladys
  within 5 seconds), volume, mute (each press toggles the mute read from the TV), 25
  remote buttons, a "Source" dropdown (TV, HDMI 1 to 4), an "Application"
  dropdown (known applications and the TV's own list) and a "Remote key"
  dropdown with every key.
- PIN pairing of the encrypted models (2018 and later) with the "Start
  pairing" and "Finish pairing" buttons: AES-128-CBC and HMAC-SHA-256 ported
  from panasonic-viera; the keys are kept in `/data` only, never logged, and
  are only declared refused on an explicit refusal (then tried again every 30
  minutes).
- Wake-on-LAN through Gladys to turn on a TV in deep standby, with the MAC
  seen by the search or typed in the configuration, an optional broadcast
  address, the packet repeated while the TV is waited for in the background;
  no power key after it.
- "Check the TVs" button: state, pairing and Wake-on-LAN of each TV.

[Unreleased]: https://github.com/LM1LC3N7/gladys-panasonic-viera/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/LM1LC3N7/gladys-panasonic-viera/releases/tag/v0.1.1
