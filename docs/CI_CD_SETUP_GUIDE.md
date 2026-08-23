# CI/CD Pipeline Setup Guide

This extension gets your story's changes onto the right branch at the right time — it
does **not** run any Salesforce deploy itself. Every actual deploy (QA, UAT) happens in
a CI/CD pipeline that has to exist **in your Salesforce project's repo** (the one with
`force-app/`), separately from this extension. This guide is the runbook for setting
that pipeline up so the extension's promote/validate flow actually does something.

> **Where does this file go?** This document, and the pipeline config it describes,
> belong in your **Salesforce project repo** — not in this extension's repo. Copy the
> relevant sections there.

---

## 1. The contract between the extension and your CI

The extension pushes specific branches at specific points and then just watches for the
result. Your CI's only job is to react to those branches correctly.

| Extension action | Branch pushed | What your CI must do | Where it's configured in the extension |
|---|---|---|---|
| **Commit & Publish** | `dev` (direct push — no PR) | Nothing. This stage has no CI step in the default model. | `sfDevops.environments[0]` |
| **Validate Only** | `validate/{storyId}-to-{env}` | Run a **check-only** validation against that env's org | `sfDevops.validateBranchTemplate` |
| **Promote & Deploy** | `promotion/{storyId}-to-{env}` → opens a PR → **merge** lands it on `{env}` | On the **merge** (i.e. a push to `qa`/`uat` itself), run the **real deploy** | `sfDevops.promotionBranchTemplate`, `sfDevops.environments` |

Default branch names (override via `sfDevops.*` settings if yours differ):

```
dev  → qa  → uat        (sfDevops.environments, in order)
main                     (sfDevops.baseBranch — feature branches cut from here)
feature/{storyId}        (sfDevops.featureBranchTemplate)
validate/{storyId}-to-{env}    (sfDevops.validateBranchTemplate)
promotion/{storyId}-to-{env}   (sfDevops.promotionBranchTemplate)
```

**Key point:** approving a PR does nothing on its own. Only the **merge** — the actual
push to `qa`/`uat` — is a CI trigger. "The merge is the deploy button."

---

## 2. Prerequisites checklist

Before writing any pipeline YAML, make sure you have:

- [ ] Admin access to each target org (QA, UAT — and Dev if you want CI to touch it, though day-to-day Dev publishing has no CI step by default).
- [ ] Ability to add repository-level secrets/variables in your git host (Bitbucket workspace/repo settings, or GitHub repo settings).
- [ ] `openssl` available locally (to generate a cert/key pair for JWT auth).
- [ ] The Salesforce CLI (`sf`) installed locally, to test the JWT login before trusting it to CI.
- [ ] Confirmed which git provider you're on — this must match `sfDevops.gitProvider` (`bitbucket` or `github`) so the extension's PR links/status polling line up with the same repo.

---

## 3. Auth: JWT Bearer Flow (no interactive login in CI)

Do this **once per target org** (QA, UAT, and Dev/DevHub if applicable).

### 3.1 Generate a cert/key pair

```bash
mkdir -p ci-certs && cd ci-certs
openssl genrsa -out server.key 2048
openssl req -new -key server.key -out server.csr \
  -subj "/C=US/ST=NA/L=NA/O=YourOrg/CN=sf-devops-ci"
openssl x509 -req -sha256 -days 3650 -in server.csr -signkey server.key -out server.crt
```

Keep `server.key` secret — it's what CI uses to authenticate. `server.crt` gets uploaded
to Salesforce; it's not sensitive by itself.

### 3.2 Create a Connected App in the target org

In **Setup → App Manager → New Connected App** (do this in QA, then repeat in UAT):

1. Basic Information: any name (e.g. `sf-devops-ci-qa`), contact email.
2. **Enable OAuth Settings** → check it.
3. Callback URL: `http://localhost:1717/OauthRedirect` (unused by JWT, but required to save).
4. **Use digital signatures** → check it → upload `server.crt`.
5. OAuth Scopes: add `Manage user data via APIs (api)`, `Perform requests at any time (refresh_token, offline_access)`.
6. Save. Wait ~10 minutes for the Connected App to propagate.
7. Open the Connected App → **Manage** → **Edit Policies** → Permitted Users:
   **"Admin approved users are pre-authorized"**. Save.
8. Under the Connected App's Profiles/Permission Sets, assign the integration user's
   profile or a dedicated permission set.
9. Copy the **Consumer Key** — this is `SF_CONSUMER_KEY` for that org.

### 3.3 Verify locally before trusting CI with it

```bash
sf org login jwt \
  --client-id <consumer-key-from-3.2> \
  --jwt-key-file server.key \
  --username <integration-user-username> \
  --instance-url https://test.salesforce.com \
  --alias qa-ci-check
sf org display --target-org qa-ci-check
```

If this works locally, it'll work in CI. `--instance-url` is `https://test.salesforce.com`
for sandboxes, `https://login.salesforce.com` for production-type orgs (UAT is usually a
sandbox too — check with `sf org display`).

