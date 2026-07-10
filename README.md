# AIOS Dashboard

Obsidian plugin for AIOS vaults: a live, interactive project and task dashboard. Reads task files (`Operations/tasks/**/tsk-*.md`) and project hubs (`Projects/<slug>/<slug>.md`), renders phase cards with computed progress bars, and writes status changes back to the files (frontmatter + folder moves). Nothing is stored in the dashboard note itself, so nothing drifts.

This is ONE engine shared by every AIOS instance. Per-fork variation is data, not code: override buckets and section order via frontmatter on the vault's `Projects/Dashboard.md`. Never fork this code per instance.

## Settings

A settings tab (Obsidian Settings > AIOS Dashboard) configures the plugin's roots and thresholds per vault: tasks root, projects root, dashboard note path, header title, intake folder, journal folder, whether the health strip shows, the three staleness thresholds, and the broken-link exclude list. Frontmatter overrides on the dashboard note (`dashboard_buckets`, `dashboard_project_statuses`) still take precedence over settings where both apply.

## Health strip

A row of small pills at the top of the dashboard surfaces vault upkeep issues: intake backlog, stale in-progress and stale open tasks, un-mined journal entries, orphan tasks (pointing at an unknown project), status/folder mismatches, and broken wikilinks. Tiles with a zero count are hidden entirely, so a healthy vault shows no strip. Click a tile to open a list of the offending files. Turn it off in settings with `showHealthStrip`.

## Install

- **BRAT** (recommended for forks): add this repo in the BRAT plugin settings; releases carry the built assets.
- **Manual**: copy `main.js`, `manifest.json`, `styles.css` into `<vault>/.obsidian/plugins/aios-dashboard/`, or run `./deploy.sh <vault-path>`.

## Develop

```
npm install
npm run dev     # watch build
npm test        # node test suites
npm run build   # production main.js
./deploy.sh ~/AIOS   # build + copy into a vault
```

## Release

Bump `manifest.json` + `package.json` + `versions.json`, commit, then:

```
gh release create <version> main.js manifest.json styles.css --title <version>
```
