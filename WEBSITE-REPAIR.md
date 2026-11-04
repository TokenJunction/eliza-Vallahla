# Website entry change: November 3, 2026

## Owner request
Remove the blocking Cloudflare human-check step temporarily. Keep Google/email login and the existing Valhalla logo. Prioritize connectivity over a public preview.

## Deployment behavior
The Pages workflow stages the website in site-build, replaces only mountTurnstile() with an advance to the existing terms/account flow, and removes the previously added preview overlay loader from the deployed errors.js. The original gate.js remains in source for restoration. app/index.html, Google/email authentication handlers, email-code verification, wallet logic, and existing logos are not replaced. No account-authentication flags are created by this build change.

Terms/risk acknowledgment remains; users are not marked as having accepted it automatically. Removal of Turnstile temporarily reduces the entry-layer bot protection. Backend authentication remains responsible for validating Google tokens, email codes, sessions, and access permissions.

## Checks
The workflow refuses deployment if expected function boundaries or existing logos are missing. It runs node --check on the staged gate.js and errors.js. These checks do not prove that Google/email backend services work. Deployment completion and actual sign-in must be verified separately.

## Rollback
Revert this workflow change to restore the original deployed gate behavior. The earlier preview files remain in source, but the updated deployment does not load the preview over /app/.
