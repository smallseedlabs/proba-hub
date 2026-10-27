# Branch protection for `main`

`.github/rulesets/main.json` is a GitHub repository ruleset for the default branch. GitHub does not read this file by itself:
a repository admin applies it once (settings are not changed by merging a pull request).

What it enforces on `main`:

- **Changes go through a pull request** (no direct pushes). Review threads must be resolved; a new push dismisses stale approvals.
  `required_approving_review_count` is `0` because the repository has a single maintainer, who cannot approve their own pull
  request. Raise it to `1` as soon as there is a second reviewer.
- **Required status checks**, and the branch must be up to date with `main` before merging: `Lint`, `Type Check`,
  `Vendored proba-audit matches pin`, `Compose security (loopback ports, no default passwords)`, `Validate Scenarios`,
  `Unit Tests`, `Integration Tests`, `Docker Build` (the job names in `.github/workflows/ci.yml`; rename them in both places together).
- **No force pushes** (`non_fast_forward`) and **no deletion** of the branch.
- No bypass actors: not even admins skip the rules. Add one under `bypass_actors` only if you need an emergency path.

## Apply it

With the GitHub CLI, as a repository admin:

```bash
gh api -X POST repos/smallseedlabs/proba-hub/rulesets --input .github/rulesets/main.json
```

Or in the web UI: Settings > Rules > Rulesets > New ruleset > Import a ruleset, and pick the file.

To update an existing ruleset after editing the file:

```bash
id=$(gh api repos/smallseedlabs/proba-hub/rulesets --jq '.[] | select(.name=="main protection") | .id')
gh api -X PUT repos/smallseedlabs/proba-hub/rulesets/$id --input .github/rulesets/main.json
```

Check what is active: `gh api repos/smallseedlabs/proba-hub/rulesets`.

## Notes

- A required check that never reports (for example a job renamed or removed) blocks every pull request. Update the ruleset
  together with any change to a job name.
- Rulesets on private repositories need GitHub Team or Enterprise; on a plan without them use classic branch protection
  (Settings > Branches) with the same options.
