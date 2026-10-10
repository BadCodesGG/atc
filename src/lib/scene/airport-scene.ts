import {
  Raycaster,
  AdditiveBlending,
  BackSide,
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  CircleGeometry,
  Color,
  DirectionalLight,
  DoubleSide,
  DynamicDrawUsage,
  Fog,
  HalfFloatType,
  HemisphereLight,
  InstancedBufferAttribute,
  InstancedMesh,
  LineBasicMaterial,
  LineSegments,
  type Material,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshLambertMaterial,
  NoToneMapping,
  Object3D,
  PCFShadowMap,
  PerspectiveCamera,
  PlaneGeometry,
  Points,
  PointsMaterial,
  Quaternion,
  Scene,
  ShaderMaterial,
  SphereGeometry,
  SRGBColorSpace,
  Texture,
  Vector2,
  Vector3,
  WebGLRenderer,
  WebGLRenderTarget,
  CylinderGeometry,
} from "three";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { GTAOPass } from "three/addons/postprocessing/GTAOPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { Pass } from "three/addons/postprocessing/Pass.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { ShaderPass } from "three/addons/postprocessing/ShaderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import type { FlightState } from "../aircraft-state";
import type { AirportMap, Point } from "../airport-map";
import { type AirfieldLight, airfieldLights, type AirfieldLightKind } from "./airfield-lights";
import { type AircraftModel, MODEL_LENGTH } from "../aircraft-class";
import { type JetLightKind, MODELS, modelGeometry, modelLights } from "./aircraft-model";
import { type Area, bandOffsetY, centreOf, fitView, fitViewToArea, NEAR_RUNWAY_M, pixelsPerMetre, placeCamera, runwayClearance, type ViewSpec } from "./camera";
import { drawnScale, fogRange, nearPlane } from "./cameras";
import { ORBIT_FOV, type OrbitBounds, type OrbitView } from "./orbit";
import { extrude, fill, type MeshData, ribbons, runwayMarkings, taxiwayRuns } from "./ground";
import { sceneLabels } from "./labels";
import { type Precipitation, rowColour, type SceneWeather, type SunLight } from "./atmosphere";
import { pathRibbons, type RibbonPath } from "./path-ribbon";
import { type StripStyle, TrailStrips } from "./light-trails";
import { TRAIL_POINTS, type TrailUpdate } from "../timelapse";
import { MODEL, type NightLighting, type SceneTheme } from "./theme";
import { createWindsock, droopFor, poseWindsock, type WindsockPose, windsockPose } from "./windsock";

/** One aircraft as the scene draws it. Map metres, height in metres above the field. */
export interface SceneAircraft {
  id: string;
  x: number;
  y: number;
  heightM: number;
  headingDeg: number;
  state: FlightState;
  /** Which shape it is drawn as. */
  model: AircraftModel;
  /** Size relative to its model's nominal length. */
  size: number;
  /** Metres per second over the ground and up. */
  speedMps: number;
  climbMps: number;
  /** 0 to 1, from the tracker. */
  fade: number;
  /** How far the page's filters have faded it out: 0 (the default) shown, 1 left out. It stays on the scene, as a hint. */
  ghost?: number;
}

/** What an aircraft fully faded out by the filters keeps of its size, and of the lights and trails drawn with it. */
const GHOST_SIZE = 0.7;
/** How far toward the ground's colour a fully faded aircraft is mixed. */
const GHOST_MIX = 0.78;

/** One aircraft's predicted path as the scene draws it: legs of [east, north, height] metres. */
export interface ScenePath {
  id: string;
  state: FlightState;
  legs: RibbonPath["legs"];
}

/**
 * Predicted paths are drawn this many CSS pixels wide whatever the zoom, within these widths in
 * metres; their chevrons this many widths apart.
 */
const PATH_PX = 5;
const PATH_WIDTH = { min: 5, max: 60 } as const;
const PATH_MARK_SPACING = 7;
/**
 * An approach or climb-out is drawn at full strength out to this many times the mapped area's reach
 * (the farthest runway end from its centre) and gone by this many: past the model's edge it would
 * hang over nothing.
 */
const PATH_FADE = { near: 2, far: 6 } as const;

/** A point on screen, CSS pixels from the canvas's top left. */
export interface ScreenPoint {
  x: number;
  y: number;
  visible: boolean;
}

const MAX_AIRCRAFT = 512;
/** Aircraft closer than this to the camera are drawn in the smooth close-range models, up to MAX_NEAR of each kind. */
const NEAR_DETAIL_M = 1000;
const MAX_NEAR = 32;
/** Seconds of travel the trail behind a moving aircraft covers, and its longest length in metres. */
const TRAIL_SECONDS = 8;
const TRAIL_MAX = 420;
/** Airborne aircraft between these heights (metres) get a drop line and a spot on the ground. */
const DROP_MIN_HEIGHT = 8;
const DROP_MAX_HEIGHT = 1500;
/** Vertices the time-lapse's light trails may use: two a point, as many points as the trail feed hands over before it starts again. */
const LIGHT_TRAIL_VERTICES = 2 * TRAIL_POINTS;

/**
 * Light trails are laid down once and never rewritten: the shader moves each vertex out to its side by
 * the half-width (so the trails keep their width in pixels as the view zooms) and fades it by its age
 * against the picture (so they grow old without being touched).
 */
function lightTrailMaterial(material: MeshBasicMaterial, uniforms: Record<string, { value: number }>): MeshBasicMaterial {
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = `attribute vec2 trailSide;
attribute float trailTime;
uniform float trailPicture;
uniform float trailWindow;
uniform float trailHalfWidth;
varying float vTrailFade;
${shader.vertexShader}`.replace(
      "#include <begin_vertex>",
      `#include <begin_vertex>
      transformed.x += trailSide.x * trailHalfWidth;
      transformed.z -= trailSide.y * trailHalfWidth;
      float trailAge = (trailPicture - trailTime) / trailWindow;
      vTrailFade = trailAge < -0.001 ? 0.0 : pow(clamp(1.0 - trailAge, 0.0, 1.0), 1.5);`,
    );
    shader.fragmentShader = `varying float vTrailFade;\n${shader.fragmentShader}`.replace(
      "#include <color_fragment>",
      `#include <color_fragment>
      diffuseColor.a *= vTrailFade;
      if (diffuseColor.a <= 0.002) discard;`,
    );
  };
  return material;
}

/** A mesh drawing a TrailStrips' arrays, which the strips fill in place. */
function stripMesh(strips: TrailStrips, material: MeshBasicMaterial): Mesh {
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new BufferAttribute(strips.positions, 3).setUsage(DynamicDrawUsage));
  geometry.setAttribute("trailSide", new BufferAttribute(strips.sides, 2).setUsage(DynamicDrawUsage));
  geometry.setAttribute("color", new BufferAttribute(strips.colors, 3).setUsage(DynamicDrawUsage));
  geometry.setAttribute("trailTime", new BufferAttribute(strips.times, 1).setUsage(DynamicDrawUsage));
  geometry.setIndex(new BufferAttribute(strips.index, 1).setUsage(DynamicDrawUsage));
  geometry.setDrawRange(0, 0);
  const mesh = new Mesh(geometry, material);
  mesh.frustumCulled = false;
  mesh.visible = false;
  mesh.layers.set(OVERLAY_LAYER);
  return mesh;
}

/** Sends the strips' changes since the last upload to the GPU, and draws all they hold. */
function uploadStrips(strips: TrailStrips, mesh: Mesh): void {
  const { vertexStart, vertexCount, indexStart, indexCount } = strips.takeChanges();
  const geometry = mesh.geometry;
  if (vertexCount > 0) {
    for (const name of ["position", "trailSide", "color", "trailTime"]) {
      const attribute = geometry.getAttribute(name) as BufferAttribute;
      attribute.clearUpdateRanges();
      attribute.addUpdateRange(vertexStart * attribute.itemSize, vertexCount * attribute.itemSize);
      attribute.needsUpdate = true;
    }
  }
  if (indexCount > 0) {
    const index = geometry.getIndex()!;
    index.clearUpdateRanges();
    index.addUpdateRange(indexStart, indexCount);
    index.needsUpdate = true;
  }
  geometry.setDrawRange(0, strips.indices);
}

/** Layer of the see-through overlays (trails, drop lines, ground spots) that ambient occlusion must not see. */
const OVERLAY_LAYER = 1;

/** Switches a camera layer on or off between passes, so a pass in between renders without it. */
class LayerSwitch extends Pass {
  constructor(
    private readonly camera: PerspectiveCamera,
    private readonly layer: number,
    private readonly on: boolean,
  ) {
    super();
    this.needsSwap = false;
  }

  render(): void {
    if (this.on) this.camera.layers.enable(this.layer);
    else this.camera.layers.disable(this.layer);
  }
}

/** Heights of the ground layers, metres: each paints over the one below without z-fighting. */
const LAYER = { apron: 0.4, taxilane: 0.6, taxiway: 0.8, taxiwayLine: 1, runway: 1.2, marking: 1.6, trail: 2, path: 2.4 } as const;

/** The view the model opens on: from the south-south-west, looking north-north-east, high and oblique. */
export const DEFAULT_VIEW: ViewSpec = { azimuthDeg: 30, elevationDeg: 40, fovDeg: ORBIT_FOV };

function geometry(data: MeshData): BufferGeometry {
  const g = new BufferGeometry();
  g.setAttribute("position", new BufferAttribute(data.positions, 3));
  if (data.normals) g.setAttribute("normal", new BufferAttribute(data.normals, 3));
  g.setIndex(new BufferAttribute(data.indices, 1));
  for (const [i, group] of data.groups.entries()) g.addGroup(group.start, group.count, i);
  g.computeBoundingSphere();
  return g;
}

