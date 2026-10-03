# Briem Hand fonts

Gunnlaugur SE Briem's handwriting model, released by Sorkin Type Co. under
the SIL Open Font License 1.1 (`OFL.txt`, from the same release).

- Repository: https://github.com/SorkinType/Briem-Hand
- Release: v1.004, `Briem-Hand-v1.004.zip`
  (sha256 `e0cf3591c5f9f5bf4ee20d177ec6d6948b9026b3fc7a87c0d68ee6d880b4bc90`)

Vendored into `internal/handler/static/fonts/`, unmodified:

| File | Family | Design | sha256 |
|---|---|---|---|
| `BriemHand-Regular.ttf` | Briem Hand | joined (contextual alternates) | `bcdfb43ec76937853dc046cb31743658698251036f6cff254351292230ce194c` |
| `BriemHandUnjoined-Regular.ttf` | Briem Hand Unjoined | print, letters separate | `664fce9b4abaf6c9c448d3e5ade3ce058ea5ded8d1809e554a0f64a076d87b3f` |

The release's Guides and Color fonts draw their own ruling and are not used;
the app rules the paper itself. The separate Briem-Print and
Briem-Hand-Guides repositories hold older builds of the same designs.

`make fonts-fetch` downloads the release again, checks every hash above, and
replaces the files.
