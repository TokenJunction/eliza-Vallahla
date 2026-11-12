import auth from "./auth.js";
import { createAuthBoundary } from "./auth-boundary.js";
export default createAuthBoundary(auth);
