import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { vi } from "vitest";
import App from "../App";
import { clearDirectorDeskHostBridge } from "../editor/io/hostBridge";
import { createInitialDirectorState, useDirectorStore } from "../editor/store/directorStore";

vi.mock("../editor/canvas/DirectorCanvas", () => ({
  DirectorCanvas: () => <div data-testid="mock-director-canvas" />,
}));

beforeEach(() => {
  clearDirectorDeskHostBridge();
  localStorage.clear();
  window.history.replaceState({}, "", "/?instanceId=workflow_node_1");
  useDirectorStore.setState({
    ...useDirectorStore.getState(),
    ...createInitialDirectorState(),
  });
});

it("renders the embedded workspace controls without a duplicate home, desk picker, or close bar", () => {
  const { container } = render(<App />);

  expect(screen.getByLabelText("导演台工作区控制")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "导演视角" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "第一视角" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "运镜" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "视角手感" })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "返回首页" })).not.toBeInTheDocument();
  expect(screen.queryByRole("combobox", { name: "选择导演台" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "关闭" })).not.toBeInTheDocument();
  expect(container.querySelector(".top-bar--embedded")).toBeInTheDocument();
});

it("notifies the host canvas when the embedded desk is ready", () => {
  const postMessage = vi.spyOn(window.parent, "postMessage").mockImplementation(() => undefined);

  render(<App />);

  expect(postMessage).toHaveBeenCalledWith(
    { type: "storyai:director-desk-ready" },
    window.location.origin
  );
});

it("uses a full-width director desk frame instead of floating card columns", () => {
  const { container } = render(<App />);
  const shell = container.querySelector(".director-shell.director-shell-fullbleed");

  expect(shell).toBeInTheDocument();
  expect(shell?.firstElementChild).toHaveClass("viewport-column");
  expect(screen.getByLabelText("场景")).toHaveClass("left-sidebar");
  expect(screen.getByLabelText("3D视口")).toHaveClass("viewport-column");
  expect(screen.getByLabelText("属性")).toHaveClass("right-sidebar");
});

it("switches from director mode to camera mode", async () => {
  const user = userEvent.setup();
  render(<App />);

  const directorButton = screen.getByRole("button", { name: "导演视角" });
  const cameraButton = screen.getByRole("button", { name: "第一视角" });
  await user.click(cameraButton);

  expect(directorButton).toHaveAttribute("aria-pressed", "false");
  expect(cameraButton).toHaveAttribute("aria-pressed", "true");
});

it("opens the upstream motion workspace from the compact header", async () => {
  const user = userEvent.setup();
  render(<App />);

  await user.click(screen.getByRole("button", { name: "运镜" }));

  expect(useDirectorStore.getState().motionStudioOpen).toBe(true);
  expect(useDirectorStore.getState().viewMode).toBe("director");
});

it("supports Cmd/Ctrl+C and Cmd/Ctrl+V to duplicate the selected object", async () => {
  const user = userEvent.setup();
  render(<App />);

  await user.click(screen.getByRole("button", { name: "角色01" }));
  await user.keyboard("{Control>}c{/Control}");
  await user.keyboard("{Control>}v{/Control}");

  const characters = useDirectorStore.getState().project.objects.filter((item) => item.kind === "character");
  expect(characters).toHaveLength(2);
  expect(useDirectorStore.getState().selectedObjectId).toBe(characters[1]?.id ?? null);
});

it("ignores repeated Cmd/Ctrl+Z events so holding the shortcut only undoes once", () => {
  render(<App />);
  act(() => {
    useDirectorStore.getState().addPresetCharacter("female");
    useDirectorStore.getState().addPresetCharacter("broad");
  });

  act(() => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "z", ctrlKey: true, repeat: false }));
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "z", ctrlKey: true, repeat: true }));
  });

  expect(useDirectorStore.getState().project.objects.filter((item) => item.kind === "character")).toHaveLength(2);
});
