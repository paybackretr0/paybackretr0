/**
 * Generates the animated 3D banner used at the top of the profile README.
 *
 * A README cannot run WebGL, so this script bakes the portfolio's 3D hero —
 * `porto-lied/src/components/three/roomScene.three.ts` — into two SVG files:
 * the room is real 3D geometry, projected with a real perspective camera on
 * every keyframe, and the resulting path data is exported as SMIL animations.
 * GitHub serves README images through an image proxy where SMIL runs, so the
 * room keeps moving without a byte of JavaScript.
 *
 * The constants below are copied from the live scene, so the banner and the
 * site stay the same room: same camera, same shaft, same dust seeding.
 *
 * Everything is deterministic — the camera, the dust and the keyframe sampling
 * all come from the constants below, and the dust uses a seeded PRNG — so two
 * runs produce byte-identical files (same idea as `porto-lied/scripts/shots.mjs`).
 *
 *   node scripts/build-banner-3d.mjs
 *
 * Output: assets/banner-3d-dark.svg, assets/banner-3d-light.svg
 */
import { mkdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = join(root, 'assets')

// ── Frame ──────────────────────────────────────────────────
const W = 1200
const H = 420
/** Seconds per loop. */
const LOOP = 18
/** Intervals per loop: FRAMES + 1 samples, the last one repeating the first. */
const FRAMES = 26

// ── Camera, mirrored from roomScene.three.ts ───────────────
const FOV = 38
const CAM = { x: 0, y: 0.9, z: 5.5 }
/**
 * LOOK_BASE.y + portraitLift is what the scene looks at on desktop; this pulls
 * the framing back and a little lower so the pool of light and the whole shaft
 * land inside a 1200×420 crop instead of being cut off at the bottom edge. The
 * same trick the scene uses for portrait screens (`portraitScale`, `portraitLift`).
 */
const LOOK = { x: 0, y: 0.22, z: -2.4 }

// ── Room geometry, mirrored from roomScene.three.ts ────────
const FLOOR_Y = -1.7
const WALL_Z = -4.2
const BEAM_FROM = [-7.2, 5.2, 1.4]
const BEAM_TO = [3.6, FLOOR_Y, -1.9]
/**
 * The shaft, as two nested stacks. The scene uses three wide crossed quads with
 * additive shaders; here each stack is a handful of concentric ribbons whose
 * alpha adds up towards the axis — the same picture without a shader.
 */
const BEAM_LAYERS = [
  { width: 7.2, intensity: 1, steps: 12, alpha: 0.032 },
  { width: 3.2, intensity: 0.85, steps: 8, alpha: 0.038 },
]
/** Ribbons of the crossed stack, which is what gives the volume a core. */
const CORE_STEPS = 4
/** Mullion slabs, the way the shader cuts each quad into four bands. */
const BEAM_BARS = 4
const DUST_COUNT = 70
/** World units a mote climbs over one loop. */
const DUST_RISE = 1.5

// ── Vector helpers ─────────────────────────────────────────
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
const mul = (v, s) => [v[0] * s, v[1] * s, v[2] * s]
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const cross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
]
const length = (v) => Math.hypot(v[0], v[1], v[2])
const unit = (v) => mul(v, 1 / length(v))

