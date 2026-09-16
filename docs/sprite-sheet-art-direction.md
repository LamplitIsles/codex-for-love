# Shio local Sprite Sheet delivery guide

This guide describes private, state-local art for the optional Partner pet. Do not commit source frames, sheets, or formal character art to CFL.

## Identity and framing

Depict an adult chibi woman seated at a small desk: silver-mist blue long hair, blue-grey eyes, distinct but restrained whale-fin ears, a light long dress, and a loose blue-grey outer layer. This is not a maid outfit, tall standing key art, or an expression bubble. In every `1024 × 1024` RGBA PNG sRGB source frame, keep face centre near `(50%, 31%)`, body centre at `50%`, desk top near `70%`, and all visible features inside `x=10–90%`, `y=4–95%`.

## Clips and motions

| Clip | Frames / fps / loop | Required readable action |
| --- | --- | --- |
| `idle` | 6 / 6 / yes | Breath, blink, glance outward then return. |
| `thinking` | 8 / 8 / yes | Chin on hand, slight tilt, quiet blue dots; no text. |
| `read` | 6 / 6 / yes | Transparent reader, eye and finger scroll motion. |
| `work` | 8 / 8 / yes | Computer and small board; two or three coloured-pencil marks. |
| `replying` | 8 / 10 / yes | Phone typing with abstract send dots only. |
| `success` | 6 / 10 / no | Look up, small smile/stretch; last frame holds. |
| `concern` | 6 / 6 / yes | Restrained frown and tiny error mark, never crying/alarming. |

## Packing and install

Name masters `activity-00.png` through `activity-05.png` or `activity-07.png`. Downscale each master to a `512 × 512` cell without cropping alpha edges, then concatenate left-to-right into `activity.webp`: 6 frames is `3072 × 512`, 8 frames `4096 × 512`. Use alpha WebP and target less than 1.5 MB per sheet. Check each clip at 96 px, 112–128 px, and 144–160 px; whale-fin ears and the activity prop must remain legible.

Create `<state>/pet-assets/manifest.json` using schema version 2, `character: "shio"`, a revision, and exactly the seven clip objects above (`file`, `frameCount`, `fps`, and `loop`). Restart Partner and reload the browser. Reduced-motion users see the first frame only.
