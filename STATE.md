# STATE — super-productivity-backlog-sections (Backlog Sections)

Project note (register level): `D:\Obsidian\Werkplaats\Projecten\code-projects\super-productivity-backlog-sections.md`.
Brief: `AGENT_PROMPT.md` in this repo (git-ignored, like in the Tag Groups repo).
Sibling project: `~\Projects\super-productivity-plugin` (Tag Groups; same tooling).

## What exists (2026-08-23, v2.13.0)

- v2.13.0 (live findings from the user, 2026-08-23) — dropping on a
  collapsed section finally works without expanding anything:
  - **Header drops are applied by the plugin's own pass.** Live behaviour:
    a release over a collapsed header leaves the CDK order unchanged, and
    the host then dispatches NO backlog action at all — so the recorded
    dropOnHeader hint was never consumed and the drop silently did nothing.
    onDragEnd now schedules reloadAllProjects (150 ms) itself, and the
    reconcileFromProjects skip-guard lets a project with a fresh drop hint
    through even when the order is unchanged. When the host does dispatch,
    the hook pass consumes the hint first and the scheduled pass is a no-op.
  - **The chevron follows the effective state**: a section sprung open for
    the drag shows ▾/aria-expanded=true (fillHeader uses the effective
    open state, not the stored one) — live report was that the arrow never
    turned down.
  - **Confirmed working live by the user (2026-08-23)**: dropping a task
    on a collapsed section header assigns the section without expanding
    anything. This also validates the whole header-drop chain (band
    tracking, dropOnHeader, the own pass) against the real app for the
    first time.
  - **Unload cancels pending timers** (later()/cancelPending wrappers for
    reapplySoon, hover-open, the own drop pass; the due sweep interval gets
    a handle). Production hygiene, and it fixed cross-test pollution where a
    dead instance's 250 ms decorate wrote into the next test's document
    (test harness now also unloads every MockHost instance per DOM test).

- v2.12.0 (user report: v2.11.0's open-everything-on-drag is unusable with a
  large backlog): **spring-loaded sections**. During a drag everything stays
  folded; a collapsed section opens only after the pointer has rested on its
  band for HOVER_OPEN_MS (500 ms), stays open for the rest of the drag, and
  everything folds back on release (reapplySoon, only when something was
  opened; the hover timer is cancelled on drag end). A quick release on the
  collapsed header still needs no waiting — the header drop assigns the
  section directly. Driven from onDragMove via scheduleHoverOpen(targetHeader);
  state: dragOpenKeys / hoverOpenTimer / hoverOpenKey. Stored collapse state
  is never touched. Not yet verified live.

- v2.11.0 (user report 2026-08-23: dropping into a collapsed section is
  hard — its band is one header tall and the CDK sorts against hidden rows):
  **collapsed sections open temporarily while a drag runs**. decorate() skips
  the hidden attribute while `dragging` (trackDrag runs earlier in the same
  pass, so the placeholder mutation that starts the drag unhides in one
  pass); `dragUnfolded` remembers that something was opened, and
  stopDragTracking refolds via reapplySoon() only then — unconditional
  refolding leaked 250 ms decorate timers across tests and would fire
  pointlessly in normal use. Stored collapse state is untouched: the section
  folds back with the dropped task inside. Not yet verified live.

- v2.10.0 (user request 2026-08-23, after v2.9.0 made dragging out of the
  bottom loose block awkward): **"Zonder sectie" is now a real standard
  section** — virtual, not stored. `core.DEFAULT_SECTION_ID` ('__default__');
  projectView appends {id, name: ''} to the shared list, so ordering, blocks,
  stops, drops and the keyboard treat it as an ordinary section that always
  sits at the bottom. Its header ALWAYS renders (empty-section path), so
  there is always a visible band to drag a task out to — the v2.9.0 gap.
  It is never stored: normalizeSections reserves the id, sectionOf returns it
  for tasks without (or with a dangling) membership, and every membership
  write strips it (inferMembership anchors/chosen, header drop, shortcut) —
  so the settings page, which renders config.sections, never shows it and it
  cannot be renamed or deleted. Gates that used to test
  `project.sections.length` now test `config.sections.length` (named
  sections), so a config without sections still deactivates the plugin.
  Adoption/due-move semantics unchanged ("unsectioned" = standard section).
  Not yet verified live.

