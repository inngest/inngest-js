# Freedoom files used by the sound prototype

Everything in this folder except this README comes from the Freedoom project (https://freedoom.github.io, https://github.com/freedoom/freedoom), taken at commit `3ac019628d70b812ffb722f7f2365771b76a9d29` (master, 2026-10-02). Freedoom is under a three-clause BSD licence: see `LICENSE`, copied byte for byte from `COPYING.adoc` at that commit. Freedoom's name and its contributors' names are not used to endorse the tour.

| Here | From (in the Freedoom repo) |
|---|---|
| `LICENSE` | `COPYING.adoc` |
| `CREDITS-MUSIC` | `CREDITS-MUSIC` (track authors) |
| `faces/*.png` | `graphics/stf*.png` (status-bar face: `stfst*` calm and glancing by health tier 0 to 4, `stfouch*` hit, `stfevl*` grin, `stfkill*` firing, `stfdead0` dead) |
| `music/d_dm09.mid` | `musics/d_dm09.mid`: "Terrible Secrets" by Lola "BlueWorrior" Harvey |
| `music/d_map07.mid` | `musics/d_map07.mid`: "Light 'Em Up, Boyz!" by Lola "BlueWorrior" Harvey and Goji (MAP07) |
| `music/d_map17.mid` | `musics/d_map17.mid`: "Mow Them Down!" by Lola "BlueWorrior" Harvey (MAP17) |
| `music/d_map28.mid` | `musics/d_map28.mid`: "Skull Underfoot" by Lola "BlueWorrior" Harvey (MAP28) |
| `music/map07-loop.ogg`, `map17-loop.ogg`, `map28-loop.ogg` | our renders of those MIDI files, same licence |
| `music/terrible-secrets-loop.ogg` | our render of the MIDI (not a Freedoom file, derived from it, so it carries the same licence) |

## How the loop was made

1. Rendered `d_dm09.mid` (160 bpm) with FluidSynth 2.5.6 and the GeneralUser GS 2.0.3 soundfont, reverb and chorus off.
2. Cut bars 8 to 23 (16 bars, 24.000 s, starting at 10.5 s), 5 ms fades at both ends, loudness normalised, encoded as Ogg Opus, 56 kbit/s, stereo (166 KB).
3. `index.html` embeds the loop and the faces as `data:` URIs and loops the buffer with Web Audio.

GeneralUser GS (S. Christian Collins) licence v2.0: "You may use GeneralUser GS without restriction for your own music creation, private or commercial." Only rendered audio ships here, never the soundfont. FluidR3 was rejected because its embedded comment reads "DO NOT REDISTRIBUTE ANY OF THESE SAMPLES".

The embedded Opus loop needs a browser that decodes Ogg Opus (Chrome, Firefox, Edge, Safari 18.4 and later).

## Round 3 loops

Same method as above (FluidSynth 2.5.6, GeneralUser GS 2.0.3, reverb and chorus off, 48 kHz), cut on bar lines at the point where the seam between the last and first bar sounded least different, 5 ms fades, Ogg Opus 56 kbit/s stereo:

| Loop | Bars | Length | Starts at (in the song) | Size |
|---|---|---|---|---|
| `map07-loop.ogg` | 16 at 167 bpm | 22.994 s | 64.67 s | 156 KB |
| `map17-loop.ogg` | 15 at 122 bpm | 29.508 s | 45.25 s | 178 KB |
| `map28-loop.ogg` | 12 at 110 bpm | 26.182 s | 52.36 s | 157 KB |

`CREDITS-MUSIC` is Freedoom's own file and already names every composer above.
