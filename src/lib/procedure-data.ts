import type { Airport } from "./airports";
import { localProcedures, type LocalProcedures, type ProcedureFile } from "./procedure-path";

/**
 * Each airport's published procedures (scripts/procedures.mjs, from the FAA's CIFP), loaded on
 * demand: one chunk per airport, as airport-data.ts loads the ground plans. Written out one by one
 * because the bundler needs every path spelled in full. A runway without a published procedure draws
 * its approach and climb-out along the extended centreline.
 */
const FILES: Record<Airport["code"], () => Promise<{ default: unknown }>> = {
  atl: () => import("@/data/procedures/atl.json"),
  pit: () => import("@/data/procedures/pit.json"),
  jfk: () => import("@/data/procedures/jfk.json"),
  dfw: () => import("@/data/procedures/dfw.json"),
  ord: () => import("@/data/procedures/ord.json"),
  den: () => import("@/data/procedures/den.json"),
  lax: () => import("@/data/procedures/lax.json"),
  mco: () => import("@/data/procedures/mco.json"),
  las: () => import("@/data/procedures/las.json"),
  mia: () => import("@/data/procedures/mia.json"),
  sfo: () => import("@/data/procedures/sfo.json"),
  clt: () => import("@/data/procedures/clt.json"),
  sea: () => import("@/data/procedures/sea.json"),
  phx: () => import("@/data/procedures/phx.json"),
  ewr: () => import("@/data/procedures/ewr.json"),
  iah: () => import("@/data/procedures/iah.json"),
  bos: () => import("@/data/procedures/bos.json"),
  msp: () => import("@/data/procedures/msp.json"),
  dtw: () => import("@/data/procedures/dtw.json"),
  lga: () => import("@/data/procedures/lga.json"),
  fll: () => import("@/data/procedures/fll.json"),
  phl: () => import("@/data/procedures/phl.json"),
  iad: () => import("@/data/procedures/iad.json"),
  slc: () => import("@/data/procedures/slc.json"),
  san: () => import("@/data/procedures/san.json"),
  bna: () => import("@/data/procedures/bna.json"),
  bwi: () => import("@/data/procedures/bwi.json"),
  tpa: () => import("@/data/procedures/tpa.json"),
  dca: () => import("@/data/procedures/dca.json"),
  aus: () => import("@/data/procedures/aus.json"),
  hnl: () => import("@/data/procedures/hnl.json"),
  cle: () => import("@/data/procedures/cle.json"),
};

export async function loadProcedures(airport: Pick<Airport, "code" | "latitude" | "longitude" | "elevationFt">): Promise<LocalProcedures> {
  return localProcedures((await FILES[airport.code]()).default as ProcedureFile, airport);
}