- v2.9.0 (user requests 2026-08-23) brings two changes:
  - **The "no section" block sits at the bottom again**, reverting the
    v2.6.0 placement. Everything keyed to the layout flipped with it:
    desiredOrder (sections first, loose last — which also matches where the
    app appends new backlog tasks, so fewer enforcement writes),
    sectionStops ([...sections, null]), keyboard 'top' = first section and
    'bottom' = no section, a drop above every row = the first block's
    section, and decorate() anchors trailing empty-section headers above the
    loose block (the reverse sweep seeds `following` with the null block's
    start). The empty-section boundary rule now applies strictly BETWEEN two
    blocks: at the very top it does not scan (a drag to the top of an
    all-loose backlog must not fall into an empty section — found by the
    "never written" test); an empty section at the top is reached by
    dropping on its header. With no loose tasks there is no loose drop zone;
    the keyboard 'bottom' move is the way out of the last section.
  - **Move due tasks out of the backlog** (option `moveDueThisWeek`,
    default off): a backlog task whose dueDay/dueWithTime falls in the
    current Monday–Sunday week moves to the TOP of the project's taskIds —
    once per task per week (per-project `movedOut` {taskId: weekKey} in the
    config, pruned to the backlog and to the current week), so putting it
    back keeps it there until next week. Stale overdue dates from earlier
    weeks deliberately stay put. Runs at the head of every reconcile (the
    write patches taskIds + backlogTaskIds in ONE updateProject; its echo
    runs the section pass), plus a half-hourly sweep and one at start-up /
    after a config reload — the sweep exists because a due date passing or
    a week rolling over changes no backlog order. taskInfos now carries
    {issueId, dueDay, dueWithTime, isDone} for all tasks.
    NOTE: updateProject writing taskIds is typia-valid but not yet verified
    live — verify the move lands correctly in the running app.

- v2.8.0 (reworked from v2.7.0 on user request: the feature and its option
  belong to the To Do plugin, this side only executes) adds **automatic
  sectioning of imported tasks**, driven entirely by a published contract: an
  importer plugin — the Microsoft To Do plugin, sibling repo
  ~Projectssuper-productivity-mstodo — publishes
  {v, enabled, assign: {issueId: sectionName}} under localStorage
  `sp-backlog-sections.assign.v1` (core.ASSIGN_STORAGE_KEY; both plugin.js
  files run in the host window). This plugin has NO option for it. When the
  payload is present and enabled, each published, still-unsectioned backlog
  task is matched by name (core.matchSectionByListName: exact on normalised
  names, variation selectors stripped so 🎞 = 🎞️, else the longest unique
  prefix in either direction; a tie places nothing) and placed once —
  per-project `adopted` map, pruned to the backlog — so dragging a task out
  afterwards is never undone and nothing is grabbed retroactively. Adoption
  runs inside reconcileProject (async step before applyHeaderDrop; task infos
  via getTasks, 5 s cache); manifest gained the getTasks permission. v2.7.0
  (option on this side, {listKey: name} map) was pushed but never installed;
  superseded the same day. Not yet verified live.