### 3.4 Store secrets per org

You'll end up with 4 values per environment: `CONSUMER_KEY`, the contents of `server.key`,
`USERNAME`, `INSTANCE_URL`. Store them as CI secrets (never commit `server.key`):

**Bitbucket** (Repository settings → Repository variables, mark the key as "Secured"):
```
QA_CONSUMER_KEY, QA_JWT_KEY, QA_USERNAME, QA_INSTANCE_URL
UAT_CONSUMER_KEY, UAT_JWT_KEY, UAT_USERNAME, UAT_INSTANCE_URL
```

**GitHub** (Repo → Settings → Secrets and variables → Actions):
```
QA_CONSUMER_KEY, QA_JWT_KEY, QA_USERNAME
UAT_CONSUMER_KEY, UAT_JWT_KEY, UAT_USERNAME
```

For a Bitbucket **multiline** secret (the JWT key has newlines), paste it with literal
`\n` line breaks preserved — Bitbucket variables support multiline values directly in the
UI text box.

---

## 4. Pipeline config

Create **one deploy job per environment** (triggered by a push to that env branch) and
**one validate job per environment** (triggered by a push to its `validate/*`/`promotion/*`
branches).

### 4.1 Bitbucket Pipelines (`bitbucket-pipelines.yml`, repo root)

```yaml
image: node:20

definitions:
  steps:
    - step: &install-cli
        name: Install Salesforce CLI
        script:
          - npm install -g @salesforce/cli

pipelines:
  branches:
    qa:
      - step:
          <<: *install-cli
          name: Deploy to QA
          script:
            - npm install -g @salesforce/cli
            - echo "$QA_JWT_KEY" > server.key
            - sf org login jwt --client-id "$QA_CONSUMER_KEY" --jwt-key-file server.key --username "$QA_USERNAME" --instance-url "$QA_INSTANCE_URL" --alias target --set-default
            - sf project deploy start --source-dir force-app --target-org target --test-level RunLocalTests

    uat:
      - step:
          name: Deploy to UAT
          script:
            - npm install -g @salesforce/cli
            - echo "$UAT_JWT_KEY" > server.key
            - sf org login jwt --client-id "$UAT_CONSUMER_KEY" --jwt-key-file server.key --username "$UAT_USERNAME" --instance-url "$UAT_INSTANCE_URL" --alias target --set-default
            - sf project deploy start --source-dir force-app --target-org target --test-level RunLocalTests

    "validate/*-to-qa":
      - step:
          name: Validate against QA
          script:
            - npm install -g @salesforce/cli
            - echo "$QA_JWT_KEY" > server.key
            - sf org login jwt --client-id "$QA_CONSUMER_KEY" --jwt-key-file server.key --username "$QA_USERNAME" --instance-url "$QA_INSTANCE_URL" --alias target --set-default
            - sf project deploy validate --source-dir force-app --target-org target --test-level RunLocalTests

    "promotion/*-to-qa":
      - step:
          name: Validate promotion branch against QA
          script:
            - npm install -g @salesforce/cli
            - echo "$QA_JWT_KEY" > server.key
            - sf org login jwt --client-id "$QA_CONSUMER_KEY" --jwt-key-file server.key --username "$QA_USERNAME" --instance-url "$QA_INSTANCE_URL" --alias target --set-default
            - sf project deploy validate --source-dir force-app --target-org target --test-level RunLocalTests

    "validate/*-to-uat":
      - step:
          name: Validate against UAT
          script:
            - npm install -g @salesforce/cli
            - echo "$UAT_JWT_KEY" > server.key
            - sf org login jwt --client-id "$UAT_CONSUMER_KEY" --jwt-key-file server.key --username "$UAT_USERNAME" --instance-url "$UAT_INSTANCE_URL" --alias target --set-default
            - sf project deploy validate --source-dir force-app --target-org target --test-level RunLocalTests

    "promotion/*-to-uat":
      - step:
          name: Validate promotion branch against UAT
          script:
            - npm install -g @salesforce/cli
            - echo "$UAT_JWT_KEY" > server.key
            - sf org login jwt --client-id "$UAT_CONSUMER_KEY" --jwt-key-file server.key --username "$UAT_USERNAME" --instance-url "$UAT_INSTANCE_URL" --alias target --set-default
            - sf project deploy validate --source-dir force-app --target-org target --test-level RunLocalTests
```

Bitbucket doesn't merge YAML anchors across the `custom:`/`branches:` sections, so each
branch pattern's step is written out in full above rather than shared — that's
deliberate, not a mistake to "clean up".

### 4.2 GitHub Actions (`.github/workflows/*.yml`, repo root)

One workflow file per environment keeps triggers unambiguous:

