import { type CustomLayerInterface, type CustomRenderMethodInput, type Map as MapLibreMap, MercatorCoordinate } from "maplibre-gl";
import { type AircraftModel, MODEL_LENGTH } from "../aircraft-class";
import { modelGeometry } from "../scene/aircraft-model";
import { aircraftMatrix, type AircraftPose, type EnRouteShot } from "./en-route";
import { hazeShells } from "./map-style";

/**
 * The far ground's haze one frame: the eye (where the camera is) and how far it is over the ground under it,
 * in `colour` (enRouteHaze), at `strength` (hazeStrength, 0 to 1).
 */
export interface HazeFrame {
  eye: EnRouteShot["eye"];
  aboveM: number;
  colour: string;
  strength: number;
  /** The haze's start, no nearer than this many of the eye's heights over the ground (the theme's hazeFloorHeights). */
  floorHeights: number;
}

/**
 * The En-route view's aircraft (docs/adr/0002-en-route-custom-layer.md): the followed flight's procedural
 * class model, the same the Diorama draws, as a MapLibre custom layer in the map's own WebGL context.
 * It draws into the map's framebuffer with the map's depth buffer, so the 3D terrain in front of it hides
 * it. It only draws: the map hands it this frame's pose (sampled once from the shared tracker, with the
 * camera), and it draws the model there. Under the model it draws the far ground's haze (hazeShells), which
 * MapLibre's own fog does not reach on a look near level.
 */

export const EN_ROUTE_LAYER = "en-route-aircraft";

/** How far over level the haze reaches into the sky, as the sine of the angle (about 3 degrees). */
const HAZE_ABOVE_LEVEL = 0.05;
/** The haze shells' sphere: its rings from pole to pole and its segments round each. */
const SPHERE_RINGS = 32;
const SPHERE_SEGMENTS = 64;

const VERTEX = `#version 300 es
in vec3 a_position;
in vec3 a_normal;
in float a_paint;
uniform mat4 u_matrix;
uniform mat3 u_turn;
out vec3 v_normal;
out float v_paint;
void main() {
  v_normal = u_turn * a_normal;
  v_paint = a_paint;
  gl_Position = u_matrix * vec4(a_position, 1.0);
}`;

const FRAGMENT = `#version 300 es
precision mediump float;
in vec3 v_normal;
in float v_paint;
uniform vec3 u_body;
uniform vec3 u_paint;
uniform vec3 u_light;
out vec4 fragColor;
void main() {
  // Lit from above on both sides of every face: the model's faces are seen from either side once mirrored into Mercator.
  float lit = 0.55 + 0.45 * abs(dot(normalize(v_normal), u_light));
  fragColor = vec4(mix(u_body, u_paint, v_paint) * lit, 1.0);
}`;

/** A haze shell: the unit sphere round the eye, scaled out to the shell's distance. */
const HAZE_VERTEX = `#version 300 es
in vec3 a_direction;
uniform mat4 u_matrix;
uniform float u_radius;
out vec3 v_direction;
void main() {
  v_direction = a_direction;
  gl_Position = u_matrix * vec4(a_direction * u_radius, 1.0);
}`;

/**
 * The haze over what is drawn, once a pixel: u_opacity, the haze with every shell nearer than the ground there
 * (drawHaze counts them). Over level it thins out within a few degrees, so the horizon is soft, and a ridge over
 * level fades as the sky beside it does.
 */
const HAZE_FRAGMENT = `#version 300 es
precision mediump float;
in vec3 v_direction;
uniform vec3 u_colour;
uniform float u_opacity;
out vec4 fragColor;
void main() {
  float alpha = u_opacity * (1.0 - smoothstep(0.0, ${HAZE_ABOVE_LEVEL.toFixed(4)}, normalize(v_direction).z));
  if (alpha <= 0.0) discard;
  fragColor = vec4(u_colour, alpha);
}`;

