// Separate from the internal candidate build. Runtime settings alone cannot
// enable a public adapter on an unreviewed/default Worker build.
declare const __TWA_NATIVE_RELEASE_BUILD__: boolean;
export const NATIVE_RELEASE_BUILD =
  typeof __TWA_NATIVE_RELEASE_BUILD__ !== 'undefined' && __TWA_NATIVE_RELEASE_BUILD__ === true;
