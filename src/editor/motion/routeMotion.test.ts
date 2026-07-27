import { expect, it } from "vitest";
import { createDefaultDirectorProject } from "../store/directorStore";
import {
  getMotionRoutePoseId,
  getMotionRouteSafety,
  normalizeMotionRoute,
  sampleMotionRoute,
  sampleMotionRoutePath,
  sampleResolvedMotionRoute,
  resolveMotionRoutePosition,
} from "./routeMotion";

it("normalizes host routes, preserves pose keys, and reports blocked paths", () => {
  const project = createDefaultDirectorProject();
  const character = project.objects.find((object) => object.kind === "character");
  expect(character).toBeTruthy();

  project.objects.push({
    id: "blocking-prop",
    name: "阻挡物",
    kind: "prop",
    visible: true,
    locked: false,
    geometryType: "box",
    transform: {
      position: [0, 0, 0],
      rotation: [0, 0, 0],
      scale: [1, 1, 1],
    },
  });

  const route = normalizeMotionRoute(
    {
      id: "route-1",
      characterId: character!.id,
      interpolationType: "linear",
      duration: 4,
      snapToGround: true,
      points: [
        { id: "start", position: [0, 9, 0], timestamp: 0, poseId: "walk" },
        { id: "middle", position: [4, 9, 0], timestamp: 0.25, poseId: "run" },
        { id: "end", position: [8, 9, 0], timestamp: 1 },
      ],
    },
    project
  );

  expect(route).toBeTruthy();
  expect(route?.points[0]?.position[1]).toBe(project.scene.groundHeight);
  expect(route?.points[0]?.position[0]).toBe(0);
  expect(route?.points[0]?.poseId).toBe("walk");
  const timedPoint = sampleMotionRoute(route!, 0.25);
  expect(timedPoint[0]).toBeCloseTo(route?.points[1]?.position[0] ?? 0);
  expect(timedPoint[1]).toBeCloseTo(route?.points[1]?.position[1] ?? 0);
  expect(timedPoint[2]).toBeCloseTo(route?.points[1]?.position[2] ?? 0);
  expect(sampleResolvedMotionRoute(route!, project, 0)[0]).toBe(0);
  expect(getMotionRoutePoseId(route!, 0.1)).toBe("walk");
  expect(getMotionRoutePoseId(route!, 0.25)).toBe("run");
  expect(getMotionRouteSafety(route!, project)).toMatchObject({
    status: "blocked",
    reason: "obstacle",
    obstacleId: "blocking-prop",
  });
});

it("sweeps a character through rotated obstacles and respects vertical clearance", () => {
  const project = createDefaultDirectorProject();
  project.objects.push({
    id: "rotated-wall",
    name: "旋转墙体",
    kind: "prop",
    visible: true,
    locked: false,
    geometryType: "box",
    transform: {
      position: [0, 0, 0],
      rotation: [0, Math.PI / 4, 0],
      scale: [3, 1, 0.2],
    },
  });

  const throughRotatedWall = normalizeMotionRoute(
    {
      id: "rotated-route",
      characterId: "char_default_a",
      interpolationType: "linear",
      duration: 2,
      snapToGround: true,
      points: [
        { id: "one", position: [0.55, 0, -0.55], timestamp: 0 },
        { id: "two", position: [0.95, 0, -0.95], timestamp: 1 },
      ],
    },
    project
  );

  expect(throughRotatedWall).toBeTruthy();
  expect(getMotionRouteSafety(throughRotatedWall!, project)).toMatchObject({
    status: "blocked",
    obstacleId: "rotated-wall",
  });

  const elevatedRoute = normalizeMotionRoute(
    {
      id: "elevated-route",
      characterId: "char_default_a",
      interpolationType: "linear",
      duration: 2,
      snapToGround: false,
      points: [
        { id: "one", position: [0.55, 4, -0.55], timestamp: 0 },
        { id: "two", position: [0.95, 4, -0.95], timestamp: 1 },
      ],
    },
    project
  );

  expect(elevatedRoute).toBeTruthy();
  expect(getMotionRouteSafety(elevatedRoute!, project)).toEqual({ status: "safe" });
});

