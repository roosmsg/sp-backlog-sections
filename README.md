# Backlog Sections — a Super Productivity plugin

Backlog Sections puts named sections inside a project's backlog — the "ruler with a title" the app does not have. A header sits above each section's tasks in the backlog panel, with the task count and a collapse toggle; drag a task under another header and it moves to that section. Sections and memberships are stored by the plugin; the app's tasks are never changed, only the order of the backlog list.

**Contents:** [What it does](#what-it-does) · [What it deliberately does not do](#what-it-deliberately-does-not-do) · [Installation](#installation) · [First use](#first-use) · [How it works](#how-it-works) · [Troubleshooting](#troubleshooting) · [Development](#development)

## What it does

- Per project, any number of named sections in a chosen order. Tasks without a section form a trailing block labelled *No section*.
- In the backlog panel of a project, a header above each block: section name, number of tasks, a ▾/▸ toggle. Collapsing hides the block's tasks; the state is remembered per device.
- Dragging a task in the backlog changes its section: drop it between two tasks of a section and it joins that section; drop it on the boundary between two sections and it goes under the header it lands beneath — unless that boundary touches its own section, in which case it just moved to the end or the top of its own section. Tasks dragged in from the main list are placed the same way; tasks that arrive at the end of the backlog (for example *Move to backlog* from the context menu) stay without a section.
- A settings page to add, rename, reorder and delete sections, and to put tasks into sections with a dropdown. Opened with the ⊞ button in the header of a project view, or with the gear on the plugin's card under Settings → Plugins.
- English and Dutch; English is the fallback and is also embedded in the plugin.
- Configuration in the plugin's synced storage, so it travels with your data.

## What it deliberately does not do

- It never creates, completes, moves or deletes a task, and never touches the main task list. Its only write to the app's data is `updateProject(projectId, { backlogTaskIds })` with the ids the backlog already holds, in a different order.
- It adds no entry to the left-hand menu; the settings page is reached through the header button and the plugin card.
- No sections in the main list or in Today, no nested sections, no quick-add or inline rename on a header (v1).

## Installation

Requires Super Productivity 18.19.0 or newer, with the backlog enabled for the project (project settings → *Enable backlog*).

1. Download **[backlog-sections.zip](https://github.com/roosmsg/super-productivity-backlog-sections/releases/latest/download/backlog-sections.zip)** from the latest [release](https://github.com/roosmsg/super-productivity-backlog-sections/releases), or build it yourself with `node build.js` (see *Development*).
2. In Super Productivity open **Settings → Plugins** and upload the ZIP. Uploading a newer ZIP with the same plugin id replaces the installed version; the configuration is kept.
3. Enable the plugin. The ⊞ button appears in the header of project views.

The plugin runs in the app's own renderer, like every Super Productivity plugin. Read the source before installing if you want to know exactly what it does; it is short.

## First use

1. Open a project that has a backlog and click ⊞ in the header (or Settings → Plugins → gear on *Backlog Sections*).
2. Add a few sections — say *Next*, *Later*, *Someday* — in the order you want them from the top.
3. Put tasks into sections with the dropdowns, or go back to the project and drag tasks under the headers in the backlog panel.
4. Collapse a section with its ▾ toggle when you do not want to see it.

## How it works

**Data.** One blob in the plugin's synced storage: `{ version, projects: { [projectId]: { sections: [{ id, name }], membership: { [taskId]: sectionId } } }, headerButton }`, normalised defensively on every load (unknown sections, non-string ids and empty projects are dropped). Memberships are pruned to tasks that are still in the backlog.

**Order.** The background script keeps each project's `backlogTaskIds` contiguous per section — sections in their configured order, tasks without a section last, the app's own order inside each block — and writes the order with `updateProject` only when it actually differs. Its own write comes back through the host's project-update hook and is recognised as an echo. A guard limits the number of writes per project in a short time.

**Drags.** The host fires `PROJECT_LIST_UPDATE` on every backlog move and, right after, the `ACTION` hook with the move action, which names the moved task. The plugin defers its work by one tick so both have arrived, then decides the moved task's section from its new neighbours (see *What it does*); without a hint — a task deleted, a sync — it compares old and new order and treats the tasks that kept their relative place as anchors. At start-up, and after the settings page changed the configuration, nothing is inferred: the stored memberships are the truth and the order follows them.

**Headers.** The plugin API has no hook into rendering, so this part leans on `plugin.js` running in the host document: a stylesheet plus a MutationObserver keep one header element before the first row of each block inside the backlog list (`.task-list-inner[data-id="BACKLOG"]`; rows are `task#t-<taskId>`). Headers are re-applied synchronously inside the observer callback — before paint — and idempotently; collapsed blocks hide their rows through an attribute. Only the active project's backlog is decorated. The structure was verified against the 18.19 and 18.20 sources; if the host ever changes it, the headers simply do not appear and everything else keeps working.

**Page.** `index.html` is the plugin's iframe page (settings). It waits for the host to inject `window.PluginAPI` — hosts before 18.20.1 inject the bridge after the page's own scripts — preselects the active project, and writes the configuration with `persistDataSynced`; the background script reloads it on `PERSISTED_DATA_CHANGED` and enforces the order without a restart.

## Troubleshooting

- **No headers in the backlog.** Sections exist for this project? (Headers appear only when at least one section is defined.) Is the backlog enabled and is this the active project? Open the developer console (Ctrl+Shift+I) and look for `[backlog-sections]`.
- **A task landed in the wrong section after a drag.** Drop it between two tasks of the section you mean, or set its section on the settings page. On a boundary, the header the task lands beneath wins, except next to its own section.
- **The ⊞ button is missing.** It appears in project views only, when *Show the Backlog sections button* is on, after a restart of the app following a change of that option.
- **Texts appear in English although the app is in Dutch.** The host had no translations registered for the plugin; re-uploading the ZIP fixes it.

## Development

No dependencies; everything runs with plain node (18 or newer).

```
src/
  manifest.json   plugin metadata, declared hooks, permissions and languages
  core.js         shared logic: configuration, membership inference, order
  plugin.js       background script (hooks, order enforcement, headers)
  index.html      settings page
  icon.svg
  i18n/en.json    translations; the Dutch file has the same keys
  i18n/nl.json
build.js          assembles dist/ and the installable ZIP
test/
  mock-host.js    minimal stand-in for the Super Productivity plugin host
  dom-stub.js     just enough DOM to render and drive the settings page in node
  fake-host-dom.js a fake host document for the backlog headers
  run.js          the test suite
```

`core.js` is inlined into both `plugin.js` and `index.html` by the build, at the `/* @@CORE@@ */` marker, together with `i18n/en.json` as the embedded fallback for `translate()`. Edit the files under `src/`, never under `dist/`.

- `node build.js` — validates the sources and writes `dist/`, `dist/backlog-sections-<version>.zip` and the stable `dist/backlog-sections.zip`. `dist/` is not committed: pushing a tag `v<version>` (matching `src/manifest.json`) runs the [release workflow](.github/workflows/release.yml), which tests, builds and attaches both ZIPs to a GitHub release; the README's download link points at the latest release.
- `node test/run.js` — core (normalisation, inference with and without the host's move hint, order, blocks, pruning), `plugin.js` in the mock host (start-up enforcement and echo, drags inside the backlog and from the main list, silent changes, settings-page changes, refused writes, header injection and collapse with a fake host document), and the settings page through a DOM stub (project picker, sections, task assignment, options, late `PluginAPI`, English fallback), plus translation parity, manifest and ZIP round-trip.

Host facts relied upon (sources of 18.19.0 and 18.20.1): backlog rows render as `task` elements with `id="t-<taskId>"` inside `.task-list-inner[data-id="BACKLOG"]`; `updateProject` accepts `backlogTaskIds`; `PROJECT_LIST_UPDATE` fires for `updateProject` and for every backlog move action with `{ action, projectState }`; the `ACTION` hook delivers the full action, whose backlog move payloads carry `taskId` and `workContextId`; plugin hooks for one dispatch fire in effect order (project list first, action second).
