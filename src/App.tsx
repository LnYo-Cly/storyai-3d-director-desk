import "./styles/index.css";
import { useEffect } from "react";
import { Route } from "lucide-react";
import { DirectorDeskShell } from "./app/layout/DirectorDeskShell";
import { DirectorCanvas } from "./editor/canvas/DirectorCanvas";
import { ViewportSensitivitySettings } from "./editor/canvas/ViewportSensitivitySettings";
import { initDirectorDeskHostBridge, postDirectorDeskMessageToHost } from "./editor/io/hostBridge";
import { useDirectorStore } from "./editor/store/directorStore";

function isEditableShortcutTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false;

  return target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
}

export default function App() {
  const viewMode = useDirectorStore((state) => state.viewMode);
  const setViewMode = useDirectorStore((state) => state.setViewMode);
  const motionStudioOpen = useDirectorStore((state) => state.motionStudioOpen);
  const setMotionStudioOpen = useDirectorStore((state) => state.setMotionStudioOpen);

  useEffect(() => {
    initDirectorDeskHostBridge();
    postDirectorDeskMessageToHost({ type: "storyai:director-desk-ready" });
  }, []);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (
        event.defaultPrevented
        || event.repeat
        || isEditableShortcutTarget(event.target)
        || (!event.metaKey && !event.ctrlKey)
      ) {
        return;
      }

      const key = event.key.toLowerCase();
      if (key === "c") {
        event.preventDefault();
        useDirectorStore.getState().copySelectedObjects();
      } else if (key === "v") {
        event.preventDefault();
        useDirectorStore.getState().pasteClipboardObjects();
      } else if (key === "z" && !event.shiftKey) {
        event.preventDefault();
        useDirectorStore.getState().undo();
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  return (
    <div className="app-shell">
      <header className="top-bar top-bar--embedded" aria-label="导演台工作区控制">
        <div className="top-bar-center">
          <div className="mode-toggle ui-segmented" role="group" aria-label="视角切换">
            <button
              className={`mode-toggle-button ui-segmented-item ${viewMode === "director" ? "ui-segmented-item-active" : ""}`}
              aria-pressed={viewMode === "director"}
              type="button"
              onClick={() => setViewMode("director")}
            >
              导演视角
            </button>
            <button
              className={`mode-toggle-button ui-segmented-item ${viewMode === "camera" ? "ui-segmented-item-active" : ""}`}
              aria-pressed={viewMode === "camera"}
              type="button"
              onClick={() => setViewMode("camera")}
            >
              第一视角
            </button>
          </div>
          <button
            className={`top-bar-motion-button${motionStudioOpen ? " is-active" : ""}`}
            type="button"
            aria-pressed={motionStudioOpen}
            onClick={() => {
              setViewMode("director");
              setMotionStudioOpen(!motionStudioOpen);
            }}
          >
            <Route aria-hidden="true" size={15} />
            运镜
          </button>
          <ViewportSensitivitySettings />
        </div>
      </header>
      <DirectorDeskShell>
        <DirectorCanvas />
      </DirectorDeskShell>
    </div>
  );
}
