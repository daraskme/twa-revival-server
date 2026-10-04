// Wrangler replaces this constant. An unspecified or production build is closed,
// regardless of runtime bindings, request headers, or account permissions.
declare const __TWA_INTERNAL_PVP_TEST_BUILD__: boolean;
export const INTERNAL_PVP_TEST_BUILD =
  typeof __TWA_INTERNAL_PVP_TEST_BUILD__ !== 'undefined' && __TWA_INTERNAL_PVP_TEST_BUILD__ === true;