/** The light, in Mercator's axes (x east, y south, z up): high, from the south-east. */
const LIGHT = (() => {
  const v = [0.35, 0.3, 0.88];
  const n = Math.hypot(...v);
  return v.map((x) => x / n);
})();

const hexToRgb = (hex: string): [number, number, number] => {
  const n = parseInt(hex.replace("#", ""), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
};

function compile(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type)!;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(`en-route: shader failed: ${gl.getShaderInfoLog(shader)}`);
  return shader;
}

function link(gl: WebGL2RenderingContext, vertex: string, fragment: string): WebGLProgram {
  const program = gl.createProgram()!;
  const vs = compile(gl, gl.VERTEX_SHADER, vertex);
  const fs = compile(gl, gl.FRAGMENT_SHADER, fragment);
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(`en-route: program failed: ${gl.getProgramInfoLog(program)}`);
  return program;
}

/** The unit sphere the haze's shells are drawn from, as indexed triangles: its points are its directions. */
function unitSphere(gl: WebGL2RenderingContext, program: WebGLProgram): { vao: WebGLVertexArrayObject; buffers: WebGLBuffer[]; count: number } {
  const points: number[] = [];
  for (let r = 0; r <= SPHERE_RINGS; r++) {
    const polar = (r / SPHERE_RINGS) * Math.PI;
    for (let s = 0; s <= SPHERE_SEGMENTS; s++) {
      const azimuth = (s / SPHERE_SEGMENTS) * 2 * Math.PI;
      points.push(Math.sin(polar) * Math.cos(azimuth), Math.sin(polar) * Math.sin(azimuth), Math.cos(polar));
    }
  }
  const indices: number[] = [];
  const row = SPHERE_SEGMENTS + 1;
  for (let r = 0; r < SPHERE_RINGS; r++) {
    for (let s = 0; s < SPHERE_SEGMENTS; s++) {
      const a = r * row + s;
      indices.push(a, a + row, a + 1, a + 1, a + row, a + row + 1);
    }
  }
  const vao = gl.createVertexArray()!;
  gl.bindVertexArray(vao);
  const positions = gl.createBuffer()!;
  gl.bindBuffer(gl.ARRAY_BUFFER, positions);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(points), gl.STATIC_DRAW);
  const direction = gl.getAttribLocation(program, "a_direction");
  gl.enableVertexAttribArray(direction);
  gl.vertexAttribPointer(direction, 3, gl.FLOAT, false, 0, 0);
  const elements = gl.createBuffer()!;
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, elements);
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array(indices), gl.STATIC_DRAW);
  gl.bindVertexArray(null);
  return { vao, buffers: [positions, elements], count: indices.length };
}

interface Mesh {
  model: AircraftModel;
  vao: WebGLVertexArrayObject;
  buffers: WebGLBuffer[];
  count: number;
}

export class EnRouteLayer implements CustomLayerInterface {
  readonly id = EN_ROUTE_LAYER;
  readonly type = "custom" as const;
  readonly renderingMode = "3d" as const;
  private map: MapLibreMap | null = null;
  private gl: WebGL2RenderingContext | null = null;
  private program: WebGLProgram | null = null;
  /** The program's uniforms, looked up once. */
  private uniforms: Record<"matrix" | "turn" | "body" | "paint" | "light", WebGLUniformLocation | null> | null = null;
  private mesh: Mesh | null = null;
  private pose: AircraftPose | null = null;
  private model: AircraftModel = "narrow";
  private lengthM = MODEL_LENGTH.narrow;
  private colours = { body: hexToRgb("#eeeeea"), paint: hexToRgb("#6d28d9") };
  /**
   * The far ground's haze: its program and uniforms, the unit sphere its shells are drawn from (built on the
   * first frame that draws it, inside render, so MapLibre resets the buffer it leaves bound), this frame's haze
   * with its colour as RGB (null draws none), and whether the context has a stencil to count the shells in.
   */
  private hazeProgram: WebGLProgram | null = null;
  private hazeUniforms: Record<"matrix" | "radius" | "colour" | "opacity", WebGLUniformLocation | null> | null = null;
  private sphere: { vao: WebGLVertexArrayObject; buffers: WebGLBuffer[]; count: number } | null = null;
  private haze: (Omit<HazeFrame, "colour"> & { colour: [number, number, number] }) | null = null;
  private stencil = false;
  /** How many shells the layer drew the haze in, last frame: read by the smoke check. */
  hazeDrawn = 0;
  /** How many frames the layer has drawn the aircraft in: read by the smoke check. */
  drawnFrames = 0;
  /** Where it last drew the aircraft's origin, in normalised device coordinates (x right, y up, -1 to 1 across the map): read by the smoke check. */
  drawnAt: { x: number; y: number } | null = null;
  private failed = false;

