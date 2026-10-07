import { BoxGeometry, BufferAttribute, type BufferGeometry, ConeGeometry, CylinderGeometry, ExtrudeGeometry, Shape, SphereGeometry } from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { type AircraftModel, MODEL_LENGTH } from "../aircraft-class";

/**
 * Low-poly aircraft, one per kind (see aircraft-class.ts), each at a nominal life size, nose toward
 * -z (north) and wheels at y = 0, so heading h is a rotation of -h about y and an aircraft of length L
 * is drawn at L / MODEL_LENGTH[model] (aircraft-class.ts).
 */

function planform(points: [number, number][], thickness: number, y: number): BufferGeometry {
  const shape = new Shape();
  points.forEach(([px, py], i) => (i === 0 ? shape.moveTo(px, py) : shape.lineTo(px, py)));
  shape.closePath();
  // Shape y is forward; after the rotation it runs along -z, and the extrusion thickness is up.
  const g = new ExtrudeGeometry(shape, { depth: thickness, bevelEnabled: false });
  g.rotateX(-Math.PI / 2);
  g.translate(0, y, 0);
  return g;
}

/** Mirrors a half outline (x >= 0, listed front to back) into a full, closed outline. */
function mirrored(half: [number, number][]): [number, number][] {
  return [...half, ...[...half].reverse().map(([x, y]): [number, number] => [-x, y])];
}

/** A cylinder along z, from rFront at the front to rBack at the back, centred at (x, y, z). */
function tube(rFront: number, rBack: number, length: number, x: number, y: number, z: number, segments = 10): BufferGeometry {
  // CylinderGeometry's top (+y) turns to +z, aft, under a quarter turn about x.
  const g = new CylinderGeometry(rBack, rFront, length, segments);
  g.rotateX(Math.PI / 2);
  g.translate(x, y, z);
  return g;
}

/** A vertical fin: root from z0 aft for `chord`, `height` tall, its top `sweep` further aft and `top` long. */
function fin(z0: number, chord: number, height: number, sweep: number, top: number, thickness: number, y: number): BufferGeometry {
  const s = new Shape();
  s.moveTo(z0, 0);
  s.lineTo(z0 + chord, 0);
  s.lineTo(z0 + sweep + top, height);
  s.lineTo(z0 + sweep, height);
  s.closePath();
  const g = new ExtrudeGeometry(s, { depth: thickness, bevelEnabled: false });
  // Shape x runs aft along +z, shape y up; the thickness ends up across x.
  g.rotateY(-Math.PI / 2);
  g.translate(-thickness / 2, y, 0);
  return g;
}

/** A propeller's disc, seen as a thin translucent-looking wheel: a flat cylinder facing forward. */
function disc(radius: number, x: number, y: number, z: number): BufferGeometry {
  const g = new CylinderGeometry(radius, radius, 0.12, 16);
  g.rotateX(Math.PI / 2);
  g.translate(x, y, z);
  return g;
}

export type JetLightKind = "port" | "starboard" | "tail" | "beacon" | "strobe";
export interface JetLight {
  kind: JetLightKind;
  x: number;
  y: number;
  z: number;
}

/**
 * Per vertex, 1 where the airline's paint goes and 0 where the metal shows: the `paint` attribute. A
 * theme with a livery draws the 0s in its body colour and the 1s in the aircraft's state colour; the
 * others paint the whole aircraft one colour and ignore it.
 */
const PAINTED = 1;
const BARE = 0;

/**
 * How finely a model is built. "far" is the cheap, flat-faceted model the whole fleet is drawn with;
 * "near" rounds the fuselage, nose and nacelles with more facets and shades them smooth, for the few
 * aircraft close to the camera. Both are the same size and carry the same paint.
 */
export type Detail = "far" | "near";

