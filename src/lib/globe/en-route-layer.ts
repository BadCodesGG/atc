import { type CustomLayerInterface, type CustomRenderMethodInput, type Map as MapLibreMap, MercatorCoordinate } from "maplibre-gl";
import { type AircraftModel, MODEL_LENGTH } from "../aircraft-class";
import { modelGeometry } from "../scene/aircraft-model";
import { aircraftMatrix, type AircraftPose } from "./en-route";

/**
 * The En-route view's aircraft (docs/adr/0002-en-route-custom-layer.md): the followed flight's procedural
 * class model, the same the Diorama draws, as a MapLibre custom layer in the map's own WebGL context.
 * It draws into the map's framebuffer with the map's depth buffer, so the 3D terrain in front of it hides
 * it. It only draws: the map hands it this frame's pose (sampled once from the shared tracker, with the
 * camera), and it draws the model there.
 */

export const EN_ROUTE_LAYER = "en-route-aircraft";

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
  /** How many frames the layer has drawn the aircraft in: read by the smoke check. */
  drawnFrames = 0;
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

  onAdd(map: MapLibreMap, gl: WebGL2RenderingContext): void {
    this.map = map;
    this.gl = gl;
    const program = gl.createProgram()!;
    const vs = compile(gl, gl.VERTEX_SHADER, VERTEX);
    const fs = compile(gl, gl.FRAGMENT_SHADER, FRAGMENT);
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(`en-route: program failed: ${gl.getProgramInfoLog(program)}`);
    this.program = program;
    const at = (name: string) => gl.getUniformLocation(program, name);
    this.uniforms = { matrix: at("u_matrix"), turn: at("u_turn"), body: at("u_body"), paint: at("u_paint"), light: at("u_light") };
  }

  onRemove(_map: MapLibreMap, gl: WebGL2RenderingContext): void {
    this.dropMesh(gl);
    if (this.program) gl.deleteProgram(this.program);
    this.program = null;
    this.uniforms = null;
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
    const pose = this.pose;
    const program = this.program;
    if (!pose || !program || this.failed || !("createVertexArray" in gl)) return;
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
