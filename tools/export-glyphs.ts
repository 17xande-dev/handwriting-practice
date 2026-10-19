// Writes testdata/glyphs/<font>.json: every character of a set (a-z, 0-9 by default) rendered
// alone on a model font, as the model raster the web app scores against (the `model` member of
// a parity fixture). The iPad app's stroke-model pipeline (docs/strokes.md, M10) skeletonises
// these to build strokes/<model>.json. Run with `make glyphs`.
//
// Needs Chromium (CHROMIUM, default /usr/bin/chromium), Deno and Go, and the network (the Google
// fonts load from fonts.gstatic.com). It starts the server itself unless --base points at one.
//
//   deno run -A tools/export-glyphs.ts [--base URL] [--out testdata/glyphs] [--fonts a,b] [--chars abc]

const args = new Map<string, string>();
for (let i = 0; i < Deno.args.length; i += 2) {
  args.set(Deno.args[i].replace(/^--/, ""), Deno.args[i + 1]);
}
const out = args.get("out") ?? "testdata/glyphs";
const chromium = Deno.env.get("CHROMIUM") ?? "/usr/bin/chromium";
const fonts = (args.get("fonts") ?? "briem-print,italic").split(",");
const chars = [...(args.get("chars") ?? "abcdefghijklmnopqrstuvwxyz0123456789")];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(url: string, tries = 100) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url);
      await r.body?.cancel();
      if (r.ok) return;
    } catch {
      // not up yet
    }
    await sleep(200);
  }
  throw new Error(`${url} did not come up`);
}

async function inUse(url: string): Promise<boolean> {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(1000) });
    await r.body?.cancel();
    return true;
  } catch (e) {
    return e instanceof DOMException && e.name === "TimeoutError";
  }
}

const children: Deno.ChildProcess[] = [];
const tmpDirs: string[] = [];
let cleaned = false;
async function cleanup() {
  if (cleaned) return;
  cleaned = true;
  for (const c of children) {
    try {
      c.kill("SIGTERM");
    } catch {
      // already gone
    }
  }
  await Promise.all(children.map(async (c) => {
    const exited = await Promise.race([c.status.then(() => true), sleep(3000).then(() => false)]);
    if (!exited) {
      try {
        c.kill("SIGKILL");
      } catch {
        // already gone
      }
      await c.status.catch(() => {});
    }
  }));
  for (const d of tmpDirs) await Deno.remove(d, { recursive: true }).catch(() => {});
}
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  Deno.addSignalListener(sig, async () => {
    await cleanup();
    Deno.exit(1);
  });
}

let base = args.get("base");
if (!base) {
  const port = 8094;
  base = `http://127.0.0.1:${port}`;
  if (await inUse(base)) throw new Error(`port ${port} is already in use`);
  const work = await Deno.makeTempDir({ prefix: "glyphs-server-" });
  tmpDirs.push(work);
  const bin = `${work}/calligraphy`;
  const build = await new Deno.Command("go", {
    args: ["build", "-o", bin, "."],
    stdout: "inherit",
    stderr: "inherit",
  }).output();
  if (!build.success) {
    await cleanup();
    throw new Error("go build failed");
  }
  children.push(
    new Deno.Command(bin, {
      env: { ADDR: `127.0.0.1:${port}`, DB_PATH: `${work}/glyphs.db` },
      stdout: "null",
      stderr: "null",
    }).spawn(),
  );
}
try {
  await waitFor(`${base}/`);
} catch (e) {
  await cleanup();
  throw e;
}

const profile = await Deno.makeTempDir({ prefix: "glyphs-chromium-" });
tmpDirs.push(profile);
const debugPort = 9334;
if (await inUse(`http://127.0.0.1:${debugPort}/json/version`)) {
  await cleanup();
  throw new Error(`debug port ${debugPort} is already in use`);
}
children.push(
  new Deno.Command(chromium, {
    args: [
      "--headless=new",
      `--remote-debugging-port=${debugPort}`,
      `--user-data-dir=${profile}`,
      "--no-first-run",
      "--no-sandbox",
      "--disable-gpu",
      "--window-size=1280,900",
      "about:blank",
    ],
    stdout: "null",
    stderr: "null",
  }).spawn(),
);
await waitFor(`http://127.0.0.1:${debugPort}/json/version`);

const targets = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
const page = targets.find((t: { type: string }) => t.type === "page");
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => {
  ws.onopen = res;
  ws.onerror = rej;
});
let nextId = 1;
const pending = new Map<number, (m: { result?: unknown; error?: { message: string } }) => void>();
const loaded: Array<() => void> = [];
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)!(m);
    pending.delete(m.id);
  } else if (m.method === "Page.loadEventFired") {
    loaded.splice(0).forEach((f) => f());
  }
};
function send(method: string, params: Record<string, unknown> = {}) {
  const id = nextId++;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise<{ result?: unknown; error?: { message: string } }>((res) =>
    pending.set(id, res)
  );
}
async function evaluate(expression: string): Promise<unknown> {
  const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  const res = r.result as {
    exceptionDetails?: { exception?: { description?: string } };
    result: { value: unknown };
  };
  if (r.error) throw new Error(r.error.message);
  if (res.exceptionDetails) {
    throw new Error(res.exceptionDetails.exception?.description ?? "evaluate failed");
  }
  return res.result.value;
}
async function navigate(url: string) {
  const done = new Promise<void>((res) => loaded.push(res));
  await send("Page.navigate", { url });
  await done;
}

await send("Page.enable");
await Deno.mkdir(out, { recursive: true });

try {
  await navigate(`${base}/sheet/warm-up#debug`);
  for (const font of fonts) {
    await evaluate(`(() => {
      const el = document.querySelector('input[name="model"][value="${font}"]');
      if (!el) throw new Error("no model ${font}");
      el.checked = true;
      el.dispatchEvent(new Event("input", { bubbles: true }));
    })()`);
    // Wait until the row is laid out with the font and its glyphs have loaded: the same export
    // twice in a row, 600 ms apart.
    const probe = `__italic.exportGlyph(${JSON.stringify(font)}, "a")`;
    let json = "", prev = "";
    for (let tries = 0; tries < 60; tries++) {
      await sleep(600);
      try {
        json = await evaluate(probe) as string;
      } catch {
        prev = "";
        continue;
      }
      if (json === prev) break;
      prev = json;
    }
    if (!json || json !== prev) throw new Error(`${font} never settled`);
    const glyphs: Record<string, unknown> = {};
    let slant = 0;
    for (const ch of chars) {
      const g = JSON.parse(
        await evaluate(
          `__italic.exportGlyph(${JSON.stringify(font)}, ${JSON.stringify(ch)})`,
        ) as string,
      );
      slant = g.slant;
      glyphs[ch] = g.model;
    }
    const file = `${out}/${font}.json`;
    const body = JSON.stringify({ version: 1, font, slant, glyphs });
    await Deno.writeTextFile(file, body + "\n");
    console.log(`${file}  ${(body.length / 1024).toFixed(0)} KB  ${chars.length} glyphs`);
  }
} finally {
  ws.close();
  await cleanup();
}
Deno.exit(0);
