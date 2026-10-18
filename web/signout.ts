// Loaded by the signed-out page only. Signing out ends the session on the
// server, but this browser's sync state (which account it syncs with, its
// cursor and queue) lives in IndexedDB, where the next person to sit here
// would find it. Clear it; the local history itself stays.

import { DeviceStore } from "./progress-store.ts";

try {
  await new DeviceStore().disableSync();
} catch {
  // Storage refused: nothing to clear, and sync cannot run either.
}
