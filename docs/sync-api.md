# Sync API

How the web app and the iPad app sync checked lines (and, later, the ink of each attempt) through the
server. The server side lives in `internal/handler/api.go` (HTTP) and `internal/history` (storage);
the web client is `web/sync.ts` and `web/progress-store.ts`. Both clients follow the algorithm at the
end of this page. It is the same contract as music-practice's, with different record kinds.

## Model

- **Local first.** Each device keeps its own history (IndexedDB on the web, files on the iPad) and
  works offline and signed out. The server is where a signed-in user's devices swap records.
- **A record is immutable.** Syncing is a union by `(kind, id)`.
- **Kinds:**

  | kind    | what it is                                                | web type (`web/progress-store.ts`) |
  | ------- | --------------------------------------------------------- | ---------------------------------- |
  | `check` | one checked line: score, letters, metrics                 | `CheckRecord`                      |
  | `ink`   | the quantized strokes of one checked attempt (see below)  | `InkRecord`                        |

  The server accepts exactly these two kinds (a database `CHECK` constraint and `history.Kinds`).
  Anything else lands in `rejected`.
- **Deletions are tombstones.** Clearing history on one device sends the removed ids (of both kinds).
  The server keeps a tombstone, so every other device deletes them too, and a device that hasn't
  heard yet can't resurrect them by pushing them again: a tombstoned id stays deleted.
- **Cursor.** Every stored record and tombstone gets a new, increasing sequence number. A client keeps
  the highest one it has seen and asks only for changes after it.

## Record identity (web and iPad must agree)

Every record has `id` (a string of 1-64 **bytes of UTF-8**, opaque to everyone except where stated
here: count `s.utf8.count` in Swift, not characters or UTF-16 units) and `ts` (a number greater than 0).
The member names are exactly `id` and `ts`, lower case. The server checks nothing else about a record
except its size and that no two of its top-level member names are equal when compared case-insensitively
(`"id"` and `"ID"`, or a repeated name).

- **`ts` is `at`.** For a check, `ts` equals the record's `at`, the time the line was checked
  (milliseconds since the epoch), which must be greater than 0 (the server refuses a non-positive
  `ts`, so a client must not make or accept a check whose `at` is not). It is never the time of the add
  or the upload. An `ink` record's
  `ts` is the `at` of the check it belongs to.
- **A record with an `id` keeps it.** Whenever it is loaded, imported or uploaded.
- **A new record gets a random UUID** (lowercase, v4). The web falls back to building a v4 UUID from
  `crypto.getRandomValues` where `crypto.randomUUID` is unavailable (a plain-HTTP page).
- **A check with no `id`** (made before sync existed, or restored from a version 1 backup) gets a
  deterministic legacy id derived only from `at`, `sheet` and `line`, so every device computes the
  same id for the same old record. Apply it on load, on import or restore, and before an upload; the
  web persists it when its IndexedDB upgrades to version 2. Ports must reproduce it byte for byte:

  ```
  at   = trunc(at)                         // integer part; at is normally already an integer
  s    = decimal(at) + "|" + sheet + "|" + line
  id   = "legacy-" + base36(at) + "-" + hex(cyrb53(s))
  ```

  - `decimal(at)` is the base-10 integer, no separators, no exponent or sign for current dates.
  - `base36(at)` is lowercase `0-9a-z`, no padding.
  - `hex(...)` is lowercase hex of the 53-bit hash as an unsigned integer, **no zero padding**
    (so its length varies; the whole id is at most 6 + 9 + 1 + 14 = 30 characters).
  - `cyrb53` runs over the **UTF-16 code units** of `s` (JavaScript's `charCodeAt`; in Swift, iterate
    `s.utf16`), seed 0, with 32-bit wrapping multiplication:

    ```js
    function cyrb53(s) {
      let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
      for (let i = 0; i < s.length; i++) {
        const c = s.charCodeAt(i);
        h1 = Math.imul(h1 ^ c, 2654435761);
        h2 = Math.imul(h2 ^ c, 1597334677);
      }
      h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
      h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
      return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16);
    }
    ```

    In Swift: `Int32` wrapping multiply (`&*`) of the XORed values, `UInt32` shifts (`>>>` is a logical
    shift of the 32-bit value), and the final value `(UInt64(h2 & 2097151) << 32) + UInt64(UInt32(bitPattern: h1))`.

  Test vectors (also pinned by `web/progress-store_test.ts`):

  | `at`            | `sheet`  | `line`                    | id                                |
  | --------------- | -------- | ------------------------- | --------------------------------- |
  | `1700000000000` | `arches` | `n m`                     | `legacy-loyw3v28-14cd5db9c318a8`  |
  | `1700000000123` | `custom` | `Café ñ — “quoted”`       | `legacy-loyw3v5n-6a49beccf0e0d`   |
  | `1700000000000.9` | `x`    | `y`                       | `legacy-loyw3v28-cd46e230def4c`   |

  and `cyrb53("")` is `bdcb81aee8d83`, `cyrb53("a")` is `1c2ba782c97901`.
