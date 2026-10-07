import { BufferAttribute, Color, CylinderGeometry, DoubleSide, Group, Mesh, MeshBasicMaterial, MeshLambertMaterial, Object3D } from "three";
import type { Wind } from "../metar";

/**
 * The airfield's windsocks, where the map has them, turned and filled by the reported wind. Drawn
 * many times life size, as the aircraft are, so a sock reads at airport scale.
 */

export interface WindsockPose {
  /** Degrees true the sock points: downwind. */
  headingDeg: number;
  /** Degrees below horizontal the sock hangs. */
  droopDeg: number;
  /** 0 limp to 1 standing straight out (15 knots: five stripes of 3 knots). */
  fill: number;
  /** The fill in the gusts, which the sock swings up to now and then. */
  gustFill: number;
}

const FULL_KT = 15;
/** How far a limp sock hangs below horizontal. */
const LIMP_DEG = 80;

const fillOf = (kt: number) => Math.min(1, Math.max(0, kt / FULL_KT));

/** Degrees below horizontal a sock hangs at a fill: nearly straight down when limp, level when full. */
export const droopFor = (fill: number) => LIMP_DEG * (1 - fill) ** 1.3;

/** How a sock hangs in this wind: pointing downwind (the middle of a variable arc), drooping as the wind falls. */
export function windsockPose(wind: Wind | null): WindsockPose {
  if (!wind) return { headingDeg: 0, droopDeg: LIMP_DEG, fill: 0, gustFill: 0 };
  let from = wind.directionDeg;
  if (wind.range) {
    const [a, b] = wind.range;
    from = (a + ((b - a + 360) % 360) / 2) % 360;
  }
  const fill = fillOf(wind.speedKt);
  return {
    headingDeg: from === null ? 0 : (from + 180) % 360,
    droopDeg: droopFor(fill),
    fill,
    gustFill: fillOf(Math.max(wind.speedKt, wind.gustKt ?? 0)),
  };
}

/** Drawn sizes, metres. */
const POLE_HEIGHT = 46;
const SOCK_LENGTH = 52;
const MOUTH = 7;
const TAIL = 4;
const STRIPES = 5;
const ORANGE = new Color("#ff6a13");
const WHITE = new Color("#f4f4f2");

/**
 * One windsock: a pole in `poleColor` and an orange-and-white sock hinged at its top. The sock is the
 * returned `sock`, pointing along +x; turn and tilt it with `poseWindsock`. At night (`lit`) the sock
 * is drawn unlit, as a lit windsock glows.
 */
export function createWindsock(poleColor: string, lit: boolean): { group: Group; sock: Object3D } {
  const group = new Group();
  const poleMaterial = new MeshLambertMaterial({ color: poleColor });
  const pole = new Mesh(new CylinderGeometry(1.6, 2.2, POLE_HEIGHT, 8).translate(0, POLE_HEIGHT / 2, 0), poleMaterial);
  pole.castShadow = true;
  group.add(pole);

  // A tapering tube along +x, five stripes from orange at the mouth.
  // Unindexed, so each triangle takes its stripe's colour whole and the bands stay crisp.
  const tube = new CylinderGeometry(TAIL, MOUTH, SOCK_LENGTH, 12, STRIPES, true).rotateZ(-Math.PI / 2).translate(SOCK_LENGTH / 2, 0, 0).toNonIndexed();
  const position = tube.getAttribute("position");
  const colors = new Float32Array(position.count * 3);
  for (let i = 0; i < position.count; i += 3) {
    const middle = (position.getX(i) + position.getX(i + 1) + position.getX(i + 2)) / 3;
    const c = Math.floor((middle / SOCK_LENGTH) * STRIPES) % 2 === 0 ? ORANGE : WHITE;
    for (let k = 0; k < 3; k++) colors.set([c.r, c.g, c.b], (i + k) * 3);
  }
  tube.setAttribute("color", new BufferAttribute(colors, 3));
  const sockMaterial = lit ? new MeshBasicMaterial({ vertexColors: true, side: DoubleSide, color: 0xcccccc }) : new MeshLambertMaterial({ vertexColors: true, side: DoubleSide });
  const sock = new Mesh(tube, sockMaterial);
  sock.castShadow = true;
  const hinge = new Object3D();
  hinge.position.y = POLE_HEIGHT;
  hinge.add(sock);
  group.add(hinge);
  return { group, sock: hinge };
}

/** Points a windsock's hinge along a pose; `fill` (0 to 1) also opens the sock's tail. */
export function poseWindsock(hinge: Object3D, headingDeg: number, droopDeg: number, fill: number): void {
  // Scene x is east and -z north, so a heading clockwise from north is a turn of -heading about y from east, plus 90.
  hinge.rotation.set(0, ((90 - headingDeg) * Math.PI) / 180, (-droopDeg * Math.PI) / 180, "YXZ");
  const open = 0.55 + 0.45 * fill;
  hinge.scale.set(1, open, open);
}
