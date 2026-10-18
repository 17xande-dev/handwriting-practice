# iPad sync: handoff

The server side of accounts and history sync, and the web client, are done in this repo. The iPad app
(`~/dev/handwriting-practice-app`, milestone M8) has **not been changed**. This page is the brief for
the session that adds sync there. The wire contract is [`sync-api.md`](sync-api.md); read it first,
especially "Record identity", which the Swift side must copy exactly. The app is modelled on
`~/dev/music-practice-app`, whose `SyncClient`, `SyncState` and `Profiles` are the thing to port.

## What already exists (this repo)

| Piece           | Where                                                        | Notes |
| --------------- | ------------------------------------------------------------ | ----- |
| Accounts        | `internal/account`, `/admin/users`                           | An admin creates the account at `/admin/users` and a password is generated and shown once. There is no sign-up. The first admin is `calligraphy -add-admin EMAIL`. |
| App sign-in     | `POST /api/token`                                            | Returns a bearer token that lasts until revoked. Rate-limited, one failure message. The `label` you send (the device name) is what `/account` lists under "Signed-in devices". |
| App sign-out    | `DELETE /api/token`                                          | `204`; the token is dead at once. |
| Sync            | `POST /api/sync`                                             | Push and pull in one round trip: cursor, tombstones, `rejected`. Kinds `check` and `ink`. Tested in `internal/handler/api_test.go` and `internal/history`. |
| Web client      | `web/sync.ts`, `web/progress-store.ts`, `web/sync-triggers.ts` | The reference implementation of the client algorithm. Port its behaviour and its tests (`web/sync_test.ts`, `web/progress-store_test.ts`) where they translate. |
| Production host | to be decided                                                | The server runs behind the owner's own reverse proxy on a Proxmox Docker host; the domain is not chosen yet, so the base URL is a setting in the app. |

## What the Swift side must do

- **Record identity, exactly as `sync-api.md` says.**
  - `ts == at` on every check, never the upload time.
  - A check without an `id` gets the deterministic legacy id: `"legacy-" + base36(trunc(at)) + "-" +
    hex(cyrb53(decimal(at) + "|" + sheet + "|" + line))`, `cyrb53` over the UTF-16 code units, 32-bit
    wrapping arithmetic, hex without padding. Check it against the test vectors in `sync-api.md`
    before anything else; a wrong id makes duplicates on the server for ever.
  - A check with an `id` keeps it. New checks get a lowercase random UUID.
  - Apply the derivation on load, on restore/import and before an upload.
- **Never rewrite the store from a filtered view.** `HandwritingCore/.../ProgressStore.swift` already
  decodes untrusted arrays with `Lossy`; make sure an add or a merge never writes back only the
  records that decoded. A record this build cannot decode (a newer client's) stays in the file
  untouched.
- **Records are JSON the server stores byte for byte.** Encode with the web's field names exactly
  (`CheckRecord` in `web/progress-store.ts`); the existing Swift record already matches, and `id` and
  `ts` are present as optional fields. Make them required on write.
- **Core `SyncClient`** in `HandwritingCore`, with an injected transport
  (`func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse)`) so the whole algorithm
  runs under `swift test` with a fake. Behaviour to copy from the web:
  - batches of at most 500;
  - clear only what was sent; drop `rejected`;
  - loop while `more` is true;
  - on `401`, turn sync off but keep history;
  - on network errors and `5xx`, keep everything pending;
  - single flight: never two syncs at once;
  - a generation counter, so a response that arrives after a sign-out (and sign-in) is discarded;
  - handle kinds `check` and `ink` generically (the iPad will be the main writer of `ink`).
- **Queueing in the store:** while sync is on, `add` and `addInk` append to `pendingAdds` and restore
  queues what it added; Clear history queues the removed ids of both kinds as `pendingDeletes` and
  drops them from `pendingAdds`.
- **Ink records.** The iPad is where strokes come from. When a check is recorded, also write an `ink`
  record (`check` = the check's id, `ts` = the check's `at`, strokes quantized as in `sync-api.md`),
  keeping it under 64 KB by simplifying, not by letting the server reject it. If the shape needs to
  change, change `sync-api.md` in the same commit and tell the web (W2 reads the same records).
- **Keychain.** Store the token as a generic-password item. Never in a file or `UserDefaults`.
- **URLSession transport** in the app target. The base URL is a setting (Settings page), because the
  domain is still to be chosen; a plain-HTTP LAN server needs an ATS exception (`NSAllowsLocalNetworking`
  or an exception domain), in DEBUG builds only if production is HTTPS.
- **Progress page "Sync" section:** signed out shows "Sign in" (email and password sheet, calling
  `POST /api/token` with `label: UIDevice.current.name`); signed in shows "Synced with <email> · 2 min
  ago", "Sync now" and "Sign out" (`DELETE /api/token`, delete the Keychain item, remove sync state).
  On a first sign-in with local history offer "Add this iPad's N records to <email>?". When signed in,
  the Clear confirmation says it also clears the account and other devices.
- **Triggers:** launch, `scenePhase == .active`, a few seconds after each recorded check (debounced),
  and "Sync now".
- **Debug hooks** (DEBUG only): `signin?email=&password=`, `signout`, `sync`, `syncstate` (token
  redacted), `profiles` if profiles are added.

## Things that are easy to get wrong

- **Ids are opaque strings of up to 64 characters.** Never parse them, except to produce the legacy
  derivation above.
- **`ts` is the check's `at`.** Not the time of the sync.
- **Deletions win.** After a pull says an id is deleted, remove it locally and from `pendingAdds`.
- **A `401` means the token is dead**, not that the request was bad. Clear the token and sync state,
  keep history, show "Signed out".
- **Settings are not synced.**
- **Restoring a backup after a Clear.** The server keeps tombstones, so restored records the account
  deleted are queued, ignored by the server and never come back from it; they stay on that device only.

## Testing

- **`swift test`:** cover the store's queueing, the legacy id vectors and `SyncClient` against a fake
  transport.
- **Against a local server:** `DB_PATH=$HOME/tmp/hp.db go run . -add-admin you@example.com`, then
  `DB_PATH=$HOME/tmp/hp.db ADDR=0.0.0.0:8093 go run .` on the Linux box. The iPad cannot reach
  `localhost`; use the LAN address with a DEBUG-only ATS exception. Delete the database afterwards.
- **End to end:**
  1. Sign in on the iPad (`signin` hook).
  2. Record a check and `sync`.
  3. Check that it appears on the web Progress page.
  4. Record one on the web and check that the iPad has it after `sync`.
  5. Clear on one side and check that the records disappear on the other.
