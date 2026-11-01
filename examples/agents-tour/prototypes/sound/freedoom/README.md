# Freedoom files used by the sound prototype

Everything in this folder except this README comes from the Freedoom project (https://freedoom.github.io, https://github.com/freedoom/freedoom), taken at commit `3ac019628d70b812ffb722f7f2365771b76a9d29` (master, 2026-10-02). Freedoom is under a three-clause BSD licence: see `LICENSE`, copied byte for byte from `COPYING.adoc` at that commit. Freedoom's name and its contributors' names are not used to endorse the tour.

| Here | From (in the Freedoom repo) |
|---|---|
| `LICENSE` | `COPYING.adoc` |
| `CREDITS-MUSIC` | `CREDITS-MUSIC` (track authors) |
| `faces/*.png` | `graphics/stf*.png` (status-bar face: `stfst*` calm and glancing by health tier 0 to 4, `stfouch*` hit, `stfevl*` grin, `stfkill*` firing, `stfdead0` dead) |
| `music/d_dm09.mid` | `musics/d_dm09.mid`: "Terrible Secrets" by Lola "BlueWorrior" Harvey |
| `music/terrible-secrets-loop.ogg` | our render of the MIDI (not a Freedoom file, derived from it, so it carries the same licence) |

## How the loop was made

1. Rendered `d_dm09.mid` (160 bpm) with FluidSynth 2.5.6 and the GeneralUser GS 2.0.3 soundfont, reverb and chorus off.
2. Cut bars 8 to 23 (16 bars, 24.000 s, starting at 10.5 s), 5 ms fades at both ends, loudness normalised, encoded as Ogg Opus, 56 kbit/s, stereo (166 KB).
3. `index.html` embeds the loop and the faces as `data:` URIs and loops the buffer with Web Audio.

GeneralUser GS (S. Christian Collins) licence v2.0: "You may use GeneralUser GS without restriction for your own music creation, private or commercial." Only rendered audio ships here, never the soundfont. FluidR3 was rejected because its embedded comment reads "DO NOT REDISTRIBUTE ANY OF THESE SAMPLES".

The embedded Opus loop needs a browser that decodes Ogg Opus (Chrome, Firefox, Edge, Safari 18.4 and later).
