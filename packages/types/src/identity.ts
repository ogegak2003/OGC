/**
 * A public OGC communication identity, e.g. `OGC000001`.
 *
 * Branded so that arbitrary strings cannot be passed where a validated
 * identity is required. Obtain one via `@ogc/validation` (`parseOgcId`).
 */
export type OgcId = string & { readonly __brand: 'OgcId' };
