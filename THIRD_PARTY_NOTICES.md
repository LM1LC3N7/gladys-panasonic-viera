# Third-party notices

This integration ports to JavaScript the logic of the following project: the
UPnP/SOAP requests of the Viera TVs, the PIN pairing and the encryption of the
recent models (AES-128-CBC, HMAC-SHA-256, the key schedules), the remote key
codes and the application ids (`src/viera/crypto.js`, `src/viera/client.js`,
`src/viera/soap.js`, `src/viera/keys.js`). Nothing of it is installed at
runtime; its notice is reproduced below.

## panasonic-viera

<https://github.com/florianholzapfel/panasonic-viera>

```
The MIT License (MIT)

Copyright (c) 2016 Florian Holzapfel

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## LM1LC3N7/gladys-mystrom and LM1LC3N7/gladys-denon-avr

The structure of the app, the `/data` store and the handler wiring follow
integrations of the same author, under the Apache License 2.0 of this
repository.
