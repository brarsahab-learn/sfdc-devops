# Onboarding — Salesforce DevOps extension

Welcome. This team now runs its Salesforce CI/CD through this VS Code extension instead
of an external pipeline — this doc gets you from "just installed it" to shipping your
first story through Dev → QA → UAT (→ Prod), in order. It's a walkthrough, not a full
reference — for every setting and edge case, see
[`docs/USER_GUIDE.md`](docs/USER_GUIDE.md), which this doc links to throughout.

---

## 1. Before you start

- **Salesforce CLI (`sf`)** installed and on your `PATH`.
- **VS Code**, with this extension installed (Extensions view → `…` → **Install from
  VSIX…** → the current `sf-devops-<version>.vsix`).
- **Git access** to the team repo.
- Your own **Dev org authenticated** (`sf org login web --alias <your-dev-alias>`) —
  everything else (QA/UAT/Prod/Demo) is configured once by an Admin, not per-developer.

## 2. Your first launch: Setup Check

Open the **Salesforce DevOps** icon in the Activity Bar. The **Current Story** panel
won't show your workspace until Setup Check passes — this is deliberate, it catches
"this won't actually work" problems (missing branches, unauthenticated orgs, wrong
folder) before you're three steps into a story and confused.

Each failing check tells you exactly what's wrong and, for the two most common gaps,
fixes itself with one click instead of just describing a command to run yourself:

- **An environment branch doesn't exist on origin yet** → **⬆ Push** creates it
  directly from the base branch's current tip (no local checkout involved), or **⚙ Edit
  sfDevops.environments instead** if it already exists under a different name.
- **An org alias isn't authenticated** → fill in the alias, hit 🔑 to log in (opens a
  terminal only if it isn't already connected), 🌐 to open the org directly.

Branch-pushing and org-alias editing are **Admin-only** — as a Developer or Lead you'll
see the same information read-only, with a note to ask an Admin.

Once every required check passes, click **✅ Confirm Setup & Continue** once — it won't
ask again for this workspace unless something actually breaks later.

## 3. The story lifecycle, end to end

This is the whole loop you'll run for every story:

```
Start New Story → do the work → Commit & Publish → Validate → Promote → (PR merged by a
human) → Deploy
```

1. **Start New Story** (toolbar) — enter your story/ticket ID, get a feature branch cut
   from `main` and pushed. One story = one branch, always.
2. **Do the work** — edit metadata as normal, stage it in Source Control like any git
   change.
3. **Commit & Publish Feature Branch** — commits your staged files, pushes your feature
   branch, and cherry-picks the story straight onto `dev`. No PR here — dev is meant to
   move fast; the real review gate comes at Promote.
4. **Validate** — this is **mandatory**, not optional. It creates (or refreshes) a real
   promotion branch cut from the target environment, and runs an actual check-only
   Salesforce deploy against that org. A PR literally cannot open without this having
   passed for the exact content you're about to promote — if the branch changes after a
   pass, it re-locks automatically and you validate again.
   - Before you click it, **Review Changes** shows a real file-by-file diff (current
     content on the target branch vs. what you're about to send) — VS Code's own diff
     editor, not just a file list. Use it any time you want to double-check exactly
     what's shipping before committing to it.
   - Validate streams real progress (`InProgress — 2/5 components, 1/3 tests`, updating
     every few seconds) instead of sitting on a static "Validating…" for however long a
     real org check takes.
5. **Promote** — once validated, opens a PR (promotion branch → the target env's
   branch). **A human reviews and merges it** — this extension never auto-merges,
   deliberately. If the story already has an open PR, clicking Promote again just jumps
   straight to it instead of restarting anything.
6. **Deploy** — a separate, explicit step from the **Deployment Dashboard**, after the
   PR is merged. Shows the full pending file tree (grouped by story, by metadata type,
   sortable, meta.xml files collapsed by default), a live diff per file, and only then
   the actual `sf project deploy`. Prod always requires this manual click regardless of
   any "auto-deploy on success" setting — there's no path that deploys Prod without a
   human clicking the button for that exact selection.

If a cherry-pick conflicts at step 3 or 4, it's left in place for you to resolve in
Source Control, then click **Resume** — never silently discarded.

Full detail on every one of these steps: [`docs/USER_GUIDE.md` §3–§7b](docs/USER_GUIDE.md#3-the-overall-flow).

## 4. Roles: Developer / Lead / Admin

Each environment can require a minimum role (`sfDevops.environments[].requiredRole`) —
by default QA is open to everyone, UAT needs **Lead**, Prod needs **Admin**. Change your
role via the toolbar's 👤 icon — elevating to Lead/Admin is password-gated (set once,
then reused).

**Be clear-eyed about what this actually is**: it's a soft, local deterrent — a password
prompt stored in VS Code's secret storage, not a real security boundary (a determined
user could work around it on their own machine). The **real** Prod safety boundary is
*who has the Prod org's credentials authenticated on their machine* — same as it would
be with raw `sf` CLI access. Role gating is there so people don't *accidentally* touch a
stage they shouldn't, not to stop someone determined to.

