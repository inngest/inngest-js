# Freedoom files used by the Agents Tour

Everything in this folder except this README comes from the Freedoom project (https://freedoom.github.io, https://github.com/freedoom/freedoom), taken at commit `3ac019628d70b812ffb722f7f2365771b76a9d29` (master, 2026-10-02). Freedoom is under a three-clause BSD licence: see `LICENSE`, copied byte for byte from `COPYING.adoc` at that commit. Freedoom's name and its contributors' names are not used to endorse the tour.

| Here | From (in the Freedoom repo) |
|---|---|
| `LICENSE` | `COPYING.adoc` |
| `CREDITS-MUSIC` | `CREDITS-MUSIC` (track authors) |
| `faces/*.png` | `graphics/stf*.png` (status-bar face: `stfst*` calm and glancing by health tier 0 to 4, `stfouch*` hit, `stfevl*` grin, `stfkill*` firing, `stfdead0` dead) |
| `music/d_map07.mid` | `musics/d_map07.mid`: "Light 'Em Up, Boyz!" by Lola "BlueWorrior" Harvey and Goji (MAP07) |
| `music/map07-loop.ogg` | our render of that MIDI file, same licence |

## How the loop was made

Rendered `d_map07.mid` (167 bpm) with FluidSynth 2.5.6 and the GeneralUser GS 2.0.3 soundfont, reverb and chorus off, 48 kHz. Cut on a bar line (16 bars, 22.994 s, starting at 64.67 s in the song) where the seam between the last and first bar sounded least different, 5 ms fades at both ends, loudness normalised, encoded as Ogg Opus, 56 kbit/s, stereo (156 KB). The tour plays it as a looping Web Audio buffer.

GeneralUser GS (S. Christian Collins) licence v2.0: "You may use GeneralUser GS without restriction for your own music creation, private or commercial." Only rendered audio ships here, never the soundfont.

The Opus loop needs a browser that decodes Ogg Opus (Chrome, Firefox, Edge, Safari 18.4 and later).

`CREDITS-MUSIC` is Freedoom's own file and names every composer.
