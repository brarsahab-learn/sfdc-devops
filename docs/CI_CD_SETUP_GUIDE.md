# Deploy Setup Guide (no external CI/CD)

This extension deliberately does **not** use an external CI/CD pipeline (Bitbucket
Pipelines, GitHub Actions, etc.) for QA/UAT/Prod deploys. Every validate/deploy action
is initiated **from inside VS Code**, via the **Deployment Dashboard**
(`🚀 Deploy` in the Current Story panel), which runs `sf project deploy start`/`validate`
directly against the org using your own already-authenticated `sf` CLI session. PR
review/approval on Bitbucket/GitHub stays as the human code-review gate before a merge
lands — it's just not what triggers the actual deploy.

If you previously read a version of this guide describing Bitbucket Pipelines/GitHub
Actions + JWT service-account auth: that's no longer this extension's model. Nothing
here needs a CI runner or a Connected App/JWT flow — just your own machine's `sf` CLI,
authenticated once per org.

## 1. What actually triggers what

| Extension action | What happens |
|---|---|
| **Commit & Publish** | Cherry-picks straight onto `dev` — no PR, no deploy. |
| **Validate Only / Promote** | Pushes a promotion/validate branch, opens a PR. The PR merge is a **code-review gate**, not a deploy trigger. |
| **Deployment Dashboard** (any time after a merge) | Runs the real `sf project deploy start` (or `validate`) against that environment's org, using the org alias you've authenticated in Setup Check. |

## 2. One-time setup: authenticate each org

Open the Current Story panel → **⚙ Setup** → the "Configured org aliases authenticated"
check has a row per stage — **Dev, QA, UAT, Prod** (Admin-only to edit; ask an Admin if
you can't see the input fields). For each:

1. Type the `sf` CLI alias you want to use for that org (any name you like, e.g. `QASandbox`).
2. Click **🔑 Authenticate** — this opens a terminal and runs
   `sf org login web --alias <alias>`, which pops your browser for the normal Salesforce
   OAuth login. Once you approve it there, that alias is authenticated on your machine.
3. Click **🔄 Re-check Setup** to confirm it now shows as authenticated.

That's the entire setup — no Connected App, no JWT key, no CI secrets to manage. Each
person who needs to deploy authenticates the relevant org(s) on their own machine once.

## 3. Deploying

Once a story has been merged into an environment branch (`qa`, `uat`, or `main` for
Prod), open the **Deployment Dashboard** (`🚀 Deploy` in the toolbar), pick the
environment's tab, choose **ALL / by story / by file**, and click **🚀 Deploy selection**
(or **🔍 Validate selection** for a check-only dry run first). Promoting to Prod
requires the Admin role — see `USER_GUIDE.md` for the full role model.

## 4. If you actually want external CI/CD instead

Nothing about this extension prevents you from also wiring up a real CI/CD pipeline
that watches these branches and deploys independently — the extension just doesn't
require or assume one. If you go that route, you'd set up a Connected App + JWT
Bearer Flow per org for the CI runner (distinct from the interactive `sf org login web`
flow above, since a CI runner can't do an interactive OAuth login) and a pipeline config
in your Salesforce project's repo watching `qa`/`uat`/`main`. That's a larger,
separate undertaking or this extension doesn't help with — worth discussing before
committing to it.
