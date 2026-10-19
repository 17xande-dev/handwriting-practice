// Loading any Google Fonts family by name, for the model picker.
//
// The name only ever becomes a query parameter on a fixed Google Fonts URL,
// so a typed name can load a font but can't point the page anywhere else; the
// CSP allows only Google's two origins. Nothing is sent to our server.

/** Google family names are letters, digits and spaces (a few have hyphens). */
const nameRe = /^[A-Za-z0-9][A-Za-z0-9 -]{0,63}$/;

export function validFamilyName(name: string): boolean {
  return nameRe.test(name);
}

/** A family name as a CSS font-family list, with a cursive fallback. */
export function familyList(name: string): string {
  return `"${name}", cursive`;
}

const linkId = "custom-font-css";

/** The stylesheet of a family's upright (or, with `italic`, italic) face; the name is validated first. */
function cssUrl(name: string, italic: boolean, text?: string): string {
  const family = encodeURIComponent(name).replace(/%20/g, "+");
  return `https://fonts.googleapis.com/css2?family=${family}${italic ? ":ital@1" : ""}${
    text ? `&text=${encodeURIComponent(text)}` : ""
  }&display=swap`;
}

function addStylesheet(url: string): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = url;
    link.addEventListener("load", () => resolve(true), { once: true });
    link.addEventListener("error", () => {
      link.remove();
      resolve(false);
    }, { once: true });
    document.head.append(link);
  });
}

const previewed = new Map<string, Promise<boolean>>();

/**
 * Load a family for a small sample on the Fonts page: only the glyphs of `text` are fetched, so a
 * list of hundreds stays light. Resolves to false when Google has no such family or the font does
 * not arrive. Never use this where the family is also written in at full size (the worksheet): a
 * subset face of the same family could shadow the full one.
 */
export function loadPreviewFont(name: string, text = "minimum quick"): Promise<boolean> {
  if (!validFamilyName(name)) return Promise.resolve(false);
  const key = `${name}\n${text}`;
  let p = previewed.get(key);
  if (!p) {
    p = addStylesheet(cssUrl(name, false, text)).then(async (ok) => {
      if (!ok) return false;
      try {
        return (await document.fonts.load(`32px "${name}"`, text)).length > 0;
      } catch {
        return false;
      }
    });
    previewed.set(key, p);
  }
  return p;
}

const tiled = new Map<string, Promise<boolean>>();

/** The full upright face of a family, kept alongside the others (a toolbar tile's sample). */
export function loadTileFont(name: string): Promise<boolean> {
  if (!validFamilyName(name)) return Promise.resolve(false);
  let p = tiled.get(name);
  if (!p) {
    p = addStylesheet(cssUrl(name, false)).then(async (ok) => {
      if (!ok) return false;
      try {
        return (await document.fonts.load(`32px "${name}"`, "an")).length > 0;
      } catch {
        return false;
      }
    });
    tiled.set(name, p);
  }
  return p;
}

/**
 * Load a family's stylesheet and then its glyphs. Rejects with a message fit
 * to show the user when the name isn't valid, Google doesn't know it, or the
 * font doesn't arrive.
 */
export async function loadGoogleFont(name: string, italic = false): Promise<void> {
  name = name.trim().replace(/\s+/g, " ");
  if (!validFamilyName(name)) {
    throw new Error("Use the family name as Google Fonts shows it: letters, numbers and spaces.");
  }
  const url = cssUrl(name, italic);

  // The new stylesheet goes in alongside the current one, which is only
  // removed once the new one has loaded: a mistyped name must not take away
  // the font already on the page.
  const previous = document.getElementById(linkId);
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = url;
  // Google answers an unknown family with a 400, which fires "error".
  await new Promise<void>((resolve, reject) => {
    link.addEventListener("load", () => resolve(), { once: true });
    link.addEventListener("error", () => {
      link.remove();
      reject(new Error(`Google Fonts has no family called “${name}”.`));
    }, { once: true });
    document.head.append(link);
  });
  previous?.remove();
  link.id = linkId;

  const faces = await document.fonts.load(`${italic ? "italic " : ""}32px "${name}"`, "anlx");
  if (faces.length === 0) {
    throw new Error(`“${name}” didn't load. Check the connection and try again.`);
  }
}
