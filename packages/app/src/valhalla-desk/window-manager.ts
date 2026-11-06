import { WINDOW_IDS, type WindowId } from "./model.ts";

export type WindowFrame = {
  id: WindowId;
  open: boolean;
  minimized: boolean;
  z: number;
  x: number;
  y: number;
};

export type WindowManagerState = {
  frames: readonly WindowFrame[];
  activeId: WindowId | null;
  nextZ: number;
};

export type WindowAction =
  | { type: "open"; id: WindowId }
  | { type: "close"; id: WindowId }
  | { type: "minimize"; id: WindowId }
  | { type: "focus"; id: WindowId }
  | { type: "taskbar"; id: WindowId }
  | { type: "move"; id: WindowId; x: number; y: number };

export function createWindowManager(): WindowManagerState {
  return {
    frames: WINDOW_IDS.map((id, index) => ({
      id,
      open: id === "setup",
      minimized: false,
      z: id === "setup" ? 1 : 0,
      x: 16 + index * 28,
      y: 16 + index * 24,
    })),
    activeId: "setup",
    nextZ: 2,
  };
}

export function reduceWindows(
  state: WindowManagerState,
  action: WindowAction,
): WindowManagerState {
  switch (action.type) {
    case "open":
    case "focus":
      return focusWindow(state, action.id);
    case "close":
      return closeWindow(state, action.id);
    case "minimize":
      return minimizeWindow(state, action.id);
    case "taskbar":
      return taskbarWindow(state, action.id);
    case "move":
      return moveWindow(state, action.id, action.x, action.y);
    default: {
      const neverAction: never = action;
      return neverAction;
    }
  }
}

function focusWindow(
  state: WindowManagerState,
  id: WindowId,
): WindowManagerState {
  const z = state.nextZ;
  return {
    frames: state.frames.map((frame) =>
      frame.id === id ? { ...frame, open: true, minimized: false, z } : frame,
    ),
    activeId: id,
    nextZ: z + 1,
  };
}

function closeWindow(
  state: WindowManagerState,
  id: WindowId,
): WindowManagerState {
  const frames = state.frames.map((frame) =>
    frame.id === id ? { ...frame, open: false, minimized: false } : frame,
  );
  return {
    frames,
    activeId: nextActive(frames, state.activeId, id),
    nextZ: state.nextZ,
  };
}

function minimizeWindow(
  state: WindowManagerState,
  id: WindowId,
): WindowManagerState {
  const frames = state.frames.map((frame) =>
    frame.id === id ? { ...frame, minimized: true } : frame,
  );
  const activeId =
    state.activeId === id ? nextActive(frames, null, id) : state.activeId;
  return { frames, activeId, nextZ: state.nextZ };
}

function taskbarWindow(
  state: WindowManagerState,
  id: WindowId,
): WindowManagerState {
  const frame = state.frames.find((item) => item.id === id);
  if (!frame?.open) return focusWindow(state, id);
  if (frame.minimized || state.activeId !== id) return focusWindow(state, id);
  return minimizeWindow(state, id);
}

function moveWindow(
  state: WindowManagerState,
  id: WindowId,
  x: number,
  y: number,
): WindowManagerState {
  return {
    ...state,
    frames: state.frames.map((frame) =>
      frame.id === id
        ? {
            ...frame,
            x: Math.max(0, Math.round(x)),
            y: Math.max(0, Math.round(y)),
          }
        : frame,
    ),
  };
}

function nextActive(
  frames: readonly WindowFrame[],
  current: WindowId | null,
  closing: WindowId,
): WindowId | null {
  if (current && current !== closing) {
    const currentFrame = frames.find((frame) => frame.id === current);
    if (currentFrame?.open && !currentFrame.minimized) return current;
  }
  const open = frames.filter((frame) => frame.open && !frame.minimized);
  const top = [...open].sort((left, right) => right.z - left.z)[0];
  return top?.id ?? null;
}
