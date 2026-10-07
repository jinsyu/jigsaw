# Third-party code in this folder

## qrcode-generator 2.0.4

- File: `qrcode-generator-2.0.4.js` (unmodified copy of `dist/qrcode.mjs` from the npm package)
- Source: https://github.com/kazuhikoarase/qrcode-generator
- SHA-256: `ea91d7118a5395289170da848b7c6758b996163bfbccf312591ab65a4911b7c0`
- License: MIT

```
Copyright (c) 2009 Kazuhiko Arase

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```

The word "QR Code" is a registered trademark of DENSO WAVE INCORPORATED.

## @jsquash/webp 1.5.0 (WebP encoder only)

Loaded only when the browser cannot make WebP from a canvas (Safari returns PNG), to
shrink and re-encode teachers' pictures (T8). Copied from the npm package
`@jsquash/webp@1.5.0`; only the encoder files are kept.

- Source: https://github.com/jamsinclair/jSquash (codecs from https://github.com/GoogleChromeLabs/squoosh)
- License: Apache License 2.0, full text in `LICENSE-Apache-2.0.txt` (Copyright 2020 Google Inc.; Copyright 2023 jamsinclair)
- Modified: `encode.js` imports `'../wasm-feature-detect-1.9.0.js'` instead of the bare
  name `'wasm-feature-detect'` (no import map here). Original `encode.js` SHA-256:
  `edcd883d10e955655946b8fe733bb139faa8b7036092827b1849a4b34d727d6b`. Every other file is unmodified.

| File | SHA-256 |
|---|---|
| `jsquash-webp-1.5.0/encode.js` | `ea225b6f5f0041870869319f69fb60418b774a4c1d250d87c4935b698197a053` |
| `jsquash-webp-1.5.0/meta.js` | `3d70163a00e6264fc5a8fa7c8f3b1fa21a50a00d910f4d2de3ef1bbd2fdc98ab` |
| `jsquash-webp-1.5.0/utils.js` | `e71535eeee820d68b68ece7c8af761c39f3ddec93d3d957d2f83b19191339e0d` |
| `jsquash-webp-1.5.0/codec/enc/webp_enc.js` | `5fd62301662e37785aec38e38807926f72933d4c8b919018a43faf1b1ca760f6` |
| `jsquash-webp-1.5.0/codec/enc/webp_enc.wasm` | `b6085bb6702f144e9dc6016d58d230b34a84976bf0d080b7390b4b4b137d6ab7` |
| `jsquash-webp-1.5.0/codec/enc/webp_enc_simd.js` | `3038e60ebba6252baba08c691e31d1efe5036a185435daa7b4afaef3cc9273f9` |
| `jsquash-webp-1.5.0/codec/enc/webp_enc_simd.wasm` | `39c279269ec1163b987b6d69749458e3d5b03b9585f58b6ca5455b76b504a305` |

The `.wasm` files are libwebp compiled with Emscripten. libwebp license:

```
Copyright (c) 2010, Google Inc. All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are
met:

  * Redistributions of source code must retain the above copyright
    notice, this list of conditions and the following disclaimer.

  * Redistributions in binary form must reproduce the above copyright
    notice, this list of conditions and the following disclaimer in
    the documentation and/or other materials provided with the
    distribution.

  * Neither the name of Google nor the names of its contributors may
    be used to endorse or promote products derived from this software
    without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS
"AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT
LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR
A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT
HOLDER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL,
SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT
LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE,
DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY
THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
(INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```

## wasm-feature-detect 1.9.0

Used by the WebP encoder to pick the SIMD build when the browser supports it.

- File: `wasm-feature-detect-1.9.0.js` (unmodified copy of `dist/esm/index.js` from the npm package)
- Source: https://github.com/GoogleChromeLabs/wasm-feature-detect
- SHA-256: `871246e709a8564b583265a37df4b90bebf6aabea6e7b86a41ab6ed986651154`
- License: Apache License 2.0, full text in `LICENSE-Apache-2.0.txt` (Copyright Google LLC, Surma)