- **Backups dedupe on `at|sheet|line`**, unchanged from before sync, and the web also skips a pulled
  record whose `at|sheet|line` it already has under a different id.
- **Never rewrite the store from a filtered view.** A stored record that fails validation (an unknown
  `pen` written by a newer client, say) is kept as it is: it is skipped in views and merges, never
  dropped when the store is rewritten after an add or a merge. The web adds only `id` and `ts` to old
  records and changes nothing else.

## Record shapes

### `check`

The client's own JSON, stored and returned byte for byte. The web's `CheckRecord`:

```json
{
  "id": "6f2c0a54-9b1e-4c1a-8f0d-2f1d6b6f4a11",
  "ts": 1760000000000,
  "at": 1760000000000,
  "sheet": "arches",
  "sheetTitle": "Branching arches",
  "line": "n m n m",
  "model": "italic",
  "modelName": "Edu SA Beginner",
  "pen": "monoline",
  "score": 82,
  "letters": [{ "char": "n", "score": 90, "missing": false }],
  "metrics": { "slantDiff": 1.5, "size": 1.02, "width": 0.97, "baseline": 0.01 }
}
```

`pen` is `"monoline"` or `"edged"`; `score` is 0-100; `sheet` is a worksheet slug or `"custom"`.
Unknown extra fields must be carried untouched.

### `ink`

The strokes of one checked attempt, so a check can be shown with what was written. **The web does not
write these yet** (W2 will); the server, the store and `sync.ts` already carry them, and they are
limited to 64 KB like every record. Beyond `id`, `ts` and size nothing is checked, so the shape below
is the agreed starting point for W2 and the iPad, and may be refined by whoever writes the first one
(update this page when they do):

```json
{
  "id": "0b8e3f0e-5f0b-4d77-a7d1-0a9f6d4a2c10",
  "ts": 1760000000000,
  "check": "6f2c0a54-9b1e-4c1a-8f0d-2f1d6b6f4a11",
  "pen": "monoline",
  "strokes": [[[12, 40, 35, 0], [14, 52, 41, 8]]]
}
```

- `check` is the `id` of the check these strokes belong to. `ts` is that check's `at`.
- `strokes` is a list of strokes; a stroke is a list of points `[u, v, p, t]`, all integers:
  `u`, `v` in hundredths of an x-height (the web's stroke units, relative to the baseline, so ink
  rescales); `p` pressure 0-100; `t` milliseconds since the stroke's first point.
- A line's ink that would exceed 64 KB must be simplified (drop points) before it is stored, not sent
  and rejected.

## Authentication

- **Browser:** the `hp_session` cookie set by signing in at `/account`. Same-origin `fetch` sends it.
  Cross-site requests are refused (403) by the server's cross-origin protection. The cookie is
  `Secure`: browsers accept it from `https://` and from `http://localhost`, but not from a plain-HTTP
  LAN address, so web sign-in needs HTTPS (or localhost). The iPad app uses a bearer token and does
  not.
- **App:** `Authorization: Bearer <token>`, from `POST /api/token`. A token lasts until it's revoked:
  by signing out in the app, by "Sign out" on the account page's device list, by an admin, by a
  password change or reset, or by the account being disabled or deleted. After any of these, every
  request answers 401.

Accounts are created by an admin at `/admin/users`, or the first one with `calligraphy -add-admin
EMAIL`. There is no sign-up endpoint.

