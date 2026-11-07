# Valhalla Workspace handoff

This folder is a desk prototype. It is not the public site in `docs/site` and it does not replace signup.

Open it from `packages/os/setup` with `bun run dev:desk`, then `desk.html`. The flasher app stays on `index.html`.

## Modules

- `ValhallaWorkspace.tsx` — Ascent, then Valhalla Workspace.
- `DeskApp.tsx` — windows, Guide, taskbar.
- `shell-panels.tsx` — Command, voice, browser, theme.
- `task-client.ts` — one task stream for typed and spoken commands. The default transport says the service is unavailable.
- `readiness.ts` — component readiness. Background services stay “Not online” until a real check says otherwise.
- `workspace-preference.ts` — local display name and `bootSeen` only. No admin flag.

Wren can mount `ValhallaWorkspace` on a future route. Pass `authSource` from the existing signup service. Do not send visitors through an unconfigured redirect. Muse can restyle the tokens in `desk.css` without changing these boundaries.
