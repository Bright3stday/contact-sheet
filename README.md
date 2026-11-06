# Contact Sheet

Cull a photo shoot on 6×6 digital contact sheets, marking picks with a red grease pencil, the
way you would with a loupe and a printed sheet.

**Open it:** https://bright3stday.github.io/contact-sheet/

## Private and offline

Your photos never leave your device. Nothing is uploaded and there are no analytics. After the
first visit the app works without a connection. It never changes, renames or deletes your photos. It
moves picked RAWs into a `Picks` folder only when you ask it to, and can move them back.

## What it does

- Opens a shoot folder, or a selection of photos (for example one shoot out of a phone's or
  tablet's camera folder), and lays it out as contact sheets, sorted by
  capture time, with frame number, filename and time under each frame.
- Shows only in-camera rated frames, or all of them.
- Tap to pick, draw with a pen or stylus (pressure sensitive), draw boxes, erase, undo.
- Zoom into a sheet, magnify a frame by holding the pen over it, and check focus in a loupe at 100%.
- Exports annotated sheets as JPEGs and a PDF, and a list of picks. For an opened folder they go
  into a `Picks` folder with a copy of the picked JPEGs; for selected photos, into Downloads.
  Each export is dated, so earlier ones are kept.
- Moves a cull between devices with a small marks file.

Tap **?** in the app for the full guide.

## Requirements

- Chrome or Edge, on a PC or an Android tablet. Opening whole folders needs a recent version.
- Photos: JPEG, Sony ARW and Fujifilm RAF. Tested with a Sony a7V, Sony RX100 VII and
  Fujifilm X-T2. RAWs are not developed: the app shows the JPEG preview stored inside the RAW,
  which on some cameras is only 1616 px wide. Other RAW formats are not read.
- A stylus is best for drawing. Fingers pick, zoom and pan; a mouse works too.

## Install

Open the link in Chrome or Edge and choose **Install app** (PC) or **Add to Home screen** (Android).

## Moving picked RAWs

In the app, after **Open folder**, **Move RAWs** moves the picked RAWs with their sidecars into
`Picks` and back. As an alternative on a PC, `tools/move-picks.ps1` does the same from the picks list of
the latest export. It moves each picked RAW with its sidecars (DxO `.dop`, `.xmp`), never
overwrites, and only shows what it would do unless you add `-Apply`:

```
powershell -ExecutionPolicy Bypass -File tools\move-picks.ps1 "F:\Photos\Shoot"
powershell -ExecutionPolicy Bypass -File tools\move-picks.ps1 "F:\Photos\Shoot" -Apply
```

`-Undo -Apply` moves them back; `-List <file>` uses an older picks list.

Easier: drag the shoot folder onto `tools\move-picks.cmd`, or onto a desktop shortcut to it
(right-click it → Show more options → Send to → Desktop). It shows what would move and asks
before moving anything.

## Running it yourself

Plain HTML, CSS and JavaScript modules, no build step. Serve the folder over HTTP(S) with any
static file server. Libraries used, included in `vendor/`:
[exifr](https://github.com/MikeKovarik/exifr) and [jsPDF](https://github.com/parallax/jsPDF).
