import { Euler, Vector3 } from "three";
import type { DirectorObject, DirectorProject } from "../schema/directorProject";
import { getBodyPreset, getGroundedLabelY } from "../runtime/mannequin/bodyTypes";
import { getUE4GroundedLabelY } from "../runtime/ue4Mannequin/ue4MannequinRig";

export type MotionInterpolationType = "catmull-rom" | "linear";

export interface MotionRoutePoint {
  id: string;
  position: [number, number, number];
  timestamp: number;
  poseId?: string;
}

export interface DirectorMotionRoute {
  id: string;
  characterId: string;
  points: MotionRoutePoint[];
  interpolationType: MotionInterpolationType;
  loop: boolean;
  duration: number;
  snapToGround: boolean;
}

type Vec3 = [number, number, number];
type Vec2 = [number, number];

type VerticalRange = {
  min: number;
  max: number;
};

type MotionObstacle = {
  id: string;
  name: string;
  verticalRange: VerticalRange;
  footprint:
    | { kind: "obb"; center: Vec2; halfWidth: number; halfDepth: number; yaw: number }
    | { kind: "circle"; center: Vec2; radius: number };
};

type RouteSegment = {
  index: number;
  from: Vec3;
  to: Vec3;
};

export type MotionRouteSafety =
  | { status: "safe" }
  | {
      status: "blocked";
      reason: "missing-character" | "curve-too-complex" | "obstacle";
      obstacleId?: string;
      obstacleName?: string;
      segmentIndex?: number;
    };

const MAX_ROUTE_POINTS = 200;
const MIN_DURATION_SECONDS = 0.1;
const MAX_DURATION_SECONDS = 120;
const COLLISION_CLEARANCE = 0.06;
const CURVE_LINEARIZATION_ERROR = 0.005;
const MAX_CURVE_SUBDIVISION_DEPTH = 12;

export function normalizeMotionRoute(value: unknown, project: Pick<DirectorProject, "scene" | "objects">): DirectorMotionRoute | null {
  if (!isRecord(value) || !Array.isArray(value.points) || value.points.length < 2 || value.points.length > MAX_ROUTE_POINTS) {
    return null;
  }

  const characterId = resolveCharacterId(value.characterId, project.objects);
  if (!characterId) return null;

  const rawPoints = value.points.map(parseRoutePoint);
  if (rawPoints.some((point) => point === null)) return null;

  const points = rawPoints as Array<{ id: string; position: Vec3; timestamp: number | null; poseId?: string }>;
  const loop = value.loop === true;
  const timestamps = normalizeTimestamps(points.map((point) => point.timestamp), loop);
  const interpolationType: MotionInterpolationType = value.interpolationType === "linear" ? "linear" : "catmull-rom";
  const route: DirectorMotionRoute = {
    id: readString(value.id) || "director-route",
    characterId,
    points: points.map((point, index) => ({
      id: point.id || `point-${index + 1}`,
      position: point.position,
      timestamp: timestamps[index],
      ...(point.poseId ? { poseId: point.poseId } : {}),
    })),
    interpolationType,
    loop,
    duration: clampNumber(value.duration, MIN_DURATION_SECONDS, MAX_DURATION_SECONDS, 10),
    snapToGround: value.snapToGround !== false,
  };

  return {
    ...route,
    points: route.points.map((point) => ({
      ...point,
      position: resolveMotionRoutePosition(route, project, point.position),
    })),
  };
}

export function sampleMotionRoute(route: DirectorMotionRoute, progress: number): Vec3 {
  const points = route.points;
  if (points.length === 0) return [0, 0, 0];
  if (points.length === 1) return [...points[0].position] as Vec3;

  const normalizedProgress = normalizeProgress(progress, route.loop);
  const { index, nextIndex, localProgress } = getSegment(points, normalizedProgress, route.loop);
  const p0 = points[route.loop ? wrapIndex(index - 1, points.length) : Math.max(0, index - 1)].position;
  const p1 = points[index].position;
  const p2 = points[nextIndex].position;
  const p3 = points[route.loop ? wrapIndex(index + 2, points.length) : Math.min(points.length - 1, index + 2)].position;

  return route.interpolationType === "linear"
    ? linearInterpolate(p1, p2, localProgress)
    : catmullRomInterpolate(p0, p1, p2, p3, localProgress);
}