- `src/core.js` — config normalisation (`{version: 2, sections: [{id, name}],
  projects: {id: {membership}}, headerButton}`; v1's per-project section lists
  are merged by name on load, memberships remapped; `projectView(config, id)`
  hands the rest of the code `{sections, membership}` so nothing below it
  knows the list is shared), membership inference (LCS, or the host's
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
- v2.6.1: the config handler (the gear on the plugin card) opens the page as
  a route again. It is pressed from the settings screen, where there is no
  work view for showInWorkContext to mount into, so the page only appeared
  after the user opened a project by hand. The header button keeps the embed
  toggle.
- v2.6.0: the block without a section is the first one, not the last
  (desiredOrder, sectionStops = [null, ...sections], 'top' = no section,
  'bottom' = the last section, a drop above every row = no section, and the
  headers of empty sections are swept in from the end). Plus the option
  clickSelectsTask (default on): a capture-phase click listener on the
  document swallows the click on a task-title and focuses the row instead,
  and a dblclick re-dispatches a flagged synthetic click so the app opens its
  editor. task-title.component.ts turns a click into edit mode itself, which
  is what this replaces.
- v2.5.0: preset emoji are 💪 ☀️ 💫 🎞️; core.RENAMED_SECTIONS renames exactly the
  four old preset names (EN+NL) on load, so sections added earlier follow
  without touching their ids or any name the user typed.
- v2.4.2: fixes the freeze v2.4.1 introduced. Two adjacent empty headers
  anchored to the same row swapped places on every pass; with v2.4.1 also
  treating own removals as foreign, every swap asked for another pass. Empty
  headers are now placed bottom-up, each directly above what must follow it
  (stable), own removals are ours again, and decorate() has a brake (60 passes
  per second, then a 2s pause) so no future mistake can lock up the app.
- v2.4.1: the collapse toggle reads activeProjectId at click time (a header
  outlives the project it was drawn for — the app re-renders the rows around
  it, not the header itself — so the captured id collapsed the wrong project);
  the state is mirrored on the header (data-backlog-sections-collapsed), a
  rAF + 250ms pass re-applies it after a click, and any removal in the list is
  now treated as foreign so a cleared list is redrawn.
- v2.4.0: '[Project] Auto Move Task from regular to backlog' is no longer a
  move hint, and inferMembership only treats a hinted newcomer as placed when
  the kind is 'drag' — a task the app puts in the backlog itself (new task,
  end of day) stays without a section instead of joining the first one.
- v2.3.1: headers 1.2rem / min-height 40px (48 while dragging); the target
  band also marks its rows (data-backlog-sections-in-target, inset bar); the
  band lookup ignores x, allows 24px slack and falls back to the first header
  above the list; drop hints live 8s. Header colours are pinned with
  !important for :hover/:focus/:focus-within because the app paints rows in
  the theme accent (pink in the user’s theme) and the header sits in that list.
- v2.3.0: a section owns the band from its header to the next one, so a drop
  anywhere in it counts (headerAt picks the last header above the pointer);
  the list gets .bs-dragging during a drag (min-height on the headers).
  'up'/'down' from the edge of a block step one section (core.stepSection /
  edgeOfBlock / sectionStops), inside a block they only reorder; an explicit
  move command with an unchanged order (the ends of the backlog) is still
  read as a move — reconcileFromProjects no longer skips such a project.
- v2.2.0: headers are drop targets — a CDK drag is tracked from the moment
  its placeholder appears (pointermove/up on the document, capture), the
  header under the pointer gets .bs-target, and a release over it records
  dropOnHeader{taskId,key} which beats every inference rule (applyHeaderDrop).
  The dragged task id comes from the placeholder/preview clone's
  data-task-id. Two shortcuts (section-up / section-down, registerShortcut)
  move the focused/selected task through the sections, "no section" last.
  The header button toggles the page as a work-view embed
  (showInWorkContext / closeWorkContextView; fallback showIndexHtmlAsView),
  and leaving the project closes it.
- v2.1.0: settings page is only the shared section list (project picker and
  per-task assignment removed — the user assigns in the backlog itself);
  action types corrected against the host source ('[Project] Auto Move Task
  from regular to backlog'), each action mapped to a kind (drag/up/down/top/
  bottom) that inferMembership uses: top = first section, bottom = no section;
  a drop on a boundary where an empty section sits fills that empty section
  (firstEmptySectionBetween) — the only way to seed one; logError also writes
  to console.error; debug trace behind localStorage 'backlog-sections:debug'.
  The CDK-placeholder idea was dropped: inside one list the CDK sorts with
  transforms and leaves the placeholder at its start position in the DOM, and
  geometry cannot separate two stacked empty headers either.
- v2.0.0: one shared section list for all projects, membership stays per
  project; headers are drawn for sections without tasks in this project too
  (anchored above the next block's header); the drop target is read from the
  CDK drag placeholder (`.cdk-drag-placeholder`, `dropHints`) so a drop into
  an empty section is exact — the neighbour inference is the fallback;
  headers larger (1.05rem since v2.2.1; the .bs-target
  highlight uses --bg plus a dashed --divider-color outline, never an accent).
- v1.1.0: preset sections (`core.PRESET_SECTION_KEYS` + `addPresetSections`,
  duplicate names skipped case-insensitively) with a button on the settings
  page; names resolved in the app language (EN: Short term / Medium term /
  Long term / Scheduled in the calendar; NL: Korte termijn / Middellange
  termijn / Lange termijn / Belegd in de agenda, each with the emoji) and then
  stored as plain text.
- `src/index.html` — project picker (active first), sections CRUD with
  counts, per-task section select, header-button option; waits for
  PluginAPI; English fallback embedded.
- `build.js` (copy of Tag Groups', stable zip name), `test/run.js` (34
  tests, plain node) with `mock-host.js`, `dom-stub.js`, `fake-host-dom.js`.
- README in English; `.github/workflows` not yet added (see open).

## Host facts relied upon (verified against the app sources, 2026-08-23)

- `plugin-hooks.effects.ts`: projectListUpdate$ dispatches
  `{action: action.type, projectState}` (the plugin-api types say otherwise —
  the effect is the truth); anyAction$ dispatches `{action}` with the whole
  action; both are declared in that order, so the list update arrives first.
- `project.actions.ts`: backlog moves are '[Project] Move Task in Backlog'
  (taskId, afterTaskId, workContextId), '[Project] Move Task {Up,Down} in
  Backlog', '[Project] Move Task to {Top,Bottom} in Backlog' (taskId,
  workContextId, doneBacklogTaskIds), '[Project] Move Task from regular to
  backlog', '[Project] Auto Move Task from regular to backlog'.
- `backlog.component.html`: `<task-list listId="PARENT" listModelId="BACKLOG">`
  → `div.task-list-inner[data-id="BACKLOG"]`; rows are `task#t-<taskId>`
  (task.component host binding `[id]="taskIdWithPrefix()"`).
- `plugin-runner.ts`: plugin.js runs in the main window via `new Function`,
  onReady/onUnload are registered per instance; registerHook has no gate.
- CDK `single-axis-sort-strategy`: only `enter()` moves the placeholder in
  the DOM; sorting inside one list uses transforms.

## Earlier host facts (18.19.0 / 18.20.1 sources)

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
- Git: private GitHub repo https://github.com/roosmsg/super-productivity-backlog-sections
  (branch main); release v1.0.0 published by hand with the two ZIPs; the
  release workflow (.github/workflows/release.yml) handles tags v* from here.
  Commits/pushes on the user's request only.
- Not in v1: nested sections, quick-add on a header, inline rename, sections
  outside the backlog.