it("catches a thin obstacle crossed between route points", () => {
  const project = createDefaultDirectorProject();
  project.objects.push({
    id: "thin-wall",
    name: "薄墙",
    kind: "prop",
    visible: true,
    locked: false,
    geometryType: "box",
    transform: {
      position: [0, 0, 0],
      rotation: [0, 0, 0],
      scale: [0.02, 1, 4],
    },
  });

  const route = normalizeMotionRoute(
    {
      id: "swept-route",
      characterId: "char_default_a",
      interpolationType: "linear",
      duration: 2,
      snapToGround: true,
      points: [
        { id: "one", position: [-2, 0, 0], timestamp: 0 },
        { id: "two", position: [2, 0, 0], timestamp: 1 },
      ],
    },
    project
  );

  expect(getMotionRouteSafety(route!, project)).toMatchObject({
    status: "blocked",
    obstacleId: "thin-wall",
  });
});

it("checks the Catmull-Rom arc instead of only its control points", () => {
  const project = createDefaultDirectorProject();
  project.objects.push({
    id: "arc-wall",
    name: "弧线墙体",
    kind: "prop",
    visible: true,
    locked: false,
    geometryType: "box",
    transform: {
      position: [0, 0, 1.35],
      rotation: [0, 0, 0],
      scale: [0.1, 1, 0.02],
    },
  });

  const route = normalizeMotionRoute(
    {
      id: "curved-route",
      characterId: "char_default_a",
      interpolationType: "catmull-rom",
      duration: 4,
      snapToGround: true,
      points: [
        { id: "one", position: [-2, 0, -2], timestamp: 0 },
        { id: "two", position: [-1, 0, 1], timestamp: 1 / 3 },
        { id: "three", position: [1, 0, 1], timestamp: 2 / 3 },
        { id: "four", position: [2, 0, -2], timestamp: 1 },
      ],
    },
    project
  );

  expect(route).toBeTruthy();
  expect(getMotionRouteSafety(route!, project)).toMatchObject({
    status: "blocked",
    obstacleId: "arc-wall",
    segmentIndex: 1,
  });
});

it("rejects malformed routes and projects routes without a character", () => {
  const project = createDefaultDirectorProject();
  const noCharacters = { ...project, objects: project.objects.filter((object) => object.kind !== "character") };

  expect(normalizeMotionRoute({ points: [] }, project)).toBeNull();
  expect(
    normalizeMotionRoute(
      { points: [{ position: [0, 0, 0] }, { position: [1, "bad", 0] }] },
      project
    )
  ).toBeNull();
  expect(
    normalizeMotionRoute(
      { points: [{ position: [0, 0, 0] }, { position: [1, 0, 0] }] },
      noCharacters
    )
  ).toBeNull();
  expect(
    normalizeMotionRoute(
      { characterId: "missing-character", points: [{ position: [0, 0, 0] }, { position: [1, 0, 0] }] },
      project
    )
  ).toBeNull();
});

it("uses loop timestamps for every segment, including the return to the first point", () => {
  const project = createDefaultDirectorProject();
  const route = normalizeMotionRoute(
    {
      characterId: "char_default_a",
      interpolationType: "linear",
      loop: true,
      duration: 4,
      points: [
        { id: "one", position: [0, 0, 0], timestamp: 0 },
        { id: "two", position: [2, 0, 0], timestamp: 0.2 },
        { id: "three", position: [4, 0, 0], timestamp: 0.7 },
      ],
    },
    project
  );

  expect(route).toBeTruthy();
  expect(sampleMotionRoute(route!, 0.1)[0]).toBeCloseTo(1);
  expect(sampleMotionRoute(route!, 0.45)[0]).toBeCloseTo(3);
  expect(sampleMotionRoute(route!, 0.85)[0]).toBeCloseTo(2);
});