export function resolveMotionRoutePosition(
  route: DirectorMotionRoute,
  project: Pick<DirectorProject, "scene" | "objects">,
  position: Vec3
): Vec3 {
  const target = project.objects.find((object) => object.id === route.characterId && object.kind === "character");
  if (!target) return position;

  const grounded: Vec3 = route.snapToGround
    ? [position[0], project.scene.groundHeight, position[2]]
    : [...position] as Vec3;
  return grounded;
}

export function sampleResolvedMotionRoute(
  route: DirectorMotionRoute,
  project: Pick<DirectorProject, "scene" | "objects">,
  progress: number
): Vec3 {
  return resolveMotionRoutePosition(route, project, sampleMotionRoute(route, progress));
}

export function sampleMotionRoutePath(
  route: DirectorMotionRoute,
  project: Pick<DirectorProject, "scene" | "objects">,
  samplesPerSegment = 12
): Vec3[] {
  const segmentCount = route.loop ? route.points.length : route.points.length - 1;
  const sampleCount = Math.max(segmentCount * Math.max(2, samplesPerSegment), 2);
  const values: Vec3[] = [];

  for (let index = 0; index <= sampleCount; index += 1) {
    values.push(sampleResolvedMotionRoute(route, project, index / sampleCount));
  }

  return values;
}

export function getMotionRoutePoseId(route: DirectorMotionRoute, progress: number): string | null {
  let activePoseId = route.loop
    ? [...route.points].reverse().map((point) => readString(point.poseId)).find(Boolean) ?? null
    : null;
  const normalizedProgress = normalizeProgress(progress, route.loop);

  for (const point of route.points) {
    if (point.timestamp > normalizedProgress) break;
    const poseId = readString(point.poseId);
    if (poseId) activePoseId = poseId;
  }

  return activePoseId;
}

/**
 * Routes are editor-authored, so an unsafe path is surfaced to the user instead of
 * mutating it during playback. The checker sweeps every linearized curve segment
 * through a clearance-expanded obstacle footprint.
 */
export function getMotionRouteSafety(
  route: DirectorMotionRoute,
  project: Pick<DirectorProject, "scene" | "objects">
): MotionRouteSafety {
  const character = project.objects.find((object) => object.id === route.characterId && object.kind === "character");
  if (!character) return { status: "blocked", reason: "missing-character" };

  const segments = collectRouteSegments(route);
  if (!segments) return { status: "blocked", reason: "curve-too-complex" };

  const characterCollider = getCharacterCollider(character);
  const obstacles = project.objects
    .filter((object) => object.id !== character.id && object.visible && (object.kind === "character" || object.kind === "prop" || object.kind === "scene"))
    .map(createMotionObstacle)
    .sort((left, right) => left.id.localeCompare(right.id));

  for (const segment of segments) {
    const characterVerticalRange = {
      min: Math.min(segment.from[1], segment.to[1]) - CURVE_LINEARIZATION_ERROR,
      max: Math.max(segment.from[1], segment.to[1]) + characterCollider.height + CURVE_LINEARIZATION_ERROR,
    };

    for (const obstacle of obstacles) {
      if (!rangesOverlap(characterVerticalRange, obstacle.verticalRange)) continue;
      if (!segmentIntersectsObstacle(segment.from, segment.to, obstacle, characterCollider.radius + COLLISION_CLEARANCE + CURVE_LINEARIZATION_ERROR)) {
        continue;
      }

      return {
        status: "blocked",
        reason: "obstacle",
        obstacleId: obstacle.id,
        obstacleName: obstacle.name,
        segmentIndex: segment.index,
      };
    }
  }

  return { status: "safe" };
}

function getSegment(points: MotionRoutePoint[], progress: number, loop: boolean) {
  if (loop) {
    for (let index = 0; index < points.length; index += 1) {
      const start = points[index].timestamp;
      const end = index === points.length - 1 ? 1 : points[index + 1].timestamp;
      if (progress >= start && progress < end) {
        return {
          index,
          nextIndex: wrapIndex(index + 1, points.length),
          localProgress: (progress - start) / (end - start),
        };
      }
    }

    return { index: points.length - 1, nextIndex: 0, localProgress: 1 };
  }

  if (progress <= points[0].timestamp) return { index: 0, nextIndex: 1, localProgress: 0 };
  if (progress >= points[points.length - 1].timestamp) {
    return { index: points.length - 2, nextIndex: points.length - 1, localProgress: 1 };
  }

  for (let index = 0; index < points.length - 1; index += 1) {
    const start = points[index].timestamp;
    const end = points[index + 1].timestamp;
    if (progress <= end) {
      return {
        index,
        nextIndex: index + 1,
        localProgress: (progress - start) / (end - start),
      };
    }
  }

  return { index: points.length - 2, nextIndex: points.length - 1, localProgress: 1 };
}

