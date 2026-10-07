import { EMERGENCY_SQUAWKS, type EmergencySquawk, readSquawk } from "./squawk";

/**
 * The events the browser alerts tell of, found by watching the feed's lists go by: a followed flight
 * pushes back, takes off or lands; an aircraft squawks 7700, 7600 or 7500; a military aircraft enters the
 * area. Pure and clocked by the feed's own seconds, so the same lists always give the same alerts.
 *
 * Each event is said once. The polls come every few seconds and an aircraft goes on squawking, or on
 * being in the air, for a long time after the event, so the detector remembers what it has said (`active`,
 * `inArea`, each aircraft's committed state) and only a change says anything new. It reads the lists
 * rather than the drawn scene, so it keeps working in a tab the browser has stopped drawing.
 */

/** One aircraft in a list: the airport's feed, or the squawk route's (which carries only the code asked for). */
export interface Sighting {
  id: string;
  callsign: string | null;
  typeCode: string | null;
  squawk: string | null;
  /** Flagged military in adsb.lol's aircraft database. */
  military: boolean;
  onGround: boolean;
  groundSpeedKt: number | null;
  latitude: number;
  longitude: number;
}

export type AlertKind = "pushback" | "takeoff" | "landing" | "emergency" | "military";

export interface Alert {
  kind: AlertKind;
  /** The aircraft it is about. */
  id: string;
  title: string;
  body: string;
}

/** A change of ground or air has to be seen this many polls running: one poll of a flickering altitude is noise. */
const CONFIRM = 2;
/** Moving this far, metres, from where it stood is a pushback; less is creeping on the stand. */
const PUSHBACK_M = 40;
/** Stood this long, seconds, before the move: less is a pause on the way. After a landing, the stand has to be reached and stood on. */
const STOOD_S = 120;
const STOOD_AFTER_LANDING_S = 600;
/** A squawk or a military aircraft not seen for this long, seconds, is gone: seen again, it is news again. */
const EMERGENCY_GONE_S = 300;
const MILITARY_GONE_S = 600;
/** An aircraft not seen for this long, seconds, is forgotten. */
const FORGET_S = 1800;

const MEANING: Record<EmergencySquawk, string> = {
  "7700": "General emergency.",
  "7600": "Radio failure.",
  "7500": "Unlawful interference (the hijack code).",
};

interface Memory {
  /** On the ground or in the air as last confirmed. */
  ground: boolean;
  pending: { ground: boolean; polls: number } | null;
  sawGround: boolean;
  sawAir: boolean;
  /** Where it has stood still on the ground, and since when. */
  stood: { latitude: number; longitude: number; since: number } | null;
  landedAt: number | null;
  lastSeen: number;
}

/** Metres between two close points: flat-earth is exact enough over the 40 m this is used for. */
function metres(a: { latitude: number; longitude: number }, b: { latitude: number; longitude: number }): number {
  const dy = (b.latitude - a.latitude) * 111_320;
  const dx = (b.longitude - a.longitude) * 111_320 * Math.cos((a.latitude * Math.PI) / 180);
  return Math.hypot(dx, dy);
}

/** A map view's edges, degrees; `east` runs past 180 where the view crosses the antimeridian. */
export interface Bounds {
  west: number;
  south: number;
  east: number;
  north: number;
}

/** Whether a point is inside a map view, however the view wraps the world. */
export function inBounds(b: Bounds, latitude: number, longitude: number): boolean {
  if (latitude < b.south || latitude > b.north) return false;
  return [longitude, longitude + 360, longitude - 360].some((lon) => lon >= b.west && lon <= b.east);
}

const nameOf = (s: Sighting) => s.callsign ?? s.id.toUpperCase();

export class AlertDetector {
  private readonly memory = new Map<string, Memory>();
  /** `${id}:${code}` for each emergency squawk said and not yet gone, with when it was last seen. */
  private readonly active = new Map<string, number>();
  /** The military aircraft in the area and when each was last seen. */
  private readonly inArea = new Map<string, number>();
  /** False until the airport's feed has been looked at once: what is there then is the baseline, not news. */
  private primed = false;
  /** The military aircraft in the map's view and when each was last seen there, and which view that is. */
  private inView = new Map<string, number>();
  private view: number | null = null;