## Endpoints

All bodies are JSON. Errors are `{"error": "message"}` with a 4xx/5xx status. Every response is
`Cache-Control: no-store`.

### `POST /api/token` - sign the app in

```json
{ "email": "a@example.com", "password": "…", "label": "Alex's iPad" }
```

- `200` `{"token": "…", "email": "a@example.com"}`. Store the token in the Keychain. The label is what
  the account page's device list shows (100 characters at most).
- `401` for every failure: unknown email, wrong password or disabled account. The message is always
  the same.
- `400` when `email` is not a bare address (after trimming and lower-casing) or is over 254 bytes. This
  is decided before the rate limiter, so it does not count as an attempt.
- `429` when rate-limited: 5 attempts per email, then one a minute, plus a per-IP ceiling of 10 in a
  burst (an IPv6 client counts by its /64). Shared with the web sign-in form.
- `503` with a `Retry-After` header (seconds) when the server is busy: at most 3 password checks run at
  once, and a request waits up to 2 seconds for one. Nothing was decided; try again after the delay.
  Treat it like any other 5xx (keep the credentials form, do not clear anything).
- The request body is limited to 4 KB.

### `DELETE /api/token` - sign the app out

Bearer token required. `204`; the token stops working immediately. Local history is kept.

### `GET /api/me`

`200` `{"email": "…"}`, or `401`. Use it to check whether a stored token or cookie is still good.

### `POST /api/sync`

Push new records and deletions, and pull everything after `cursor`, in one round trip.

Limits on a request (a client must stay inside all of them):

- At most **1000 records in total** across every kind in `push`, and at most **1000 entries in
  `deleted`**. More is `400` and nothing is stored. Clients send far fewer (below).
- The body is at most 16 MB (`413` beyond that). Clients keep the record data of one request to about
  **4 MB of JSON** (`4 * 1024 * 1024` bytes of serialized records, always at least one record) and at
  most **500 records**, deletions at most 1000.
- On `413`, halve the batch (records and bytes) and send again; a single record that still gets `413`
  is an error to report, not to retry.

Request (`push` and `deleted` may be omitted; `account` is optional on the wire, but the web and iPad
always send it):

```json
{
  "account": "a@example.com",
  "cursor": 0,
  "push": {
    "check": [{ "id": "…", "ts": 1760000000000, "...": "the record's own fields" }],
    "ink": []
  },
  "deleted": [{ "kind": "check", "id": "…" }]
}
```

Response (always every key, always arrays, never `null`):

```json
{
  "cursor": 42,
  "records": { "check": [ {…} ], "ink": [] },
  "deleted": [ { "kind": "check", "id": "…" } ],
  "more": false,
  "rejected": [ { "kind": "ink", "id": "…", "reason": "record over 65536 bytes" } ]
}
```

