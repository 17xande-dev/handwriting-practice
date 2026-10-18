// Writes testdata/parity/<font>-<sheet>-<row>.json: for several fonts and
// sheet rows, the model raster the web app scores against and the scores it
// gives a set of synthetic writings (web/fixture.ts). The iPad app's Swift
// core replays these to prove its scoring matches. Run with `make fixtures`.
//
// Needs Chromium (CHROMIUM, default /usr/bin/chromium), Deno and Go, and the
// network (the Google fonts load from fonts.gstatic.com). It starts the
// server itself unless --base points at one that is already running.
//
//   deno run -A tools/export-fixtures.ts [--base http://localhost:8083] [--out testdata/parity]

const args = new Map<string, string>();
for (let i = 0; i < Deno.args.length; i += 2) {
  args.set(Deno.args[i].replace(/^--/, ""), Deno.args[i + 1]);
}
const out = args.get("out") ?? "testdata/parity";
const chromium = Deno.env.get("CHROMIUM") ?? "/usr/bin/chromium";

const fonts = ["briem-print", "briem-hand", "italic", "gb-s", "upright"];
const sheets: Array<[slug: string, row: number]> = [
  ["warm-up", 0],
  ["a-family", 0],
  ["chains", 0],
  ["sentences", 0],
  ["capitals", 0],
  ["numerals", 0],
];

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

// True when something already answers on url: a stale server (or another
// program) holding the port would otherwise be read as ours.
async function inUse(url: string): Promise<boolean> {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(1000) });
    await r.body?.cancel();
    return true;
  } catch (e) {
    // A refused connection is the good answer; a timeout means something is there.
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
  // Wait for each to exit; one that ignores SIGTERM is killed.
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
// Ctrl-C or kill must not leave a server or a browser behind.
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  Deno.addSignalListener(sig, async () => {
    await cleanup();
    Deno.exit(1);
  });
}

let base = args.get("base");
if (!base) {
  const port = 8093;
  base = `http://127.0.0.1:${port}`;
  if (await inUse(base)) {
    throw new Error(`port ${port} is already in use: refusing to talk to a stale server`);
  }
  // Build the binary and run it, rather than `go run`: killing `go run` kills
  // only the go tool and can leave the server it started listening.
  const work = await Deno.makeTempDir({ prefix: "fixtures-server-" });
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
      env: { ADDR: `127.0.0.1:${port}`, DB_PATH: `${work}/fixtures.db` },
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

const profile = await Deno.makeTempDir({ prefix: "fixtures-chromium-" });
tmpDirs.push(profile);
const debugPort = 9333;
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

// A minimal DevTools Protocol client over one page's WebSocket.
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
// Evaluate an expression in the page (awaiting promises) and return its value.
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
  let total = 0;
  for (const [slug, row] of sheets) {
    await navigate(`${base}/sheet/${slug}#debug`);
    for (const font of fonts) {
      await evaluate(`(() => {
        const el = document.querySelector('input[name="model"][value="${font}"]');
        if (!el) throw new Error("no model ${font}");
        el.checked = true;
        el.dispatchEvent(new Event("input", { bubbles: true }));
      })()`);
      // Wait for the font to load and the row to be laid out with it: two
      // identical exports in a row, 600 ms apart, once the row's font matches.
      let json = "", prev = "";
      for (let tries = 0; tries < 60; tries++) {
        await sleep(600);
        try {
          json = await evaluate(`(() => {
            const want = getComputedStyle(document.documentElement)
              .getPropertyValue("--font-${font}").trim();
            const f = __italic.rows[${row}].font;
            if (!f || (want && f.family !== want)) throw new Error("not laid out with ${font}");
            return __italic.exportFixture({ row: ${row} });
          })()`) as string;
        } catch {
          prev = "";
          continue;
        }
        if (json === prev) break;
        prev = json;
      }
      if (!json || json !== prev) throw new Error(`${font} on ${slug} never settled`);
      const fixture = JSON.parse(json);
      if (fixture.font !== font) throw new Error(`wanted ${font}, got ${fixture.font}`);
      const file = `${out}/${font}-${slug}-${row}.json`;
      await Deno.writeTextFile(file, json + "\n");
      total += json.length;
      console.log(`${file}  ${(json.length / 1024).toFixed(0)} KB  "${fixture.text}"`);
    }
  }
  console.log(`total ${(total / 1024 / 1024).toFixed(2)} MB`);
} finally {
  ws.close();
  await cleanup();
}
Deno.exit(0);