## 5. Setting up Prod

Prod is a real, fully-gated stage by default (`branch: "main"`, `requiredRole: "Admin"`)
— it isn't disabled or different from QA/UAT in how it works, it just isn't
**authenticated** until an Admin does it once:

1. Change your role to **Admin** (toolbar → 👤).
2. Open **⚙ Setup Check**, find the **Prod** row in the org-alias manager, enter the
   org alias, hit 🔑 to authenticate.

That's it — Prod now behaves exactly like every other stage: mandatory validate, a
human-merged PR, and a manual Deploy click, restricted to Admin.

## 6. Parallel Prod + Demo deploy

If your team also keeps a Demo org that should always mirror whatever ships to Prod, an
Admin can configure it the same way (Setup Check → **Demo** row — this one's optional
and separate from the pipeline; Demo has no branch or promotion of its own).

Once a Demo alias is set, the Prod pane in the Deployment Dashboard shows an extra
checkbox: **☐ Also deploy to Demo (`<alias>`) in parallel**. Check it before clicking
Deploy and both orgs receive the *exact same* validated package in the *same* action —
genuinely concurrent (`sf project deploy` runs against both orgs at the same time, not
one after the other). Demo's result is reported independently — a Demo failure never
blocks, fails, or gets conflated with Prod's own result, and nothing else in the
pipeline gates on Demo's state.

Leave the checkbox unchecked (the default) for a Prod-only deploy, same as today.

## 7. Reading the pipeline UI

- **Badges** (🟢/⚪) on each stage in the pipeline card, with a **Timeline** accordion
  showing the real date/time each stage (Validate/Promote/Deploy) actually happened —
  click to expand.
- If a stage that was already fully deployed suddenly shows as pending again after you
  publish more work to `dev`, that's correct, not a bug — the pipeline detected your new
  content hasn't been promoted through yet and is asking you to re-run it, instead of
  silently showing a stale "done."
- **Stash & Continue**: if you have uncommitted local changes when starting
  Validate/Promote/Resume, you'll be offered to stash them, proceed, and get them back
  automatically once the action finishes — instead of a dead-end error telling you to go
  handle it yourself first.

## 8. Troubleshooting — what a few real messages actually mean

- **"Deploy did not succeed — the Salesforce CLI gave no further detail"**: if you see
  this today it should already carry real detail (component or test failure messages) —
  a genuinely bare version of this message with real changes behind it is worth
  reporting, since it usually means the CLI hit something this extension doesn't parse
  yet.
- **"N deleted file(s) can't be included in this deploy yet"**: a story that deletes a
  file will show this and just skip those files (with a warning naming them) rather than
  crashing outright — deletions currently need to be removed from the target org
  manually; the rest of the deploy still goes through.
- **A stage stuck showing "Working…" or a busy state that never seems to clear**: check
  for a *second* notification/prompt that might be waiting on you (e.g. a "delete the
  promotion branch now?" prompt after a successful deploy) — it's easy to miss among
  other VS Code notifications.

## 9. If you end up touching the extension's own code

Tests live in `test/` and run with:

```sh
npm test
```

This compiles first, then runs the full suite (compiled-JS integration tests against a
stubbed `vscode` module — no real VS Code window needed) and prints a pass/skip/fail
summary. See [`test/README.md`](test/README.md) for how the suite is structured and how
to add to it — worth reading before changing anything in `src/`, since this suite is
what currently stands in for a full CI pipeline.
