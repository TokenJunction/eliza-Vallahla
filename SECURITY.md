# Security

## Reporting a vulnerability

Do not open a public defect report for a security issue.

Open this repository's **Security** tab and choose **Report a vulnerability**. That starts a private GitHub security advisory.

We aim to acknowledge a report within 7 days.

## Supported versions

The current default branch is supported. Older commits are not.

## Disclosure

We confirm the report, prepare a fix, and then publish the advisory. Please give us time to ship the fix before describing the issue in public.

## Secret commits

The pull request job named `pr-checks` runs Gitleaks on the commits that belong to the pull request. A finding fails that job. The job blocks a merge only after `pr-checks` is a required check. That branch-protection setting is not changed in these files. The workflow is `.github/workflows/pr-checks.yml`.

Workflow logs must not print secret values. Actions mask `github.token` and repository secrets.
