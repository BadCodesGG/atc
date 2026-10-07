import type { AirportMap } from "./airport-map";
import type { Airport } from "./airports";

/**
 * Each airport's ground plan, loaded on demand: one chunk per airport, so the page downloads only the
 * airports it shows. Written out one by one because the bundler needs every path spelled in full.
 */
const PLANS: Record<Airport["code"], () => Promise<{ default: unknown }>> = {
  atl: () => import("@/data/airports/atl.json"),
  pit: () => import("@/data/airports/pit.json"),
  jfk: () => import("@/data/airports/jfk.json"),
  dfw: () => import("@/data/airports/dfw.json"),
  ord: () => import("@/data/airports/ord.json"),
  den: () => import("@/data/airports/den.json"),
  lax: () => import("@/data/airports/lax.json"),
  mco: () => import("@/data/airports/mco.json"),
  las: () => import("@/data/airports/las.json"),
  mia: () => import("@/data/airports/mia.json"),
  sfo: () => import("@/data/airports/sfo.json"),
  clt: () => import("@/data/airports/clt.json"),
  sea: () => import("@/data/airports/sea.json"),
  phx: () => import("@/data/airports/phx.json"),
  ewr: () => import("@/data/airports/ewr.json"),
  iah: () => import("@/data/airports/iah.json"),
  bos: () => import("@/data/airports/bos.json"),
  msp: () => import("@/data/airports/msp.json"),
  dtw: () => import("@/data/airports/dtw.json"),
  lga: () => import("@/data/airports/lga.json"),
  fll: () => import("@/data/airports/fll.json"),
  phl: () => import("@/data/airports/phl.json"),
  iad: () => import("@/data/airports/iad.json"),
  slc: () => import("@/data/airports/slc.json"),
  san: () => import("@/data/airports/san.json"),
  bna: () => import("@/data/airports/bna.json"),
  bwi: () => import("@/data/airports/bwi.json"),
  tpa: () => import("@/data/airports/tpa.json"),
  dca: () => import("@/data/airports/dca.json"),
  aus: () => import("@/data/airports/aus.json"),
  hnl: () => import("@/data/airports/hnl.json"),
  cle: () => import("@/data/airports/cle.json"),
};

export async function loadAirportMap(code: Airport["code"]): Promise<AirportMap> {
  return (await PLANS[code]()).default as AirportMap;
}
