// The lookup the checks use: the person's own definitions first (the `strokes` records on this
// device, which a sync keeps up to date), then the built-in model (docs/strokes.md, "Lookup order").
// A character with no entry in either is not judged.

import { assemble, type StrokesRec, userLookup } from "./stroke-defs.ts";
import { loadBuiltin, lookupOf, strokesFontID } from "./stroke-models.ts";
import { chainLookups, type StrokeLookup } from "./stroke-order.ts";

/** Where the records are read from (DeviceStore). */
export interface StrokeRecordSource {
  allStrokesRecords(): Promise<StrokesRec[]>;
}

export class StrokeModels {
  #source: StrokeRecordSource | null;
  #records: StrokesRec[] = [];

  constructor(source: StrokeRecordSource | null) {
    this.#source = source;
  }

  /** Read the stored definitions again (after a sync, or on coming back to the page). */
  async refresh(): Promise<void> {
    try {
      this.#records = this.#source ? await this.#source.allStrokesRecords() : [];
    } catch {
      this.#records = []; // Storage unavailable: only the built-in models apply.
    }
  }

  /** The person's definitions of a font, assembled from the records. */
  defs(fontId: string) {
    return assemble(this.#records, fontId);
  }

  /** The lookup for a model font (a catalogue id, or "custom" with its family): user first, then built-in. */
  async lookup(model: string, family: string): Promise<StrokeLookup | null> {
    const fontId = strokesFontID(model, family);
    const built = await loadBuiltin(model);
    return chainLookups([userLookup(this.defs(fontId)), built ? lookupOf(built.glyphs) : null]);
  }
}
