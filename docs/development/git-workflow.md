# Git workflow

## Branches

- `main` is always releasable and protected: changes land through pull requests with
  passing CI.
- Short-lived branches from `main`, named `<type>/<short-description>`, e.g.
  `feat/identity-issuance`, `fix/health-readiness-timeout`, `chore/upgrade-expo-58`.
- Rebase on `main` to stay current; squash-merge pull requests.

## Commits

[Conventional Commits](https://www.conventionalcommits.org/):

```text
<type>(<optional scope>): <imperative summary>

<optional body: what and why>
```

Types: `feat`, `fix`, `refactor`, `perf`, `test`, `docs`, `build`, `ci`, `chore`, `security`.
Scopes match workspaces or modules: `api`, `web`, `mobile`, `ui`, `validation`, `identity`, …

Examples:

```text
feat(identity): issue OGC identities on registration
fix(api): return 413 instead of 500 for oversized bodies
security(deps): override mysql2 to 3.24.5
```

## Pull requests

- One focused change per PR, with a description of _what_ and _why_, and how it was tested.
- CI must pass: format, lint, typecheck, tests, build, dependency audit.
- Changes touching authentication, authorization, cryptography, data access, or
  dependencies' install scripts need an explicit security review.
- Database migrations are reviewed as code and never edited once merged.

## Never commit

- `.env` files or any real credential, key, token, or certificate
- Generated output (`dist/`, `src/generated/`, coverage, caches)
- Native build folders for the mobile app (`android/`, `ios/`) while using Expo prebuild

If a secret is committed, treat it as compromised: **rotate it first**, then remove it
from history.

## Recommended repository settings (when hosted on GitHub)

- Branch protection on `main`: required PR review, required status checks (`CI`), no force
  pushes, linear history.
- Enable secret scanning and push protection, Dependabot alerts, and code scanning.
