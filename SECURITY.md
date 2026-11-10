# Security

## Reporting a vulnerability

Do not open a public defect report for a security issue.

- Use GitHub private vulnerability reporting: https://github.com/TokenJunction/eliza-valhalla/security/advisories/new
- Or email security@valos.live. That mailbox is monitored.

We aim to acknowledge a report within 7 days.

## Supported versions

The site deployed at https://valhalla-app.xyz tracks the `develop` branch. Older commits are not supported.

## Disclosure

We confirm the report, prepare a fix, and then publish the advisory. Please give us time to ship the fix before describing the issue in public.

## Secret commits

Pull request job `pr-checks` runs Gitleaks on the commits that belong to the pull request. A finding fails that job. The job blocks a merge only after `pr-checks` is a required check. That branch-protection setting is not changed in this repository's files. The workflow is `.github/workflows/pr-checks.yml` in pull request #84.

Workflow logs must not print secret values. Actions mask `github.token` and repository secrets.
