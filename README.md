# Backlog Sections — a [Super Productivity](https://github.com/super-productivity/super-productivity) plugin

Backlog Sections puts named sections inside a project's backlog — the "ruler with a title" the app does not have. You define the sections once and every project's backlog uses the same set; which task sits in which section is kept per project. A header sits above each section in the backlog panel, with the task count and a collapse toggle; drag a task under another header and it moves to that section. Sections and memberships are stored by the plugin; the app's tasks are never changed, only the order of the backlog list.

**Contents:** [What it does](#what-it-does) · [What it deliberately does not do](#what-it-deliberately-does-not-do) · [Installation](#installation) · [First use](#first-use) · [How it works](#how-it-works) · [Troubleshooting](#troubleshooting) · [Development](#development)

## What it does

- One list of named sections in a chosen order, shared by every project's backlog. Tasks without a section form the block on top, labelled *No section*: new tasks arrive there, in sight, and are sorted downwards into the sections.
- In the backlog panel of a project, a header above each section: section name, number of tasks in this project, a ▾/▸ toggle; a click anywhere on the header folds or opens the section as well. Sections that hold no task here are shown too, so every backlog offers the same structure and you can drop the first task into one. Collapsing hides the section's tasks; the state is remembered per device.
- **Drop a task anywhere in a section and it joins that section.** A section owns the band from its own header down to the next one, so the whole block is the target, not just the header strip; the header of the section you are over is outlined while you hold the task there. This is the direct way to move a task between sections, and the only way into a section that holds no task here yet.
- The app's own *move task up* / *down* step one section at a time: inside a section they reorder as usual, and from its top or bottom row the task moves to the section above or below — including a section that holds no task here, which a move by rows could never reach. *Move to top* takes a task out of every section, *move to bottom* puts it in the last one.
- Two keyboard shortcuts of the plugin, *Move task to the section above* / *below*, do the same for the task you have in hand regardless of where it sits in its section (bind keys under Settings → Keyboard shortcuts).
- New tasks stay out of every section: a task the app itself puts in the backlog — a new one, or one pushed back at the end of the day — lands in *No section*, at the top, whatever it ends up next to.
- Dragging without aiming, from another list or through the context menu, still lands somewhere sensible. Between two tasks of a section a task joins that section. On the boundary between two sections it goes under the header it lands beneath — unless that boundary touches its own section, in which case it just moved to the end or the top of it. When a section that holds no task here sits on that boundary, the task lands in that section: an empty section has no rows to drop between, so the boundary under its header is its only target. Dropped above every row it has no section, that being the block up there.
- A settings page for one thing: the shared list of sections — add, rename, reorder, delete, or add the four standard ones in one click. Which task goes in which section is decided in the project backlog itself. Opened with the ⊞ button in the header of a project view, which shows the page in place of the task list and closes it again on the second press, or with the gear on the plugin's card under Settings → Plugins, which opens it as a page of its own.
- An option for how a click on a task behaves: one click selects the task and two clicks open its name for editing, instead of the app's own single click straight into the editor. It applies in the main task views only — a project, My Day, Inbox, a tag; in the task detail panel, the planner, the schedule and elsewhere one click edits as before — and it can be switched off. Whenever the editor opens on a click — a double click with the option, a single click without it or in the detail panel — the name is selected whole, so the first keystroke replaces it.
- English and Dutch; English is the fallback and is also embedded in the plugin.
- Configuration in the plugin's synced storage, so it travels with your data.

## What it deliberately does not do

- It never creates, completes, moves or deletes a task, and never touches the main task list. Its only write to the app's data is `updateProject(projectId, { backlogTaskIds })` with the ids the backlog already holds, in a different order.
- It adds no entry to the left-hand menu; the settings page is reached through the header button and the plugin card.
- No sections in the main list or in Today, no nested sections, no per-project section list, no quick-add or inline rename on a header.

## Installation

Requires [Super Productivity](https://github.com/super-productivity/super-productivity) 18.19.0 or newer, with the backlog enabled for the project (project settings → *Enable backlog*).

1. Download **[backlog-sections.zip](https://github.com/roosmsg/super-productivity-backlog-sections/releases/latest/download/backlog-sections.zip)** from the latest [release](https://github.com/roosmsg/super-productivity-backlog-sections/releases), or build it yourself with `node build.js` (see *Development*).
2. In Super Productivity open **Settings → Plugins** and upload the ZIP. Uploading a newer ZIP with the same plugin id replaces the installed version; the configuration is kept.
3. Enable the plugin. The ⊞ button appears in the header of project views.

The plugin runs in the app's own renderer, like every Super Productivity plugin. Read the source before installing if you want to know exactly what it does; it is short.

## First use

1. Open a project that has a backlog and click ⊞ in the header (or Settings → Plugins → gear on *Backlog Sections*).
2. Click **Add the standard sections** for the four ready-made ones — they apply to every project — 💪 Short term, ☀️ Medium term, 💫 Long term, 🎞️ Scheduled in the calendar (in Dutch: Korte termijn, Middellange termijn, Lange termijn, Belegd in de agenda) — or type your own sections in the order you want them from the top. The standard names are added in the app language and are ordinary sections afterwards: rename, reorder or delete them like any other.
3. Press ⊞ again to close the page. The backlog now shows every section as a header. Drag a task into the section you want — anywhere between that header and the next one — or move it there with the keyboard. Repeat per project: the sections are shared, the tasks in them are not.
4. Collapse a section with its ▾ toggle when you do not want to see it; a click anywhere on the header does the same.

## How it works

**Data.** One blob in the plugin's synced storage: `{ version: 2, sections: [{ id, name }], projects: { [projectId]: { membership: { [taskId]: sectionId } } }, headerButton }`, normalised defensively on every load (unknown sections, non-string ids and empty projects are dropped). Memberships are pruned to tasks that are still in the backlog. A version 1 configuration — one section list per project — is migrated on load: sections with the same name become one shared section and the memberships follow.

**Order.** The background script keeps each project's `backlogTaskIds` contiguous per section — sections in their configured order, tasks without a section last, the app's own order inside each block — and writes the order with `updateProject` only when it actually differs. Its own write comes back through the host's project-update hook and is recognised as an echo. A guard limits the number of writes per project in a short time.

**Moves.** The host fires `PROJECT_LIST_UPDATE` on every backlog move and, right after, the `ACTION` hook with the move action, which names the moved task and says what kind of move it was (drag, up, down, to top, to bottom). The plugin defers its work by one tick so both have arrived, then decides the moved task's section from that action and its new neighbours (see *What it does*); without a hint — a task deleted, a sync — it compares old and new order and treats the tasks that kept their relative place as anchors. At start-up, and after the settings page changed the configuration, nothing is inferred: the stored memberships are the truth and the order follows them.

**Headers.** The plugin API has no hook into rendering, so this part leans on `plugin.js` running in the host document: a stylesheet plus a MutationObserver keep one header element before the first row of each block inside the backlog list (`.task-list-inner[data-id="BACKLOG"]`; rows are `task#t-<taskId>`). Headers are re-applied synchronously inside the observer callback — before paint — and idempotently; collapsed blocks hide their rows through an attribute. Only the active project's backlog is decorated. The structure was verified against the 18.19 and 18.20 sources; if the host ever changes it, the headers simply do not appear and everything else keeps working.

**Page.** `index.html` is the plugin's iframe page (settings), shown inside the work view (`showInWorkContext`) so the header button that opened it can close it again (`closeWorkContextView`); hosts without those methods get the full-page route instead. It waits for the host to inject `window.PluginAPI` — hosts before 18.20.1 inject the bridge after the page's own scripts — and writes the configuration with `persistDataSynced`; the background script reloads it on `PERSISTED_DATA_CHANGED` and enforces the order without a restart.

## Troubleshooting

- **No headers in the backlog.** Is at least one section defined? (The list is shared by all projects; headers appear as soon as one section exists.) Is the backlog enabled and is this the active project? Open the developer console (Ctrl+Shift+I) and look for `[backlog-sections]`.
- **A task landed in the wrong section after a move.** Move it again: between two tasks of the section you mean, it always joins that one. A drop on a boundary where an empty section sits fills that empty section first.
- **Nothing happens when you move a task.** Turn the plugin's log on: open the developer console (Ctrl+Shift+I), run `localStorage.setItem('backlog-sections:debug','1')`, reload the app (Ctrl+R) and move a task. Every hook and every decision is then printed with the prefix `[backlog-sections]`; `localStorage.removeItem('backlog-sections:debug')` turns it off again.
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
