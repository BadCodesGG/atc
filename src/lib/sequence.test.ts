import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_AIRPORT } from "./airports";
import { readSequence } from "./sequence";

const FIXTURE = path.join(import.meta.dirname, "../../public/fixtures/atl-sequence.json.gz");

describe("readSequence", () => {
  it("reads the recorded ATL sequence: minutes of snapshots in order, each with aircraft", async () => {
    const bytes = readFileSync(FIXTURE);
    const snapshots = await readSequence(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), DEFAULT_AIRPORT);
    expect(snapshots.length).toBeGreaterThanOrEqual(20);
    for (let i = 1; i < snapshots.length; i++) expect(snapshots[i].time).toBeGreaterThan(snapshots[i - 1].time);
    expect(snapshots.at(-1)!.time - snapshots[0].time).toBeGreaterThan(7 * 60);
    expect(snapshots.every((s) => s.airport === "atl" && s.aircraft.length > 0)).toBe(true);
  });

  it("reads the same sequence uncompressed, in case a server has already unpacked it", async () => {
    const body = { airport: "atl", interval: 15, snapshots: [{ now: 1_000_000, ac: [{ hex: "abc123", lat: 33.64, lon: -84.43, alt_baro: "ground", seen_pos: 1 }] }] };
    const snapshots = await readSequence(new TextEncoder().encode(JSON.stringify(body)).buffer, DEFAULT_AIRPORT);
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0].time).toBe(1000);
    expect(snapshots[0].aircraft[0]).toMatchObject({ id: "abc123", onGround: true, positionAge: 1 });
  });
});