- **`account`** is the email the client believes it is signed in as (its stored sync state's `email`).
  If it is present and, after trimming and lower-casing, differs from the authenticated user's email
  (or is not a valid address), the server answers **`409` `{"error":"account mismatch"}`** and stores
  and returns nothing. This is how a shared browser (or an app whose token was replaced) is stopped
  from pushing one person's history into another's account. Omitting it skips the check.
- **Server checks:** each pushed record must be a JSON object with a string `id` (1-64 bytes of UTF-8),
  a numeric `ts` greater than 0, at most 64 KB, and no two top-level member names that match
  case-insensitively. An unknown kind is rejected too. Anything else lands in `rejected` and the rest
  of the push is still stored. Drop rejected records from the pending list rather than resending them
  for ever. **A rejected record carries its `id` whenever the record has a string `id`, whatever the
  reason** (size, `ts`, a case clash, an id of the wrong length); only a record with no string `id`, or
  that is not a JSON object, is rejected without one.
- **Order:** the push is applied first (records, then deletions), then changes after `cursor` are
  returned. The client's own just-pushed records therefore come back in `records`; merging by id makes
  that harmless.
- **Paging:** a response carries at most 1000 changes and at most about 4 MB of record data (a
  tombstone counts as a small constant), and always at least one change when there is one. `more` is
  true when either cap stopped the page. While `more` is true, call again with the new `cursor` and
  nothing to push.
- **Atomic:** the push is one transaction. If the request fails, nothing was stored, and sending the
  same push again is safe.
- `400`: malformed JSON, a negative cursor, or more than 1000 records or deletions. `409`: `account`
  does not match the signed-in user (above). `413`: body over 16 MB. `401`: not signed in, meaning the token or cookie is
  dead. A server fault while checking credentials is a `500`, never a `401`, so a client never drops a
  live token because of a passing error.

## Client algorithm

Sync state is stored per device (web: the `meta` object store of IndexedDB, key `sync`, written in the
same transaction as the change it follows; iPad: a file):

```json
{
  "email": "a@example.com",
  "cursor": 42,
  "pendingAdds": [{ "kind": "check", "id": "…" }],
  "pendingDeletes": [{ "kind": "ink", "id": "…" }],
  "lastSyncAt": 1760000000000
}
```

Its absence means sync is off (signed out). The token itself is not stored here: the iPad keeps it in
the Keychain, and the browser's cookie is HttpOnly.

1. **Recording** a check or ink record, while sync is on: append `{kind, id}` to `pendingAdds`.
   Restoring a backup queues every record it added.
2. **Deleting** (Clear history), while sync is on: work out the ids actually removed, of both kinds,
   append them to `pendingDeletes`, and drop them from `pendingAdds`.
3. **Signing in** on a device that already has history: offer "Add this device's N records to
   <email>?". On yes, queue every local record in `pendingAdds`. The server dedupes, so this is safe to
   offer on every sign-in. Start with `cursor` 0 and sync.
4. **`sync()`:**
   1. Take entries from the front of `pendingAdds`, up to 500 and until their serialized JSON reaches
      4 MB (always at least one), looking each up in the local store. Entries whose record is gone
      count as taken and send nothing.
   2. Send them with up to 1000 of `pendingDeletes`, the stored `cursor` and `account` (the stored
      `email`).
   3. If sync was turned off, or on again, while the request was out, throw the response away. The
      web checks this two ways: an in-memory generation counter (this tab), and by re-reading the
      stored sync state and comparing `email` (another tab changed it). Do the second wherever more
      than one process can change the state.
   4. On `200`, remove exactly what was sent from the pending lists; entries queued while the request
      was in flight stay. Remove the `rejected` ones too.
   5. Merge `records` into the local store: union by id (the web also skips a check whose
      `at|sheet|line` it already has). Skip any record deleted locally since the request went out.
   6. Remove the `deleted` ids locally, and from `pendingAdds`.
   7. Save `cursor` and `lastSyncAt`.
   8. Repeat while `more` is true or `pendingAdds` still has entries.
5. **`401`:** turn sync off by removing the sync state (and the Keychain token on the iPad). Keep the
   local history, and show "Signed out - sign in again to sync".
   **`409`:** the session belongs to another account than the one this device syncs with. Remove the
   sync state (queue and cursor included) as for `401`, keep the local history, and show that the
   account changed; signing in again starts a fresh sync (with the offer to add this device's records
   to the new account). On the iPad the token is still valid, so ask which account to use rather than
   silently keeping it.
   **`413`:** halve the batch (records and bytes) and retry the round; give up with an error if a single
   record is refused.
6. **Network errors and `5xx`:** keep everything pending and try again on the next trigger.
7. **Triggers:** page load or app launch; returning to the foreground (`visibilitychange` /
   `scenePhase == .active`); coming back online; a few seconds after each recorded check (debounced);
   and a "Sync now" button. Don't run two syncs at once.
8. **Signing out:** the web posts to `/account/logout`, the app sends `DELETE /api/token`. Then remove
   the sync state. Local history stays on the device. The web clears it on the signed-out page
   (`/account?notice=signed-out`, via `/static/signout.js`), so any sign-out path, including ending
   this browser's own session from the device list, leaves no state behind.
9. **No progress is an error.** If another round is wanted (`more`, or entries still pending) but the
   last one removed nothing from the queues, pulled no record or tombstone and did not move the
   cursor, stop and report an error instead of repeating the request.

## What is not synced

Settings (chosen model, pen, slant, custom text) stay on each device.
