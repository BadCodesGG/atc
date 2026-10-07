import { type Fetcher, providerUrl, type Read } from "../upstream";

/** A `Read` that asks only adsb.lol, through a fake fetcher: for the tests of what sits above the provider chain. */
export const readViaLol =
  (get: Fetcher): Read =>
  async (query) => ({ body: await get(providerUrl("adsb.lol", query)), source: "adsb.lol" });