function catmullRomInterpolate(p0: Vec3, p1: Vec3, p2: Vec3, p3: Vec3, progress: number): Vec3 {
  const t = clampNumber(progress, 0, 1, 0);
  const t2 = t * t;
  const t3 = t2 * t;

  return [0, 1, 2].map((axis) =>
    0.5 * (
      2 * p1[axis] +
      (-p0[axis] + p2[axis]) * t +
      (2 * p0[axis] - 5 * p1[axis] + 4 * p2[axis] - p3[axis]) * t2 +
      (-p0[axis] + 3 * p1[axis] - 3 * p2[axis] + p3[axis]) * t3
    )
  ) as Vec3;
}

function linearInterpolate(start: Vec3, end: Vec3, progress: number): Vec3 {
  const t = clampNumber(progress, 0, 1, 0);
  return [
    start[0] + (end[0] - start[0]) * t,
    start[1] + (end[1] - start[1]) * t,
    start[2] + (end[2] - start[2]) * t,
  ];
}

function normalizeProgress(progress: number, loop: boolean) {
  if (!Number.isFinite(progress)) return 0;
  if (!loop) return clampNumber(progress, 0, 1, 0);
  return ((progress % 1) + 1) % 1;
}

function normalizeTimestamps(values: Array<number | null>, loop: boolean) {
  const isValid = values.every((value, index) => {
    if (value === null || value < 0 || value > 1) return false;
    if (index === 0) return value === 0;
    if (value <= (values[index - 1] ?? -1)) return false;
    return !loop || value < 1;
  });

  if (isValid && (loop || values[values.length - 1] === 1)) {
    return values as number[];
  }

  return values.map((_, index) => index / (loop ? values.length : Math.max(values.length - 1, 1)));
}

function parseRoutePoint(value: unknown) {
  if (!isRecord(value) || !Array.isArray(value.position) || value.position.length !== 3) return null;
  const position = value.position.map((coordinate) => Number(coordinate));
  if (!position.every(Number.isFinite)) return null;

  const timestamp = typeof value.timestamp === "number" && Number.isFinite(value.timestamp) ? value.timestamp : null;
  return {
    id: readString(value.id),
    position: position as Vec3,
    timestamp,
    poseId: readString(value.poseId) || undefined,
  };
}

function resolveCharacterId(value: unknown, objects: DirectorObject[]) {
  const requestedId = readString(value);
  if (requestedId) {
    return objects.find((object) => object.id === requestedId && object.kind === "character")?.id ?? null;
  }

  return objects.find((object) => object.kind === "character")?.id ?? null;
}

function getObjectSize(object: DirectorObject): Vec3 {
  const [scaleX, scaleY, scaleZ] = object.transform.scale.map((value) => Math.max(Math.abs(value), 0.01));
  const [width, height, depth] = getBaseObjectSize(object);
  return [width * scaleX, height * scaleY, depth * scaleZ];
}

function getBaseObjectSize(object: DirectorObject): Vec3 {
  if (object.kind === "character") return [0.8, getCharacterHeight(object), 0.8];

  switch (object.geometryType) {
    case "cylinder":
      return [0.9, 1.2, 0.9];
    case "torus":
      return [1.18, 0.28, 1.18];
    case "cone":
      return [1, 1.1, 1];
    case "pyramid":
      return [1.1, 1.1, 1.1];
    case "sphere":
      return [1.1, 1.1, 1.1];
    case "box":
      return [1, 1, 1];
    default:
      return [2, 2, 2];
  }
}