/** Facets around a round part, and around and along a sphere. */
const SEGMENTS: Record<Detail, { round: number; sphere: [number, number] }> = {
  far: { round: 10, sphere: [12, 8] },
  near: { round: 28, sphere: [28, 16] },
};

class Parts {
  readonly list: { g: BufferGeometry; paint: number; smooth: boolean }[] = [];
  constructor(private readonly detail: Detail) {}
  /** A part; a `smooth` one (fuselage, nose, nacelles) keeps its rounded normals in the close-range model. */
  add(g: BufferGeometry, paint: number, smooth = false) {
    this.list.push({ g, paint, smooth });
  }
  merge(): BufferGeometry {
    const near = this.detail === "near";
    const merged = mergeGeometries(
      this.list.map(({ g, paint, smooth }) => {
        // Every part carries the same attributes. Far: position only, faceted after the merge. Near: a
        // smooth part keeps its own normals, the rest get their faces' normals.
        const flat = g.index ? g.toNonIndexed() : g;
        const keep = near && smooth ? ["position", "normal"] : ["position"];
        for (const name of Object.keys(flat.attributes)) if (!keep.includes(name)) flat.deleteAttribute(name);
        if (near && !smooth) flat.computeVertexNormals();
        flat.setAttribute("paint", new BufferAttribute(new Float32Array(flat.getAttribute("position").count).fill(paint), 1));
        return flat;
      }),
    );
    for (const { g } of this.list) g.dispose();
    if (!merged) throw new Error("aircraft: could not merge parts");
    if (!near) merged.computeVertexNormals();
    return merged;
  }
}

interface FixedWing {
  length: number;
  radius: number;
  span: number;
  /** Wing root chord and tip chord, metres. */
  root: number;
  tip: number;
  /** How far aft the tip's leading edge sits behind the root's. */
  sweep: number;
  wing: "low" | "high";
  /** Engine x positions (one side; mirrored), radius and length. */
  engines: number[];
  engineRadius: number;
  engineLength: number;
  /** Engines on the rear fuselage instead of under the wings. */
  rear?: boolean;
  /** Propellers on the engines, or one on the nose. */
  props?: boolean;
  noseProp?: boolean;
  tTail?: boolean;
  finHeight: number;
  stabSpan: number;
}

