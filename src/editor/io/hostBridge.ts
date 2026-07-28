import { useDirectorStore } from "../store/directorStore";
import { getCameraMotionPath } from "../schema/cameraMotion";
import type { DirectorProject } from "../schema/directorProject";
import { normalizeObjectMotionPath } from "../schema/objectMotion";
import {
  getMotionRouteSafety,
  normalizeMotionRoute,
  type DirectorMotionRoute,
  type MotionRouteSafety,
} from "../motion/routeMotion";
import {
  DIRECTOR_EXTENSION_PROTOCOL_VERSION,
  DIRECTOR_EXTENSION_REQUEST_TYPE,
  DIRECTOR_EXTENSION_RESPONSE_TYPE,
  createDirectorExtensionResponse,
  isDirectorExtensionAction,
  parseDirectorExtensionRequest,
  type DirectorExtensionResponsePayload,
} from "./extensionProtocol";
import { requestCleanFrameExport } from "./cleanFrameExport";
import { requestReferenceVideoExport } from "./referenceVideoExport";
import {
  createDirectorProjectDocument,
  getDirectorProjectFingerprint,
  parseDirectorProjectDocument,
} from "./projectDocument";
import { listDirectorPluginResults, submitDirectorPluginResult } from "./pluginResultRegistry";
import {
  initTauriDirectorHostTransport,
  postTauriDirectorHostMessage,
  type DirectorDeskTransportMessage,
} from "./tauriHostTransport";

interface HostPanoramaPayload {
  edgeId?: unknown;
  sourceNodeId?: unknown;
  imageUrl?: unknown;
  fileName?: unknown;
}

interface HostSessionPayload {
  instanceId?: unknown;
  theme?: unknown;
  route?: unknown;
  project?: unknown;
}

interface HostRoutePayload {
  route?: unknown;
}

export interface HostCaptureItemPayload {
  dataUrl?: unknown;
  fileName?: unknown;
}

export interface HostCaptureBatchPayload {
  captures?: HostCaptureItemPayload[];
}

export interface DirectorDeskReferenceVideoPayload {
  exportId: string;
  video: Blob;
  fileName: string;
  mimeType: string;
  durationMs: number;
  fps: number;
  width: number;
  height: number;
  cameraPath: Array<{ fov: number; position: number[]; target: number[] }>;
}

export interface DirectorDeskExportStatus {
  exportId: string;
  ok: boolean;
  message: string;
}

let initialized = false;
let activeExtensionExportRequestId: string | null = null;
let clearTauriTransport: (() => void) | null = null;
let hostedRoute: DirectorMotionRoute | null = null;
let hostedRouteCharacterId: string | null = null;
let removeMotionRouteUnsubscribe: (() => void) | null = null;
let removeProjectUnsubscribe: (() => void) | null = null;
let suppressNextMotionRouteNotice = false;
let suppressNextProjectNotice = false;
let hostedInstanceId: string | null = null;
let hostedProjectFingerprint = "";
let projectSyncTimer: ReturnType<typeof window.setTimeout> | null = null;
export const DIRECTOR_DESK_SESSION_OPENED_EVENT = "storyai:director-desk-session-opened";
export const DIRECTOR_DESK_EXPORT_STATUS_EVENT = "storyai:director-desk-export-status";