  /** `onFail` is told, once, if drawing fails (the context cannot build the mesh); the layer then draws nothing. */
  constructor(private readonly onFail: () => void = () => {}) {}

  /** The aircraft this frame: where and how it flies, its class's model and its length; null draws nothing. */
  setAircraft(pose: AircraftPose | null, model: AircraftModel, lengthM: number): void {
    this.pose = pose;
    this.model = model;
    this.lengthM = lengthM;
  }

  /** Its colours: the metal, and the paint on tail, wings and engines. */
  setColours(body: string, paint: string): void {
    this.colours = { body: hexToRgb(body), paint: hexToRgb(paint) };
    this.map?.triggerRepaint();
  }

  /** The far ground's haze this frame (HazeFrame); null draws none. */
  setHaze(haze: HazeFrame | null): void {
    this.haze = haze && { ...haze, colour: hexToRgb(haze.colour) };
  }

  onAdd(map: MapLibreMap, gl: WebGL2RenderingContext): void {
    this.map = map;
    this.gl = gl;
    const program = link(gl, VERTEX, FRAGMENT);
    this.program = program;
    const at = (name: string) => gl.getUniformLocation(program, name);
    this.uniforms = { matrix: at("u_matrix"), turn: at("u_turn"), body: at("u_body"), paint: at("u_paint"), light: at("u_light") };
    // A context without a stencil cannot count the shells (every count would match and the view fill with haze): no haze.
    this.stencil = gl.getParameter(gl.STENCIL_BITS) > 0;
    if (!this.stencil) return;
    let haze: WebGLProgram;
    try {
      haze = link(gl, HAZE_VERTEX, HAZE_FRAGMENT);
    } catch (error) {
      // onRemove never runs for a layer whose onAdd threw: the aircraft's program goes with it.
      gl.deleteProgram(program);
      this.program = null;
      this.uniforms = null;
      throw error;
    }
    this.hazeProgram = haze;
    const hazeAt = (name: string) => gl.getUniformLocation(haze, name);
    this.hazeUniforms = { matrix: hazeAt("u_matrix"), radius: hazeAt("u_radius"), colour: hazeAt("u_colour"), opacity: hazeAt("u_opacity") };
  }

  onRemove(_map: MapLibreMap, gl: WebGL2RenderingContext): void {
    this.dropMesh(gl);
    if (this.program) gl.deleteProgram(this.program);
    if (this.hazeProgram) gl.deleteProgram(this.hazeProgram);
    if (this.sphere) {
      gl.deleteVertexArray(this.sphere.vao);
      for (const b of this.sphere.buffers) gl.deleteBuffer(b);
    }
    this.program = null;
    this.uniforms = null;
    this.hazeProgram = null;
    this.hazeUniforms = null;
    this.sphere = null;
    this.map = null;
    this.gl = null;
  }

  private dropMesh(gl: WebGL2RenderingContext): void {
    if (!this.mesh) return;
    gl.deleteVertexArray(this.mesh.vao);
    for (const b of this.mesh.buffers) gl.deleteBuffer(b);
    this.mesh = null;
  }

