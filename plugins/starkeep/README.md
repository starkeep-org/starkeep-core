# The `starkeep` Claude Code plugin

Skills for agents authoring a Starkeep app. Each skill is a short router: it says when it applies,
names the gotchas, and links the sections of [`docs/authoring-an-app.md`](ref/docs/authoring-an-app.md)
and [`docs/system-design.md`](ref/docs/system-design.md) that state the platform's rules. The docs
stay the source of truth; a skill never restates them.

## Install

From the marketplace this repository publishes:

```sh
claude plugin marketplace add myleshenderson/starkeep-core
claude plugin install starkeep@starkeep-core
```

Or in one step, inside Claude Code:

```text
/plugin install starkeep --marketplace myleshenderson/starkeep-core
```

From a checkout of this repository, without installing:

```sh
claude --plugin-dir ./plugins/starkeep
```

Skills are discovered from `skills/<name>/SKILL.md` and invoke as `/starkeep:<skill>`.

## `ref/` is generated

An installed plugin contains only this directory, so skills cannot link `docs/...` by repository
path. `ref/` holds byte-identical copies of the docs skills link, at their repository paths; a skill
links them as `../../ref/<repo path>#anchor`. Do not edit `ref/` by hand. After changing one of the
copied files, refresh it from the repository root:

```sh
node scripts/sync-plugin-ref.mjs
```

CI fails when `ref/` differs from the originals. `node scripts/check-skill-links.mjs` checks that
every skill link resolves to a file inside this plugin and, with an anchor, to a heading in it.
