// Writes internal/handler/static/google-handwriting.json: the Google Fonts families in the
// HANDWRITING category, for the Fonts page's library. Run once at dev time (the list changes
// slowly); the result is checked in. Needs git and the network.
//
//   deno run -A tools/gen-google-handwriting.ts [--repo path/to/google-fonts] [--out file]
//
// It reads every METADATA.pb of github.com/google/fonts. Without --repo it makes a blobless
// shallow clone in a temporary directory and fetches only those files. The file is
// {"source": "...", "families": [{"family": "Caveat", "italic": false}, ...]} sorted by name;
// "italic" says the family has an italic style (so the toolbar can offer a variant chip).
// The iPad app generates its own list from the same source; the two need not match exactly.

const args = new Map<string, string>();
for (let i = 0; i < Deno.args.length; i += 2) {
  args.set(Deno.args[i].replace(/^--/, ""), Deno.args[i + 1]);
}
const out = args.get("out") ?? "internal/handler/static/google-handwriting.json";

/** The same rule as validFamilyName in web/googlefont.ts and the Go fonts package. */
const nameRe = /^[A-Za-z0-9][A-Za-z0-9 -]{0,63}$/;

async function git(cwd: string, ...a: string[]): Promise<string> {
  const r = await new Deno.Command("git", { args: a, cwd, stdout: "piped", stderr: "inherit" })
    .output();
  if (!r.success) throw new Error(`git ${a.join(" ")} failed`);
  return new TextDecoder().decode(r.stdout);
}

export interface Family {
  family: string;
  italic: boolean;
}

/** One METADATA.pb as a family, or null when it isn't a handwriting family. */
export function parseMetadata(pb: string): Family | null {
  // Top-level fields start at column 0; nested blocks (fonts { ... }) are indented.
  const top = (key: string) =>
    [...pb.matchAll(new RegExp(`^${key}: "([^"]*)"`, "gm"))].map((m) => m[1]);
  const name = top("name")[0];
  const categories = [...top("category"), ...top("classifications")];
  if (!name || !categories.includes("HANDWRITING")) return null;
  const italic = /^\s+style: "italic"/m.test(pb);
  return { family: name, italic };
}

/** One family per line, so a regenerated list diffs cleanly. */
export function formatList(body: { source: string; families: Family[] }): string {
  const lines = body.families.map((f) => `  ${JSON.stringify(f)}`).join(",\n");
  return `{\n "source": ${JSON.stringify(body.source)},\n "families": [\n${lines}\n ]\n}\n`;
}

if (import.meta.main) {
  let repo = args.get("repo");
  let tmp = "";
  if (!repo) {
    tmp = await Deno.makeTempDir({ prefix: "google-fonts-" });
    repo = tmp;
    await git(
      tmp,
      "clone",
      "--depth",
      "1",
      "--filter=blob:none",
      "--no-checkout",
      "https://github.com/google/fonts.git",
      ".",
    );
  }
  try {
    const rev = (await git(repo, "rev-parse", "HEAD")).trim();
    const files = (await git(repo, "ls-tree", "-r", "--name-only", "HEAD")).split("\n")
      .filter((f) => f.endsWith("/METADATA.pb"));
    if (tmp) {
      // A sparse checkout of just the METADATA.pb files fetches their blobs in one request.
      await git(
        repo,
        "sparse-checkout",
        "set",
        "--no-cone",
        "/ofl/*/METADATA.pb",
        "/apache/*/METADATA.pb",
        "/ufl/*/METADATA.pb",
      );
      await git(repo, "checkout", "HEAD");
    }
    const dec = new TextDecoder();
    const families = new Map<string, Family>();
    const skipped: string[] = [];
    for (const f of files) {
      const fam = parseMetadata(dec.decode(await Deno.readFile(`${repo}/${f}`)));
      if (!fam) continue;
      if (!nameRe.test(fam.family)) skipped.push(fam.family);
      else families.set(fam.family, fam);
    }
    const list = [...families.values()].sort((a, b) => a.family.localeCompare(b.family, "en"));
    const body = {
      source: `github.com/google/fonts METADATA.pb, category HANDWRITING, commit ${rev}`,
      families: list,
    };
    await Deno.writeTextFile(out, formatList(body));
    console.log(
      `${list.length} families to ${out}` +
        (skipped.length ? `; skipped (name): ${skipped.join(", ")}` : ""),
    );
  } finally {
    if (tmp) await Deno.remove(tmp, { recursive: true });
  }
}
