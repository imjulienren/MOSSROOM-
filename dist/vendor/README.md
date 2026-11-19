# Signalsmith Stretch

Source: https://github.com/Signalsmith-Audio/signalsmith-stretch/blob/main/web/release/SignalsmithStretch.js

Snapshot retrieved 2026-10-22. Upstream file SHA-256: fe0e23b6bb5dbffb231a91e7dc39f9d2a7d10c7f793fb0237d819ca748f7f778

The embedded WASM factory is retained and the AudioWorklet wrapper is removed. DSP code is unchanged. MIT license is included in signalsmith-LICENSE.txt.

## MP3 encoder

`lamejs.iife.js` is the unchanged `dist/lamejs.iife.js` from [@breezystack/lamejs 1.2.7](https://registry.npmjs.org/@breezystack/lamejs/-/lamejs-1.2.7.tgz). The package records [commit 1fb0ef5](https://github.com/shijinyu/lamejs/tree/1fb0ef5fa177413107e2e107d054a9b994e3f79c) as its source. Build the IIFE bundle with `npm ci` and `npm run build` in that checkout, then replace the separate script file at this path.

SHA-256: `0be202ec162aa3042d5c5c4e6288ad326cff8cec7312c2894a0a91ad2f9aeda1`
