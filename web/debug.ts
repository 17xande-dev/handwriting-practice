// The test-only half of the app, bundled separately as /static/debug.js and
// loaded by main.ts only under #debug (see exportFixture there), so ordinary
// visitors never download it.

export { buildFixture } from "./fixture.ts";
export { fixtureModelOf } from "./fixture.ts";