  /** The model's mesh, built once per class (the far model: a few hundred faces). */
  private meshFor(gl: WebGL2RenderingContext, program: WebGLProgram): Mesh {
    if (this.mesh?.model === this.model) return this.mesh;
    this.dropMesh(gl);
    const geometry = modelGeometry(this.model, "far");
    const flat = geometry.index ? geometry.toNonIndexed() : geometry;
    if (!flat.getAttribute("normal")) flat.computeVertexNormals();
    const vao = gl.createVertexArray()!;
    gl.bindVertexArray(vao);
    const buffers: WebGLBuffer[] = [];
    for (const [name, attribute, size] of [
      ["position", "a_position", 3],
      ["normal", "a_normal", 3],
      ["paint", "a_paint", 1],
    ] as const) {
      const data = flat.getAttribute(name).array as Float32Array;
      const buffer = gl.createBuffer()!;
      buffers.push(buffer);
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(data), gl.STATIC_DRAW);
      const at = gl.getAttribLocation(program, attribute);
      gl.enableVertexAttribArray(at);
      gl.vertexAttribPointer(at, size, gl.FLOAT, false, 0, 0);
    }
    gl.bindVertexArray(null);
    const count = flat.getAttribute("position").count;
    if (flat !== geometry) flat.dispose();
    geometry.dispose();
    this.mesh = { model: this.model, vao, buffers, count };
    return this.mesh;
  }

  render(gl: WebGL2RenderingContext | WebGLRenderingContext, args: CustomRenderMethodInput): void {
    if (this.failed || !("createVertexArray" in gl)) return;
    // The haze first, over the ground drawn and under the aircraft, which is never in it.
    this.drawHaze(gl, args);
    this.drawAircraft(gl, args);
  }

  /**
   * The far ground's haze (hazeShells), each shell a sphere round the eye. First the shells only count, in the
   * stencil, against the map's depth: a pixel's count is how many shells are nearer than the ground there. Then
   * each count's haze is drawn where the stencil holds it, so every pixel is blended once, at the opacity of the
   * shells counted. Blended shell by shell instead, 24 faint layers each rounded to the framebuffer's 8 bits
   * tinted and darkened the sky in a line where the haze thins out. Nothing is written to the depth.
   *
   * The stencil is cleared before and after, which wipes MapLibre's tile clipping masks: safe only because this
   * layer is the map's topmost (the controller adds it last), so nothing tile-clipped draws after it in the frame,
   * and MapLibre clears the stencil and its record of the masks at the start of the next. Keep it topmost.
   */
  private drawHaze(gl: WebGL2RenderingContext, args: CustomRenderMethodInput): void {
    this.hazeDrawn = 0;
    const { haze, hazeProgram: program, hazeUniforms: u, map } = this;
    if (!haze || !(haze.strength > 0) || !program || !u || !map) return;
    const sphere = (this.sphere ??= unitSphere(gl, program));
    const eye = MercatorCoordinate.fromLngLat([haze.eye.longitude, haze.eye.latitude], haze.eye.altitudeM);
    const metre = eye.meterInMercatorCoordinateUnits();
    // The far plane, from MapLibre's pixels (512 to a tile at zoom 0) to metres.
    const farM = args.farZ / (512 * 2 ** map.getZoom()) / metre;
    const shells = hazeShells(haze.aboveM, haze.floorHeights, farM);
    if (!shells.length) return;
    // Metres round the eye to the map's clip space, composed in doubles: the eye's frame, then the map's projection.
    const local = [metre, 0, 0, 0, 0, metre, 0, 0, 0, 0, metre, 0, eye.x, eye.y, eye.z, 1];
    const clip = multiply(args.defaultProjectionData.mainMatrix as ArrayLike<number>, local);
    gl.useProgram(program);
    gl.uniformMatrix4fv(u.matrix, false, new Float32Array(clip));
    gl.uniform3fv(u.colour, haze.colour);
    gl.disable(gl.CULL_FACE);
    gl.depthMask(false);
    gl.enable(gl.STENCIL_TEST);
    gl.stencilMask(0xff);
    gl.clearStencil(0);
    gl.clear(gl.STENCIL_BUFFER_BIT);
    gl.bindVertexArray(sphere.vao);
    // Count: each shell adds one where the ground is beyond it, colour untouched.
    gl.colorMask(false, false, false, false);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.disable(gl.BLEND);
    gl.stencilFunc(gl.ALWAYS, 0, 0xff);
    gl.stencilOp(gl.KEEP, gl.KEEP, gl.INCR);
    for (const shell of shells) {
      gl.uniform1f(u.radius, shell.distanceM);
      gl.drawElements(gl.TRIANGLES, sphere.count, gl.UNSIGNED_SHORT, 0);
    }
    // Haze: where the count is n, the haze of the nearest n shells, over the whole view (the farthest shell's sphere surrounds it).
    gl.colorMask(true, true, true, true);
    gl.disable(gl.DEPTH_TEST);
    gl.enable(gl.BLEND);
    gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.stencilOp(gl.KEEP, gl.KEEP, gl.KEEP);
    gl.uniform1f(u.radius, shells.at(-1)!.distanceM);
    shells.forEach((shell, i) => {
      gl.stencilFunc(gl.EQUAL, i + 1, 0xff);
      gl.uniform1f(u.opacity, shell.opacity * haze.strength);
      gl.drawElements(gl.TRIANGLES, sphere.count, gl.UNSIGNED_SHORT, 0);
    });
    gl.bindVertexArray(null);
    gl.disable(gl.BLEND);
    gl.clear(gl.STENCIL_BUFFER_BIT);
    gl.disable(gl.STENCIL_TEST);
    gl.depthMask(true);
    this.hazeDrawn = shells.length;
  }

  private drawAircraft(gl: WebGL2RenderingContext, args: CustomRenderMethodInput): void {
    const pose = this.pose;
    const program = this.program;
    if (!pose || !program) return;
    let mesh: Mesh;
    try {
      mesh = this.meshFor(gl, program);
    } catch (error) {
      // Inside MapLibre's frame: a throw here would stop the whole map drawing, so the view gives way to Map instead.
      this.failed = true;
      console.warn("atc: the en-route aircraft failed to draw", error);
      this.onFail();
      return;
    }
    const at = MercatorCoordinate.fromLngLat([pose.longitude, pose.latitude], pose.altitudeM);
    const model = aircraftMatrix(at, at.meterInMercatorCoordinateUnits(), pose, this.lengthM / MODEL_LENGTH[this.model]);
    // The map's projection (doubles) times the model's, multiplied here in doubles, then handed to the GPU.
    const clip = multiply(args.defaultProjectionData.mainMatrix as ArrayLike<number>, model);
    this.drawnAt = { x: clip[12] / clip[15], y: clip[13] / clip[15] };
    // The rotation alone, for the normals: the model matrix's columns without their scale.
    const scale = Math.hypot(model[0], model[1], model[2]);
    const rotation = [model[0], model[1], model[2], model[4], model[5], model[6], model[8], model[9], model[10]].map((v) => v / scale);
    const u = this.uniforms!;
    gl.useProgram(program);
    gl.uniformMatrix4fv(u.matrix, false, new Float32Array(clip));
    gl.uniformMatrix3fv(u.turn, false, new Float32Array(rotation));
    gl.uniform3fv(u.body, this.colours.body);
    gl.uniform3fv(u.paint, this.colours.paint);
    gl.uniform3fv(u.light, LIGHT);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.depthMask(true);
    gl.disable(gl.BLEND);
    gl.disable(gl.CULL_FACE);
    gl.disable(gl.STENCIL_TEST);
    gl.bindVertexArray(mesh.vao);
    gl.drawArrays(gl.TRIANGLES, 0, mesh.count);
    gl.bindVertexArray(null);
    this.drawnFrames++;
  }
}

/** a * b, 4x4 column-major, in doubles. */
function multiply(a: ArrayLike<number>, b: ArrayLike<number>): number[] {
  const out = new Array<number>(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
      out[c * 4 + r] = s;
    }
  }
  return out;
}