it("handles degenerate samples, generated timestamps, and loop pose carry-over", () => {
  const project = createDefaultDirectorProject();
  const route = normalizeMotionRoute(
    {
      characterId: "char_default_a",
      loop: true,
      duration: "invalid",
      points: [
        { position: [0, 0, 0], timestamp: 0, poseId: "idle" },
        { id: "middle", position: [2, 0, 0], timestamp: 0.3, poseId: "walk" },
        { id: "end", position: [4, 0, 0], timestamp: 0.8 },
      ],
    },
    project
  );

  expect(route).toBeTruthy();
  expect(route?.duration).toBe(10);
  expect(route?.points.map((point) => point.id)).toEqual(["point-1", "middle", "end"]);
  expect(getMotionRoutePoseId(route!, 0.1)).toBe("idle");
  expect(getMotionRoutePoseId(route!, -0.1)).toBe("walk");
  expect(sampleMotionRoutePath(route!, project)).toHaveLength(37);
  expect(sampleMotionRoute({ ...route!, points: [] }, 0.5)).toEqual([0, 0, 0]);
  expect(sampleMotionRoute({ ...route!, points: [route!.points[0]] }, 0.5)).toEqual(route!.points[0]?.position);
});

it("keeps an explicitly elevated route and safely handles an unavailable target", () => {
  const project = createDefaultDirectorProject();
  const route = normalizeMotionRoute(
    {
      characterId: "char_default_a",
      interpolationType: "linear",
      snapToGround: false,
      duration: 999,
      points: [
        { position: [0, 3, 0], timestamp: 0 },
        { position: [2, 3, 0], timestamp: 1 },
      ],
    },
    project
  );

  expect(route).toBeTruthy();
  expect(route?.duration).toBe(120);
  expect(sampleResolvedMotionRoute(route!, project, 0.5)).toEqual([1, 3, 0]);
  expect(resolveMotionRoutePosition({ ...route!, characterId: "removed-character" }, project, [1, 7, 2])).toEqual([1, 7, 2]);
});

it("checks character, tilted, and primitive obstacle geometry without false positives", () => {
  const project = createDefaultDirectorProject();
  const defaultCharacter = project.objects.find((object) => object.id === "char_default_a");
  if (!defaultCharacter) throw new Error("Expected default character");

  project.objects.push({
    ...defaultCharacter,
    id: "character-obstacle",
    name: "角色02",
    transform: { ...defaultCharacter.transform, position: [20, 0, 20] },
    characterRig: { rigType: "mannequin", posePresetId: "stand", controls: {} },
  });

  for (const [index, geometryType] of (["cylinder", "torus", "cone", "pyramid", "sphere"] as const).entries()) {
    project.objects.push({
      id: `primitive-${geometryType}`,
      name: geometryType,
      kind: "prop",
      visible: true,
      locked: false,
      geometryType,
      transform: {
        position: [30 + index * 3, 0, 30],
        rotation: geometryType === "sphere" ? [0.2, 0, 0] : [0, 0, 0],
        scale: [1, 1, 1],
      },
    });
  }
  project.objects.push({
    id: "scene-default-size",
    name: "场景模型",
    kind: "scene",
    visible: true,
    locked: false,
    transform: { position: [50, 0, 50], rotation: [0, 0, 0], scale: [1, 1, 1] },
  });

  const route = normalizeMotionRoute(
    {
      characterId: "char_default_a",
      interpolationType: "linear",
      points: [
        { position: [-3, 0, -3], timestamp: 0 },
        { position: [-2, 0, -3], timestamp: 1 },
      ],
    },
    project
  );

  expect(getMotionRouteSafety(route!, project)).toEqual({ status: "safe" });
});
