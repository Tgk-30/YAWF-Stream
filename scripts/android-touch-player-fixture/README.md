# Android touch-player synthetic media

This fixture is the exact retained 30 second media from the read-only `multiaudio-fixture59-density3` preparation. It contains one 320x180 H.264 video track with keyframes at 0, 10, and 20 seconds plus two mono AAC-LC 48 kHz tracks:

1. `eng`, default, `Synthetic English 440 Hz tone`
2. `jpn`, non-default, `Synthetic Japanese 880 Hz tone`

`media-contract.mjs` binds the MP4 and both retained ffprobe receipts by SHA-256 and validates the track, clock, frame, and GOP facts without starting a server. The runtime server additionally executes the installed `ffprobe`, enables the production real transcoder, and records sanitized proxy, audio-inventory, HLS-manifest, and HLS-asset responses.

These synthetic bytes and local checks are not Android runtime, audible-output, physical-device, signing, OTA, or publication evidence.
