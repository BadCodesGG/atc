import type { Airport } from "../airports";
import { toLocal } from "../geo";
import { ease, type OrbitView } from "../scene/orbit";

/**
 * The stretch of camera distance (metres) over which the map hands over to the diorama: beyond `far`
 * only the map is drawn, inside `near` only the diorama.
 */
export interface Band {
  near: number;
  far: number;
}

/** How far through the band a distance is, 0 at its outer edge to 1 at its inner, even in scale (log distance). */
function progress(distance: number, { near, far }: Band): number {
  return Math.min(1, Math.max(0, Math.log(far / distance) / Math.log(far / near)));
}

/** How much of the diorama shows at this distance: 0 to 1, easing in and out at the band's edges. */
export function reveal(distance: number, band: Band): number {
  const t = progress(distance, band);
  return t * t * (3 - 2 * t);
}

/**
 * A CSS mask for the diorama while it comes in over the map: an ellipse round the airport (`anchor`,
 * `radiusPx` its reach on screen, `squash` how much the tilt flattens the ground) with a soft edge, so
 * the map stays in view around the airport as the ground plan comes up out of it. Near the end the
 * ellipse widens until it is well past the frame, and the diorama covers the map.
 */
export function revealMask(anchor: { x: number; y: number }, radiusPx: number, squash: number, shown: number): string {
  const grow = 1 + 9 * Math.max(0, (shown - 0.7) / 0.3) ** 2;
  const rx = Math.round(radiusPx * 1.1 * grow);
  const ry = Math.round(rx * squash);
  return `radial-gradient(${rx}px ${ry}px at ${Math.round(anchor.x)}px ${Math.round(anchor.y)}px, #000 70%, transparent 100%)`;
}

/**
 * The camera inside the band over the airport: the bearing, tilt and target the reader came in with
 * (`entry`), turned toward the framed view (`home`) by how far through the band the distance is. It
 * depends on the distance alone, so a wheel zoom, an eased button zoom and a zoom back out all draw the
 * same view at the same distance, and the camera arrives on the framed view exactly as it leaves the
 * band: one continuous camera, no cut. Beyond the band, or over somewhere other than the airport, the
 * camera is left alone.
 */
export function guide(entry: OrbitView, next: OrbitView, home: OrbitView, band: Band): OrbitView {
  if (progress(next.distance, band) <= 0) return next;
  if (!overAirport(entry, home, band)) return next;
  return { ...ease(entry, home, reveal(next.distance, band)), distance: next.distance };
}

/**
 * Whether a camera looks at the airport: at a point within the band's outer distance of the framed
 * view's. Zoomed in anywhere else (a lake, a city with no built airport) the map goes on alone, and the
 * diorama stays hidden rather than rising far from its field.
 */
export function overAirport(view: OrbitView, home: OrbitView, band: Band): boolean {
  return Math.hypot(view.target[0] - home.target[0], view.target[1] - home.target[1]) <= band.far;
}

/**
 * The guide as the map uses it, camera update by camera update: it keeps the camera the map had as it
 * came into the band, and stands aside on the way back out. When the diorama hands the camera back
 * (release), whatever the reader did to the view there stays as it is until the map has left the band.
 */
export class Guide {
  private entry: OrbitView | null = null;
  private held = false;

  release(): void {
    this.entry = null;
    this.held = true;
  }

  step(current: OrbitView, next: OrbitView, home: OrbitView, band: Band): OrbitView {
    if (next.distance >= band.far) {
      this.entry = null;
      this.held = false;
      return next;
    }
    if (this.held) return next;
    this.entry ??= current;
    return guide(this.entry, next, home, band);
  }
}

/**
 * Below this camera distance, metres, the map gets the airport under it ready to land on: its ground
 * plan and traffic load while the camera is still well outside the handover band.
 */
const LANDING_FROM_M = 150_000;
/** An airport counts as under the middle of the map within this, metres. */
const LANDING_RADIUS_M = 40_000;

/** The built airport the map is coming down on: the nearest to the middle of the map, once the camera is low enough. */
export function landingAirport(center: { lat: number; lng: number }, cameraDistanceM: number, airports: readonly Airport[]): Airport | null {
  if (cameraDistanceM > LANDING_FROM_M) return null;
  let best: Airport | null = null;
  let bestD = LANDING_RADIUS_M;
  for (const airport of airports) {
    const [x, y] = toLocal(airport, center.lat, center.lng);
    const d = Math.hypot(x, y);
    if (d < bestD) {
      best = airport;
      bestD = d;
    }
  }
  return best;
}

/**
 * Whether the world view may be drawn as a globe on this renderer (the WebGL unmasked renderer string).
 * Software renderers drew MapLibre's globe without any of its lines, so they keep the flat map; so does
 * a browser that will not name its renderer.
 */
export function globeCapable(renderer: string | null): boolean {
  return renderer !== null && !/swiftshader|llvmpipe|softpipe|software|microsoft basic render/i.test(renderer);
}