/** A soft round spot, white in the middle fading to clear, for contact shadows under airborne aircraft. */
function spotTexture(): Texture {
  const size = 64;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, "rgba(255,255,255,1)");
  g.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const t = new CanvasTexture(canvas);
  t.colorSpace = SRGBColorSpace;
  return t;
}

/** Separable blur whose strength grows with distance from a horizontal band of focus: a tilt-shift lens. */
const TiltShiftShader = {
  uniforms: {
    tDiffuse: { value: null as Texture | null },
    direction: { value: new Vector2(1, 0) },
    texel: { value: new Vector2(1 / 1024, 1 / 1024) },
    blur: { value: 2 },
    focus: { value: 0.5 },
    band: { value: 0.3 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }`,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform vec2 direction;
    uniform vec2 texel;
    uniform float blur;
    uniform float focus;
    uniform float band;
    varying vec2 vUv;
    void main() {
      float d = abs(vUv.y - focus);
      float amount = blur * smoothstep(band * 0.5, band * 0.5 + 0.35, d);
      vec2 step = direction * texel * amount;
      vec4 sum = texture2D(tDiffuse, vUv) * 0.2270270270;
      sum += texture2D(tDiffuse, vUv + step * 1.3846153846) * 0.3162162162;
      sum += texture2D(tDiffuse, vUv - step * 1.3846153846) * 0.3162162162;
      sum += texture2D(tDiffuse, vUv + step * 3.2307692308) * 0.0702702703;
      sum += texture2D(tDiffuse, vUv - step * 3.2307692308) * 0.0702702703;
      gl_FragColor = sum;
    }`,
};

/** Radius of the sky around the camera at eye level, metres: inside the far plane, past the haze's end. */
const SKY_RADIUS = 40_000;

/**
 * The sky at eye level: a sphere around the camera shading from the horizon's colour (and below it, so
 * the hazed ground meets it without a seam) to the zenith's, faded in with the eye level.
 */
function skyMaterial(horizon: Color, zenith: Color): ShaderMaterial {
  return new ShaderMaterial({
    uniforms: { horizon: { value: horizon }, zenith: { value: zenith }, opacity: { value: 0 } },
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main() {
        vDir = position;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 horizon;
      uniform vec3 zenith;
      uniform float opacity;
      varying vec3 vDir;
      void main() {
        float up = max(0.0, normalize(vDir).y);
        gl_FragColor = vec4(mix(horizon, zenith, pow(up, 0.55)), opacity);
      }`,
    side: BackSide,
    transparent: true,
    depthWrite: false,
    fog: false,
  });
}

/** A colour pushed past 1 so the bloom sees it: linear RGB times `intensity`. */
function hdr(color: string, intensity: number): Color {
  return new Color(color).multiplyScalar(intensity);
}

/** Lights drawn as round points a fixed number of pixels across, adding their colour to what is behind. */
function lightMaterial(texture: Texture): PointsMaterial {
  return new PointsMaterial({ size: 1, sizeAttenuation: false, vertexColors: true, map: texture, transparent: true, depthWrite: false, blending: AdditiveBlending });
}

/**
 * Makes an aircraft emit a share of its own instance colour, so it reads in the dark whatever lights
 * it: the legend's colours survive the night.
 */
function glowInstances(material: MeshLambertMaterial, glow: number): void {
  material.onBeforeCompile = (shader) => {
    shader.uniforms.instanceGlow = { value: glow };
    shader.fragmentShader = `uniform float instanceGlow;\n${shader.fragmentShader}`.replace(
      "#include <emissivemap_fragment>",
      `#include <emissivemap_fragment>
      #ifdef USE_COLOR
        totalEmissiveRadiance += vColor.rgb * instanceGlow;
      #endif`,
    );
  };
}

/**
 * Paints an aircraft as an airliner is: its instance colour on the parts the model marks as painted
 * (its `paint` attribute), the livery's body colour everywhere else.
 */
function paintedInstances(material: MeshLambertMaterial, body: string): void {
  const color = new Color(body);
  material.onBeforeCompile = (shader) => {
    shader.uniforms.liveryBody = { value: color };
    shader.vertexShader = `attribute float paint;
varying float vPaint;
${shader.vertexShader}`.replace(
      "#include <color_vertex>",
      `#include <color_vertex>
      vPaint = paint;`,
    );
    shader.fragmentShader = `uniform vec3 liveryBody;
varying float vPaint;
${shader.fragmentShader}`.replace(
      "#include <color_fragment>",
      `#include <color_fragment>
      #ifdef USE_COLOR
        diffuseColor.rgb = mix(liveryBody, vColor.rgb, vPaint);
      #endif`,
    );
  };
}

/** Most drops or flakes ever in the air at once. */
const MAX_PRECIPITATION = 6000;

/** A thin vertical streak, brightest at its foot: a raindrop as a camera sees it falling. */
function streakTexture(): Texture {
  const size = 32;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  const g = ctx.createLinearGradient(0, 0, 0, size);
  g.addColorStop(0, "rgba(255,255,255,0)");
  g.addColorStop(0.8, "rgba(255,255,255,0.9)");
  g.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = g;
  ctx.fillRect(size / 2 - 1, 0, 2, size);
  const t = new CanvasTexture(canvas);
  t.colorSpace = SRGBColorSpace;
  return t;
}

/**
 * Rain or snow on the GPU: the drops sit still in a unit box, and the vertex shader moves each one
 * down (and downwind) by the time, wrapping it back to the top, so a frame costs one uniform.
 */
function fallingPoints(material: PointsMaterial, uniforms: { time: { value: number }; fall: { value: number }; drift: { value: Vector2 } }): void {
  material.onBeforeCompile = (shader) => {
    shader.uniforms.precipTime = uniforms.time;
    shader.uniforms.precipFall = uniforms.fall;
    shader.uniforms.precipDrift = uniforms.drift;
    shader.vertexShader = `uniform float precipTime;\nuniform float precipFall;\nuniform vec2 precipDrift;\n${shader.vertexShader}`.replace(
      "#include <begin_vertex>",
      `#include <begin_vertex>
      transformed.y = fract(transformed.y - precipTime / precipFall);
      transformed.xz = fract(transformed.xz + precipDrift * precipTime);
      transformed -= 0.5;`,
    );
  };
}

/**
 * Fades an aircraft the filters leave out: its per-instance `ghost` mixes the lit colour toward the
 * ground's, after the lights and any glow, so it recedes whatever paint or night glow it has. Runs last.
 */
function ghostedInstances(material: MeshLambertMaterial, ground: Color): void {
  const before = material.onBeforeCompile;
  material.onBeforeCompile = (shader, renderer) => {
    before.call(material, shader, renderer);
    shader.uniforms.ghostGround = { value: ground };
    shader.vertexShader = `attribute float ghost;
varying float vGhost;
${shader.vertexShader}`.replace(
      "#include <color_vertex>",
      `#include <color_vertex>
      vGhost = ghost;`,
    );
    shader.fragmentShader = `uniform vec3 ghostGround;
varying float vGhost;
${shader.fragmentShader}`.replace(
      "#include <opaque_fragment>",
      `outgoingLight = mix(outgoingLight, ghostGround, vGhost * ${GHOST_MIX.toFixed(2)});
      #include <opaque_fragment>`,
    );
  };
}

/**
 * Adds an emitted share of each aircraft's own (painted) colour, read from `glow` at draw time, so the
 * day themes' aircraft stay legible after sunset. Runs after any other shader change on the material.
 */
function afterDarkGlow(material: MeshLambertMaterial, glow: { value: number }): void {
  const before = material.onBeforeCompile;
  material.onBeforeCompile = (shader, renderer) => {
    before.call(material, shader, renderer);
    shader.uniforms.afterDarkGlow = glow;
    shader.fragmentShader = `uniform float afterDarkGlow;
${shader.fragmentShader}`.replace(
      "#include <emissivemap_fragment>",
      `#include <emissivemap_fragment>
      totalEmissiveRadiance += diffuseColor.rgb * afterDarkGlow;`,
    );
  };
}

/** A hard round dot with a soft rim: an unlit light fixture seen from above. */
function dotTexture(): Texture {
  const size = 32;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, "rgba(255,255,255,1)");
  g.addColorStop(0.6, "rgba(255,255,255,1)");
  g.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const t = new CanvasTexture(canvas);
  t.colorSpace = SRGBColorSpace;
  return t;
}

/**
 * Varies the ground's colour as grass does: a few octaves of value noise in world space, and the
 * field's middle a little lighter than its surroundings. The field's centre (world x, z) and radius
 * are read at draw time, so they can be set once its extent is known.
 */
function grassVariation(material: MeshLambertMaterial, variation: NonNullable<SceneTheme["groundVariation"]>, field: { centre: Vector2; radius: number }): void {
  material.onBeforeCompile = (shader) => {
    shader.uniforms.grassStrength = { value: variation.strength };
    shader.uniforms.grassScale = { value: variation.scale };
    shader.uniforms.grassLift = { value: variation.lift };
    shader.uniforms.grassCentre = { value: field.centre };
    shader.uniforms.grassRadius = { value: field.radius };
    shader.vertexShader = `varying vec2 vGrassPos;\n${shader.vertexShader}`.replace(
      "#include <project_vertex>",
      `#include <project_vertex>
      vGrassPos = (modelMatrix * vec4(transformed, 1.0)).xz;`,
    );
    shader.fragmentShader = `uniform float grassStrength;
      uniform float grassScale;
      uniform float grassLift;
      uniform vec2 grassCentre;
      uniform float grassRadius;
      varying vec2 vGrassPos;
      float grassHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
      float grassNoise(vec2 p) {
        vec2 i = floor(p);
        vec2 f = fract(p);
        vec2 u = f * f * (3.0 - 2.0 * f);
        return mix(mix(grassHash(i), grassHash(i + vec2(1.0, 0.0)), u.x), mix(grassHash(i + vec2(0.0, 1.0)), grassHash(i + vec2(1.0, 1.0)), u.x), u.y);
      }
      ${shader.fragmentShader}`.replace(
      "#include <color_fragment>",
      `#include <color_fragment>
      {
        vec2 p = vGrassPos / grassScale;
        float n = 0.0;
        float a = 0.5;
        for (int k = 0; k < 4; k++) {
          n += a * grassNoise(p);
          p *= 2.03;
          a *= 0.5;
        }
        float r = length(vGrassPos - grassCentre) / grassRadius;
        diffuseColor.rgb *= (1.0 + grassStrength * (n - 0.47) * 2.0) * (1.0 + grassLift * (1.0 - 2.0 * smoothstep(0.0, 1.0, r)));
      }`,
    );
  };
}

/**
 * Lit windows on walls: bands a storey apart, panes along the wall, a share of them lit, chosen by a
 * hash of where they are so the pattern holds still.
 */
function litWindows(material: MeshLambertMaterial, windows: NightLighting["windows"], storey: number): void {
  const color = hdr(windows.color, windows.intensity);
  material.onBeforeCompile = (shader) => {
    shader.uniforms.windowColor = { value: color };
    shader.uniforms.windowLit = { value: windows.lit };
    shader.uniforms.storey = { value: storey };
    shader.vertexShader = `varying vec3 vWinPos;\nvarying vec3 vWinNormal;\n${shader.vertexShader}`.replace(
      "#include <project_vertex>",
      `#include <project_vertex>
      vWinPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
      vWinNormal = normalize((modelMatrix * vec4(objectNormal, 0.0)).xyz);`,
    );
    shader.fragmentShader = `uniform vec3 windowColor;\nuniform float windowLit;\nuniform float storey;\nvarying vec3 vWinPos;\nvarying vec3 vWinNormal;\n${shader.fragmentShader}`.replace(
      "#include <emissivemap_fragment>",
      `#include <emissivemap_fragment>
      {
        float row = vWinPos.y / storey;
        float band = step(0.3, fract(row)) * step(fract(row), 0.62) * step(1.0, row);
        vec2 along = normalize(vec2(-vWinNormal.z, vWinNormal.x) + 1e-5);
        float col = dot(vWinPos.xz, along) / 5.0;
        float pane = step(0.18, fract(col)) * step(fract(col), 0.82);
        vec2 cell = vec2(floor(row), floor(col / 4.0)) + floor(vWinPos.xz / 97.0);
        float lit = step(fract(sin(dot(cell, vec2(12.9898, 78.233))) * 43758.5453), windowLit);
        totalEmissiveRadiance += windowColor * band * pane * lit;
      }`,
    );
  };
}

/**
 * The 3D model of one airport and the traffic on it. It owns its canvas, renderer and every GPU
 * resource, and gives them all back in dispose(). Colours, lights and post effects come from the
 * theme; nothing in here names a colour.
 */
export class AirportScene {
  readonly canvas: HTMLCanvasElement;
  private readonly renderer: WebGLRenderer;
  private readonly scene = new Scene();
  private readonly camera = new PerspectiveCamera(DEFAULT_VIEW.fovDeg, 1, 50, 60_000);
  private readonly composer: EffectComposer;
  /** topColour's read of the frame's top row: the buffer on the GPU, the fence that says it is done, and the last colour read. */
  private readonly top: { buffer: WebGLBuffer | null; fence: WebGLSync | null; row: Uint8Array; colour: string | null } = { buffer: null, fence: null, row: new Uint8Array(0), colour: null };
  private readonly aoPass: GTAOPass | null = null;
  private readonly tiltPasses: ShaderPass[] = [];
  /** One instanced mesh per model of aircraft. */
  private readonly fleet = new Map<AircraftModel, InstancedMesh>();
  /** The same models built smooth and finer, for aircraft within NEAR_DETAIL_M of the camera. */
  private readonly fleetNear = new Map<AircraftModel, InstancedMesh>();
  /** The current view's share of drawing every aircraft at true size (OrbitView.trueSize). */
  private trueSize = 0;
  private readonly spots: InstancedMesh;
  private readonly trails: Mesh;
  private readonly drops: LineSegments;
  /** The time-lapse's light trails as laid down so far, and the stretch from each to its aircraft now. */
  private readonly lightStrips = new TrailStrips(LIGHT_TRAIL_VERTICES);
  private readonly headStrips = new TrailStrips(MAX_AIRCRAFT * 16);
  private readonly lightTrails: Mesh;
  private readonly lightHeads: Mesh;
  private readonly lightUniforms = { trailPicture: { value: 0 }, trailWindow: { value: 1 }, trailHalfWidth: { value: 1 } };
  /** Night only: each aircraft's nav lights, beacon and strobes, and the colours they take. */
  private readonly navLights: Points | null = null;
  private readonly navColors: Record<JetLightKind, Color> | null = null;
  /** Point materials and their size in CSS pixels, rescaled with the pixel ratio. */
  private readonly pointMaterials: { material: PointsMaterial; size: number }[] = [];
  private readonly textures: Texture[] = [];
  private readonly stateColors: Record<FlightState, Color>;
  private readonly trailColors: Record<FlightState, Color>;
  private readonly framePoints: Point[];
  /** Where the whole field is framed on a wide screen: the runway designators and the passenger terminals. */
  private readonly fieldPoints: Point[];
  /** The painted taxiway centrelines, hidden when they would be thinner than a pixel or two on screen. */
  private readonly taxiwayLines: Mesh;
  /** The predicted paths: what was asked for, and the strip width (metres) their mesh was built at. */
  private readonly pathMesh: Mesh;
  private pathInput: { paths: ScenePath[]; selected: string | null } = { paths: [], selected: null };
  private pathWidth = 0;
  /** The towers, which stand up off the ground with the buildings as setRise raises them, but are never squashed. */
  private readonly towers: Object3D[] = [];
  /** How far everything stands up (setRise), and the buildings' share of their drawn height at this camera (true height close up). */
  private rise = 1;
  private closeHeight = 1;
  private width = 1;
  private height = 1;
  /** The framed view for the current shape of the frame, and where the reader has moved to from it (null: still home). */
  private home: OrbitView = { azimuthDeg: DEFAULT_VIEW.azimuthDeg, elevationDeg: DEFAULT_VIEW.elevationDeg, target: [0, 0], height: 0, distance: 1 };
  private view: OrbitView | null = null;
  /** The view offset (CSS pixels) the fit chose, and the one an eye-level view uses: null when there is none. */
  private offsets: { orbit: { x: number; y: number } | null; eye: { x: number; y: number } | null } = { orbit: null, eye: null };
  /** How far from the field's centre the view may slide: past the farthest runway end. */
  private readonly reach: number;
  /**
   * The buildings and their roof outlines, drawn MODEL.heightScale times their height from above and
   * squashed back toward true height in a close camera mode, where the exaggeration reads as a toy.
   */
  private readonly raised: Object3D[] = [];
  /** The sky shown at eye level, and the fog's colours from above (the page's) and at eye level (the horizon's). */
  private readonly sky: { dome: Mesh; material: ShaderMaterial; background: Color; horizon: Color };
  /** The ground plane's material, and its colour from above and at eye level (the theme's eyeLevel.ground). */
  private readonly groundTint: { material: MeshLambertMaterial; above: Color; eye: Color };
  private readonly raycaster = new Raycaster();
  /** The key light and fill, which the real sun moves and recolours (setSun). */
  private readonly sunLight: DirectionalLight;
  private readonly fill: HemisphereLight;
  /** The point the sun shines at and how far back it stands: the field's middle. */
  private readonly sunAnchor: { x: number; y: number; far: number };
  /** The fog in force: the theme's, or the weather's (setWeather). */
  private fogSpec: SceneTheme["fog"];
  /** The close views' haze as a share of the clear air's (setWeather). */
  private haze = 1;
  /** How far out the orbit's haze is pushed (setFogReach): 1 is the theme's own. */
  private fogReach = 1;
  /** Rain or snow, drawn around the view, and the drift and fall its shader reads. */
  private readonly precipitation: Points;
  private readonly precipitationUniforms = { time: { value: 0 }, fall: { value: 1 }, drift: { value: new Vector2() } };
  private precipitationSize = 0;
  private readonly precipitationTextures: Record<Precipitation["kind"], Texture>;
  /** CSS pixels to drawing-buffer pixels for the round point lights, from the last resize. */
  private pointScale = 1;
  /** Each windsock's hinge, and the pose the wind gives them all. */
  private readonly windsocks: Object3D[] = [];
  private windsock: WindsockPose = windsockPose(null);
  /** Share of their own colour the aircraft emit after sunset in the day themes (setSun). */
  private readonly aircraftGlow = { value: 0 };
  private readonly tmp = { m: new Matrix4(), q: new Quaternion(), p: new Vector3(), s: new Vector3(), up: new Vector3(0, 1, 0), v: new Vector3(), o: new Object3D() };

  constructor(
    container: HTMLElement,
    map: AirportMap,
    private readonly theme: SceneTheme,
  ) {
    this.canvas = document.createElement("canvas");
    this.canvas.style.display = "block";
    this.canvas.style.width = "100%";
    this.canvas.style.height = "100%";
    container.appendChild(this.canvas);

    const renderer = new WebGLRenderer({ canvas: this.canvas, antialias: false, powerPreference: "high-performance" });
    renderer.outputColorSpace = SRGBColorSpace;
    renderer.toneMapping = NoToneMapping;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = PCFShadowMap;
    this.renderer = renderer;

    const scene = this.scene;
    scene.background = new Color(theme.background);
    if (theme.fog) scene.fog = new Fog(theme.background);
    {
      const horizon = new Color(theme.eyeLevel.horizon);
      const material = skyMaterial(horizon, new Color(theme.eyeLevel.zenith));
      const dome = new Mesh(new SphereGeometry(SKY_RADIUS, 32, 16), material);
      dome.visible = false;
      dome.frustumCulled = false;
      // An overlay, so ambient occlusion never sees it as a wall.
      dome.layers.set(OVERLAY_LAYER);
      scene.add(dome);
      this.sky = { dome, material, background: new Color(theme.background), horizon };
    }

    this.stateColors = {
      arriving: new Color(theme.aircraft.arriving),
      departing: new Color(theme.aircraft.departing),
      taxiing: new Color(theme.aircraft.taxiing),
      parked: new Color(theme.aircraft.parked),
    };

    // Lights.
    const { lights } = theme;
    this.fogSpec = theme.fog;
    this.fill = new HemisphereLight(lights.sky, lights.groundBounce, lights.hemisphere);
    scene.add(this.fill);
    const sun = new DirectionalLight(lights.sun.color, lights.sun.intensity);
    this.sunLight = sun;
    sun.castShadow = true;
    sun.shadow.mapSize.set(lights.shadowMapSize, lights.shadowMapSize);
    sun.shadow.radius = lights.shadowRadius;
    sun.shadow.bias = -0.0004;
    sun.shadow.normalBias = 1.5;
    scene.add(sun, sun.target);

    // Ground: the paper, then the paved layers, then paint.
    const lambert = (color: string) => new MeshLambertMaterial({ color });
    const flat = (data: MeshData, color: string) => {
      const mesh = new Mesh(geometry(data), lambert(color));
      mesh.receiveShadow = true;
      scene.add(mesh);
      return mesh;
    };
    const groundMaterial = lambert(theme.surfaces.ground);
    this.groundTint = { material: groundMaterial, above: groundMaterial.color.clone(), eye: theme.eyeLevel.ground ? lambert(theme.eyeLevel.ground).color : groundMaterial.color.clone() };
    const paper = new Mesh(new PlaneGeometry(80_000, 80_000).rotateX(-Math.PI / 2), groundMaterial);
    paper.receiveShadow = true;
    scene.add(paper);
    flat(
      fill(
        map.aprons.map((a) => a.rings),
        LAYER.apron,
      ),
      theme.surfaces.apron,
    );
    // The taxiways proper at full strength, with a painted centreline; the lanes between stands thinner
    // and nearer the apron, so the network reads as its main routes. Every mapped line is still drawn.
    const runs = taxiwayRuns(map);
    const major = runs.filter((r) => !r.minor);
    flat(ribbons(runs.filter((r) => r.minor), { height: LAYER.taxilane, caps: "round", widthScale: MODEL.taxilaneWidthScale }), theme.surfaces.taxilane);
    flat(ribbons(major, { height: LAYER.taxiway, caps: "round", widthScale: MODEL.taxiwayWidthScale }), theme.surfaces.taxiway);
    this.taxiwayLines = flat(ribbons(major.map((r) => ({ line: r.line, width: MODEL.taxiwayLineWidth })), { height: LAYER.taxiwayLine, caps: "round" }), theme.surfaces.taxiwayLine);
    flat(
      ribbons(
        map.runways.map((r) => ({ line: r.ends.length >= 2 ? r.ends.map((e): Point => [e.x, e.y]) : r.centerline, width: r.width })),
        { height: LAYER.runway, caps: "butt" },
      ),
      theme.surfaces.runway,
    );
    flat(runwayMarkings(map.runways, { height: LAYER.marking, dash: 30, gap: 30, lineWidth: 4, thresholdLength: 45 }), theme.surfaces.marking);

    // Buildings: terminals, concourses and every other mapped building, raised as white blocks. By
    // night the terminals are a block of their own, with lit windows.
    const night = theme.night;
    for (const footprints of night ? [map.terminals, map.buildings] : [[...map.terminals, ...map.buildings]]) {
      const wall = lambert(theme.surfaces.wall);
      if (night && footprints === map.terminals) litWindows(wall, night.windows, 4 * MODEL.heightScale);
      const buildings = new Mesh(geometry(extrude(footprints, MODEL.heightScale)), [lambert(theme.surfaces.roof), wall]);
      buildings.castShadow = buildings.receiveShadow = true;
      scene.add(buildings);
      this.raised.push(buildings);
    }
    {
      // Roof outlines, as the mocks draw the buildings.
      const edges: number[] = [];
      for (const { rings, height } of [...map.terminals, ...map.buildings]) {
        const h = height * MODEL.heightScale + 0.3;
        for (const ring of rings) {
          for (let i = 0; i < ring.length; i++) {
            const [ax, ay] = ring[i];
            const [bx, by] = ring[(i + 1) % ring.length];
            edges.push(ax, h, -ay, bx, h, -by);
          }
        }
      }
      const outline = new BufferGeometry();
      outline.setAttribute("position", new BufferAttribute(new Float32Array(edges), 3));
      const roofEdges = new LineSegments(outline, new LineBasicMaterial({ color: theme.surfaces.roofEdge }));
      scene.add(roofEdges);
      this.raised.push(roofEdges);
    }
    for (const tower of map.towers) {
      const shaft = new Mesh(new CylinderGeometry(4, 6, tower.height, 12).translate(0, tower.height / 2, 0), lambert(theme.surfaces.roof));
      const cab = new Mesh(new CylinderGeometry(11, 8, 10, 12).translate(0, tower.height + 5, 0), lambert(theme.surfaces.roof));
      for (const part of [shaft, cab]) {
        part.position.set(tower.x, 0, -tower.y);
        part.castShadow = part.receiveShadow = true;
        scene.add(part);
        this.towers.push(part);
      }
    }

    // Windsocks, where the map has them, hanging limp until the weather comes in.
    for (const [x, y] of map.windsocks) {
      const { group, sock } = createWindsock(theme.surfaces.roof, night !== null);
      group.position.set(x, 0, -y);
      scene.add(group);
      this.windsocks.push(sock);
    }
    this.poseWindsocks(0);

    const spot = spotTexture();
    this.textures.push(spot);

    // Rain or snow: drops scattered once through a unit box that follows the view; none until reported.
    {
      const streak = streakTexture();
      this.textures.push(streak);
      this.precipitationTextures = { rain: streak, snow: spot };
      const positions = new Float32Array(MAX_PRECIPITATION * 3);
      // A fixed sequence, so the rain falls the same way on every load.
      let seed = 1;
      for (let i = 0; i < positions.length; i++) {
        seed = (seed * 16807) % 2147483647;
        positions[i] = seed / 2147483647;
      }
      const g = new BufferGeometry();
      g.setAttribute("position", new BufferAttribute(positions, 3));
      g.setDrawRange(0, 0);
      const material = new PointsMaterial({ size: 1, sizeAttenuation: false, map: streak, transparent: true, depthWrite: false });
      fallingPoints(material, this.precipitationUniforms);
      this.precipitation = new Points(g, material);
      this.precipitation.frustumCulled = false;
      this.precipitation.visible = false;
      this.precipitation.layers.set(OVERLAY_LAYER);
      scene.add(this.precipitation);
    }

    // Airfield lights, from the runway and taxiway geometry and the mapped approach lights: the same
    // fixtures in every theme, glowing by night and drawn unlit by day.
    const fixtures = airfieldLights(map);
    if (night) {
      const a = night.airfield;
      const palette: Record<AirfieldLightKind, Color> = {
        runwayEdge: hdr(a.runwayEdge, a.intensity),
        runwayCaution: hdr(a.runwayCaution, a.intensity),
        runwayCentre: hdr(a.runwayCentre, a.intensity * 0.7),
        threshold: hdr(a.threshold, a.barIntensity),
        runwayEnd: hdr(a.runwayEnd, a.barIntensity),
        taxiwayCentre: hdr(a.taxiwayCentre, a.taxiwayIntensity),
        approach: hdr(a.approach, a.approachIntensity),
        papiRed: hdr(a.papiRed, a.intensity),
        papiWhite: hdr(a.papiWhite, a.intensity),
      };
      const sizeOf = (kind: AirfieldLightKind) =>
        kind === "taxiwayCentre" ? a.taxiwaySize : kind === "approach" ? a.approachSize : kind === "threshold" || kind === "runwayEnd" ? a.barSize : a.size;
      // One group per size, each light adding its colour to what is behind it.
      for (const size of new Set(fixtures.map((l) => sizeOf(l.kind)))) {
        this.addFixtures(
          fixtures.filter((l) => sizeOf(l.kind) === size),
          (l) => palette[l.kind],
          lightMaterial(spot),
          size,
        );
      }
    } else {
      const dot = dotTexture();
      this.textures.push(dot);
      const color = new Color(theme.fixtures.color);
      this.addFixtures(
        fixtures,
        () => color,
        new PointsMaterial({ size: 1, sizeAttenuation: false, vertexColors: true, map: dot, transparent: true, depthWrite: false }),
        theme.fixtures.size,
      );
    }

    if (night) {
      // A pool of floodlight around every stand.
      const f = night.floodlight;
      const pools = new InstancedMesh(
        new CircleGeometry(1, 24).rotateX(-Math.PI / 2),
        new MeshBasicMaterial({ color: f.color, map: spot, transparent: true, opacity: f.opacity, depthWrite: false, blending: AdditiveBlending }),
        Math.max(1, map.stands.length),
      );
      pools.count = map.stands.length;
      const o = new Object3D();
      map.stands.forEach((stand, i) => {
        o.position.set(stand.x, LAYER.trail - 0.5, -stand.y);
        o.scale.setScalar(f.radius);
        o.updateMatrix();
        pools.setMatrixAt(i, o.matrix);
      });
      pools.layers.set(OVERLAY_LAYER);
      scene.add(pools);

      // Each aircraft's own lights, filled in every frame.
      const n = MAX_AIRCRAFT * Math.max(...MODELS.map((model) => modelLights(model).length));
      const navGeometry = new BufferGeometry();
      navGeometry.setAttribute("position", new BufferAttribute(new Float32Array(n * 3), 3).setUsage(DynamicDrawUsage));
      navGeometry.setAttribute("color", new BufferAttribute(new Float32Array(n * 3), 3).setUsage(DynamicDrawUsage));
      navGeometry.setDrawRange(0, 0);
      const navMaterial = lightMaterial(spot);
      navMaterial.fog = false;
      this.pointMaterials.push({ material: navMaterial, size: night.aircraft.size });
      this.navLights = new Points(navGeometry, navMaterial);
      this.navLights.frustumCulled = false;
      this.navLights.layers.set(OVERLAY_LAYER);
      scene.add(this.navLights);
      const na = night.aircraft;
      this.navColors = {
        port: hdr(na.port, na.intensity),
        starboard: hdr(na.starboard, na.intensity),
        tail: hdr(na.tail, na.intensity * 0.6),
        beacon: hdr(na.beacon, na.intensity),
        strobe: hdr(na.strobe, na.intensity * 1.4),
      };
    }

    // Traffic.
    this.trailColors = {
      arriving: new Color(theme.trail.arriving),
      departing: new Color(theme.trail.departing),
      taxiing: new Color(theme.trail.taxiing),
      parked: new Color(theme.trail.parked),
    };
    // The fleet in flat-faceted low poly; the few aircraft near the camera in the smooth close-range models.
    // The traffic is the data: fog never fades it (fog: false here and on the trails, spots and drop lines).
    for (const [detail, fleet, capacity] of [
      ["far", this.fleet, MAX_AIRCRAFT],
      ["near", this.fleetNear, MAX_NEAR],
    ] as const) {
      const jetMaterial = new MeshLambertMaterial({ flatShading: detail === "far", fog: false });
      if (night) glowInstances(jetMaterial, night.aircraft.glow);
      if (theme.livery) paintedInstances(jetMaterial, theme.livery.body);
      if (!night) afterDarkGlow(jetMaterial, this.aircraftGlow);
      // The scene's own background colour, which the weather changes in place, so a faded aircraft follows the hour.
      ghostedInstances(jetMaterial, scene.background as Color);
      for (const model of MODELS) {
        const geometry = modelGeometry(model, detail);
        geometry.setAttribute("ghost", new InstancedBufferAttribute(new Float32Array(capacity), 1).setUsage(DynamicDrawUsage));
        const mesh = new InstancedMesh(geometry, jetMaterial, capacity);
        mesh.instanceMatrix.setUsage(DynamicDrawUsage);
        mesh.castShadow = true;
        mesh.count = 0;
        mesh.frustumCulled = false;
        fleet.set(model, mesh);
        scene.add(mesh);
      }
    }

    this.spots = new InstancedMesh(
      new CircleGeometry(1, 20).rotateX(-Math.PI / 2),
      new MeshBasicMaterial({ color: theme.dropLine, map: spot, transparent: true, opacity: 0.45, depthWrite: false, fog: false }),
      MAX_AIRCRAFT,
    );
    this.spots.count = 0;
    this.spots.frustumCulled = false;
    this.spots.layers.set(OVERLAY_LAYER);
    scene.add(this.spots);

    const trailGeometry = new BufferGeometry();
    trailGeometry.setAttribute("position", new BufferAttribute(new Float32Array(MAX_AIRCRAFT * 4 * 3), 3).setUsage(DynamicDrawUsage));
    trailGeometry.setAttribute("color", new BufferAttribute(new Float32Array(MAX_AIRCRAFT * 4 * 4), 4).setUsage(DynamicDrawUsage));
    const trailIndex = new Uint32Array(MAX_AIRCRAFT * 6);
    for (let i = 0; i < MAX_AIRCRAFT; i++) trailIndex.set([4 * i, 4 * i + 1, 4 * i + 2, 4 * i, 4 * i + 2, 4 * i + 3], 6 * i);
    trailGeometry.setIndex(new BufferAttribute(trailIndex, 1));
    trailGeometry.setDrawRange(0, 0);
    this.trails = new Mesh(trailGeometry, new MeshBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, side: DoubleSide, fog: false }));
    this.trails.frustumCulled = false;
    this.trails.layers.set(OVERLAY_LAYER);
    scene.add(this.trails);

    const dropGeometry = new BufferGeometry();
    dropGeometry.setAttribute("position", new BufferAttribute(new Float32Array(MAX_AIRCRAFT * 2 * 3), 3).setUsage(DynamicDrawUsage));
    dropGeometry.setDrawRange(0, 0);
    this.drops = new LineSegments(dropGeometry, new LineBasicMaterial({ color: theme.dropLine, transparent: true, opacity: 0.6, fog: false }));
    this.drops.frustumCulled = false;
    this.drops.layers.set(OVERLAY_LAYER);
    scene.add(this.drops);

    // Predicted paths: built in setPaths, see-through like the trails, over the paint and under the aircraft.
    this.pathMesh = new Mesh(new BufferGeometry(), new MeshBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, side: DoubleSide }));
    this.pathMesh.frustumCulled = false;
    this.pathMesh.layers.set(OVERLAY_LAYER);
    scene.add(this.pathMesh);
    // The time-lapse's light trails: empty until a time-lapse asks for them. At night they add light, as
    // the airfield's lights do, so the bloom gives them a glow; by day they paint over the ground.
    const trailMaterial = lightTrailMaterial(
      new MeshBasicMaterial({
        vertexColors: true,
        transparent: true,
        opacity: theme.lightTrails.opacity,
        depthWrite: false,
        side: DoubleSide,
        ...(theme.lightTrails.glow ? { blending: AdditiveBlending } : {}),
      }),
      this.lightUniforms,
    );
    this.lightTrails = stripMesh(this.lightStrips, trailMaterial);
    this.lightHeads = stripMesh(this.headStrips, trailMaterial);
    scene.add(this.lightTrails, this.lightHeads);
    this.camera.layers.enable(OVERLAY_LAYER);

    // What the camera frames, and where the sun's shadow camera has to cover.
    const pts: Point[] = [];
    for (const a of map.aprons) pts.push(...a.rings[0]);
    for (const t of map.terminals) pts.push(...t.rings[0]);
    // The view centres on the passenger terminals and concourses, where the traffic is.
    const passenger = map.terminals.filter((t) => /concourse|terminal/i.test(t.name ?? "")).flatMap((t) => t.rings[0]);
    this.framePoints = passenger.length ? passenger : pts;
    // The wide view frames the terminals and the runways that bound them. A runway well clear of the
    // terminals (ATL's 10/28, 1.9 km south; PIT's 14/32) would shrink the whole airport to fit it,
    // so it is left to run off the edge of the frame.
    const near = new Set(map.runways.filter((r) => runwayClearance(r, this.framePoints) <= NEAR_RUNWAY_M).flatMap((r) => r.ends));
    const nearEnd = (x: number, y: number) => [...near].some((e) => Math.hypot(e.x - x, e.y - y) < 400);
    this.fieldPoints = [
      ...sceneLabels(map, MODEL.heightScale).filter((l) => l.kind === "runway" && nearEnd(l.x, l.y)).map((l): Point => [l.x, l.y]),
      ...this.framePoints,
    ];
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const r of map.runways) {
      for (const e of r.ends) {
        minX = Math.min(minX, e.x);
        maxX = Math.max(maxX, e.x);
        minY = Math.min(minY, e.y);
        maxY = Math.max(maxY, e.y);
      }
    }
    for (const [x, y] of pts) {
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    }
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    const half = Math.max(maxX - minX, maxY - minY) / 2 + 300;
    const centre = centreOf(this.fieldPoints);
    this.reach = Math.max(1500, ...map.runways.flatMap((r) => r.ends.map((e) => Math.hypot(e.x - centre[0], e.y - centre[1]))));
    if (theme.groundVariation) grassVariation(groundMaterial, theme.groundVariation, { centre: new Vector2(cx, -cy), radius: half * 1.6 });
    const far = 6_000;
    this.sunAnchor = { x: cx, y: cy, far };
    this.placeSun(lights.sun.azimuthDeg, lights.sun.elevationDeg);
    sun.target.position.set(cx, 0, -cy);
    Object.assign(sun.shadow.camera, { left: -half, right: half, top: half, bottom: -half, near: 100, far: far * 2 });
    sun.shadow.camera.updateProjectionMatrix();

    // Post: render with MSAA, occlusion, tilt-shift, then the sRGB output transform.
    const target = new WebGLRenderTarget(1, 1, { type: HalfFloatType, samples: 4 });
    this.composer = new EffectComposer(renderer, target);
    this.composer.addPass(new RenderPass(scene, this.camera));
    if (theme.ambientOcclusion) {
      const ao = theme.ambientOcclusion;
      const pass = new GTAOPass(scene, this.camera, 1, 1);
      pass.updateGtaoMaterial({ radius: ao.radius, distanceExponent: ao.distanceExponent, thickness: ao.thickness, scale: ao.scale, samples: 16 });
      pass.blendIntensity = ao.blend;
      this.composer.addPass(new LayerSwitch(this.camera, OVERLAY_LAYER, false));
      this.composer.addPass(pass);
      this.composer.addPass(new LayerSwitch(this.camera, OVERLAY_LAYER, true));
      this.aoPass = pass;
    }
    if (night) {
      const { strength, radius, threshold } = night.bloom;
      this.composer.addPass(new UnrealBloomPass(new Vector2(1, 1), strength, radius, threshold));
    }
    if (theme.tiltShift) {
      for (const direction of [new Vector2(1, 0), new Vector2(0, 1)]) {
        const pass = new ShaderPass(TiltShiftShader);
        pass.uniforms.direction.value = direction;
        pass.uniforms.blur.value = theme.tiltShift.blur;
        pass.uniforms.focus.value = theme.tiltShift.focus;
        pass.uniforms.band.value = theme.tiltShift.band;
        this.composer.addPass(pass);
        this.tiltPasses.push(pass);
      }
    }
    this.composer.addPass(new OutputPass());
  }

  /** Adds airfield light fixtures as one group of round points, `size` CSS pixels across. */
  private addFixtures(lights: AirfieldLight[], colorOf: (light: AirfieldLight) => Color, material: PointsMaterial, size: number): void {
    const positions = new Float32Array(lights.length * 3);
    const colors = new Float32Array(lights.length * 3);
    lights.forEach((l, i) => {
      positions.set([l.x, LAYER.trail + 0.5, -l.y], 3 * i);
      const c = colorOf(l);
      colors.set([c.r, c.g, c.b], 3 * i);
    });
    const g = new BufferGeometry();
    g.setAttribute("position", new BufferAttribute(positions, 3));
    g.setAttribute("color", new BufferAttribute(colors, 3));
    this.pointMaterials.push({ material, size });
    const points = new Points(g, material);
    points.layers.set(OVERLAY_LAYER);
    this.scene.add(points);
  }

  /**
   * Sizes the drawing buffer to the container and re-frames the model for the new shape. On a wide
   * screen the whole field is fitted into `area` (CSS pixels from the frame's top left: what the
   * interface leaves free, default the whole frame); a phone shows the concourses, centred in the band
   * `area` leaves between its controls and the flight card (setFreeArea). The framing depends on the
   * shape and the area only, never on the theme.
   */
  resize(width: number, height: number, pixelRatio: number, area?: Area): void {
    this.width = Math.max(1, width);
    this.height = Math.max(1, height);
    const ratio = Math.min(pixelRatio, 2);
    this.renderer.setPixelRatio(ratio);
    this.renderer.setSize(this.width, this.height, false);
    this.composer.setPixelRatio(ratio);
    this.composer.setSize(this.width, this.height);
    for (const pass of this.tiltPasses) pass.uniforms.texel.value.set(1 / (this.width * ratio), 1 / (this.height * ratio));
    // Lights shrink a little on a small screen, where the whole field is drawn smaller.
    const lightScale = Math.min(1, Math.max(0.65, this.width / 1200));
    this.pointScale = ratio * lightScale;
    for (const { material, size } of this.pointMaterials) material.size = size * this.pointScale;
    (this.precipitation.material as PointsMaterial).size = this.precipitationSize * this.pointScale;
    this.camera.aspect = this.width / this.height;
    this.camera.clearViewOffset();
    const portrait = this.width < this.height;
    let distance: number;
    let framed: Point[];
    if (portrait) {
      framed = this.framePoints;
      distance = fitView(this.camera, DEFAULT_VIEW, framed, { zoom: 0.95 });
    } else {
      framed = this.fieldPoints;
      distance = fitViewToArea(this.camera, DEFAULT_VIEW, framed, area ?? { left: 0, top: 0, right: this.width, bottom: this.height }, { width: this.width, height: this.height });
    }
    // The view offset stays as the fit set it, so a moved view keeps its target centred in the free area.
    // At eye level it centres what the camera looks at in the free area instead: the fit's offset
    // centres the field's footprint, which says nothing about where the horizon falls.
    const view = this.camera.view;
    this.offsets.orbit = view?.enabled ? { x: view.offsetX, y: view.offsetY } : null;
    const free = area ?? { left: 0, top: 0, right: this.width, bottom: this.height };
    this.offsets.eye = this.offsets.orbit && !portrait ? { x: this.width / 2 - (free.left + free.right) / 2, y: this.height / 2 - (free.top + free.bottom) / 2 } : this.offsets.orbit;
    this.home = { azimuthDeg: DEFAULT_VIEW.azimuthDeg, elevationDeg: DEFAULT_VIEW.elevationDeg, target: centreOf(framed), height: 0, distance };
    if (portrait) this.setFreeArea(free);
    else this.applyView(this.view ?? this.home);
  }

  /**
   * On a portrait frame, where the controls stand in rows above the model and the flight card below it:
   * what they leave free, so what the camera looks at (the framed field, a followed aircraft) is drawn
   * in the middle of that band rather than of the whole frame, behind the rows. The page measures the
   * band as the chrome changes (a card opening, the tabs folding) and calls this again; it moves the
   * picture without refitting it. A landscape frame is framed into its area by `resize`.
   */
  setFreeArea(area: Area): void {
    if (this.width >= this.height) return;
    const offset = { x: 0, y: bandOffsetY(this.height, area) };
    this.offsets = { orbit: offset, eye: offset };
    this.applyView(this.view ?? this.home);
  }

  /** The framed view, for the frame's current shape. */
  get homeView(): OrbitView {
    return this.home;
  }

  /** Where the camera is now. */
  get currentView(): OrbitView {
    return this.view ?? this.home;
  }

  /** How far a reader may move the view: in to an aircraft's length or so, out a little past the framed field. */
  get bounds(): OrbitBounds {
    return { minDistance: 250, maxDistance: this.home.distance * 1.8, radius: this.reach, home: this.home.target };
  }

  /**
   * Pushes the orbit's haze out `reach` times (1, the theme's own), from the next view on: a view that
   * frames a field beyond the point it looks at (a journey's climb-out and approach) needs it farther.
   */
  setFogReach(reach: number): void {
    this.fogReach = Math.max(1, reach);
  }

  /** Moves the camera to `view`, or back to the framed view with null. The theme never calls this. */
  setView(view: OrbitView | null): void {
    this.view = view;
    this.applyView(view ?? this.home);
  }

  private applyView(view: OrbitView): void {
    const spec: ViewSpec = { azimuthDeg: view.azimuthDeg, elevationDeg: view.elevationDeg, fovDeg: view.fovDeg ?? DEFAULT_VIEW.fovDeg };
    // A close camera mode needs the near plane in close, set before placeCamera updates the projection.
    this.camera.near = nearPlane(view);
    const level = view.eyeLevel ?? 0;
    this.trueSize = view.trueSize ?? 0;
    const { orbit, eye } = this.offsets;
    if (orbit && eye) {
      this.camera.setViewOffset(this.width, this.height, orbit.x + (eye.x - orbit.x) * level, orbit.y + (eye.y - orbit.y) * level, this.width, this.height);
    }
    placeCamera(this.camera, spec, view.target, view.distance, view.height);
    // Fog thins with the camera's distance, so a close view is as clear as the framed one; the weather
    // brings it in (setWeather). In a close camera mode it becomes the theme's haze, in metres, in the
    // sky's colour at the horizon.
    if (this.scene.fog instanceof Fog && this.fogSpec) {
      const range = fogRange(view, { near: this.fogSpec.near * this.fogReach, far: this.fogSpec.far * this.fogReach }, this.theme.eyeLevel.fog, this.haze);
      this.scene.fog.near = range.near;
      this.scene.fog.far = range.far;
      this.scene.fog.color.lerpColors(this.sky.background, this.sky.horizon, level);
    }
    this.groundTint.material.color.lerpColors(this.groundTint.above, this.groundTint.eye, level);
    this.sky.dome.visible = level > 0;
    this.sky.dome.position.copy(this.camera.position);
    this.sky.material.uniforms.opacity.value = level;
    // The tilt-shift lens is what makes the model read as a miniature from above; close up it goes, and
    // the buildings come down to their true height.
    for (const pass of this.tiltPasses) {
      pass.uniforms.blur.value = (this.theme.tiltShift?.blur ?? 0) * (1 - level);
      pass.enabled = level < 0.99;
    }
    const height = MODEL.heightScale + (1 - MODEL.heightScale) * level;
    this.closeHeight = height / MODEL.heightScale;
    this.applyHeights();
    // Rain and snow fill a box around what the camera looks at, sized to the view, so they read the same at every zoom.
    this.precipitation.position.set(view.target[0], view.distance * 0.25, -view.target[1]);
    this.precipitation.scale.set(view.distance * 1.4, view.distance * 0.5, view.distance * 1.4);
    this.taxiwayLines.visible = MODEL.taxiwayLineWidth * pixelsPerMetre(spec, view.distance, this.height) >= MODEL.taxiwayLineMinPx;
    // The paths keep their width on screen: rebuilt when the zoom has changed it by a sixth or more.
    const pathWidth = Math.min(PATH_WIDTH.max, Math.max(PATH_WIDTH.min, PATH_PX / pixelsPerMetre(spec, view.distance, this.height)));
    if (Math.abs(pathWidth - this.pathWidth) > this.pathWidth / 6) {
      this.pathWidth = pathWidth;
      this.buildPaths();
    }
  }

  /**
   * Draws each aircraft's predicted path as a strip in its state's colour with chevrons pointing the
   * way it will go; the selected flight's stronger than the rest. Pass the same array again to leave
   * them as they are: the mesh is rebuilt only when the paths, the selection or the zoom change.
   */
  setPaths(paths: ScenePath[], selected: string | null = null): void {
    if (paths === this.pathInput.paths && selected === this.pathInput.selected) return;
    this.pathInput = { paths, selected };
    this.buildPaths();
  }

  private buildPaths(): void {
    const { paths, selected } = this.pathInput;
    const width = this.pathWidth || PATH_WIDTH.min;
    const mesh = pathRibbons(
      paths.map((p) => ({ state: p.state, emphasis: p.id === selected, legs: p.legs })),
      {
        width,
        lift: LAYER.path,
        markSpacing: width * PATH_MARK_SPACING,
        colorOf: (state) => this.trailColors[state].toArray() as [number, number, number],
        fade: { near: this.reach * PATH_FADE.near, far: this.reach * PATH_FADE.far },
      },
    );
    const g = this.pathMesh.geometry;
    g.setAttribute("position", new BufferAttribute(mesh.positions, 3));
    g.setAttribute("color", new BufferAttribute(mesh.colors, 4));
    g.setIndex(new BufferAttribute(mesh.indices, 1));
    g.computeBoundingSphere();
  }

  /** The ground point under a screen point (CSS pixels from the frame's top left), or null above the horizon. */
  groundAt(x: number, y: number): Point | null {
    const ndc = new Vector2((x / this.width) * 2 - 1, 1 - (y / this.height) * 2);
    this.raycaster.setFromCamera(ndc, this.camera);
    const { origin, direction } = this.raycaster.ray;
    if (direction.y > -1e-3) return null;
    const t = -origin.y / direction.y;
    return [origin.x + direction.x * t, -(origin.z + direction.z * t)];
  }

  /** Metres from the camera to an aircraft. */
  private distanceTo(a: SceneAircraft): number {
    const eye = this.camera.position;
    return Math.hypot(a.x - eye.x, a.heightM - eye.y, -a.y - eye.z);
  }

  /** How many times its model's nominal size an aircraft is drawn: true size near the camera, larger farther off, smaller while it fades in. */
  private drawnSize(a: SceneAircraft, distance = this.distanceTo(a)): number {
    const scale = drawnScale(distance);
    // A drone or approach view draws every aircraft at true size, so near and far ones keep their proportions.
    return (scale + (1 - scale) * this.trueSize) * a.size * (0.4 + 0.6 * a.fade) * (1 - (1 - GHOST_SIZE) * (a.ghost ?? 0));
  }

  /**
   * How far the buildings and towers stand up: 0 flat on the ground plan, 1 their full modelled height.
   * The world map raises them as the camera closes on the airport. Geometry is untouched; only how
   * tall it is drawn changes.
   */
  setRise(rise: number): void {
    // Never quite 0: a zero scale has no inverse, which the lighting needs.
    this.rise = Math.min(1, Math.max(0.001, rise));
    this.applyHeights();
  }

  /** The drawn heights: the rise for everything, and the buildings also come down to true height close up. */
  private applyHeights(): void {
    for (const object of this.raised) object.scale.y = this.closeHeight * this.rise;
    for (const object of this.towers) object.scale.y = this.rise;
  }

  /** Draws these aircraft. `time` (seconds, any epoch) sets where each beacon and strobe is in its flash. */
  setAircraft(list: SceneAircraft[], time = 0): void {
    const { m, q, p, s, up, o } = this.tmp;
    const n = Math.min(list.length, MAX_AIRCRAFT);
    const trailPos = this.trails.geometry.getAttribute("position") as BufferAttribute;
    const trailCol = this.trails.geometry.getAttribute("color") as BufferAttribute;
    const dropPos = this.drops.geometry.getAttribute("position") as BufferAttribute;
    let trails = 0;
    let drops = 0;
    for (const mesh of [...this.fleet.values(), ...this.fleetNear.values()]) mesh.count = 0;
    for (let i = 0; i < n; i++) {
      const a = list[i];
      const h = a.heightM;
      const heading = (a.headingDeg * Math.PI) / 180;
      const distance = this.distanceTo(a);
      const scale = this.drawnSize(a, distance);
      const ghost = a.ghost ?? 0;
      q.setFromAxisAngle(up, -heading);
      p.set(a.x, h, -a.y);
      s.setScalar(scale);
      m.compose(p, q, s);
      const close = this.fleetNear.get(a.model)!;
      const mesh = distance < NEAR_DETAIL_M && close.count < MAX_NEAR ? close : this.fleet.get(a.model)!;
      mesh.setMatrixAt(mesh.count, m);
      mesh.setColorAt(mesh.count, this.stateColors[a.state]);
      (mesh.geometry.getAttribute("ghost") as InstancedBufferAttribute).setX(mesh.count, ghost);
      mesh.count++;
      // Metres of the drawn aircraft, for sizing what is drawn around it.
      const length = MODEL_LENGTH[a.model] * scale;

      // A contact spot under every aircraft in the air, sized to it, fainter the higher it is.
      o.position.set(a.x, LAYER.trail - 0.2, -a.y);
      const dropped = h > DROP_MIN_HEIGHT && h < DROP_MAX_HEIGHT;
      o.scale.setScalar(dropped ? 0.45 * length * Math.max(0.35, 1 - h / DROP_MAX_HEIGHT) * (1 - ghost) : 0);
      o.updateMatrix();
      this.spots.setMatrixAt(i, o.matrix);

      if (dropped && ghost < 0.5) {
        dropPos.setXYZ(2 * drops, a.x, h, -a.y);
        dropPos.setXYZ(2 * drops + 1, a.x, LAYER.trail, -a.y);
        drops++;
      }

      const trail = Math.min(TRAIL_MAX, a.speedMps * TRAIL_SECONDS);
      if (trail > 20) {
        // A ribbon from the tail back along the track, climbing or descending with the aircraft.
        const fx = Math.sin(heading);
        const fy = Math.cos(heading);
        const tail = 0.45 * length;
        const w = 0.1 * length;
        const h0 = Math.max(LAYER.trail, h + 0.07 * length);
        const h1 = Math.max(LAYER.trail, h0 - a.climbMps * (trail / Math.max(1, a.speedMps)));
        const x0 = a.x - fx * tail;
        const y0 = a.y - fy * tail;
        const x1 = x0 - fx * trail;
        const y1 = y0 - fy * trail;
        const k = 4 * trails;
        trailPos.setXYZ(k, x0 + fy * w, h0, -(y0 - fx * w));
        trailPos.setXYZ(k + 1, x0 - fy * w, h0, -(y0 + fx * w));
        trailPos.setXYZ(k + 2, x1 - fy * w, h1, -(y1 + fx * w));
        trailPos.setXYZ(k + 3, x1 + fy * w, h1, -(y1 - fx * w));
        const c = this.trailColors[a.state];
        const alpha = 0.4 * a.fade * (1 - ghost);
        trailCol.setXYZW(k, c.r, c.g, c.b, alpha);
        trailCol.setXYZW(k + 1, c.r, c.g, c.b, alpha);
        trailCol.setXYZW(k + 2, c.r, c.g, c.b, 0);
        trailCol.setXYZW(k + 3, c.r, c.g, c.b, 0);
        trails++;
      }
    }
    if (this.navLights) this.setNavLights(list, n, time);
    for (const mesh of [...this.fleet.values(), ...this.fleetNear.values()]) {
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      mesh.geometry.getAttribute("ghost").needsUpdate = true;
    }
    this.spots.count = n;
    this.spots.instanceMatrix.needsUpdate = true;
    trailPos.needsUpdate = trailCol.needsUpdate = true;
    this.trails.geometry.setDrawRange(0, trails * 6);
    dropPos.needsUpdate = true;
    this.drops.geometry.setDrawRange(0, drops * 2);
  }

  /**
   * Draws the time-lapse's light trails (each aircraft's recent path, fading with age), or none with
   * null. Takes only what is new each frame: the points laid down before are not touched again, unless
   * the update starts the trails over. Their width is a few pixels at the current view, whatever the zoom.
   */
  setLightTrails(update: TrailUpdate | null): void {
    this.lightTrails.visible = this.lightHeads.visible = update !== null;
    if (!update) return;
    const theme = this.theme.lightTrails;
    const style: StripStyle = {
      floor: LAYER.trail + 0.3,
      colors: Object.fromEntries(Object.entries(this.trailColors).map(([state, c]) => [state, [c.r, c.g, c.b]])) as StripStyle["colors"],
      intensity: theme.intensity,
    };
    const strips = this.lightStrips;
    if (update.reset) strips.clear(update.picture);
    strips.append(update.added, style);
    uploadStrips(strips, this.lightTrails);
    // The stretch from each trail's last point to its aircraft moves every frame: rebuilt, but it is a few points an aircraft.
    this.headStrips.clear(strips.epoch);
    this.headStrips.append(
      update.heads.flatMap((head, i) => head.map((p) => ({ ...p, run: i }))),
      style,
    );
    uploadStrips(this.headStrips, this.lightHeads);

    const view = this.currentView;
    const spec: ViewSpec = { azimuthDeg: view.azimuthDeg, elevationDeg: view.elevationDeg, fovDeg: DEFAULT_VIEW.fovDeg };
    this.lightUniforms.trailPicture.value = update.picture - strips.epoch;
    this.lightUniforms.trailWindow.value = update.window;
    this.lightUniforms.trailHalfWidth.value = theme.widthPx / 2 / pixelsPerMetre(spec, view.distance, this.height);
  }

  /**
   * Red on the left wingtip, green on the right, white on the tail, all the time; a red beacon pulsing
   * while the engines run (anything not parked); white wingtip strobes on the runway and in the air.
   */
  private setNavLights(list: SceneAircraft[], n: number, time: number): void {
    const nav = this.navLights!;
    const colors = this.navColors!;
    const position = nav.geometry.getAttribute("position") as BufferAttribute;
    const color = nav.geometry.getAttribute("color") as BufferAttribute;
    const { m, q, p, s, up, v } = this.tmp;
    let k = 0;
    for (let i = 0; i < n; i++) {
      const a = list[i];
      q.setFromAxisAngle(up, (-a.headingDeg * Math.PI) / 180);
      p.set(a.x, a.heightM, -a.y);
      s.setScalar(this.drawnSize(a));
      m.compose(p, q, s);
      // Each aircraft flashes on its own phase, fixed by its id.
      let phase = 0;
      for (let c = 0; c < a.id.length; c++) phase = (phase * 31 + a.id.charCodeAt(c)) % 997;
      phase /= 997;
      const beacon = a.state === "parked" ? 0 : 0.25 + 0.75 * Math.max(0, Math.cos(2 * Math.PI * (time + phase))) ** 6;
      const strobing = a.state === "arriving" || a.state === "departing";
      const strobe = strobing && (((time * 0.8 + phase) % 1) + 1) % 1 < 0.08 ? 1 : 0;
      for (const light of modelLights(a.model)) {
        const level = (light.kind === "beacon" ? beacon : light.kind === "strobe" ? strobe : 1) * a.fade * (1 - (a.ghost ?? 0));
        if (level <= 0) continue;
        v.set(light.x, light.y, light.z).applyMatrix4(m);
        position.setXYZ(k, v.x, v.y, v.z);
        const c = colors[light.kind];
        color.setXYZ(k, c.r * level, c.g * level, c.b * level);
        k++;
      }
    }
    nav.geometry.setDrawRange(0, k);
    position.needsUpdate = color.needsUpdate = true;
  }

  /** Puts the key light at a bearing and elevation (degrees) from the field's middle; its shadow box stays on the field. */
  private placeSun(azimuthDeg: number, elevationDeg: number): void {
    const az = (azimuthDeg * Math.PI) / 180;
    const el = (elevationDeg * Math.PI) / 180;
    const { x, y, far } = this.sunAnchor;
    this.sunLight.position.set(x + Math.sin(az) * Math.cos(el) * far, Math.sin(el) * far, -(y + Math.cos(az) * Math.cos(el) * far));
  }

  /** Relights the model by the real sun (see atmosphere.ts): the key light's direction, colour and strength, and the fill. */
  setSun(light: SunLight): void {
    this.fill.color.set(light.sky);
    this.fill.groundColor.set(light.groundBounce);
    this.fill.intensity = light.hemisphere;
    this.aircraftGlow.value = light.aircraftGlow;
    this.sunLight.color.set(light.color);
    this.sunLight.intensity = light.intensity;
    this.placeSun(light.azimuthDeg, light.elevationDeg);
    // The eye-level sky takes the sun's colour; the horizon's is also the colour the haze fades into there.
    this.sky.horizon.set(light.horizon);
    (this.sky.material.uniforms.zenith.value as Color).set(light.zenith);
    if (this.scene.fog instanceof Fog) this.scene.fog.color.lerpColors(this.sky.background, this.sky.horizon, this.sky.material.uniforms.opacity.value);
  }

  /** The air over the model (see atmosphere.ts): page and fog colour, how close the fog comes, rain or snow, and the windsocks. */
  setWeather(weather: SceneWeather): void {
    (this.scene.background as Color).set(weather.background);
    this.sky.background.set(weather.background);
    this.fogSpec = weather.fog;
    this.haze = weather.haze;
    if (weather.fog) {
      if (!(this.scene.fog instanceof Fog)) this.scene.fog = new Fog(weather.background);
      // At eye level the fog shades to the horizon's colour (setView), so keep the current camera's mix.
      this.scene.fog.color.lerpColors(this.sky.background, this.sky.horizon, this.sky.material.uniforms.opacity.value);
    } else {
      this.scene.fog = null;
    }
    const p = weather.precipitation;
    const points = this.precipitation;
    points.visible = p !== null;
    if (p) {
      const material = points.material as PointsMaterial;
      if (material.map !== this.precipitationTextures[p.kind]) {
        material.map = this.precipitationTextures[p.kind];
        material.needsUpdate = true;
      }
      material.color.set(p.color);
      material.opacity = p.opacity;
      this.precipitationSize = p.sizePx;
      material.size = p.sizePx * this.pointScale;
      points.geometry.setDrawRange(0, Math.min(MAX_PRECIPITATION, p.count));
      this.precipitationUniforms.fall.value = p.fallSeconds;
      // Map east and north to the box's x and z (z points south).
      this.precipitationUniforms.drift.value.set(p.drift[0], -p.drift[1]);
    }
    this.windsock = windsockPose(weather.wind);
    this.applyView(this.view ?? this.home);
  }

  /** Turns every windsock to the wind's pose, fluttering about it and lifting in the gusts. `t` is seconds. */
  private poseWindsocks(t: number): void {
    const { headingDeg, fill, gustFill } = this.windsock;
    this.windsocks.forEach((hinge, i) => {
      // A gust now and then: a short swell toward the gust's fill, each sock a little out of step.
      const gust = Math.max(0, Math.sin(t * 0.45 + i * 0.7)) ** 6;
      const f = fill + (gustFill - fill) * gust;
      const wobble = fill > 0 ? (Math.sin(t * 1.9 + i) + 0.6 * Math.sin(t * 4.7 + 2 * i)) * (3 - 2 * f) : 0;
      poseWindsock(hinge, headingDeg + wobble, droopFor(f), f);
    });
  }

  render(): void {
    const t = (performance.now() / 1000) % 10_000;
    this.precipitationUniforms.time.value = t;
    if (this.windsocks.length) this.poseWindsocks(t);
    this.composer.render();
  }

  /**
   * The colour the frame draws along its top, `fromTopPx` CSS pixels down, where the chrome's scrims
   * sit: whatever is there (the lit ground, the fog, the clear colour, the sky at eye level), as most of
   * the row shows it. Call straight after render: it starts a read of this frame's row into a buffer on
   * the GPU and answers with the last read that has finished, a frame or two old, so the page never
   * waits on the GPU for it. Null until the first has.
   */
  topColour(fromTopPx: number): string | null {
    const gl = this.renderer.getContext() as WebGL2RenderingContext;
    const top = this.top;
    if (top.fence) {
      // Polled, never waited on: until the GPU has written the row, the last colour stands.
      if (gl.getSyncParameter(top.fence, gl.SYNC_STATUS) !== gl.SIGNALED) return top.colour;
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, top.buffer);
      gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, top.row);
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
      gl.deleteSync(top.fence);
      top.fence = null;
      top.colour = rowColour(top.row);
    }
    const width = gl.drawingBufferWidth;
    const row = Math.max(0, gl.drawingBufferHeight - 1 - Math.round(fromTopPx * this.renderer.getPixelRatio()));
    top.buffer ??= gl.createBuffer();
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, top.buffer);
    if (top.row.length !== width * 4) {
      top.row = new Uint8Array(width * 4);
      // Not a READ usage: Chrome shadows those for readback and warns each time a read finds the shadow stale.
      gl.bufferData(gl.PIXEL_PACK_BUFFER, top.row.byteLength, gl.DYNAMIC_DRAW);
    }
    this.renderer.setRenderTarget(null);
    gl.readPixels(0, row, width, 1, gl.RGBA, gl.UNSIGNED_BYTE, 0);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    top.fence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
    gl.flush();
    return top.colour;
  }

  /** Where a map point at a height lands on screen. */
  project(x: number, y: number, h: number): ScreenPoint {
    const v = this.tmp.v.set(x, h, -y).project(this.camera);
    return { x: ((v.x + 1) / 2) * this.width, y: ((1 - v.y) / 2) * this.height, visible: v.z < 1 && Math.abs(v.x) <= 1.2 && Math.abs(v.y) <= 1.2 };
  }

  dispose(): void {
    this.scene.traverse((object) => {
      const mesh = object as Mesh;
      mesh.geometry?.dispose();
      const material = mesh.material as Material | Material[] | undefined;
      if (Array.isArray(material)) material.forEach((mat) => mat.dispose());
      else material?.dispose();
    });
    for (const t of this.textures) t.dispose();
    for (const pass of this.composer.passes) pass.dispose();
    this.composer.dispose();
    const gl = this.renderer.getContext() as WebGL2RenderingContext;
    if (this.top.fence) gl.deleteSync(this.top.fence);
    if (this.top.buffer) gl.deleteBuffer(this.top.buffer);
    this.renderer.dispose();
    this.renderer.forceContextLoss();
    this.canvas.remove();
  }
}