function fixedWing(spec: FixedWing, detail: Detail): { geometry: BufferGeometry; lights: JetLight[] } {
  const { length: L, radius: R, span } = spec;
  const parts = new Parts(detail);
  const round = SEGMENTS[detail].round;
  // Height of the fuselage axis above the ground: enough gear for the engines to hang under a low wing.
  const underslung = spec.wing === "low" && !spec.rear && spec.engines.length > 0;
  const body = Math.max(R + Math.max(0.5, R * 0.4), underslung ? R * 0.55 + spec.engineRadius * 1.9 + 0.4 : 0);
  const noseLen = L * 0.14;
  const tailLen = L * 0.18;
  const tubeLen = L - noseLen - tailLen;
  const front = -L / 2;

  if (detail === "near") {
    // A rounded nose: half an ellipsoid, its pole at the front.
    const nose = new SphereGeometry(R, round, SEGMENTS.near.sphere[1], 0, Math.PI * 2, 0, Math.PI / 2);
    nose.rotateX(-Math.PI / 2);
    nose.scale(1, 1, noseLen / R);
    nose.translate(0, body, front + noseLen);
    parts.add(nose, BARE, true);
  } else {
    const nose = new ConeGeometry(R, noseLen, round);
    nose.rotateX(-Math.PI / 2);
    nose.translate(0, body, front + noseLen / 2);
    parts.add(nose, BARE);
  }
  parts.add(tube(R, R, tubeLen, 0, body, front + noseLen + tubeLen / 2, round), BARE, true);
  const tail = new ConeGeometry(R, tailLen, round);
  tail.rotateX(Math.PI / 2);
  tail.translate(0, body + R * 0.26, L / 2 - tailLen / 2);
  parts.add(tail, PAINTED, true);

  // The wing, its root's leading edge a little ahead of the middle.
  const lead = L * 0.09; // Forward of centre, in planform coordinates (forward is +).
  const half = span / 2;
  const rootX = R * 0.8;
  const thick = Math.max(0.3, R * 0.3);
  const wingY = spec.wing === "high" ? body + R * 0.7 : body - R * 0.55;
  parts.add(
    planform(
      mirrored([
        [rootX, lead],
        [half, lead - spec.sweep],
        [half, lead - spec.sweep - spec.tip],
        [rootX, lead - spec.root],
      ]),
      thick,
      wingY,
    ),
    PAINTED,
  );
  /** z of the wing's leading edge at x across. */
  const leadZ = (x: number) => -(lead - (spec.sweep * (x - rootX)) / (half - rootX));

  // Fin and tailplane.
  const finRoot = L * 0.16;
  const finZ = L / 2 - tailLen - finRoot * 0.2;
  const finBase = body + R * 0.7;
  const finSweep = spec.finHeight * 0.75;
  parts.add(fin(finZ, finRoot, spec.finHeight, finSweep, finRoot * 0.45, Math.max(0.3, R * 0.25), finBase), PAINTED);
  const stabY = spec.tTail ? finBase + spec.finHeight - 0.2 : body + R * 0.4;
  const stabLead = spec.tTail ? -(finZ + finSweep) : -(finZ + finRoot * 0.1);
  const stabHalf = spec.stabSpan / 2;
  parts.add(
    planform(
      mirrored([
        [0.3, stabLead],
        [stabHalf, stabLead - stabHalf * 0.55],
        [stabHalf, stabLead - stabHalf * 0.55 - finRoot * 0.3],
        [0.3, stabLead - finRoot * 0.6],
      ]),
      Math.max(0.25, thick * 0.7),
      stabY,
    ),
    PAINTED,
  );

  // Engines.
  const er = spec.engineRadius;
  const el = spec.engineLength;
  for (const x of spec.engines) {
    for (const side of [-1, 1]) {
      let ex: number;
      let ey: number;
      let ez: number;
      if (spec.rear) {
        ex = side * (R + er + 0.3);
        ey = body + R * 0.35;
        ez = L / 2 - tailLen - el * 0.6;
      } else {
        ex = side * x;
        ey = spec.wing === "high" ? wingY - er * 0.2 : wingY - er * 0.9;
        ez = leadZ(x) - el * 0.25;
      }
      parts.add(tube(er, er * 0.85, el, ex, ey, ez, round), PAINTED, true);
      if (spec.props) parts.add(disc(er * 2.6, ex, ey, ez - el / 2 - 0.15), BARE);
    }
  }
  if (spec.noseProp) parts.add(disc(R * 1.6, 0, body, front - 0.15), BARE);

  const tipZ = leadZ(half) + spec.tip / 2;
  const lights: JetLight[] = [
    { kind: "port", x: -half, y: wingY + thick, z: tipZ },
    { kind: "starboard", x: half, y: wingY + thick, z: tipZ },
    { kind: "tail", x: 0, y: body + R * 0.26, z: L / 2 },
    { kind: "beacon", x: 0, y: body + R + 0.4, z: -L * 0.05 },
    { kind: "strobe", x: -half, y: wingY + thick, z: tipZ + spec.tip / 2 },
    { kind: "strobe", x: half, y: wingY + thick, z: tipZ + spec.tip / 2 },
  ];
  return { geometry: parts.merge(), lights };
}