function getCharacterCollider(object: DirectorObject) {
  const proportions = getBodyPreset(object.bodyType).proportions;
  const [scaleX, scaleY, scaleZ] = object.transform.scale.map((value) => Math.max(Math.abs(value), 0.01));
  const baseRadius = Math.max(
    proportions.shoulderWidth + proportions.shoulderRadius,
    proportions.legSpread + proportions.thighRadius,
    proportions.pelvisRadius * Math.max(proportions.pelvisScale[0], proportions.pelvisScale[2])
  );

  return {
    radius: baseRadius * Math.max(scaleX, scaleZ),
    height: getCharacterHeight(object) * scaleY,
  };
}

function getCharacterHeight(object: DirectorObject) {
  return object.characterRig?.rigType === "ue4-mannequin"
    ? getUE4GroundedLabelY(object.bodyType)
    : getGroundedLabelY(object.bodyType);
}

function createMotionObstacle(object: DirectorObject): MotionObstacle {
  if (object.kind === "character") {
    const collider = getCharacterCollider(object);
    return {
      id: object.id,
      name: object.name,
      verticalRange: {
        min: object.transform.position[1],
        max: object.transform.position[1] + collider.height,
      },
      footprint: {
        kind: "circle",
        center: [object.transform.position[0], object.transform.position[2]],
        radius: collider.radius,
      },
    };
  }

  const [width, height, depth] = getObjectSize(object);
  const [pitch, yaw, roll] = object.transform.rotation;
  const hasTilt = Math.abs(pitch) > 0.0001 || Math.abs(roll) > 0.0001;

  if (!hasTilt) {
    return {
      id: object.id,
      name: object.name,
      verticalRange: {
        min: object.transform.position[1],
        max: object.transform.position[1] + height,
      },
      footprint: {
        kind: "obb",
        center: [object.transform.position[0], object.transform.position[2]],
        halfWidth: width / 2,
        halfDepth: depth / 2,
        yaw,
      },
    };
  }

  const rotation = new Euler(pitch, yaw, roll);
  const center = new Vector3(0, height / 2, 0)
    .applyEuler(rotation)
    .add(new Vector3(...object.transform.position));
  const verticalHalfExtent =
    Math.abs(new Vector3(1, 0, 0).applyEuler(rotation).y) * width / 2 +
    Math.abs(new Vector3(0, 1, 0).applyEuler(rotation).y) * height / 2 +
    Math.abs(new Vector3(0, 0, 1).applyEuler(rotation).y) * depth / 2;

  return {
    id: object.id,
    name: object.name,
    verticalRange: {
      min: center.y - verticalHalfExtent,
      max: center.y + verticalHalfExtent,
    },
    footprint: {
      kind: "circle",
      center: [center.x, center.z],
      radius: Math.hypot(width, height, depth) / 2,
    },
  };
}

function collectRouteSegments(route: DirectorMotionRoute): RouteSegment[] | null {
  const segmentCount = route.loop ? route.points.length : route.points.length - 1;
  const segments: RouteSegment[] = [];

  for (let index = 0; index < segmentCount; index += 1) {
    const startProgress = route.points[index].timestamp;
    const endProgress = index === route.points.length - 1 ? 1 : route.points[index + 1].timestamp;
    const start = sampleMotionRoute(route, startProgress);
    const end = sampleMotionRoute(route, endProgress);

    if (!appendLinearizedSegments(route, index, startProgress, endProgress, start, end, 0, segments)) {
      return null;
    }
  }

  return segments;
}

function appendLinearizedSegments(
  route: DirectorMotionRoute,
  index: number,
  startProgress: number,
  endProgress: number,
  start: Vec3,
  end: Vec3,
  depth: number,
  segments: RouteSegment[]
): boolean {
  if (route.interpolationType === "linear") {
    segments.push({ index, from: start, to: end });
    return true;
  }

  const oneQuarter = sampleMotionRoute(route, startProgress + (endProgress - startProgress) * 0.25);
  const midpoint = sampleMotionRoute(route, startProgress + (endProgress - startProgress) * 0.5);
  const threeQuarters = sampleMotionRoute(route, startProgress + (endProgress - startProgress) * 0.75);
  const deviation = Math.max(
    distanceToSegment(oneQuarter, start, end),
    distanceToSegment(midpoint, start, end),
    distanceToSegment(threeQuarters, start, end)
  );

  if (deviation <= CURVE_LINEARIZATION_ERROR) {
    segments.push({ index, from: start, to: end });
    return true;
  }
  if (depth >= MAX_CURVE_SUBDIVISION_DEPTH) return false;

  const middleProgress = startProgress + (endProgress - startProgress) * 0.5;
  return appendLinearizedSegments(route, index, startProgress, middleProgress, start, midpoint, depth + 1, segments) &&
    appendLinearizedSegments(route, index, middleProgress, endProgress, midpoint, end, depth + 1, segments);
}