  /**
   * The airport's whole list at `time` (feed seconds). Says what changed for the followed flights
   * (`watched`, by id), for any aircraft squawking an emergency, and for military arriving.
   */
  observe(time: number, list: Sighting[], watched: ReadonlySet<string>): Alert[] {
    const out: Alert[] = [];
    this.expire(time);
    for (const s of list) {
      this.follow(s, time, watched.has(s.id), out);
      // The airport's feed sees every aircraft: one that has changed its code has cleared the old one.
      for (const code of EMERGENCY_SQUAWKS) if (code !== s.squawk) this.active.delete(`${s.id}:${code}`);
      this.emergency(s, time, out);
      if (s.military) {
        if (!this.inArea.has(s.id) && this.primed) out.push({ kind: "military", id: s.id, title: "Military aircraft in the area", body: `${nameOf(s)}${s.typeCode ? ` (${s.typeCode})` : ""} entered the area.` });
        this.inArea.set(s.id, time);
      }
    }
    this.primed = true;
    return out;
  }

  /**
   * The military aircraft the map draws in view at `time`. `view` changes whenever the map is moved: what
   * a new view already holds is its baseline, not news, so only an aircraft that then flies into it is said.
   * One already said for the airport's area is not said again.
   */
  observeView(time: number, list: readonly Pick<Sighting, "id" | "callsign" | "typeCode">[], view: number): Alert[] {
    const out: Alert[] = [];
    this.expire(time);
    if (view !== this.view) {
      this.view = view;
      this.inView = new Map(list.map((s) => [s.id, time]));
      return out;
    }
    for (const s of list) {
      if (!this.inView.has(s.id) && !this.inArea.has(s.id)) out.push({ kind: "military", id: s.id, title: "Military aircraft in view", body: `${s.callsign ?? s.id.toUpperCase()}${s.typeCode ? ` (${s.typeCode})` : ""} flew into the map's view.` });
      this.inView.set(s.id, time);
    }
    return out;
  }

  /** The aircraft the squawk route lists for `code`, already limited to the area on show. */
  observeSquawks(time: number, code: EmergencySquawk, list: Omit<Sighting, "squawk" | "military">[]): Alert[] {
    const out: Alert[] = [];
    this.expire(time);
    for (const s of list) this.emergency({ ...s, squawk: code, military: false }, time, out);
    return out;
  }

  private emergency(s: Sighting, time: number, out: Alert[]): void {
    const code = s.squawk && readSquawk(s.squawk);
    if (!code) return;
    const key = `${s.id}:${code}`;
    if (!this.active.has(key)) out.push({ kind: "emergency", id: s.id, title: `${nameOf(s)} is squawking ${code}`, body: MEANING[code] });
    this.active.set(key, time);
  }

  /** Takeoff, landing and pushback for one aircraft, said only when it is followed; its state is kept for all so a follow starts informed. */
  private follow(s: Sighting, time: number, watched: boolean, out: Alert[]): void {
    let m = this.memory.get(s.id);
    if (!m) {
      m = { ground: s.onGround, pending: null, sawGround: s.onGround, sawAir: !s.onGround, stood: null, landedAt: null, lastSeen: time };
      this.memory.set(s.id, m);
    }
    m.lastSeen = time;
    const say = (kind: "takeoff" | "landing" | "pushback", title: string, body: string) => {
      if (watched) out.push({ kind, id: s.id, title, body });
    };

    if (s.onGround === m.ground) m.pending = null;
    else {
      m.pending = m.pending?.ground === s.onGround ? { ground: s.onGround, polls: m.pending.polls + 1 } : { ground: s.onGround, polls: 1 };
      if (m.pending.polls >= CONFIRM) {
        m.ground = s.onGround;
        m.pending = null;
        m.stood = null;
        if (s.onGround) {
          if (m.sawAir) {
            say("landing", `${nameOf(s)} has landed`, "It is on the ground.");
            m.landedAt = time;
          }
          m.sawGround = true;
        } else {
          if (m.sawGround) say("takeoff", `${nameOf(s)} has taken off`, "It is in the air.");
          m.sawAir = true;
        }
      }
    }

    if (!m.ground || !s.onGround) {
      m.stood = null;
      return;
    }
    if (!m.stood) {
      if ((s.groundSpeedKt ?? 0) < 2) m.stood = { latitude: s.latitude, longitude: s.longitude, since: time };
      return;
    }
    if (metres(m.stood, s) < PUSHBACK_M) return;
    const need = m.landedAt === null ? STOOD_S : STOOD_AFTER_LANDING_S;
    if (time - m.stood.since >= need) say("pushback", `${nameOf(s)} is pushing back`, "It has left its stand.");
    m.stood = null;
  }

  private expire(time: number): void {
    for (const [key, seen] of this.active) if (time - seen > EMERGENCY_GONE_S) this.active.delete(key);
    for (const [id, seen] of this.inArea) if (time - seen > MILITARY_GONE_S) this.inArea.delete(id);
    for (const [id, seen] of this.inView) if (time - seen > MILITARY_GONE_S) this.inView.delete(id);
    for (const [id, m] of this.memory) if (time - m.lastSeen > FORGET_S) this.memory.delete(id);
  }
}