function normalizeString(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

const HOST_ORIGIN_QUERY_KEY = "hostOrigin";

function normalizeOrigin(value: unknown) {
  const text = normalizeString(value);
  if (!text) return null;

  try {
    return new URL(text).origin;
  } catch {
    return null;
  }
}

export function getDirectorDeskHostOrigin() {
  try {
    const params = new URLSearchParams(window.location.search);
    return normalizeOrigin(params.get(HOST_ORIGIN_QUERY_KEY)) ?? window.location.origin;
  } catch {
    return window.location.origin;
  }
}

function isAllowedHostEvent(event: MessageEvent) {
  const fromExpectedOrigin = event.origin === getDirectorDeskHostOrigin();
  const fromParentWindow = window.parent === window || event.source === window.parent;
  return fromExpectedOrigin && fromParentWindow;
}

function normalizeTheme(value: unknown): "dark" | "light" | null {
  return value === "light" || value === "dark" ? value : null;
}

function applyDirectorDeskTheme(theme: "dark" | "light") {
  document.documentElement.dataset.theme = theme;
  document.documentElement.classList.toggle("dark", theme === "dark");
}

function getInitialHostTheme() {
  try {
    return normalizeTheme(new URLSearchParams(window.location.search).get("theme"));
  } catch {
    return null;
  }
}

export function isDirectorDeskCanvasEmbedded() {
  try {
    return new URLSearchParams(window.location.search).get("embed") === "canvas";
  } catch {
    return false;
  }
}

function getActiveCamera(project: DirectorProject) {
  return project.cameras.find((camera) => camera.id === project.activeCameraId)
    ?? project.cameras[0]
    ?? null;
}

function routeFingerprint(route: DirectorMotionRoute | null) {
  return JSON.stringify(route);
}

function createHostedRouteSeed(characterId: string): DirectorMotionRoute {
  return {
    id: `route-${characterId}`,
    characterId,
    points: [],
    interpolationType: "catmull-rom",
    loop: false,
    duration: 10,
    snapToGround: true,
  };
}

/**
 * The Zhiying host owns a single workflow-node route. The editor owns object
 * motion paths, so this adapter keeps the host payload stable while letting
 * the upstream timeline remain the only in-editor route UI.
 */
export function getHostedMotionRoute(
  project: DirectorProject = useDirectorStore.getState().project
): DirectorMotionRoute | null {
  const characterId = hostedRouteCharacterId ?? hostedRoute?.characterId;
  if (!characterId) return null;

  const route = hostedRoute?.characterId === characterId
    ? hostedRoute
    : createHostedRouteSeed(characterId);

  const character = project.objects.find(
    (object) => object.id === characterId && object.kind === "character"
  );
  if (!character) return null;

  const motionPath = normalizeObjectMotionPath(character.motionPath, character.transform);
  if (motionPath.keyframes.length < 2) return null;

  const camera = getActiveCamera(project);
  const cameraPath = camera ? getCameraMotionPath(camera) : null;
  const poseIds = new Map(route.points.map((point) => [point.id, point.poseId]));

  return normalizeMotionRoute(
    {
      ...route,
      characterId: character.id,
      interpolationType: motionPath.interpolation === "linear" ? "linear" : "catmull-rom",
      loop: cameraPath?.loop ?? route.loop,
      duration: cameraPath?.duration ?? route.duration,
      points: motionPath.keyframes.map((keyframe) => ({
        id: keyframe.id,
        position: keyframe.transform.position,
        timestamp: keyframe.time,
        ...(keyframe.actionPresetId || poseIds.get(keyframe.id)
          ? { poseId: keyframe.actionPresetId ?? poseIds.get(keyframe.id) }
          : {}),
      })),
    },
    project
  );
}

export function getHostedMotionRouteSafety(
  project: DirectorProject = useDirectorStore.getState().project
): MotionRouteSafety | null {
  const route = getHostedMotionRoute(project);
  return route ? getMotionRouteSafety(route, project) : null;
}

function applyHostedMotionRoute(route: DirectorMotionRoute | null) {
  const state = useDirectorStore.getState();
  const previousRoute = hostedRoute;
  hostedRoute = route;
  hostedRouteCharacterId = route?.characterId ?? null;

  if (!route) {
    if (previousRoute) {
      state.updateObjectMotionPath(previousRoute.characterId, { keyframes: [] });
    }
    state.setCameraMotionPlaying(false);
    state.setCameraMotionProgress(0);
    return;
  }

  const character = state.project.objects.find(
    (object) => object.id === route.characterId && object.kind === "character"
  );
  if (!character) {
    hostedRoute = null;
    return;
  }

  const currentPath = normalizeObjectMotionPath(character.motionPath, character.transform);
  state.updateObjectMotionPath(route.characterId, {
    ...currentPath,
    interpolation: route.interpolationType === "linear" ? "linear" : "smooth",
    speedMode: "uniform",
    keyframes: route.points.map((point) => ({
      id: point.id,
      time: point.timestamp,
      transform: {
        position: [...point.position],
        rotation: [...character.transform.rotation],
        scale: [...character.transform.scale],
      },
      actionPresetId: point.poseId ?? null,
      facingMode: "path",
      pointBehavior: "pass",
      holdSeconds: 0,
      holdAction: "current",
      holdActionPresetId: null,
    })),
  });

  const nextState = useDirectorStore.getState();
  const camera = getActiveCamera(nextState.project);
  if (camera) {
    nextState.updateCameraMotionPath(camera.id, {
      duration: route.duration,
      loop: route.loop,
    });
  }
  nextState.selectObject(route.characterId);
  nextState.setCameraMotionPlaying(false);
  nextState.setCameraMotionProgress(0);
}

function postMotionRouteToHost(route: DirectorMotionRoute | null) {
  postDirectorDeskMessageToHost({
    type: "storyai:director-desk-route-synced",
    payload: { route },
  });
}

function subscribeToMotionRouteUpdates() {
  if (removeMotionRouteUnsubscribe) return;

  let previousFingerprint = routeFingerprint(getHostedMotionRoute());
  let previousSelectedObjectId = useDirectorStore.getState().selectedObjectId;
  removeMotionRouteUnsubscribe = useDirectorStore.subscribe((state) => {
    const selectedObjectId = state.selectedObjectId;
    if (!suppressNextMotionRouteNotice && !hostedRouteCharacterId && selectedObjectId !== previousSelectedObjectId) {
      const selectedCharacter = state.project.objects.find(
        (object) => object.id === selectedObjectId && object.kind === "character"
      );
      if (selectedCharacter) {
        hostedRouteCharacterId = selectedCharacter.id;
      }
    }
    previousSelectedObjectId = selectedObjectId;

    const route = getHostedMotionRoute(state.project);
    const fingerprint = routeFingerprint(route);
    if (fingerprint === previousFingerprint) return;

    previousFingerprint = fingerprint;
    hostedRoute = route;
    if (route) {
      hostedRouteCharacterId = route.characterId;
    }
    if (getHostedMotionRouteSafety(state.project)?.status === "blocked" && state.cameraMotionPlaying) {
      state.setCameraMotionPlaying(false);
    }
    if (!suppressNextMotionRouteNotice) {
      postMotionRouteToHost(route);
    }
  });
}

function postProjectToHost(force = false) {
  if (!isDirectorDeskCanvasEmbedded() || !hostedInstanceId) return;

  const project = useDirectorStore.getState().project;
  const fingerprint = getDirectorProjectFingerprint(project);
  if (!force && fingerprint === hostedProjectFingerprint) return;

  hostedProjectFingerprint = fingerprint;
  postDirectorDeskMessageToHost({
    type: "storyai:director-desk-project-synced",
    payload: {
      instanceId: hostedInstanceId,
      project: createDirectorProjectDocument(project),
    },
  });
}

function scheduleProjectSyncToHost() {
  if (!isDirectorDeskCanvasEmbedded() || !hostedInstanceId || suppressNextProjectNotice) return;
  if (projectSyncTimer !== null) window.clearTimeout(projectSyncTimer);
  projectSyncTimer = window.setTimeout(() => {
    projectSyncTimer = null;
    postProjectToHost();
  }, 250);
}

function subscribeToProjectUpdates() {
  if (removeProjectUnsubscribe) return;

  removeProjectUnsubscribe = useDirectorStore.subscribe((state, previousState) => {
    if (state.project === previousState.project) return;
    if (suppressNextProjectNotice) return;
    scheduleProjectSyncToHost();
  });
}

export function flushDirectorDeskProjectToHost() {
  if (projectSyncTimer !== null) {
    window.clearTimeout(projectSyncTimer);
    projectSyncTimer = null;
  }
  postProjectToHost();
}

function readHostProject(value: unknown): DirectorProject | null {
  if (value === null || value === undefined) return null;
  try {
    return parseDirectorProjectDocument(value);
  } catch {
    return null;
  }
}

function isSupportedHostImageUrl(value: string) {
  if (value.startsWith("data:image/")) {
    return true;
  }

  try {
    const url = new URL(value, window.location.href);
    return url.protocol === "http:" || url.protocol === "https:" || url.protocol === "blob:";
  } catch {
    return false;
  }
}

function importHostPanorama(payload: HostPanoramaPayload) {
  const edgeId = normalizeString(payload.edgeId);
  const sourceNodeId = normalizeString(payload.sourceNodeId);
  const imageUrl = normalizeString(payload.imageUrl);
  const fileName = normalizeString(payload.fileName);

  if (!edgeId || !sourceNodeId || !fileName || !imageUrl || !isSupportedHostImageUrl(imageUrl)) {
    return;
  }

  useDirectorStore.getState().setPanoramaAsset({
    name: fileName,
    fileName,
    url: imageUrl,
    projectionMode: "equirectangular",
  });
}

function openHostSession(payload: HostSessionPayload) {
  const instanceId = normalizeString(payload.instanceId);
  const theme = normalizeTheme(payload.theme);
  if (theme) {
    applyDirectorDeskTheme(theme);
  }
  if (instanceId) {
    suppressNextMotionRouteNotice = true;
    suppressNextProjectNotice = true;
    hostedInstanceId = instanceId;
    const state = useDirectorStore.getState();
    state.openScopedScene(instanceId);
    const hostProjectWasProvided = payload.project !== null && payload.project !== undefined;
    const hostProject = readHostProject(payload.project);
    if (hostProject) {
      state.replaceProject(hostProject);
    }
    if (Object.prototype.hasOwnProperty.call(payload, "route")) {
      applyHostedMotionRoute(normalizeMotionRoute(payload.route, useDirectorStore.getState().project));
    } else {
      hostedRoute = null;
      hostedRouteCharacterId = null;
    }
    suppressNextMotionRouteNotice = false;
    suppressNextProjectNotice = false;
    hostedProjectFingerprint = getDirectorProjectFingerprint(useDirectorStore.getState().project);
    window.dispatchEvent(new CustomEvent(DIRECTOR_DESK_SESSION_OPENED_EVENT, { detail: { instanceId } }));
    postMotionRouteToHost(getHostedMotionRoute());
    if (!hostProject && !hostProjectWasProvided) {
      postProjectToHost(true);
    }
  }
}

function applyHostMotionRoute(payload: HostRoutePayload) {
  if (!Object.prototype.hasOwnProperty.call(payload, "route")) return;

  suppressNextMotionRouteNotice = true;
  suppressNextProjectNotice = true;
  applyHostedMotionRoute(normalizeMotionRoute(payload.route, useDirectorStore.getState().project));
  suppressNextMotionRouteNotice = false;
  suppressNextProjectNotice = false;
  hostedProjectFingerprint = getDirectorProjectFingerprint(useDirectorStore.getState().project);
  postMotionRouteToHost(getHostedMotionRoute());
}

export function postDirectorDeskMessageToHost(message: DirectorDeskTransportMessage) {
  if (postTauriDirectorHostMessage(message)) return;
  window.parent?.postMessage(message, getDirectorDeskHostOrigin());
}

export function createDirectorDeskExportId() {
  const randomId = typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  return `director-export-${randomId}`;
}

export function postDirectorDeskReferenceVideoToHost(payload: DirectorDeskReferenceVideoPayload) {
  const exportId = normalizeString(payload.exportId);
  if (!exportId || !(payload.video instanceof Blob) || payload.video.size === 0) return;

  postDirectorDeskMessageToHost({
    type: "storyai:director-desk-reference-video-sent",
    payload: {
      ...payload,
      exportId,
    },
  });
}

function dispatchDirectorDeskExportStatus(payload: unknown) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return;
  const value = payload as Partial<DirectorDeskExportStatus>;
  const exportId = normalizeString(value.exportId);
  const message = normalizeString(value.message);
  if (!exportId || typeof value.ok !== "boolean") return;

  window.dispatchEvent(new CustomEvent<DirectorDeskExportStatus>(DIRECTOR_DESK_EXPORT_STATUS_EVENT, {
    detail: {
      exportId,
      ok: value.ok,
      message: message || (value.ok ? "已保存到画布" : "保存失败"),
    },
  }));
}

