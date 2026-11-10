# Releases

A release archive includes `LICENSE`, once TJ adds it, and `SECURITY.md`. See `LICENSE_PENDING.md` until a license is chosen.

The archive is built only by CI. Do not assemble a release on a laptop and commit the output. The deployment workflow is `.github/workflows/deploy-valhalla.yml`, started with a workflow dispatch for a reviewed commit.

`scripts/check-no-binaries.mjs` fails if a compiled executable or a native binary is committed outside `scripts/binary-allowlist.txt`. Image, video, and font files are not executables. A scan of this repository found no ELF, Mach-O, or PE files and no `.exe`, `.dll`, `.so`, or `.dylib` files. The tracked media are `.png`, `.jpg`, `.gif`, `.webp`, `.svg`, and `.mp4` under `website/`.
