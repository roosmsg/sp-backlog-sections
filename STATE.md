# STATE — super-productivity-backlog-sections (Backlog Sections)

Project note (register level): `D:\Obsidian\Werkplaats\Projecten\code-projects\super-productivity-backlog-sections.md`.
Brief: `AGENT_PROMPT.md` in this repo (git-ignored, like in the Tag Groups repo).
Sibling project: `~\Projects\super-productivity-plugin` (Tag Groups; same tooling).

## What exists (2026-08-23, v1.0.0)

- `src/core.js` — config normalisation (`{version, projects: {id: {sections,
  membership}}, headerButton}`), membership inference (LCS, or the host's
  move hint; boundary rule: own section wins, else the following header),
  desired order (sections in order, loose tasks last), blocks, pruning.
- `src/plugin.js` — hooks PROJECT_LIST_UPDATE (+ one-tick defer), ACTION
  (backlog move actions → hint {taskId, workContextId}), WORK_CONTEXT_CHANGE,
  PERSISTED_DATA_CHANGED (own-save echo detected by comparing content);
  enforces `backlogTaskIds` via `updateProject` with echo detection and a
  write guard; injects headers (name, count, collapse; `localStorage` per
  device) into `.task-list-inner[data-id="BACKLOG"]` before `task#t-<id>`
  rows via MutationObserver (sync, before paint). Header button
  (`view_agenda`, PROJECT) and config handler both open the page.
- `src/index.html` — project picker (active first), sections CRUD with
  counts, per-task section select, header-button option; waits for
  PluginAPI; English fallback embedded.
- `build.js` (copy of Tag Groups', stable zip name), `test/run.js` (21
  tests, plain node) with `mock-host.js`, `dom-stub.js`, `fake-host-dom.js`.
- README in English; `.github/workflows` not yet added (see open).

## Host facts relied upon (18.19.0 / 18.20.1 sources)

- Backlog rows: `task` with `id="t-<taskId>"` inside
  `.task-list-inner[data-id="BACKLOG"]` (task-list.component.html).
- `updateProject` accepts `backlogTaskIds` (typia Partial<Project>);
  `reorderTasks` only writes the main list.
- PROJECT_LIST_UPDATE payload `{action, projectState}` for updateProject and
  all backlog move actions; ACTION payload `{action}` with the full action
  (`taskId`, `afterTaskId`, `workContextId` / `projectId`). Effect order:
  projectListUpdate$ before anyAction$.
- Header buttons render in the main header; embed needs PROJECT/TODAY — not
  used here (the page opens as a route via showIndexHtmlAsView).

## Not done / open

- Not yet installed live. CDK drag-and-drop shifts only item elements during
  a drag; the injected headers stay put until the drop re-renders — visual
  behaviour during the drag is unverified.
- No GitHub repo yet (user decides); release workflow to be added like Tag
  Groups' when the repo exists.
- Not in v1: nested sections, quick-add on a header, inline rename, sections
  outside the backlog.