function postDirectorExtensionResponse(payload: DirectorExtensionResponsePayload) {
  postDirectorDeskMessageToHost({ type: DIRECTOR_EXTENSION_RESPONSE_TYPE, payload });
}

async function handleDirectorExtensionRequest(payload: unknown) {
  const request = parseDirectorExtensionRequest(payload);
  if (request) {
    if (request.action === "plugin.results.list") {
      const projectFingerprint = getDirectorProjectFingerprint(useDirectorStore.getState().project);
      postDirectorExtensionResponse({
        protocolVersion: DIRECTOR_EXTENSION_PROTOCOL_VERSION,
        requestId: request.requestId,
        action: request.action,
        ok: true,
        data: listDirectorPluginResults(projectFingerprint),
      });
      return;
    }
    if (request.action === "plugin.result.submit") {
      try {
        const project = useDirectorStore.getState().project;
        const result = submitDirectorPluginResult(
          request.options?.result,
          getDirectorProjectFingerprint(project)
        );
        postDirectorExtensionResponse({
          protocolVersion: DIRECTOR_EXTENSION_PROTOCOL_VERSION,
          requestId: request.requestId,
          action: request.action,
          ok: true,
          data: result,
        });
      } catch (error) {
        postDirectorExtensionResponse({
          protocolVersion: DIRECTOR_EXTENSION_PROTOCOL_VERSION,
          requestId: request.requestId,
          action: request.action,
          ok: false,
          error: {
            code: "invalid-plugin-result",
            message: error instanceof Error ? error.message : "插件结果无效",
          },
        });
      }
      return;
    }
    if (request.action === "export.frame" || request.action === "export.video") {
      if (activeExtensionExportRequestId) {
        postDirectorExtensionResponse({
          protocolVersion: DIRECTOR_EXTENSION_PROTOCOL_VERSION,
          requestId: request.requestId,
          action: request.action,
          ok: false,
          error: { code: "export-busy", message: "已有导出任务正在进行，请稍后再试" },
        });
        return;
      }
      activeExtensionExportRequestId = request.requestId;
      try {
        const result = request.action === "export.frame"
          ? await requestCleanFrameExport({
              fileName: request.options?.fileName ?? "current-frame.png",
              position: request.options?.position ?? "current",
              quality: request.options?.quality ?? "720p",
            })
          : await requestReferenceVideoExport({
              fileName: request.options?.fileName ?? "director-reference.mp4",
              fps: request.options?.fps ?? 30,
              quality: request.options?.quality ?? "720p",
            });
        postDirectorExtensionResponse({
          protocolVersion: DIRECTOR_EXTENSION_PROTOCOL_VERSION,
          requestId: request.requestId,
          action: request.action,
          ok: true,
          data: result,
        });
      } catch (error) {
        postDirectorExtensionResponse({
          protocolVersion: DIRECTOR_EXTENSION_PROTOCOL_VERSION,
          requestId: request.requestId,
          action: request.action,
          ok: false,
          error: {
            code: "export-failed",
            message: error instanceof Error ? error.message : "导出失败",
          },
        });
      } finally {
        activeExtensionExportRequestId = null;
      }
      return;
    }
    const state = useDirectorStore.getState();
    postDirectorExtensionResponse(createDirectorExtensionResponse(request, state));
    return;
  }

  const value = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
  const requestId = normalizeString(value.requestId).slice(0, 128) || "unknown";
  const action = normalizeString(value.action);
  const unsupportedAction = Boolean(action) && !isDirectorExtensionAction(action);
  postDirectorExtensionResponse({
    protocolVersion: DIRECTOR_EXTENSION_PROTOCOL_VERSION,
    requestId,
    action: "unknown",
    ok: false,
    error: {
      code: unsupportedAction ? "unsupported-action" : "invalid-request",
      message: unsupportedAction ? `不支持的二创接口操作：${action}` : "二创接口请求缺少有效的 requestId 或 action",
    },
  });
}

