# Panasonic Viera

Control your **Panasonic Viera** TVs from Gladys, on your local network,
without any cloud: power, volume, mute, remote keys, source (TV, HDMI 1 to 4)
and application launch. The integration uses the UPnP/SOAP network remote
control of the TV (port 55000), the one Panasonic's "TV Remote" app uses.

> **Unofficial integration, not affiliated with Panasonic.** This first
> milestone was written and tested against a simulated TV:
> it has **never been tested** on a real TV. Your feedback is welcome.

## Prepare the TV

1. In the TV menus: **Network > TV Remote App Settings** (the name varies
   with the year), enable **TV Remote** (network remote control).
2. To turn the TV on from Gladys, also enable, depending on the model,
   **Powered On by Apps** and/or **Wake-on-LAN**.
3. Give the TV a **fixed IP address** in your router (reserved DHCP lease).

## Add a TV

- **By its address**: type the IP address in "IP addresses of the TVs"
  (several addresses separated by commas) and save.
- **By the search**: use **Find the TVs**. Gladys searches the network (SSDP)
  for the integration; a TV that is off, or a network blocking multicast, may
  not answer: type the address then.

The TV appears in the integration's **Discovery** tab: create it.

## Pairing (models from about 2018 on)

Recent TVs (FZ, GZ, HZ, JZ series and later) encrypt their remote control and
ask for a PIN once:

1. Turn the TV on.
2. In the integration configuration, use **Start pairing** with the TV's IP
   address. The TV shows a 4-digit PIN.
3. Within 5 minutes, use **Finish pairing** with that PIN.

The integration then keeps the keys given by the TV in its own data folder
(`/data`); they are never sent to Gladys nor written to the logs. If the TV is
reset and refuses these keys, the integration status says so: pair again.
Older TVs need no pairing.

Before pairing, volume and mute already work; keys, power and applications do
not.

## What you get

| Feature     | Detail                                                                                                                                                           |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Power       | State read from the TV; command with the power key                                                                                                               |
| Volume      | 0 to 100, read and set                                                                                                                                           |
| Mute        | Button: each press toggles the mute read from the TV                                                                                                             |
| Buttons     | Volume +/-, channel +/-, last view, arrows, OK, back, exit, menu, option, info, guide, input, play, pause, stop, rewind, fast forward, skip back/forward, record |
| Source      | Dropdown: TV, HDMI 1 to 4                                                                                                                                        |
| Application | Dropdown: Netflix, YouTube, Prime Video, web browser… and the applications the TV lists (after an "Update" of the device in Discovery)                           |
| Remote key  | Dropdown of every remote key (digits, colours, subtitles…), handy in scenes                                                                                      |

Source and application are not read back from the TV: the dropdowns command,
they do not show the state.

## Turning the TV on

The power key toggles: the integration reads the state from the TV just
before acting and sends nothing when the TV already is in the wanted state.

- TV in **network standby** ("Powered On by Apps" enabled): the power key is
  enough.
- TV in **deep standby** (it answers nothing at all): **Wake-on-LAN** is
  needed. Gladys sends the packet for the integration, to the MAC seen by the
  search, or the one typed in "MAC addresses for Wake-on-LAN"
  (`192.168.1.40=a8:13:74:12:34:56`). The integration then waits up to 20
  seconds for the TV to answer, without sending a power key (it could turn
  off a TV that is booting).

Known limit: a TV in standby that still answers volume requests shows as on,
and "turn on" then sends nothing. To be checked on real models.

## Settings

- **Refresh interval**: how often power, volume and mute are read, 5 to 300
  seconds (10 by default).
- **Check the TVs**: state, pairing and Wake-on-LAN of every known TV.

## Limits

- Local network only, port 55000 open between Gladys and the TV.
- Gladys voice notifications do not go through the TV.
- The direct HDMI keys and the application list depend on the model.
- Never tested on a real TV so far.

## Credits

Logic ported to JavaScript from
[panasonic-viera](https://github.com/florianholzapfel/panasonic-viera) by
Florian Holzapfel (MIT license). Panasonic and Viera are trademarks of
Panasonic Holdings Corporation, used only to name the compatible products.