function helicopter(detail: Detail): { geometry: BufferGeometry; lights: JetLight[] } {
  const parts = new Parts(detail);
  const { round, sphere } = SEGMENTS[detail];
  const cabin = new SphereGeometry(1, ...sphere);
  cabin.scale(1.25, 1.3, 2.6);
  cabin.translate(0, 2.1, -2.6);
  parts.add(cabin, PAINTED, true);
  parts.add(tube(0.45, 0.2, 7, 0, 2.5, 3.2, round), BARE, true);
  parts.add(fin(5.6, 1.2, 1.8, 0.8, 0.6, 0.18, 2.4), PAINTED);
  // Main rotor and mast; the tail rotor turns across, in the y-z plane.
  const mast = new CylinderGeometry(0.15, 0.15, 0.8, 6);
  mast.translate(0, 3.6, -2.4);
  parts.add(mast, BARE);
  // Two blades crossed, so the cabin shows through where a disc would hide it.
  for (const angle of [Math.PI / 4, -Math.PI / 4]) {
    const blade = new BoxGeometry(0.35, 0.08, 10.8);
    blade.rotateY(angle);
    blade.translate(0, 4.05, -2.4);
    parts.add(blade, BARE);
  }
  const tailRotor = new CylinderGeometry(0.9, 0.9, 0.08, 12);
  tailRotor.rotateZ(Math.PI / 2);
  tailRotor.translate(0.35, 2.9, 6.3);
  parts.add(tailRotor, BARE);
  for (const side of [-1, 1]) {
    const skid = new BoxGeometry(0.12, 0.12, 4.6);
    skid.translate(side * 1.05, 0.06, -2.3);
    parts.add(skid, BARE);
    for (const z of [-3.6, -1.2]) {
      const strut = new BoxGeometry(0.1, 0.9, 0.1);
      strut.translate(side * 0.95, 0.5, z);
      parts.add(strut, BARE);
    }
  }
  const lights: JetLight[] = [
    { kind: "port", x: -1.25, y: 2.1, z: -2.4 },
    { kind: "starboard", x: 1.25, y: 2.1, z: -2.4 },
    { kind: "tail", x: 0, y: 2.5, z: 6.7 },
    { kind: "beacon", x: 0, y: 3.45, z: -1.4 },
    { kind: "strobe", x: 0, y: 4.2, z: 2.9 },
  ];
  return { geometry: parts.merge(), lights };
}

function fastJet(detail: Detail): { geometry: BufferGeometry; lights: JetLight[] } {
  const parts = new Parts(detail);
  const { round, sphere } = SEGMENTS[detail];
  const body = 1.7;
  const nose = new ConeGeometry(0.75, 4.5, round);
  nose.rotateX(-Math.PI / 2);
  nose.translate(0, body, -5.75);
  parts.add(nose, BARE, true);
  parts.add(tube(0.85, 0.75, 11, 0, body, 2, round), BARE, true);
  // Canopy.
  const canopy = detail === "near" ? new SphereGeometry(1, ...sphere) : new SphereGeometry(1, 10, 6);
  canopy.scale(0.5, 0.45, 1.5);
  canopy.translate(0, body + 0.65, -3.2);
  parts.add(canopy, BARE, true);
  // A cropped delta, mid-mounted, and a small swept tailplane.
  parts.add(
    planform(
      mirrored([
        [0.7, 1.5],
        [5, -3.6],
        [5, -4.6],
        [0.7, -5.2],
      ]),
      0.25,
      body - 0.1,
    ),
    PAINTED,
  );
  parts.add(
    planform(
      mirrored([
        [0.6, -5.4],
        [3, -7],
        [3, -7.6],
        [0.6, -7.4],
      ]),
      0.2,
      body,
    ),
    PAINTED,
  );
  parts.add(fin(3.6, 3, 3, 2.2, 1.2, 0.2, body + 0.5), PAINTED);
  const lights: JetLight[] = [
    { kind: "port", x: -5, y: body + 0.2, z: 4.1 },
    { kind: "starboard", x: 5, y: body + 0.2, z: 4.1 },
    { kind: "tail", x: 0, y: body + 3.4, z: 7.4 },
    { kind: "beacon", x: 0, y: body + 0.9, z: 1 },
    { kind: "strobe", x: -5, y: body + 0.2, z: 4.6 },
    { kind: "strobe", x: 5, y: body + 0.2, z: 4.6 },
  ];
  return { geometry: parts.merge(), lights };
}