```yaml
# .github/workflows/qa.yml
name: QA
on:
  push:
    branches: [qa, 'validate/*-to-qa', 'promotion/*-to-qa']

jobs:
  run:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npm install -g @salesforce/cli
      - run: echo "${{ secrets.QA_JWT_KEY }}" > server.key
      - run: >
          sf org login jwt --client-id ${{ secrets.QA_CONSUMER_KEY }}
          --jwt-key-file server.key --username ${{ secrets.QA_USERNAME }}
          --instance-url https://test.salesforce.com --alias target --set-default
      - name: Deploy (only on merge to qa)
        if: github.ref == 'refs/heads/qa'
        run: sf project deploy start --source-dir force-app --target-org target --test-level RunLocalTests
      - name: Validate (on validate/promotion push)
        if: github.ref != 'refs/heads/qa'
        run: sf project deploy validate --source-dir force-app --target-org target --test-level RunLocalTests
```

Duplicate as `uat.yml` with the UAT secrets and branch names.

### 4.3 Things to line up with `sfDevops.*` settings

| Pipeline detail | Must match |
|---|---|
| `--source-dir force-app` | `sfDevops.sourceRootFolder` (only if you changed it from the default) |
| Branch patterns (`qa`, `validate/*-to-qa`, ...) | `sfDevops.environments[].branch`, `sfDevops.validateBranchTemplate`, `sfDevops.promotionBranchTemplate` |
| One job pair per environment | Every entry in `sfDevops.environments` **after** the first (the first — `dev` — has no CI step) |
| `--test-level` | Your org's actual test suite policy; `RunLocalTests` is a safe default, switch to `RunSpecifiedTests` + `--tests` if the full suite is slow |

`sfDevops.environments[].orgAlias` in the extension is **reference/informational only** —
it does not feed the pipeline. The org alias/username used above lives entirely in your
CI secrets, independent of that setting.

---

## 5. How this maps to the extension's own "Setup Check"

The extension's story panel runs a setup-validation gate before letting you start work
(`src/SetupCheck.ts`). It checks the **extension-and-repo** half of this contract, not
the CI pipeline itself:

| Setup Check item | What it verifies | Related to this guide |
|---|---|---|
| Git repository detected | Workspace is a git repo | — |
| "origin" remote configured | `git remote get-url origin` succeeds | Same repo your CI watches |
| Repo identity resolvable | `sfDevops.repoWorkspace`/`repoSlug`, or derivable from origin URL | Must match the repo where you put the pipeline file |
| Base branch exists on origin | `origin/<sfDevops.baseBranch>` | — |
| Environment branches exist on origin | `origin/<branch>` for every `sfDevops.environments[]` entry | These are exactly the branches your pipeline triggers on |
| Source folder present | `sfDevops.sourceRootFolder` exists in the workspace | Must match `--source-dir` in the pipeline |
| Provider credentials stored (optional) | A Bitbucket/GitHub token is stored for live PR/pipeline status | Unrelated to the deploy pipeline — this is for the extension's own status polling |

The Setup Check **cannot** verify that your CI pipeline file exists or that JWT auth is
correctly wired up — that's what the rest of this guide covers. Passing the Setup Check
means the extension can push the right branches; it doesn't mean anything will deploy
when they land.

---

## 6. End-to-end verification

1. Push this guide's pipeline file to your Salesforce project repo, with real secrets set.
2. In VS Code, run **Start New Story**, make a trivial change (e.g. a comment in one Apex class), **Commit & Publish**.
3. Run **Validate Only — QA**. Confirm in your CI provider's UI that a validation job ran against QA and passed.
4. Run **Promote & Deploy — QA**, approve & merge the opened PR. Confirm in CI that the QA deploy job ran, and in Salesforce Setup → Deployment Status that it succeeded.
5. Refresh the story panel in VS Code — the QA row should flip to "✅ Deployed" once `origin/qa` contains the story's commit.
6. Repeat 3–5 for UAT with a `TrackLead`-role user (or your configured `requiredRole`).

---

## 7. Troubleshooting

| Symptom | Likely cause |
|---|---|
| `sf org login jwt` fails with "invalid_grant" | Connected App hasn't propagated yet (wait ~10 min), or the cert uploaded doesn't match the key used, or the integration user isn't pre-authorized in the Connected App's policy. |
| CI job never triggers on the `validate/*` push | Branch pattern syntax differs slightly between providers — Bitbucket uses glob-style (`validate/*-to-qa`), GitHub Actions uses the same glob syntax but double-check `on.push.branches` matches exactly what `sfDevops.validateBranchTemplate` produces. |
| Deploy runs but extension still shows "Validated / In PR" after merge | The story panel only re-checks on refresh — click ↻ refresh, or reopen the panel. |
| `sf project deploy start` succeeds in CI but nothing changed in the org | Check `--source-dir` matches `sfDevops.sourceRootFolder`, and that the branch CI checked out is actually the merged `qa`/`uat` branch, not a stale ref (`actions/checkout`/Bitbucket checkout should already handle this by default). |
| Multiple stories deploy at once unexpectedly | Two concurrent Promote & Deploy runs both merged into `qa` close together — this is expected git behavior, not a pipeline bug; each merge triggers its own deploy of whatever's on `qa` at that point. |