function segmentIntersectsObstacle(from: Vec3, to: Vec3, obstacle: MotionObstacle, clearanceRadius: number) {
  const start: Vec2 = [from[0], from[2]];
  const end: Vec2 = [to[0], to[2]];

  if (obstacle.footprint.kind === "circle") {
    return segmentDistanceSquared(start, end, obstacle.footprint.center) <= (obstacle.footprint.radius + clearanceRadius) ** 2;
  }

  const localStart = toObstacleLocal(start, obstacle.footprint);
  const localEnd = toObstacleLocal(end, obstacle.footprint);
  return segmentIntersectsRectangle(
    localStart,
    localEnd,
    obstacle.footprint.halfWidth + clearanceRadius,
    obstacle.footprint.halfDepth + clearanceRadius
  );
}

function toObstacleLocal(point: Vec2, obstacle: Extract<MotionObstacle["footprint"], { kind: "obb" }>): Vec2 {
  const x = point[0] - obstacle.center[0];
  const z = point[1] - obstacle.center[1];
  const cosine = Math.cos(obstacle.yaw);
  const sine = Math.sin(obstacle.yaw);
  return [cosine * x - sine * z, sine * x + cosine * z];
}

function segmentIntersectsRectangle(start: Vec2, end: Vec2, halfWidth: number, halfDepth: number) {
  let minimum = 0;
  let maximum = 1;

  for (const [startCoordinate, delta, extent] of [
    [start[0], end[0] - start[0], halfWidth],
    [start[1], end[1] - start[1], halfDepth],
  ] as const) {
    if (Math.abs(delta) < Number.EPSILON) {
      if (startCoordinate < -extent || startCoordinate > extent) return false;
      continue;
    }

    const first = (-extent - startCoordinate) / delta;
    const second = (extent - startCoordinate) / delta;
    minimum = Math.max(minimum, Math.min(first, second));
    maximum = Math.min(maximum, Math.max(first, second));
    if (minimum > maximum) return false;
  }

  return true;
}

function segmentDistanceSquared(start: Vec2, end: Vec2, point: Vec2) {
  const deltaX = end[0] - start[0];
  const deltaZ = end[1] - start[1];
  const lengthSquared = deltaX * deltaX + deltaZ * deltaZ;
  const progress = lengthSquared === 0
    ? 0
    : Math.min(1, Math.max(0, ((point[0] - start[0]) * deltaX + (point[1] - start[1]) * deltaZ) / lengthSquared));
  const nearestX = start[0] + deltaX * progress;
  const nearestZ = start[1] + deltaZ * progress;
  return (point[0] - nearestX) ** 2 + (point[1] - nearestZ) ** 2;
}

function distanceToSegment(point: Vec3, start: Vec3, end: Vec3) {
  const deltaX = end[0] - start[0];
  const deltaY = end[1] - start[1];
  const deltaZ = end[2] - start[2];
  const lengthSquared = deltaX * deltaX + deltaY * deltaY + deltaZ * deltaZ;
  const progress = lengthSquared === 0
    ? 0
    : Math.min(1, Math.max(0, ((point[0] - start[0]) * deltaX + (point[1] - start[1]) * deltaY + (point[2] - start[2]) * deltaZ) / lengthSquared));
  const nearestX = start[0] + deltaX * progress;
  const nearestY = start[1] + deltaY * progress;
  const nearestZ = start[2] + deltaZ * progress;
  return Math.hypot(point[0] - nearestX, point[1] - nearestY, point[2] - nearestZ);
}

function rangesOverlap(left: VerticalRange, right: VerticalRange) {
  return left.min < right.max && left.max > right.min;
}

function wrapIndex(index: number, length: number) {
  return ((index % length) + length) % length;
}

function clampNumber(value: unknown, minimum: number, maximum: number, fallback: number) {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(maximum, Math.max(minimum, number));
}

function readString(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