/** Each model's specification, at its nominal length. */
const FIXED_WING: Record<Exclude<AircraftModel, "heli" | "fighter">, FixedWing> = {
  // About an A321: 44 m long, 36 m across.
  narrow: { length: 44, radius: 2.3, span: 36, root: 7, tip: 2.6, sweep: 9, wing: "low", engines: [6], engineRadius: 1.1, engineLength: 4.5, finHeight: 8, stabSpan: 14 },
  // About a 777-300: longer, fatter, big fans.
  wide: { length: 74, radius: 3.2, span: 64, root: 12, tip: 3.6, sweep: 15, wing: "low", engines: [10], engineRadius: 1.9, engineLength: 7.5, finHeight: 12, stabSpan: 22 },
  // About a 747-400.
  quad: { length: 71, radius: 3.3, span: 64, root: 12, tip: 3.6, sweep: 16, wing: "low", engines: [12, 21], engineRadius: 1.4, engineLength: 6, finHeight: 12, stabSpan: 22 },
  // About a CRJ900: slim, T-tail, engines on the tail.
  rearjet: { length: 36, radius: 1.4, span: 25, root: 4.5, tip: 1.6, sweep: 5, wing: "low", engines: [0], engineRadius: 0.75, engineLength: 4, rear: true, tTail: true, finHeight: 5.5, stabSpan: 8.5 },
  // About an ATR 72: high straight wing, T-tail, two propellers.
  turboprop: { length: 27, radius: 1.4, span: 27, root: 2.6, tip: 1.6, sweep: 0.3, wing: "high", engines: [4.1], engineRadius: 0.55, engineLength: 4, props: true, tTail: true, finHeight: 5, stabSpan: 7.4 },
  // About a Cessna 172: high wing, a propeller on the nose.
  light: { length: 8, radius: 0.65, span: 11, root: 1.6, tip: 1.3, sweep: 0, wing: "high", engines: [], engineRadius: 0, engineLength: 0, noseProp: true, finHeight: 1.6, stabSpan: 3.4 },
  // About a C-17: high wing, T-tail, four engines.
  airlifter: { length: 53, radius: 3.4, span: 52, root: 9, tip: 3, sweep: 8, wing: "high", engines: [8, 14.5], engineRadius: 1.15, engineLength: 5.5, tTail: true, finHeight: 9, stabSpan: 20 },
};

export const MODELS = Object.keys(MODEL_LENGTH) as AircraftModel[];

const built = new Map<AircraftModel, { geometry: BufferGeometry; lights: JetLight[] }>();

function build(model: AircraftModel, detail: Detail = "far") {
  if (model === "heli") return helicopter(detail);
  if (model === "fighter") return fastJet(detail);
  return fixedWing(FIXED_WING[model], detail);
}

/** A fresh geometry for the model, at a detail (the cheap far one by default); the caller owns and disposes it. */
export function modelGeometry(model: AircraftModel, detail: Detail = "far"): BufferGeometry {
  return build(model, detail).geometry;
}

/**
 * Where the model's lights sit, in its own frame: red nav light on the left, green on the right,
 * white at the tail, a red beacon on top, white strobes on the wingtips.
 */
export function modelLights(model: AircraftModel): readonly JetLight[] {
  let entry = built.get(model);
  if (!entry) {
    entry = build(model);
    entry.geometry.dispose();
    built.set(model, entry);
  }
  return entry.lights;
}

/** The narrowbody: the model drawn when nothing better is known. */
export function jetGeometry(): BufferGeometry {
  return modelGeometry("narrow");
}

export const JET_LIGHTS = modelLights("narrow");
