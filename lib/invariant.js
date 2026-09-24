//#region src/invariant.ts
/**
* Package invariant companion. Registered with the DSH invariant registry by
* the host composition; this plugin adds no runtime-side invariant because it
* has no host-side behavior — all state lives in the browser conversation
* projection.
*/
const name = "dsh-cache-badge/invariant";
function apply() {}
//#endregion
export { apply, name };
