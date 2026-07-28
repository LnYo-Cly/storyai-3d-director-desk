import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach } from "vitest";
import { DEFAULT_CAMERA_MOTION_PATH } from "../../schema/cameraMotion";
import { createInitialDirectorState, useDirectorStore } from "../../store/directorStore";
import { CharacterPanel } from "../../panels/CharacterPanel";
import { MotionStudio } from "../MotionStudio";
import { ObjectMotionTransport } from "../ObjectMotionTransport";

beforeEach(() => {
  const initialState = createInitialDirectorState();
  useDirectorStore.setState({
    ...useDirectorStore.getState(),
    ...initialState,
    project: {
      ...initialState.project,
      cameras: initialState.project.cameras.map((camera) => ({
        ...camera,
        motionPath: { ...DEFAULT_CAMERA_MOTION_PATH, keyframes: [] },
      })),
    },
    cameraPilotMode: "idle",
    motionStudioOpen: true,
  });
});

it("runs the director workspace smoke path from a camera preset through playback and timeline scrubbing", async () => {
  const user = userEvent.setup();
  render(
    <>
      <MotionStudio getViewportCameraSnapshot={() => ({ position: [0, 2, 8], target: [0, 1, 0], fov: 50 })} />
      <ObjectMotionTransport />
    </>
  );

  expect(screen.getByRole("region", { name: "运镜工作台" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "套用推镜镜头预设" })).toBeInTheDocument();
  expect(screen.getByRole("slider", { name: "场景动作时间轴" })).toBeInTheDocument();
  expect(useDirectorStore.getState().project.cameras[0]?.motionPath?.keyframes).toHaveLength(0);

  await user.click(screen.getByRole("button", { name: "套用推镜镜头预设" }));
  expect(useDirectorStore.getState().project.cameras[0]?.motionPath?.keyframes).toHaveLength(3);

  await user.click(screen.getByRole("button", { name: "播放第一视角运镜预演" }));
  expect(useDirectorStore.getState().viewMode).toBe("camera");
  expect(useDirectorStore.getState().cameraMotionPlaying).toBe(true);

  fireEvent.change(screen.getByRole("slider", { name: "场景动作时间轴" }), { target: { value: "0.5" } });
  expect(useDirectorStore.getState().cameraMotionPlaying).toBe(false);
  expect(useDirectorStore.getState().cameraMotionProgress).toBe(0.5);

  await user.click(screen.getByRole("button", { name: "关闭运镜工作台" }));
  expect(useDirectorStore.getState().motionStudioOpen).toBe(false);
});

it("runs a character route from editor controls through shared timeline scrubbing", async () => {
  const user = userEvent.setup();
  useDirectorStore.setState({
    ...useDirectorStore.getState(),
    motionStudioOpen: false,
    selectedObjectId: "char_default_a",
    selectedObjectIds: ["char_default_a"],
  });

  render(
    <>
      <CharacterPanel />
      <ObjectMotionTransport />
    </>
  );

  await user.click(screen.getByRole("button", { name: "路线" }));
  await user.click(screen.getByRole("button", { name: "添加点" }));
  await user.click(screen.getByRole("button", { name: "添加点" }));

  expect(screen.getByRole("button", { name: "选择路线点 2" })).toHaveAttribute("aria-pressed", "true");
  expect(useDirectorStore.getState().project.objects.find((item) => item.id === "char_default_a")?.motionPath?.keyframes).toHaveLength(2);

  useDirectorStore.getState().setCameraMotionPlaying(true);
  fireEvent.change(screen.getByRole("slider", { name: "场景动作时间轴" }), { target: { value: "0.5" } });

  expect(useDirectorStore.getState().cameraMotionPlaying).toBe(false);
  expect(useDirectorStore.getState().cameraMotionProgress).toBe(0.5);
});
