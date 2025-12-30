# Building a minimal polyrhythm trainer

1. Start from an empty `index.tsx` and import React hooks plus your stylesheet.
2. Define a `Track` type with an `id`, `beatsPerCycle`, `pitchIndex`, `volume`, `muted`, and `deafened` fields.
3. Declare constants for default tempo (30 cpm), default volume (0.75), the initial two tracks (4 and 3 beats), and a pitch table ordered G, B, D, A, E, G, C, F.
4. Add helpers to clamp tempo, schedule clicks in the Web Audio API with a short tanh-shaped envelope, and encode/decode state into the URL hash (skip defaults but always rewrite the hash so the default link is shareable).
5. Use `useState` for tempo, tracks, playback, and an optional dark-mode flag; store `AudioContext` refs for scheduling and reset them when stopping or retiming.
6. Render transport controls (play/stop, tempo +/- with a number input), concise track rows (mute, volume slider, deafen, beats input with a live beat visualization beside it, trash, plus an add button), and a header with a theme toggle and commit hash.
7. Style with CSS variables so light/dark themes are easy to flip, keep buttons neutral, center the +/- glyphs, keep inputs compact, and add a segmented beat meter that fills the current pulse while playing.
