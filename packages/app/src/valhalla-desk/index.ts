export { DeskApp, DeskErrorBoundary } from "./DeskApp.tsx";
export { PUBLIC_FIXTURE } from "./fixtures.ts";
export {
  beginMockDriveConnect,
  finishMockDriveConnect,
  MockCredentialVault,
  mockDriveDisconnect,
  mockServiceStart,
  mockServiceStop,
} from "./mock-adapters.ts";
export {
  buildRouteRows,
  cloudFallbackCopy,
  probeRoute,
  validatePublic,
  validateSecret,
} from "./model.ts";
export { defaultAuthSource, ValhallaWorkspace } from "./ValhallaWorkspace.tsx";
export { createWindowManager, reduceWindows } from "./window-manager.ts";
