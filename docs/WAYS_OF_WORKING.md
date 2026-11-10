# Ways of working

These rules apply to every pull request.

## Minimal code

Make the smallest change that works. Leave no dead code, unused dependencies, or unused files.

## Production builds

Public browser JavaScript and CSS are minified in the production build. `/os/` JavaScript also gets a light obfuscation pass. The readable source stays in the repository. Obfuscation is not security. Secrets stay on the server and are never sent to the browser.

## 5S

- **Sort.** Remove what the system does not need.
- **Set in order.** Keep the structure and the names clear.
- **Shine.** Leave the change clean, tested, and free of warnings.
- **Standardize.** Use the shared `visual.css` and the shared patterns.
- **Sustain.** Keep CI checks, the Zeus self-healing job, and monitoring in place.

## Customer experience

The customer GUI should feel as finished as a Disney or Apple product. One clear path. No dead buttons. Do not show "NOT CONNECTED" to a customer unless the screen also gives the next step.

## Self-sustaining

Every feature ships with a health check and a safe fallback.
