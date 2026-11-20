# Gemini edition brand assets

Icons for the Windows **T3 Code (Gemini)** edition (`appId com.invictine.t3code.gemini`,
version suffix `-gemini.N`). They keep the production T3 mark on the same graphite
squircle and only re-tint the glyph with the Gemini blue → violet ramp
(`#4C8DF6` → `#846CEC` → `#A85CE8`), so the edition reads as a sibling of the stock
and nightly builds rather than a different app.

`logo.svg` is the human-editable source. Everything else is a rendering of it and is
checked in because the repository's icon pipeline (`scripts/export-brand-icons.ts`)
drives Apple's Icon Composer `ictool`, which only exists on macOS.

| File | Purpose |
| --- | --- |
| `logo.svg` | 128 px source artwork (gradient glyph on the production squircle). |
| `gemini-windows.ico` | Windows app/installer/shortcut icon, 16/24/32/48/64/128/256 px PNG frames. |
| `gemini-web-favicon.ico` | Browser favicon for the packaged client (same bytes as the Windows icon). |
| `gemini-web-favicon-16x16.png`, `gemini-web-favicon-32x32.png` | Favicon renditions. |
| `gemini-web-apple-touch-180.png` | iOS/iPadOS home screen icon used by the web client. |
| `gemini-web-icon-192x192.png`, `gemini-web-icon-512x512.png` | Web app manifest icons. |
| `gemini-macos-1024.png` | macOS artwork (unused by the Windows-only edition, kept for symmetry). |
| `gemini-universal-1024.png`, `gemini-ios-1024.png` | Full-bleed 1024 px artwork (Linux desktop entry, iOS). |

## Regenerating

The checked-in bytes were produced from `assets/prod` artwork so that the squircle,
lighting, inner shadow, and per-size pixel hinting match the shipped icons exactly:

1. Load `assets/prod/black-macos-1024.png`, `assets/prod/black-universal-1024.png`, and each
   PNG frame of `assets/prod/t3-black-windows.ico`.
2. For every pixel, compute luminance `L` and use `clamp((L - 0.30) / 0.18, 0, 1)` as the glyph
   mask, so the dark squircle and its rim stay untouched while anti-aliased glyph edges blend.
3. Replace masked pixels with the gradient sampled at `t = (x + y) / (w + h - 2)`, scaled by
   `0.62 + 0.38 * min(1, L / 0.95)` to keep the original top-left highlight falloff.
4. Re-encode each ICO frame as PNG and repack the 7-frame container; downscale the 1024 px art
   with a high-quality bicubic filter for the web renditions.

If Apple tooling is available, prefer adding an equivalent Icon Composer project here and
wiring it into `ICON_VARIANTS` instead of editing the committed bytes.
