# Contributing

Work on a branch. Open a pull request into `develop`. There is no `main` branch.

## Checks

Pull requests that change the site run "Verify ValhallaOS website on Node 22". Pull requests that change the deployment scripts run "Test Valhalla deployment repair". The `pr-checks` job runs the site tests and Gitleaks.

## Review

A maintainer reviews the pull request before it is merged. Do not merge your own pull request.

## Developer Certificate of Origin

Add a `Signed-off-by` line to each commit:

```
git commit -s
```

That line certifies you can submit the change under the project's license, once a license is chosen. See `LICENSE_PENDING.md`.