/** Seeded PRNG, so the dust never moves between builds. */
function mulberry32(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * The camera at one point of the loop: the same slow drift the live scene runs
 * (`sin(t * 0.11) * 0.07` on X), plus a matching dolly on Z. Both are single
 * sine cycles, so the loop closes on itself instead of jumping.
 */
function cameraAt(phase) {
  const a = phase * Math.PI * 2
  const eye = [CAM.x + Math.sin(a) * 0.07, CAM.y, CAM.z * (1 + Math.sin(a + 1.9) * 0.035)]
  const look = [LOOK.x, LOOK.y + Math.sin(a + 0.7) * 0.03, LOOK.z]
  const forward = unit(sub(look, eye))
  const right = unit(cross(forward, [0, 1, 0]))
  return { eye, forward, right, up: cross(right, forward) }
}

const TAN_HALF = Math.tan((FOV * Math.PI) / 180 / 2)
const ASPECT = W / H

/** Perspective projection of a world point into banner pixels. */
function project(cam, point) {
  const rel = sub(point, cam.eye)
  const z = Math.max(dot(rel, cam.forward), 0.2)
  const x = dot(rel, cam.right)
  const y = dot(rel, cam.up)
  return [
    W / 2 + (x / (z * TAN_HALF * ASPECT)) * (W / 2),
    H / 2 - (y / (z * TAN_HALF)) * (H / 2),
    z,
  ]
}

// ── Path data ──────────────────────────────────────────────
/** Shortest number strings keep the keyframe payload small. */
const n1 = (value) => {
  const rounded = Math.round(value * 10) / 10
  return Object.is(rounded, -0) ? '0' : String(rounded)
}
const n4 = (value) => {
  const rounded = Math.round(value * 10000) / 10000
  return Object.is(rounded, -0) ? '0' : String(rounded)
}

const KEY_TIMES = Array.from({ length: FRAMES + 1 }, (_, i) => n4(i / FRAMES)).join(';')

const quadD = (points) =>
  `M${n1(points[0][0])} ${n1(points[0][1])}L${n1(points[1][0])} ${n1(points[1][1])}` +
  `L${n1(points[2][0])} ${n1(points[2][1])}L${n1(points[3][0])} ${n1(points[3][1])}Z`

const lineD = (points) =>
  `M${n1(points[0][0])} ${n1(points[0][1])}L${n1(points[1][0])} ${n1(points[1][1])}`

/**
 * Projects a world-space quad once per keyframe.
 *
 * The camera moves, so every polygon has to be re-projected — that re-projection
 * *is* the 3D: the wall barely shifts, the shaft swings, the dust arcs. SMIL
 * interpolates between samples, which is why this is a keyframe bake and not a
 * per-frame export.
 */
function animateQuad(world) {
  const values = []
  for (let i = 0; i <= FRAMES; i += 1) {
    const cam = cameraAt(i / FRAMES)
    values.push(quadD(world.map((point) => project(cam, point))))
  }
  return values.join(';')
}

/** Same, for a two-point path (the wall/floor junction hairline). */
function animateLine(world) {
  const values = []
  for (let i = 0; i <= FRAMES; i += 1) {
    const cam = cameraAt(i / FRAMES)
    values.push(lineD(world.map((point) => project(cam, point))))
  }
  return values.join(';')
}

const morph = (values) =>
  `<animate attributeName="d" dur="${LOOP}s" repeatCount="indefinite" ` +
  `calcMode="linear" keyTimes="${KEY_TIMES}" values="${values}"/>`

function polygon(world, fill, opacity) {
  return `<path fill="${fill}" fill-opacity="${n4(opacity)}">${morph(animateQuad(world))}</path>`
}

function hairline(world, stroke, opacity, width) {
  return (
    `<path fill="none" stroke="${stroke}" stroke-width="${width}" ` +
    `stroke-opacity="${n4(opacity)}">${morph(animateLine(world))}</path>`
  )
}

// ── Geometry ───────────────────────────────────────────────
function rotateY([x, y, z], angle) {
  return [x * Math.cos(angle) + z * Math.sin(angle), y, -x * Math.sin(angle) + z * Math.cos(angle)]
}
function rotateZ([x, y, z], angle) {
  return [x * Math.cos(angle) - y * Math.sin(angle), x * Math.sin(angle) + y * Math.cos(angle), z]
}

/**
 * The wall and the floor are only drawn as far as the frame needs them: the
 * visible sliver of floor starts well above the bottom edge, so the polygon is
 * trimmed to keep the numbers short instead of projecting ±17 units near the
 * camera.
 */
const WALL = [
  [-17, -7.2, WALL_Z],
  [17, -7.2, WALL_Z],
  [17, 10.8, WALL_Z],
  [-17, 10.8, WALL_Z],
]

const FLOOR = [
  [-12, FLOOR_Y, 2.6],
  [12, FLOOR_Y, 2.6],
  [12, FLOOR_Y, WALL_Z],
  [-12, FLOOR_Y, WALL_Z],
]

const JUNCTION = [
  [-17, FLOOR_Y, WALL_Z],
  [17, FLOOR_Y, WALL_Z],
]

const BEAM_UNIT = unit(sub(BEAM_TO, BEAM_FROM))
const BEAM_LENGTH = length(sub(BEAM_TO, BEAM_FROM))
const BEAM_SIDE = unit(cross(BEAM_UNIT, [0, 1, 0]))
const BEAM_UP = unit(cross(BEAM_SIDE, BEAM_UNIT))

/** A quad that runs the whole length of the shaft, `width` across `axis`. */
function beamRibbon(axis, width) {
  const offset = mul(axis, width / 2)
  return [
    add(BEAM_FROM, offset),
    sub(BEAM_FROM, offset),
    sub(BEAM_TO, offset),
    add(BEAM_TO, offset),
  ]
}

/**
 * Concentric ribbons: stacking translucent quads is how a hard-edged polygon
 * becomes a glow.
 *
 * A screen-space gradient cannot do this job. The shaft runs so deep into the
 * perspective that a single linear gradient's parameter leaves 0..1 well before
 * the far end, which blanked the whole shaft when this was first built. Nested
 * geometry has no such problem — every ring is projected on its own.
 */
function nestedRibbons(axis, width, steps) {
  const ribbons = []
  for (let i = 0; i < steps; i += 1) {
    const t = steps === 1 ? 0 : i / (steps - 1)
    ribbons.push(beamRibbon(axis, width * (1 - 0.88 * t)))
  }
  return ribbons
}

/** The mullion slabs: `BEAM_BARS` narrow ribbons across one shaft layer. */
function beamBars(axis, width) {
  const slab = width / BEAM_BARS
  const bars = []
  for (let i = 0; i < BEAM_BARS; i += 1) {
    const center = -width / 2 + slab * (i + 0.5)
    bars.push(beamRibbon(axis, slab * 0.66).map((point) => add(point, mul(axis, center))))
  }
  return bars
}

/** Where the shaft lands: the painted pool of striped light on the floor. */
const PATCH_CENTER = [BEAM_TO[0] - 0.6, FLOOR_Y + 0.02, BEAM_TO[2] + 0.4]
const PATCH_ROTATION = -0.28
const patchPoint = (x, z) => add(PATCH_CENTER, rotateY([x, 0, z], PATCH_ROTATION))

const PATCH = [patchPoint(-5.5, -4), patchPoint(5.5, -4), patchPoint(5.5, 4), patchPoint(-5.5, 4)]

/** The pool, shrunk towards its own centre — the nesting trick, on the floor. */
const nestedPatch = (scale) => [
  patchPoint(-5.5 * scale, -4 * scale),
  patchPoint(5.5 * scale, -4 * scale),
  patchPoint(5.5 * scale, 4 * scale),
  patchPoint(-5.5 * scale, 4 * scale),
]

/**
 * Day theme: the same window pattern as a *shadow* on the wall instead of light
 * in the air, mirroring `wallShadow` in the scene.
 */
const SHADOW_CENTER = [0.8, 2.2, WALL_Z + 0.04]
const shadowPoint = (x, y) => add(SHADOW_CENTER, rotateZ([x, y, 0], -0.12))

const SHADOW = [
  shadowPoint(-6.5, -3.75),
  shadowPoint(6.5, -3.75),
  shadowPoint(6.5, 3.75),
  shadowPoint(-6.5, 3.75),
]

const nestedShadow = (scale) => [
  shadowPoint(-6.5 * scale, -3.75 * scale),
  shadowPoint(6.5 * scale, -3.75 * scale),
  shadowPoint(6.5 * scale, 3.75 * scale),
  shadowPoint(-6.5 * scale, 3.75 * scale),
]

const CAM0 = cameraAt(0)

/**
 * A soft ellipse of light — or of shadow — in screen space.
 *
 * The pool and the wall shadow are nearly flat-on to the camera, so a radial
 * gradient is exact enough here (unlike the shaft, which is too deep in
 * perspective for one). The radius is measured to the *edge midpoints* of the
 * quad, not its corners, so the fill has already reached zero by the time any of
 * the quad's own edges arrive and no cut line ever shows.
 */
function softEllipse(id, centerWorld, corners, color, peak) {
  const center = project(CAM0, centerWorld)
  const edges = corners.map((corner, index) => {
    const next = corners[(index + 1) % corners.length]
    return [
      (corner[0] + next[0]) / 2,
      (corner[1] + next[1]) / 2,
      (corner[2] + next[2]) / 2,
    ]
  })
  const radius =
    Math.min(
      ...edges.map((edge) => {
        const point = project(CAM0, edge)
        return Math.hypot(point[0] - center[0], point[1] - center[1])
      }),
    ) * 0.92

  return (
    `<radialGradient id="${id}" gradientUnits="userSpaceOnUse" ` +
    `cx="${n1(center[0])}" cy="${n1(center[1])}" r="${n1(radius)}">` +
    `<stop offset="0" stop-color="${color}" stop-opacity="${n4(peak)}"/>` +
    `<stop offset="0.45" stop-color="${color}" stop-opacity="${n4(peak * 0.62)}"/>` +
    `<stop offset="0.8" stop-color="${color}" stop-opacity="${n4(peak * 0.22)}"/>` +
    `<stop offset="1" stop-color="${color}" stop-opacity="0"/></radialGradient>`
  )
}


// ── Dust ───────────────────────────────────────────────────
// Motes are seeded *inside* the shaft, exactly like the scene does it: averaging
// three randoms clumps them towards the axis, which is what stops the air from
// looking like random noise.
const random = mulberry32(0x5eed)
const DUST = Array.from({ length: DUST_COUNT }, () => {
  const along = random()
  const radius = ((random() + random() + random()) / 3 - 0.5) * 3.4
  const angle = random() * Math.PI * 2
  return {
    base: add(
      add(BEAM_FROM, mul(BEAM_UNIT, BEAM_LENGTH * along)),
      add(mul(BEAM_SIDE, Math.cos(angle) * radius), mul(BEAM_UP, Math.sin(angle) * radius)),
    ),
    offset: random(),
    speed: 0.4 + random() * 0.9,
    sway: random() * Math.PI * 2,
    size: 1 + random() * 1.4,
  }
})

/**
 * One mote, sampled across the loop: it climbs the shaft, sways, fades out at
 * the wrap and dims with distance. Those three cues are what the live scene uses
 * to make the dust read as volume instead of dots.
 */
function dustFrames(mote) {
  const xs = []
  const ys = []
  const os = []

  for (let i = 0; i <= FRAMES; i += 1) {
    const phase = i / FRAMES
    const cam = cameraAt(phase)

    // The climb wraps inside the loop, and the fade is zero at both ends of the
    // wrap, so the reset is never visible.
    const climb = (phase + mote.offset) % 1
    const world = [
      mote.base[0] + Math.sin(phase * Math.PI * 4 + mote.sway) * 0.09,
      mote.base[1] + climb * DUST_RISE * mote.speed,
      mote.base[2],
    ]

    const [x, y, z] = project(cam, world)
    const fade = Math.sin(Math.PI * climb) ** 0.8
    const depth = Math.min(Math.max(1.55 - z * 0.12, 0.2), 1)
    // Only lit dust is visible: a mote far from the shaft is dust in the dark,
    // so its opacity follows the distance to the shaft's screen centreline.
    const gate = beamProximity(x, y, project(cam, BEAM_FROM), project(cam, BEAM_TO))

    xs.push(n1(x))
    ys.push(n1(y))
    os.push(n4(fade * depth * gate))
  }

  return { xs: xs.join(';'), ys: ys.join(';'), os: os.join(';') }
}

/** 1 on the shaft's centreline, 0 once a mote is clearly outside the glow. */
function beamProximity(x, y, from, to) {
  const dx = to[0] - from[0]
  const dy = to[1] - from[1]
  const t = Math.min(
    Math.max(((x - from[0]) * dx + (y - from[1]) * dy) / (dx * dx + dy * dy), 0),
    1,
  )
  const distance = Math.hypot(x - (from[0] + dx * t), y - (from[1] + dy * t))
  return Math.min(Math.max(1 - distance / 190, 0), 1) ** 1.4
}

// ── Themes ─────────────────────────────────────────────────
// The two palettes are the two themes of the site: `--room-*` by night and the
// plaster room by day. `beamOpacity: 0` switches the shaft off entirely — an
// additive shaft on a plaster wall just burns it white, which is why the live
// scene does the same thing (`applyTuning`).
const THEMES = {
  dark: {
    file: 'banner-3d-dark.svg',
    title: 'Khalied Nauly Maturino — night gallery hero',
    ink: '#0c0a08',
    wallTop: '#231e17',
    wallBottom: '#12100c',
    floorFar: '#0d0b09',
    floorNear: '#191510',
    beam: '#ffe3b0',
    dust: '#ffefd2',
    bronze: '#b08d57',
    primary: '#c9ae86',
    copy: '#efeae1',
    muted: '#a7a093',
    muted2: '#7a7365',
    scrim: '#0c0a08',
    beamOpacity: 1,
    dustOpacity: 0.72,
    shadowOpacity: 0,
    lampOpacity: 0.5,
  },
  light: {
    file: 'banner-3d-light.svg',
    title: 'Khalied Nauly Maturino — daylight gallery hero',
    ink: '#faf7f1',
    wallTop: '#f7f2e9',
    wallBottom: '#e6ddcd',
    floorFar: '#d3cbbb',
    floorNear: '#efe8db',
    beam: '#ffffff',
    dust: '#8c6a3f',
    bronze: '#8c6a3f',
    primary: '#a07c4a',
    copy: '#0c0a08',
    muted: '#57503f',
    muted2: '#857c6e',
    scrim: '#faf7f1',
    beamOpacity: 0,
    dustOpacity: 0,
    shadowOpacity: 1,
    lampOpacity: 0.35,
  },
}

// ── Type ───────────────────────────────────────────────────
// Only system fonts: an SVG loaded through <img> cannot fetch webfonts, so the
// banner borrows the closest faces that are already on every machine — Georgia
// for the display voice, a mono stack for the labels.
const SERIF = "'Iowan Old Style', Georgia, 'Times New Roman', serif"
const SANS = "'Segoe UI', Manrope, system-ui, -apple-system, Arial, sans-serif"
const MONO = "'JetBrains Mono', ui-monospace, Consolas, 'Courier New', monospace"

const CHIPS = ['MOBILE & WEB', 'INFORMATION SYSTEMS', 'OPEN TO COLLAB']

function buildDefs(theme, gradients) {
  return `<defs>
<linearGradient id="wall" x1="0" y1="0" x2="0" y2="1">
<stop offset="0" stop-color="${theme.wallTop}"/>
<stop offset="0.55" stop-color="${theme.wallBottom}"/>
<stop offset="1" stop-color="${theme.wallBottom}"/>
</linearGradient>
<linearGradient id="floor" x1="0" y1="0" x2="0" y2="1">
<stop offset="0" stop-color="${theme.floorFar}"/>
<stop offset="1" stop-color="${theme.floorNear}"/>
</linearGradient>
<radialGradient id="lamp" cx="0.5" cy="0.5" r="0.5">
<stop offset="0" stop-color="${theme.beam}" stop-opacity="0.2"/>
<stop offset="0.55" stop-color="${theme.beam}" stop-opacity="0.05"/>
<stop offset="1" stop-color="${theme.beam}" stop-opacity="0"/>
</radialGradient>
${
  theme.beamOpacity > 0
    ? `<radialGradient id="pool" cx="0.5" cy="0.5" r="0.5">
<stop offset="0" stop-color="${theme.beam}" stop-opacity="0.34"/>
<stop offset="1" stop-color="${theme.beam}" stop-opacity="0"/>
</radialGradient>`
    : ''
}
<linearGradient id="scrim" x1="0" y1="0" x2="1" y2="0">
<stop offset="0" stop-color="${theme.scrim}" stop-opacity="0.95"/>
<stop offset="0.4" stop-color="${theme.scrim}" stop-opacity="0.82"/>
<stop offset="0.6" stop-color="${theme.scrim}" stop-opacity="0.36"/>
<stop offset="0.78" stop-color="${theme.scrim}" stop-opacity="0"/>
</linearGradient>
<radialGradient id="vignette" cx="0.5" cy="0.55" r="0.78">
<stop offset="0.55" stop-color="${theme.ink}" stop-opacity="0"/>
<stop offset="1" stop-color="${theme.ink}" stop-opacity="0.55"/>
</radialGradient>
<filter id="grain" x="0" y="0" width="100%" height="100%">
<feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="3" stitchTiles="stitch"/>
<feColorMatrix type="saturate" values="0"/>
</filter>
${gradients.join('\n')}
</defs>`
}

function buildSvg(theme) {
  const body = []
  const gradients = []

  // ── Room ────────────────────────────────────────────────
  body.push(`<rect width="${W}" height="${H}" fill="${theme.ink}"/>`)
  body.push(polygon(WALL, 'url(#wall)', 1))
  body.push(polygon(FLOOR, 'url(#floor)', 1))
  body.push(hairline(JUNCTION, theme.bronze, 0.26, 1.1))
  body.push(
    `<ellipse cx="300" cy="-40" rx="640" ry="430" fill="url(#lamp)" ` +
      `opacity="${theme.lampOpacity}"/>`,
  )

  // ── The shaft ───────────────────────────────────────────
  // Concentric ribbons across the shaft, and a crossed stack for the core.
  // Stacked alpha does what additive blending does in WebGL: the axis gets
  // brighter and the edges dissolve instead of ending in a hard line.
  if (theme.beamOpacity > 0) {
    for (const layer of BEAM_LAYERS) {
      for (const ribbon of nestedRibbons(BEAM_SIDE, layer.width, layer.steps)) {
        body.push(polygon(ribbon, theme.beam, layer.alpha * layer.intensity * theme.beamOpacity))
      }
      for (const ribbon of nestedRibbons(BEAM_UP, layer.width * 0.5, CORE_STEPS)) {
        body.push(polygon(ribbon, theme.beam, 0.026 * layer.intensity * theme.beamOpacity))
      }
    }

    // Window bars, cut straight across the shaft.
    for (const bar of beamBars(BEAM_SIDE, BEAM_LAYERS[0].width)) {
      body.push(polygon(bar, theme.beam, 0.07 * theme.beamOpacity))
    }

    // ── The pool it paints on the floor ───────────────────
    // One radial fill does the fade, and the bars sample the same gradient, so
    // the stripes fade out with it instead of ending at a cut line.
    gradients.push(softEllipse('poolfill', PATCH_CENTER, nestedPatch(1), theme.beam, 0.55))
    body.push(polygon(nestedPatch(1), 'url(#poolfill)', theme.beamOpacity))

    const poolSlab = 11 / BEAM_BARS
    for (let i = 0; i < BEAM_BARS; i += 1) {
      const center = -11 / 2 + poolSlab * (i + 0.5)
      const half = (poolSlab * 0.66) / 2
      body.push(
        polygon(
          [
            patchPoint(center - half, -4),
            patchPoint(center + half, -4),
            patchPoint(center + half, 4),
            patchPoint(center - half, 4),
          ],
          'url(#poolfill)',
          0.55 * theme.beamOpacity,
        ),
      )
    }

    body.push(
      `<ellipse cx="880" cy="352" rx="330" ry="190" fill="url(#pool)" ` +
        `opacity="${theme.lampOpacity}"/>`,
    )
  } else {
    // Daylight: the window pattern reads as shadow on plaster, not light in air.
    gradients.push(softEllipse('shadowfill', SHADOW_CENTER, nestedShadow(1), theme.copy, 0.3))
    body.push(polygon(nestedShadow(1), 'url(#shadowfill)', theme.shadowOpacity))

    const shadowBars = 6
    const shadowSlab = 13 / shadowBars
    for (let i = 0; i < shadowBars; i += 1) {
      const center = -13 / 2 + shadowSlab * (i + 0.5)
      const half = (shadowSlab * 0.55) / 2
      body.push(
        polygon(
          [
            shadowPoint(center - half, -3.75),
            shadowPoint(center + half, -3.75),
            shadowPoint(center + half, 3.75),
            shadowPoint(center - half, 3.75),
          ],
          'url(#shadowfill)',
          0.8 * theme.shadowOpacity,
        ),
      )
    }
  }

  // ── Dust ────────────────────────────────────────────────
  if (theme.dustOpacity > 0) {
    for (const mote of DUST) {
      const frames = dustFrames(mote)
      body.push(
        `<circle r="${n1(mote.size)}" fill="${theme.dust}" ` +
          `fill-opacity="${theme.dustOpacity}">` +
          `<animate attributeName="cx" dur="${LOOP}s" repeatCount="indefinite" ` +
          `calcMode="linear" keyTimes="${KEY_TIMES}" values="${frames.xs}"/>` +
          `<animate attributeName="cy" dur="${LOOP}s" repeatCount="indefinite" ` +
          `calcMode="linear" keyTimes="${KEY_TIMES}" values="${frames.ys}"/>` +
          `<animate attributeName="opacity" dur="${LOOP}s" repeatCount="indefinite" ` +
          `calcMode="linear" keyTimes="${KEY_TIMES}" values="${frames.os}"/>` +
          `</circle>`,
      )
    }
  }

  body.push(`<rect width="${W}" height="${H}" fill="url(#vignette)"/>`)
  body.push(`<rect width="${W}" height="${H}" fill="url(#scrim)"/>`)

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="100%" ` +
    `role="img" aria-label="${theme.title}">` +
    `<title>${theme.title}</title>` +
    buildDefs(theme, gradients) +
    body.join('\n') +
    '\n' +
    buildOverlay(theme) +
    `</svg>\n`
  )
}

const esc = (text) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/**
 * Everything in front of the room: film grain, the bronze plate, and the type.
 * The type sits on the scrim, on the left — the editorial split the site's hero
 * uses, where the light owns the right half of the frame.
 */
function buildOverlay(theme) {
  const parts = []

  parts.push(
    `<rect width="${W}" height="${H}" fill="#808080" filter="url(#grain)" opacity="0.045"/>`,
  )

  // Plate + corner ticks, the same hairline language as the site's print frame.
  parts.push(
    `<rect x="20.5" y="16.5" width="${W - 41}" height="${H - 33}" fill="none" ` +
      `stroke="${theme.bronze}" stroke-opacity="0.16"/>`,
  )
  const ticks = [
    `M20.5 44.5L20.5 16.5L48.5 16.5`,
    `M${W - 48.5} 16.5L${W - 20.5} 16.5L${W - 20.5} 44.5`,
    `M${W - 20.5} ${H - 44.5}L${W - 20.5} ${H - 16.5}L${W - 48.5} ${H - 16.5}`,
    `M48.5 ${H - 16.5}L20.5 ${H - 16.5}L20.5 ${H - 44.5}`,
  ]
  parts.push(
    `<path d="${ticks.join('')}" fill="none" stroke="${theme.bronze}" stroke-opacity="0.5"/>`,
  )

  // ── Left column ─────────────────────────────────────────
  parts.push(
    `<text x="56" y="104" font-family="${MONO}" font-size="11" letter-spacing="3.2" ` +
      `fill="${theme.muted}">${esc('SOFTWARE DEVELOPER · PADANG, INDONESIA')}</text>`,
  )
  parts.push(
    `<text x="52" y="180" font-family="${SERIF}" font-size="62" letter-spacing="0.5" ` +
      `fill="${theme.copy}">Khalied Nauly</text>`,
  )
  parts.push(
    `<text x="52" y="242" font-family="${SERIF}" font-size="62" font-style="italic" ` +
      `fill="${theme.primary}">Maturino</text>`,
  )
  parts.push(
    `<path d="M56 268L330 268" stroke="${theme.bronze}" stroke-opacity="0.55" stroke-width="1.4"/>` +
      `<circle cx="338" cy="268" r="2.3" fill="${theme.bronze}" fill-opacity="0.85"/>`,
  )
  parts.push(
    `<text x="52" y="302" font-family="${SANS}" font-size="14.5" ` +
      `fill="${theme.muted}">${esc('Mobile & Web — information systems for campuses and public services')}</text>`,
  )

  // Chips: hairline pills, mono capitals, no fill — the quietest way to list
  // three things without turning the banner into a badge wall.
  let cursor = 56
  const chipTop = 322
  const chipHeight = 28
  for (const label of CHIPS) {
    const width = Math.round(label.length * 6.35 + 26)
    parts.push(
      `<rect x="${cursor}" y="${chipTop}" width="${width}" height="${chipHeight}" ` +
        `rx="${chipHeight / 2}" fill="none" stroke="${theme.bronze}" stroke-opacity="0.42"/>` +
        `<text x="${cursor + width / 2}" y="${chipTop + 18.5}" text-anchor="middle" ` +
        `font-family="${MONO}" font-size="10" letter-spacing="0.9" ` +
        `fill="${theme.muted}">${esc(label)}</text>`,
    )
    cursor += width + 10
  }

  parts.push(
    `<text x="56" y="398" font-family="${MONO}" font-size="10" letter-spacing="1.8" ` +
      `fill="${theme.muted2}">${esc('ANDROID · FLUTTER · LARAVEL · REACT · NODE')}</text>`,
  )

  // ── Right column ────────────────────────────────────────
  parts.push(
    `<text x="${W - 56}" y="104" text-anchor="end" font-family="${MONO}" font-size="10.5" ` +
      `letter-spacing="2.6" fill="${theme.bronze}">${esc('LIVE 3D STAGE ↗')}</text>`,
  )
  parts.push(
    `<text x="${W - 56}" y="124" text-anchor="end" font-family="${MONO}" font-size="10" ` +
      `letter-spacing="1.2" fill="${theme.muted2}">paybackretr0.github.io</text>`,
  )

  return parts.join('\n')
}

// ── Build ──────────────────────────────────────────────────
function main() {
  mkdirSync(outDir, { recursive: true })

  for (const theme of Object.values(THEMES)) {
    const file = join(outDir, theme.file)
    writeFileSync(file, buildSvg(theme), 'utf8')
    console.log(`  assets/${theme.file} → ${Math.round(statSync(file).size / 1024)} kB`)
  }
}

main()