export function postDirectorDeskCapturesToHost(
  captures: Array<{
    dataUrl: string;
    fileName?: string;
  }>
) {
  const normalizedCaptures = captures
    .map((capture, index) => {
      const dataUrl = normalizeString(capture.dataUrl);
      if (!dataUrl) {
        return null;
      }

      return {
        dataUrl,
        fileName: normalizeString(capture.fileName) || `director-desk-capture-${index + 1}.png`,
      };
    })
    .filter((capture): capture is { dataUrl: string; fileName: string } => Boolean(capture));

  if (normalizedCaptures.length === 0) {
    return;
  }

  postDirectorDeskMessageToHost({
    type: "storyai:director-desk-captures-sent",
    payload: { captures: normalizedCaptures },
  });
}

function handleHostProtocolMessage(message: DirectorDeskTransportMessage) {
  if (message.type === "storyai:director-desk-session") {
    openHostSession((message.payload || {}) as HostSessionPayload);
    return;
  }

  if (message.type === "storyai:director-desk-panorama") {
    importHostPanorama((message.payload || {}) as HostPanoramaPayload);
    return;
  }

  if (message.type === "storyai:director-desk-route") {
    applyHostMotionRoute((message.payload || {}) as HostRoutePayload);
    return;
  }

  if (message.type === "storyai:director-desk-export-status") {
    dispatchDirectorDeskExportStatus(message.payload);
    return;
  }

  if (message.type === DIRECTOR_EXTENSION_REQUEST_TYPE) {
    void handleDirectorExtensionRequest(message.payload);
  }
}

