import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import {
  DEMO_BANNER,
  demoSessionFixture,
} from "../../../../app/src/valhalla-desk/demo-fixture.ts";
import { ValhallaWorkspace } from "../../../../app/src/valhalla-desk/ValhallaWorkspace.tsx";
import "../../../../app/src/valhalla-desk/desk.css";

const rootElement = document.getElementById("root");

if (!rootElement) {
  throw new Error("Missing #root element");
}

createRoot(rootElement).render(
  <StrictMode>
    <p id="demo-banner" role="status">
      {DEMO_BANNER}
    </p>
    <ValhallaWorkspace authSource={demoSessionFixture} reducedMotion />
  </StrictMode>,
);
