import { describe, expect, it } from "vitest";
import { createInitialDirectorState } from "../../store/directorStore";
import { getCameraPlaybackSnapshot } from "../cameraPlayback";
import { getObjectMotionSnapshot } from "../objectMotion";
import type { DirectorCameraShot, DirectorObject } from "../directorProject";
import { constrainCameraPosition, constrainObjectMotionTransform } from "../pathCollision";

function createFixture() {
  const project = createInitialDirectorState().project;
  const character = project.objects.find((object) => object.kind === "character")!;
  const obstacle: DirectorObject = {
    ...character,
    id: "collision_box",
    name: "碰撞箱",
    kind: "prop",
    geometryType: "box",
    motionPath: undefined,
    transform: {
      position: [0, 0, 0],
      rotation: [0, 0, 0],
      scale: [2, 2, 2],
    },
  };
  return { character, obstacle, scene: project.scene };
}

describe("path collision", () => {
  it("preserves authored positions while collision is disabled", () => {
    const { character, obstacle, scene } = createFixture();
    const transform = { ...character.transform, position: [0, 5, 0] as [number, number, number] };

    expect(constrainObjectMotionTransform(character, transform, scene, [character, obstacle])).toBe(transform);
    expect(constrainCameraPosition([0, -2, 0], scene, [obstacle])).toEqual([0, -2, 0]);
  });

  it("grounds characters and pushes their route outside scene obstacles", () => {
    const { character, obstacle, scene } = createFixture();
    const collisionScene = { ...scene, groundHeight: 1.5, pathCollisionEnabled: true };
    const transform = { ...character.transform, position: [0, 8, 0] as [number, number, number] };

    const result = constrainObjectMotionTransform(character, transform, collisionScene, [character, obstacle]);

    expect(result.position[1]).toBe(1.5);
    expect(Math.abs(result.position[0]) > 1.1 || Math.abs(result.position[2]) > 1.1).toBe(true);
  });

  it("does not rescan static props when collision is enabled", () => {
    const { character, obstacle, scene } = createFixture();
    const collisionScene = { ...scene, pathCollisionEnabled: true };

    expect(constrainObjectMotionTransform(obstacle, obstacle.transform, collisionScene, [character, obstacle]))
      .toBe(obstacle.transform);
  });

  it("keeps the camera above ground and outside obstacles", () => {
    const { obstacle, scene } = createFixture();
    const collisionScene = { ...scene, groundHeight: 0, pathCollisionEnabled: true };

    const belowGround = constrainCameraPosition([5, -3, 5], collisionScene, [obstacle]);
    const insideObstacle = constrainCameraPosition([0, 0.5, 0], collisionScene, [obstacle]);

    expect(belowGround[1]).toBeGreaterThanOrEqual(0.18);
    expect(insideObstacle[1]).toBeGreaterThanOrEqual(0.18);
    expect(Math.abs(insideObstacle[0]) > 1.1 || Math.abs(insideObstacle[2]) > 1.1 || insideObstacle[1] > 2).toBe(true);
  });

  it("keeps every sampled actor and camera playback point outside a static obstacle", () => {
    const { character, obstacle, scene } = createFixture();
    const collisionScene = { ...scene, groundHeight: 1.25, pathCollisionEnabled: true };
    const movingCharacter: DirectorObject = {
      ...character,
      motionPath: {
        interpolation: "linear",
        keyframes: [
          { id: "route_start", time: 0, transform: { ...character.transform, position: [-3, 4, 0] } },
          { id: "route_end", time: 1, transform: { ...character.transform, position: [3, 4, 0] } },
        ],
      },
    };
    const camera: DirectorCameraShot = {
      id: "collision_camera",
      name: "穿越障碍的机位",
      fov: 50,
      transform: { position: [-3, -2, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
      targetMode: "manual",
      target: [0, 1.25, 0],
      motionPath: {
        duration: 4,
        loop: false,
        interpolation: "linear",
        easing: "linear",
        keyframes: [
          { id: "camera_start", time: 0, position: [-3, -2, 0], target: [0, 1.25, 0], fov: 50 },
          { id: "camera_end", time: 1, position: [3, 0.5, 0], target: [0, 1.25, 0], fov: 50 },
        ],
      },
    };

    for (let sample = 0; sample <= 10; sample += 1) {
      const progress = sample / 10;
      const actor = constrainObjectMotionTransform(
        movingCharacter,
        getObjectMotionSnapshot(movingCharacter, progress, 4),
        collisionScene,
        [movingCharacter, obstacle]
      );
      const playback = getCameraPlaybackSnapshot(camera, [movingCharacter, obstacle], progress, collisionScene);

      expect(actor.position[1]).toBe(1.25);
      expect(Math.abs(actor.position[0]) >= 1.42 || Math.abs(actor.position[2]) >= 1.42).toBe(true);
      expect(playback.position[1]).toBeGreaterThanOrEqual(1.43);
      expect(
        Math.abs(playback.position[0]) >= 1.28 ||
        Math.abs(playback.position[2]) >= 1.28 ||
        playback.position[1] >= 2.58
      ).toBe(true);
    }
  });
});