function handleHostMessage(event: MessageEvent) {
  if (!isAllowedHostEvent(event)) return;
  if (!event.data || typeof event.data !== "object" || typeof event.data.type !== "string") return;
  handleHostProtocolMessage(event.data as DirectorDeskTransportMessage);
}

export function initDirectorDeskHostBridge() {
  if (initialized) {
    return;
  }

  initialized = true;
  applyDirectorDeskTheme(getInitialHostTheme() ?? "dark");
  window.addEventListener("message", handleHostMessage);
  subscribeToMotionRouteUpdates();
  subscribeToProjectUpdates();
  void initTauriDirectorHostTransport(handleHostProtocolMessage).then((cleanup) => {
    if (!cleanup) return;
    if (!initialized) {
      cleanup();
      return;
    }
    clearTauriTransport = cleanup;
  });
}

export function clearDirectorDeskHostBridge() {
  if (!initialized) {
    return;
  }

  initialized = false;
  activeExtensionExportRequestId = null;
  hostedRoute = null;
  hostedRouteCharacterId = null;
  suppressNextMotionRouteNotice = false;
  suppressNextProjectNotice = false;
  hostedInstanceId = null;
  hostedProjectFingerprint = "";
  if (projectSyncTimer !== null) {
    window.clearTimeout(projectSyncTimer);
    projectSyncTimer = null;
  }
  window.removeEventListener("message", handleHostMessage);
  removeMotionRouteUnsubscribe?.();
  removeMotionRouteUnsubscribe = null;
  removeProjectUnsubscribe?.();
  removeProjectUnsubscribe = null;
  clearTauriTransport?.();
  clearTauriTransport = null;
}
