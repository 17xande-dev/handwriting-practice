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

/**
 * Load a family's stylesheet and then its glyphs. Rejects with a message fit
 * to show the user when the name isn't valid, Google doesn't know it, or the
 * font doesn't arrive.
 */
export async function loadGoogleFont(name: string): Promise<void> {
  name = name.trim().replace(/\s+/g, " ");
  if (!validFamilyName(name)) {
    throw new Error("Use the family name as Google Fonts shows it: letters, numbers and spaces.");
  }
  const url = `https://fonts.googleapis.com/css2?family=${
    encodeURIComponent(name).replace(/%20/g, "+")
  }&display=swap`;

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

  const faces = await document.fonts.load(`32px "${name}"`, "anlx");
  if (faces.length === 0) {
    throw new Error(`“${name}” didn't load. Check the connection and try again.`);
  }
}
