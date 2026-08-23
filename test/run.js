#!/usr/bin/env node
/*
 * Test suite for the Backlog Sections plugin. Runs with plain node:
 *
 *   node test/run.js
 *
 * plugin.js is assembled from src/ exactly as the build does and loaded into
 * the mock host the way Super Productivity loads it.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const build = require('../build.js');
const { MockHost, HOOKS, TRANSLATIONS } = require('./mock-host.js');
const { createDocument } = require('./dom-stub.js');
const { backlogDocument, FakeMutationObserver, FakeStorage, FakeElement, layout } = require('./fake-host-dom.js');

const PLUGIN_JS = build.assemblePluginJs();
const INDEX_SCRIPTS = [...build.assembleIndexHtml().matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join('\n');
const core = new Function(`${build.readSrc('core.js')}\nreturn BacklogSectionsCore;`)();

// ---- fixtures -------------------------------------------------------------------

// The sections are one shared list; only the memberships are per project.
const SECTIONS = [
  { id: 'next', name: 'Next' },
  { id: 'later', name: 'Later' },
];
const MEMBERSHIP = { a1: 'next', a2: 'next', b1: 'later', b2: 'later' };
// What the core functions work with: the shared sections plus one project's memberships.
const PROJECT_CFG = { sections: SECTIONS, membership: MEMBERSHIP };
const CONFIG = { version: 2, sections: SECTIONS, projects: { p1: { membership: MEMBERSHIP } }, headerButton: true };
const ORDER = ['a1', 'a2', 'b1', 'b2', 'u1'];

const projects = (order) => [
  { id: 'p1', title: 'Inbox', taskIds: ['m1'], backlogTaskIds: order || ORDER.slice(), isEnableBacklog: true },
  { id: 'p2', title: 'Other', taskIds: [], backlogTaskIds: ['x1', 'x2'], isEnableBacklog: true },
];
const TASKS = [
  { id: 'm1', title: 'Main task', projectId: 'p1', tagIds: [] },
  { id: 'a1', title: 'Alpha one', projectId: 'p1', tagIds: [] },
  { id: 'a2', title: 'Alpha two', projectId: 'p1', tagIds: [] },
  { id: 'b1', title: 'Beta one', projectId: 'p1', tagIds: [] },
  { id: 'b2', title: 'Beta two', projectId: 'p1', tagIds: [] },
  { id: 'u1', title: 'Unsorted', projectId: 'p1', tagIds: [] },
  { id: 'x1', title: 'X one', projectId: 'p2', tagIds: [] },
  { id: 'x2', title: 'X two', projectId: 'p2', tagIds: [] },
];
const CONTEXT_P1 = { id: 'p1', type: 'PROJECT', title: 'Inbox', taskIds: [] };

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function startHost(options = {}) {
  const host = new MockHost({ projects: projects(), tasks: TASKS, storedConfig: CONFIG, activeContext: CONTEXT_P1, ...options });
  host.loadPlugin(PLUGIN_JS);
  await host.ready();
  return host;
}

const stored = (host) => core.normalizeConfig(host.storage['']);

const flush = async () => {
  for (let i = 0; i < 10; i++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
};

async function startScreen(options = {}) {
  const { dialogAnswer, apiLate, noTranslations, apiOverrides, ...hostOptions } = options;
  const host = new MockHost({ projects: projects(), tasks: TASKS, storedConfig: CONFIG, activeContext: CONTEXT_P1, ...hostOptions });
  const iframeApi = Object.assign(
    {},
    host.api,
    {
      translate: (key, params) => {
        host.calls.push({ method: 'translate', args: [key] });
        return Promise.resolve(noTranslations ? key : host.api.translate(key, params));
      },
      onReady: (fn) => queueMicrotask(fn),
      openDialog: (cfg) => {
        host.calls.push({ method: 'openDialog', args: [cfg] });
        return Promise.resolve(dialogAnswer);
      },
    },
    apiOverrides || {}
  );
  const window = { PluginAPI: apiLate ? undefined : iframeApi, confirm: () => false };
  const document = createDocument();
  const consoleStub = { error: (...args) => host.logs.push({ level: 'console.error', args }), log() {}, warn() {} };
  new Function('window', 'document', 'console', INDEX_SCRIPTS)(window, document, consoleStub);
  if (apiLate) {
    await sleep(5);
    window.PluginAPI = iframeApi;
    await sleep(150);
  }
  await flush();
  const screen = {
    host,
    app: document.getElementById('app'),
    status: document.getElementById('status'),
    storedConfig: () => core.normalizeConfig(host.storage['']),
    button: (text, within) => (within || screen.app).find((n) => n.tagName === 'BUTTON' && n.textContent === text),
    sectionRows: () => screen.app.findAll((n) => n.className === 'section-row'),
    taskSelect: (taskId) => screen.app.find((n) => n.tagName === 'SELECT' && n.getAttribute('data-task-id') === taskId),
    click: async (node) => {
      assert.ok(node, 'element to click not found');
      node.dispatch('click');
      await flush();
    },
    change: async (node, value) => {
      assert.ok(node, 'element to change not found');
      if (node.getAttribute('type') === 'checkbox') node.checked = value;
      else node.value = value;
      node.dispatch('change');
      await flush();
    },
  };
  return screen;
}

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

// ---- core -------------------------------------------------------------------------

test('normalizeConfig: defaults, strings, malformed projects and memberships', () => {
  for (const raw of [undefined, null, '', 'junk', '[]', 42]) {
    assert.deepStrictEqual(core.normalizeConfig(raw), core.createDefaultConfig(), JSON.stringify(raw));
  }
  const cfg = core.normalizeConfig({
    headerButton: 'yes',
    sections: [{ id: 'a', name: ' Next ' }, 'Later', { id: 'a', name: 'dup' }, 7],
    projects: {
      p1: { membership: { t1: 'a', t2: 'gone', t3: 9 } },
      p2: {},
      p3: 'x',
      '': { membership: { t9: 'a' } },
    },
  });
  assert.strictEqual(cfg.headerButton, true);
  assert.strictEqual(cfg.sections.length, 3);
  assert.deepStrictEqual(cfg.sections[0], { id: 'a', name: 'Next' });
  assert.strictEqual(cfg.sections[1].name, 'Later');
  assert.notStrictEqual(cfg.sections[2].id, 'a', 'a duplicate id is replaced');
  assert.deepStrictEqual(Object.keys(cfg.projects), ['p1'], 'empty and malformed projects are dropped');
  assert.deepStrictEqual(cfg.projects.p1.membership, { t1: 'a' }, 'unknown sections and non-string values dropped');
  assert.deepStrictEqual(core.normalizeConfig(JSON.stringify(cfg)), cfg, 'idempotent through JSON');
});

test('normalizeConfig: version 1 per-project sections are merged into one shared list', () => {
  const cfg = core.normalizeConfig({
    version: 1,
    headerButton: false,
    projects: {
      p1: { sections: [{ id: 'next', name: 'Next' }, { id: 'later', name: 'Later' }], membership: { a1: 'next', b1: 'later' } },
      p2: { sections: [{ id: 'l2', name: 'later' }, { id: 's2', name: 'Someday' }], membership: { x1: 'l2', x2: 's2' } },
    },
  });
  assert.strictEqual(cfg.version, 2);
  assert.deepStrictEqual(cfg.sections.map((s) => s.name), ['Next', 'Later', 'Someday'], 'same name, case-insensitively, is one section');
  assert.deepStrictEqual(cfg.projects.p1.membership, { a1: 'next', b1: 'later' });
  assert.deepStrictEqual(cfg.projects.p2.membership, { x1: 'later', x2: 's2' }, 'memberships follow the merged ids');
  assert.strictEqual(cfg.headerButton, false);
});

test('normalizeConfig: preset sections follow their emoji, names of your own do not', () => {
  const cfg = core.normalizeConfig({
    sections: [
      { id: 'a', name: '🌟 Middellange termijn' },
      { id: 'b', name: '🌙 Long term' },
      { id: 'c', name: '🌟 My own list' },
    ],
    projects: { p1: { membership: { t1: 'a' } } },
  });
  assert.deepStrictEqual(cfg.sections.map((x) => x.name), ['☀️ Middellange termijn', '💫 Long term', '🌟 My own list']);
  assert.deepStrictEqual(cfg.projects.p1.membership, { t1: 'a' }, 'the ids stay, so nothing moves');
});

test('desiredOrder, blocks and pruneMembership', () => {
  assert.deepStrictEqual(core.desiredOrder(['u1', 'b2', 'a2', 'b1', 'a1'], PROJECT_CFG), ['a2', 'a1', 'b2', 'b1', 'u1']);
  assert.deepStrictEqual(core.blocks(ORDER, PROJECT_CFG), [
    { sectionId: 'next', taskIds: ['a1', 'a2'] },
    { sectionId: 'later', taskIds: ['b1', 'b2'] },
    { sectionId: null, taskIds: ['u1'] },
  ]);
  assert.deepStrictEqual(core.blocks(['a1', 'u1', 'a2'], PROJECT_CFG).map((b) => b.sectionId), ['next', null, 'next']);
  assert.deepStrictEqual(core.pruneMembership(PROJECT_CFG.membership, ['a1', 'b2', 'zz']), { a1: 'next', b2: 'later' });
  assert.strictEqual(core.sectionOf(PROJECT_CFG, 'u1'), null);
  assert.strictEqual(core.sectionOf({ sections: [], membership: { t: 'gone' } }, 't'), null);
});

test('inferMembership: moved tasks adopt their neighbours, boundaries read as "under the next header"', () => {
  const infer = (after, moved, kind) => core.inferMembership(ORDER, after, PROJECT_CFG, moved || null, kind || null);
  assert.deepStrictEqual(infer(['a2', 'b1', 'a1', 'b2', 'u1']), { a2: 'next', b1: 'later', a1: 'later', b2: 'later' }, 'into the middle of Later');
  assert.deepStrictEqual(infer(['a2', 'a1', 'b1', 'b2', 'u1']).a1, 'next', 'to the end of its own section: stays');
  assert.deepStrictEqual(infer(['a1', 'a2', 'b2', 'b1', 'u1']).b2, 'later', 'to the top of its own section: stays');
  assert.deepStrictEqual(infer(['a1', 'a2', 'u1', 'b1', 'b2'], ['u1']).u1, 'later', 'dropped on a boundary: under the next header');
  assert.strictEqual(infer(['u1', 'a1', 'a2', 'b1', 'b2'], ['u1']).u1, 'next', 'to the very top: the first section');
  assert.strictEqual(infer(['a1', 'a2', 'b1', 'u1', 'b2'], ['b2']).b2, undefined, 'to the very end, below the loose block: no section');
  assert.strictEqual(infer(['a1', 'a2', 'b2', 'b1'], ['b1'], 'drag').b1, 'later', 'at the bottom of the last block, no loose tasks after it: stays');
  assert.deepStrictEqual(infer(['a1', 'a2', 'b1', 'b2', 'u1', 'n1']).n1, undefined, 'new task without a hint: no section');
  // With the host's move hint the ambiguity of a one-step swap disappears.
  assert.deepStrictEqual(infer(['a1', 'a2', 'b1', 'u1', 'b2'], ['u1']), { a1: 'next', a2: 'next', b1: 'later', b2: 'later', u1: 'later' });
  // A task new to the backlog is placed like a moved one when the user
  // dropped it there, and stays without a section when the app moved it.
  assert.deepStrictEqual(infer(['a1', 'n1', 'a2', 'b1', 'b2', 'u1'], ['n1'], 'drag').n1, 'next');
  assert.strictEqual(infer(['a1', 'n1', 'a2', 'b1', 'b2', 'u1'], ['n1']).n1, undefined);
  assert.deepStrictEqual(core.lcs(['a', 'b', 'c', 'd'], ['b', 'a', 'c', 'd']).length, 3);
});

// ---- background script ------------------------------------------------------------------

test('loads the way the host loads it and registers hooks, the config handler and the header button', async () => {
  const host = await startHost();
  const hooks = host.calls.filter((c) => c.method === 'registerHook').map((c) => c.args[0]);
  for (const h of [HOOKS.PROJECT_LIST_UPDATE, HOOKS.ACTION, HOOKS.WORK_CONTEXT_CHANGE, HOOKS.PERSISTED_DATA_CHANGED]) {
    assert.ok(hooks.includes(h), h);
  }
  assert.strictEqual(typeof host.configHandler, 'function');
  host.configHandler();
  assert.strictEqual(host.embedded, false, 'the gear is pressed from the settings screen: no work view to mount into');
  assert.strictEqual(host.calls.filter((c) => c.method === 'showIndexHtmlAsView').length, 1, 'it opens the page as its own view');
  assert.strictEqual(host.workContextButtons.length, 1);
  assert.deepStrictEqual(host.workContextButtons[0].showFor, ['PROJECT']);
  assert.strictEqual(host.workContextButtons[0].label, 'Backlog sections');
  // The header button is a toggle: it opens the page in the project view
  // it is pressed from, and closes it again.
  host.workContextButtons[0].onClick(CONTEXT_P1);
  assert.strictEqual(host.embedded, true);
  host.workContextButtons[0].onClick(CONTEXT_P1);
  assert.strictEqual(host.embedded, false);
  host.workContextButtons[0].onClick(CONTEXT_P1);
  assert.strictEqual(host.embedded, true);
  await host.userOpensContext({ id: 'p2', type: 'PROJECT', title: 'Other', taskIds: [] });
  assert.strictEqual(host.embedded, false, 'leaving the project closes it');
  assert.deepStrictEqual(Object.keys(host.shortcuts), ['section-up', 'section-down']);
  for (const method of ['registerHeaderButton', 'registerMenuEntry', 'registerSidePanelButton']) {
    assert.strictEqual(host.calls.filter((c) => c.method === method).length, 0, method);
  }
  assert.strictEqual(build.readManifest().isSkipMenuEntry, true);
  const off = await startHost({ storedConfig: { ...CONFIG, headerButton: false } });
  assert.strictEqual(off.workContextButtons.length, 0);
});

test('the section shortcuts move the task in hand one section up or down', async () => {
  const host = await startHost({ focusedTask: TASKS.find((t) => t.id === 'u1') });
  const membership = () => stored(host).projects.p1.membership;
  // "u1" has no section, the block at the bottom: up from there is the last section.
  await host.shortcuts['section-up'].onExec();
  await host.settle();
  assert.strictEqual(membership().u1, 'later');
  assert.deepStrictEqual(host.project('p1').backlogTaskIds, ['a1', 'a2', 'b1', 'b2', 'u1'], 'the backlog follows');
  await host.shortcuts['section-up'].onExec();
  await host.settle();
  assert.strictEqual(membership().u1, 'next');
  await host.shortcuts['section-up'].onExec();
  await host.settle();
  assert.strictEqual(membership().u1, 'next', 'the first section is the top');
  await host.shortcuts['section-down'].onExec();
  await host.settle();
  assert.strictEqual(membership().u1, 'later');
  await host.shortcuts['section-down'].onExec();
  await host.settle();
  assert.strictEqual(membership().u1, undefined, 'and down from the last section: no section again');
  // A task the backlog does not hold is left alone.
  const other = await startHost({ focusedTask: TASKS.find((t) => t.id === 'm1') });
  await other.shortcuts['section-down'].onExec();
  await other.settle();
  assert.strictEqual(stored(other).projects.p1.membership.m1, undefined);
});

test('start-up: a backlog that is out of section order is put in order once, with one write and a recognised echo', async () => {
  const host = await startHost({ projects: projects(['b2', 'u1', 'a1', 'b1', 'a2']) });
  assert.deepStrictEqual(host.project('p1').backlogTaskIds, ['a1', 'a2', 'b2', 'b1', 'u1']);
  assert.strictEqual(host.writes().length, 1, 'one write, the echo causes no second one');
  assert.deepStrictEqual(host.writes()[0].args, ['p1', { backlogTaskIds: ['a1', 'a2', 'b2', 'b1', 'u1'] }]);
  assert.strictEqual(host.calls.filter((c) => c.method === 'persistDataSynced').length, 0, 'memberships unchanged: nothing persisted');
  const tidy = await startHost();
  assert.strictEqual(tidy.writes().length, 0, 'an ordered backlog is left alone');
  assert.strictEqual(tidy.logs.filter((l) => l.level === 'hook-error' || l.level === 'err').length, 0);
});

test('drag in the backlog: the moved task changes section, memberships are persisted, no reorder needed', async () => {
  const host = await startHost();
  await host.userDragsInBacklog('p1', 'a1', ['a2', 'b1', 'a1', 'b2', 'u1']);
  assert.deepStrictEqual(stored(host).projects.p1.membership, { a2: 'next', b1: 'later', a1: 'later', b2: 'later' });
  assert.strictEqual(host.writes().length, 0, 'the order already matches the sections');
  assert.deepStrictEqual(host.project('p1').backlogTaskIds, ['a2', 'b1', 'a1', 'b2', 'u1']);
  // A task without a section, dropped between the last Next task and the
  // first Later task, sits under the Later header…
  await host.userDragsInBacklog('p1', 'u1', ['a2', 'u1', 'b1', 'a1', 'b2']);
  assert.strictEqual(stored(host).projects.p1.membership.u1, 'later');
  // …and dragged above everything it joins the first section.
  await host.userDragsInBacklog('p1', 'u1', ['u1', 'a2', 'b1', 'a1', 'b2']);
  assert.strictEqual(stored(host).projects.p1.membership.u1, 'next');
  assert.strictEqual(host.writes().length, 0);
});

test('drag to a boundary: the hinted task is the one that moved, even when the order alone is ambiguous', async () => {
  const host = await startHost();
  // u1 dragged down between the two Later tasks: it joins Later. Without the
  // hint this could also read as "b1 moved up out of Later".
  await host.userDragsInBacklog('p1', 'u1', ['a1', 'a2', 'b1', 'u1', 'b2']);
  assert.strictEqual(stored(host).projects.p1.membership.u1, 'later');
  // b1 dragged up between the two Next tasks: it leaves Later for Next, and
  // the tasks it landed between keep their section.
  const host2 = await startHost();
  await host2.userDragsInBacklog('p1', 'b1', ['a1', 'b1', 'a2', 'b2', 'u1']);
  const m = stored(host2).projects.p1.membership;
  assert.strictEqual(m.b1, 'next');
  assert.strictEqual(m.a2, 'next');
  assert.strictEqual(m.u1, undefined, 'u1 kept its place, so it kept having no section');
});

test('moving a task from the main list into the backlog: placed where it was dropped, appended ones stay loose', async () => {
  const host = await startHost();
  await host.userMovesToBacklog('p1', 'm1', ['a1', 'm1', 'a2', 'b1', 'b2', 'u1']);
  assert.strictEqual(stored(host).projects.p1.membership.m1, 'next');
  assert.strictEqual(host.writes().length, 0);
  const host2 = await startHost();
  await host2.userMovesToBacklog('p1', 'm1', ['m1', 'a1', 'a2', 'b1', 'b2', 'u1']);
  assert.strictEqual(stored(host2).projects.p1.membership.m1, 'next', 'dropped above everything: the first section');
  assert.strictEqual(host2.writes().length, 0);
});

test('a task the app puts in the backlog itself stays out of every section', async () => {
  const host = await startHost();
  // The app adds it at the top of the backlog.
  await host.taskArrivesInBacklog('p1', 'n1', ['n1', 'a1', 'a2', 'b1', 'b2', 'u1']);
  assert.strictEqual(stored(host).projects.p1.membership.n1, undefined, 'no section');
  assert.deepStrictEqual(host.project('p1').backlogTaskIds, ['a1', 'a2', 'b1', 'b2', 'n1', 'u1'], 'and the enforcement moves it into the loose block at the bottom');
});

test('a silent change (task removed from the backlog) prunes the membership and reorders nothing', async () => {
  const host = await startHost();
  await host.backlogChangedSilently('p1', ['a1', 'b1', 'b2', 'u1']);
  assert.deepStrictEqual(stored(host).projects.p1.membership, { a1: 'next', b1: 'later', b2: 'later' });
  assert.strictEqual(host.writes().length, 0);
});

test('changes made on the settings page are enforced without a restart', async () => {
  const host = await startHost();
  // The page moves b1 into Next and adds a section in front; the background
  // reloads the configuration and reorders the backlog accordingly.
  const next = JSON.parse(JSON.stringify(CONFIG));
  next.sections.unshift({ id: 'now', name: 'Now' });
  next.projects.p1.membership.a1 = 'later';
  await host.api.persistDataSynced(JSON.stringify(next));
  await host.settle();
  assert.deepStrictEqual(host.project('p1').backlogTaskIds, ['a2', 'a1', 'b1', 'b2', 'u1'], 'inside a block the order the app had is kept');
  assert.strictEqual(host.writes().length, 1);
});

test('a backlog whose tasks have no section is never written to or persisted', async () => {
  const host = await startHost();
  // Every task is in the block on top; sorting it changes no section.
  await host.userDragsInBacklog('p2', 'x2', ['x2', 'x1']);
  assert.strictEqual(host.writes().length, 0);
  assert.strictEqual(host.calls.filter((c) => c.method === 'persistDataSynced').length, 0);
  assert.strictEqual(stored(host).projects.p2, undefined);
  const empty = await startHost({ storedConfig: undefined, projects: projects(['b2', 'a1']) });
  await empty.userDragsInBacklog('p1', 'a1', ['a1', 'b2']);
  assert.strictEqual(empty.writes().length, 0);
  assert.strictEqual(empty.calls.filter((c) => c.method === 'persistDataSynced').length, 0);
});

test('a refused write is logged, the plugin keeps working and the write guard bounds retries', async () => {
  const host = await startHost();
  host.failUpdateFor.add('p1');
  const next = JSON.parse(JSON.stringify(CONFIG));
  next.projects.p1.membership.b2 = 'next';
  await host.api.persistDataSynced(JSON.stringify(next));
  await host.settle();
  assert.ok(host.logs.some((l) => l.level === 'err'));
  assert.strictEqual(host.logs.filter((l) => l.level === 'hook-error').length, 0);
  host.failUpdateFor.clear();
  await host.userDragsInBacklog('p1', 'a2', ['a2', 'a1', 'b1', 'b2', 'u1']);
  assert.deepStrictEqual(host.project('p1').backlogTaskIds, ['a2', 'a1', 'b2', 'b1', 'u1'], 'the pending membership change is now enforced');
});

// ---- headers in the backlog panel -----------------------------------------------------------

async function withHostDom(taskIds, fn) {
  const doc = backlogDocument(taskIds);
  FakeMutationObserver.instances = [];
  global.document = doc;
  global.MutationObserver = FakeMutationObserver;
  global.window = { localStorage: new FakeStorage() };
  try {
    await fn(doc);
  } finally {
    delete global.document;
    delete global.MutationObserver;
    delete global.window;
  }
}

const headersOf = (doc) =>
  doc.backlogList.children.map((c) => (c.tagName === 'task' ? c.id.slice(2) : `[${c.querySelector('.bs-name').textContent} ${c.querySelector('.bs-count').textContent}]`));

test('headers: one per block before its first row, with name and count; loose tasks get their own header', async () => {
  await withHostDom(ORDER, async (doc) => {
    const host = await startHost();
    assert.deepStrictEqual(headersOf(doc), ['[Next 2]', 'a1', 'a2', '[Later 2]', 'b1', 'b2', '[No section 1]', 'u1']);
    assert.ok(doc.getElementById('backlog-sections-style'), 'stylesheet injected');
    const observer = FakeMutationObserver.instances[0];
    assert.ok(observer && observer.observing);

    // The app re-renders the rows (drag): after the move the headers follow.
    await host.userDragsInBacklog('p1', 'a1', ['a2', 'b1', 'a1', 'b2', 'u1']);
    doc.setRows(['a2', 'b1', 'a1', 'b2', 'u1']);
    observer.trigger();
    assert.deepStrictEqual(headersOf(doc), ['[Next 1]', 'a2', '[Later 3]', 'b1', 'a1', 'b2', '[No section 1]', 'u1']);

    // Leaving the project removes the headers; coming back restores them.
    await host.userOpensContext({ id: 'p2', type: 'PROJECT', title: 'Other', taskIds: [] });
    doc.setRows(['x1', 'x2']);
    observer.trigger();
    assert.deepStrictEqual(headersOf(doc), ['[Next 0]', '[Later 0]', '[No section 2]', 'x1', 'x2'], 'the same sections, empty, in a project without memberships');
    await host.userOpensContext(CONTEXT_P1);
    doc.setRows(['a2', 'b1', 'a1', 'b2', 'u1']);
    observer.trigger();
    assert.deepStrictEqual(headersOf(doc), ['[Next 1]', 'a2', '[Later 3]', 'b1', 'a1', 'b2', '[No section 1]', 'u1']);

    // A pass that changes nothing writes nothing — that is what keeps the
    // observer from feeding itself (every text write is a mutation it sees).
    const before = FakeElement.textWrites;
    observer.trigger();
    observer.trigger();
    assert.strictEqual(FakeElement.textWrites, before, 'idempotent passes perform no DOM text writes');
    // Mutations inside a header (its own text nodes) are ignored outright.
    const header = doc.backlogList.querySelector('[data-backlog-sections-header="next"]');
    const span = header.querySelector('.bs-count');
    observer.trigger([{ type: 'childList', target: span, addedNodes: [{ nodeType: 3, parentNode: span }], removedNodes: [] }]);
    assert.strictEqual(FakeElement.textWrites, before);

    host.unloadFn();
    assert.deepStrictEqual(headersOf(doc), ['a2', 'b1', 'a1', 'b2', 'u1']);
    assert.strictEqual(doc.getElementById('backlog-sections-style'), null);
    assert.strictEqual(observer.observing, false);
  });
});

test('headers: a section without tasks here still gets a header, in its place in the order', async () => {
  // Only the first and the last section have tasks in this project; the ones
  // in between are shown empty so every backlog offers the same structure.
  const sections = [
    { id: 'now', name: 'Now' },
    { id: 'next', name: 'Next' },
    { id: 'later', name: 'Later' },
  ];
  const config = { version: 2, sections: sections, projects: { p1: { membership: { a1: 'now', b1: 'later' } } }, headerButton: true };
  await withHostDom(['a1', 'b1', 'u1'], async (doc) => {
    await startHost({ projects: [{ id: 'p1', title: 'Inbox', taskIds: [], backlogTaskIds: ['a1', 'b1', 'u1'], isEnableBacklog: true }], storedConfig: config });
    assert.deepStrictEqual(headersOf(doc), ['[Now 1]', 'a1', '[Next 0]', '[Later 1]', 'b1', '[No section 1]', 'u1']);
  });
  // Trailing empty sections sit directly above the loose block at the end.
  const trailing = { version: 2, sections: sections, projects: { p1: { membership: { a1: 'now' } } }, headerButton: true };
  await withHostDom(['a1', 'u1'], async (doc) => {
    await startHost({ projects: [{ id: 'p1', title: 'Inbox', taskIds: [], backlogTaskIds: ['a1', 'u1'], isEnableBacklog: true }], storedConfig: trailing });
    assert.deepStrictEqual(headersOf(doc), ['[Now 1]', 'a1', '[Next 0]', '[Later 0]', '[No section 1]', 'u1']);
  });
});

test('drag into a section without tasks: the empty section on that boundary wins', async () => {
  const sections = [
    { id: 'now', name: 'Now' },
    { id: 'next', name: 'Next' },
    { id: 'later', name: 'Later' },
  ];
  const config = () => ({ version: 2, sections: sections, projects: { p1: { membership: { t1: 'now', t2: 'later' } } }, headerButton: true });
  const project = () => ({ id: 'p1', title: 'Inbox', taskIds: [], backlogTaskIds: ['t1', 't2', 'u1'], isEnableBacklog: true });
  await withHostDom(['t1', 't2', 'u1'], async (doc) => {
    const host = await startHost({ projects: [project()], storedConfig: config() });
    // "Next" holds nothing here, so its header has no rows to drop between:
    // the boundary between "Now" and "Later" is its only target.
    assert.deepStrictEqual(headersOf(doc), ['[Now 1]', 't1', '[Next 0]', '[Later 1]', 't2', '[No section 1]', 'u1']);
    await host.userDragsInBacklog('p1', 'u1', ['t1', 'u1', 't2']);
    assert.deepStrictEqual(stored(host).projects.p1.membership, { t1: 'now', u1: 'next', t2: 'later' }, 'the empty section receives its first task');
    assert.strictEqual(host.writes().length, 0, 'the dropped order already matches the sections');
  });
  // A drop inside the loose block at the bottom stays there: no empty
  // section in between.
  await withHostDom(['t1', 't2', 'u1', 'z1'], async () => {
    const host = await startHost({
      projects: [{ ...project(), backlogTaskIds: ['t1', 't2', 'u1', 'z1'] }],
      storedConfig: config(),
    });
    await host.userDragsInBacklog('p1', 'z1', ['t1', 't2', 'z1', 'u1']);
    assert.deepStrictEqual(stored(host).projects.p1.membership, { t1: 'now', t2: 'later' });
  });
});

test('the keyboard moves: to the top is the first section, to the bottom is no section', async () => {
  const host = await startHost();
  // "Move to bottom" takes a task out of every section: the loose block.
  await host.userMovesInBacklog('p1', 'a1', ['a2', 'b1', 'b2', 'u1', 'a1'], '[Project] Move Task to Bottom in Backlog');
  assert.strictEqual(stored(host).projects.p1.membership.a1, undefined);
  // "Move to top" puts it in the first section.
  await host.userMovesInBacklog('p1', 'a1', ['a1', 'a2', 'b1', 'b2', 'u1'], '[Project] Move Task to Top in Backlog');
  assert.strictEqual(stored(host).projects.p1.membership.a1, 'next');
  // "Move up" from the top row of a block is one section up, in one press.
  await host.userMovesInBacklog('p1', 'b1', ['a1', 'a2', 'b1', 'b2', 'u1'], '[Project] Move Task Up in Backlog');
  assert.strictEqual(stored(host).projects.p1.membership.b1, 'next');
  // Below the top row of its block it only reorders: b1 is a later row of
  // Next now, so moving it up keeps it there.
  await host.userMovesInBacklog('p1', 'b1', ['a1', 'b1', 'a2', 'b2', 'u1'], '[Project] Move Task Up in Backlog');
  assert.strictEqual(stored(host).projects.p1.membership.b1, 'next');
});

test('a task dropped on a header lands in that section, empty or not', async () => {
  const sections = [
    { id: 'short', name: 'Short' },
    { id: 'mid', name: 'Mid' },
    { id: 'long', name: 'Long' },
  ];
  const config = { version: 2, sections: sections, projects: {}, headerButton: true };
  const project = { id: 'p1', title: 'Inbox', taskIds: [], backlogTaskIds: ['t1', 't2', 't3'], isEnableBacklog: true };
  await withHostDom(['t1', 't2', 't3'], async (doc) => {
    const host = await startHost({ projects: [project], storedConfig: config });
    assert.deepStrictEqual(headersOf(doc), ['[Short 0]', '[Mid 0]', '[Long 0]', '[No section 3]', 't1', 't2', 't3']);
    const list = doc.backlogList;

    // The CDK clones the dragged row into a placeholder that keeps the row's
    // data-task-id; its arrival is what tells the plugin a drag is running.
    const placeholder = doc.createElement('task');
    placeholder.className = 'cdk-drag-placeholder';
    placeholder.setAttribute('data-task-id', 't3');
    list.appendChild(placeholder);
    FakeMutationObserver.instances[0].trigger();
    layout(list);

    // The user holds the task somewhere in the band of "Long" — the header
    // itself or anything below it up to the next header — and lets go.
    const header = list.querySelector('[data-backlog-sections-header="long"]');
    doc.dispatch('pointermove', { clientX: 10, clientY: header.rect.top + 2 });
    assert.ok(header.className.includes('bs-target'), 'the section under the pointer is marked');
    doc.dispatch('pointerup', {});
    assert.ok(!header.className.includes('bs-target'), 'the mark goes away again');
    list.removeChild(placeholder);

    await host.userDragsInBacklog('p1', 't3', ['t1', 't3', 't2']);
    assert.deepStrictEqual(stored(host).projects.p1.membership, { t3: 'long' }, 'the section the user pointed at');
    assert.deepStrictEqual(host.project('p1').backlogTaskIds, ['t3', 't1', 't2'], 'and the backlog is put in that order');
  });

  // The whole band counts: released over a task row of the loose block, the
  // task belongs to that block, not to the header it started in.
  await withHostDom(['t1', 't2', 't3'], async (doc) => {
    const host = await startHost({
      projects: [{ id: 'p1', title: 'Inbox', taskIds: [], backlogTaskIds: ['t1', 't2', 't3'], isEnableBacklog: true }],
      storedConfig: { version: 2, sections: sections, projects: { p1: { membership: { t1: 'short' } } }, headerButton: true },
    });
    const list = doc.backlogList;
    const placeholder = doc.createElement('task');
    placeholder.className = 'cdk-drag-placeholder';
    placeholder.setAttribute('data-task-id', 't1');
    list.appendChild(placeholder);
    FakeMutationObserver.instances[0].trigger();
    layout(list);
    const loose = list.querySelector('[data-backlog-sections-header="__none__"]');
    const row = doc.getElementById('t-t3');
    assert.ok(row.rect.top > loose.rect.top, 'the row sits inside the loose band');
    doc.dispatch('pointermove', { clientX: 10, clientY: row.rect.top + 5 });
    assert.ok(loose.className.includes('bs-target'));
    doc.dispatch('pointerup', {});
    list.removeChild(placeholder);
    await host.userDragsInBacklog('p1', 't1', ['t2', 't1', 't3']);
    assert.strictEqual(stored(host).projects.p1, undefined, 'dropped in the loose band: no section left in this project');
  });
});

test('headers: collapse hides the rows of the section, is remembered per device, and a tag context shows nothing', async () => {
  await withHostDom(ORDER, async (doc) => {
    const host = await startHost();
    const later = doc.backlogList.querySelector('[data-backlog-sections-header="later"]');
    later.querySelector('.bs-toggle').dispatch('click');
    const hidden = () => doc.backlogList.children.filter((c) => c.tagName === 'task' && c.getAttribute('data-backlog-sections-hidden') === '1').map((c) => c.id.slice(2));
    assert.deepStrictEqual(hidden(), ['b1', 'b2']);
    assert.strictEqual(later.querySelector('.bs-toggle').getAttribute('aria-expanded'), 'false');
    assert.ok(global.window.localStorage.getItem('backlog-sections:collapsed').includes('later'));
    later.querySelector('.bs-toggle').dispatch('click');
    assert.deepStrictEqual(hidden(), []);
    await host.userOpensContext({ id: 'TODAY', type: 'TODAY', title: 'Today', taskIds: [] });
    assert.deepStrictEqual(headersOf(doc), ORDER);
  });
});

test('headers: several empty sections in a row settle down and stay put', async () => {
  // Adjacent empty headers used to swap places on every pass, and every swap
  // asked for the next one: the app locked up on opening the backlog.
  const sections = [
    { id: 'short', name: 'Short' },
    { id: 'mid', name: 'Mid' },
    { id: 'long', name: 'Long' },
    { id: 'cal', name: 'Calendar' },
  ];
  const config = { version: 2, sections: sections, projects: { p1: { membership: { t1: 'short' } } }, headerButton: true };
  await withHostDom(['t1', 't2', 't3'], async (doc) => {
    await startHost({
      projects: [{ id: 'p1', title: 'Inbox', taskIds: [], backlogTaskIds: ['t1', 't2', 't3'], isEnableBacklog: true }],
      storedConfig: config,
    });
    const expected = ['[Short 1]', 't1', '[Mid 0]', '[Long 0]', '[Calendar 0]', '[No section 2]', 't2', 't3'];
    assert.deepStrictEqual(headersOf(doc), expected);
    const observer = FakeMutationObserver.instances[0];
    const moves = () => doc.backlogList.children.map((c) => (c.tagName === 'task' ? c.id : c.getAttribute('data-backlog-sections-header')));
    const before = moves();
    for (let i = 0; i < 5; i++) observer.trigger();
    assert.deepStrictEqual(moves(), before, 'repeated passes move nothing');
    assert.deepStrictEqual(headersOf(doc), expected);
  });
});

test('headers: a header that outlived a project switch collapses the project on screen', async () => {
  const config = {
    version: 2,
    sections: SECTIONS,
    projects: { p1: { membership: MEMBERSHIP }, p2: { membership: { x1: 'next', x2: 'later' } } },
    headerButton: true,
  };
  await withHostDom(ORDER, async (doc) => {
    const host = await startHost({ storedConfig: config });
    // The app re-renders the rows on a switch but leaves the injected headers
    // in place, so their handlers must not remember the old project.
    await host.userOpensContext({ id: 'p2', type: 'PROJECT', title: 'Other', taskIds: [] });
    doc.setRows(['x1', 'x2']);
    FakeMutationObserver.instances[0].trigger();
    const header = doc.backlogList.querySelector('[data-backlog-sections-header="next"]');
    header.querySelector('.bs-toggle').dispatch('click');
    const hidden = () =>
      doc.backlogList.children.filter((c) => c.tagName === 'task' && c.getAttribute('data-backlog-sections-hidden') === '1').map((c) => c.id.slice(2));
    assert.deepStrictEqual(hidden(), ['x1'], 'the section of the project on screen collapses');
    assert.ok(global.window.localStorage.getItem('backlog-sections:collapsed').includes('p2'));
    header.querySelector('.bs-toggle').dispatch('click');
    assert.deepStrictEqual(hidden(), [], 'and opens again');
  });
});

test('headers: without a document the background still works', async () => {
  const host = await startHost();
  await host.userDragsInBacklog('p1', 'a1', ['a2', 'a1', 'b1', 'b2', 'u1']);
  assert.strictEqual(host.logs.filter((l) => l.level === 'hook-error' || l.level === 'err').length, 0);
});

test('the option: one click selects a task, two clicks open its name for editing', async () => {
  await withHostDom(ORDER, async (doc) => {
    await startHost();
    // The app renders the title as its own element and edits it on click.
    const row = doc.getElementById('t-a1');
    const title = doc.createElement('task-title');
    row.appendChild(title);
    const appSaw = [];
    title.addEventListener('click', (event) => appSaw.push(event));

    let stopped = 0;
    doc.dispatch('click', { target: title, stopPropagation: () => (stopped += 1), preventDefault() {} });
    assert.strictEqual(stopped, 1, 'the click is caught before the app sees it');
    assert.strictEqual(row.focused, true, 'the task is selected instead');
    assert.strictEqual(appSaw.length, 0, 'nothing is opened for editing');

    doc.dispatch('dblclick', { target: title, stopPropagation() {} });
    assert.strictEqual(appSaw.length, 1, 'the second click is handed to the app');
    assert.strictEqual(appSaw[0].__backlogSectionsSynthetic, true);

    // A click on a link inside a title is left alone.
    const link = doc.createElement('a');
    title.appendChild(link);
    stopped = 0;
    doc.dispatch('click', { target: link, stopPropagation: () => (stopped += 1), preventDefault() {} });
    assert.strictEqual(stopped, 0);
  });

  // With the option off the app keeps its own behaviour.
  await withHostDom(ORDER, async (doc) => {
    await startHost({ storedConfig: { ...CONFIG, clickSelectsTask: false } });
    const row = doc.getElementById('t-a1');
    const title = doc.createElement('task-title');
    row.appendChild(title);
    let stopped = 0;
    doc.dispatch('click', { target: title, stopPropagation: () => (stopped += 1), preventDefault() {} });
    assert.strictEqual(stopped, 0, 'the app opens the title as it always did');
    assert.notStrictEqual(row.focused, true);
  });
});

// ---- settings page ----------------------------------------------------------------------------

test('the app\'s move commands step through sections that hold no task here', async () => {
  const sections = [
    { id: 'short', name: 'Short' },
    { id: 'mid', name: 'Mid' },
    { id: 'long', name: 'Long' },
  ];
  const host = await startHost({
    projects: [{ id: 'p1', title: 'Inbox', taskIds: [], backlogTaskIds: ['t3', 't1', 't2'], isEnableBacklog: true }],
    storedConfig: { version: 2, sections: sections, projects: { p1: { membership: { t1: 'short', t2: 'short' } } }, headerButton: true },
  });
  const membership = () => stored(host).projects.p1.membership;
  // t3 has no section, so it sits in the block on top: one press down is
  // "Short", the first section — even though its rows come after t3's.
  await host.userMovesInBacklog('p1', 't3', ['t1', 't3', 't2'], '[Project] Move Task Down in Backlog');
  assert.strictEqual(membership().t3, 'short');
  // Inside the block it only reorders...
  await host.userMovesInBacklog('p1', 't3', ['t1', 't2', 't3'], '[Project] Move Task Down in Backlog');
  assert.strictEqual(membership().t3, 'short');
  // ...and from its bottom row it steps into the next section, empty or not.
  await host.userMovesInBacklog('p1', 't3', ['t1', 't2', 't3'], '[Project] Move Task Down in Backlog');
  assert.strictEqual(membership().t3, 'mid');
  await host.userMovesInBacklog('p1', 't3', ['t1', 't2', 't3'], '[Project] Move Task Down in Backlog');
  assert.strictEqual(membership().t3, 'long');
  await host.userMovesInBacklog('p1', 't3', ['t1', 't2', 't3'], '[Project] Move Task Up in Backlog');
  assert.strictEqual(membership().t3, 'mid', 'and back up again, one section at a time');
});

test('settings page: shows the shared sections, nothing per project', async () => {
  const s = await startScreen();
  assert.deepStrictEqual(s.sectionRows().map((r) => r.find((n) => n.className === 'section-name').value), ['Next', 'Later']);
  assert.strictEqual(s.app.find((n) => n.tagName === 'SELECT'), null, 'no project picker and no task assignment');
  assert.ok(!s.app.textContent.includes('Alpha one'), 'the page does not list tasks');
});

test('settings page: add, rename, reorder and delete sections', async () => {
  const s = await startScreen({ dialogAnswer: 'Delete' });
  const input = s.app.find((n) => n.tagName === 'INPUT' && n.getAttribute('placeholder') === 'Section name' && n.className !== 'section-name');
  input.value = ' Someday ';
  await s.click(s.button('Add section'));
  assert.deepStrictEqual(s.storedConfig().sections.map((x) => x.name), ['Next', 'Later', 'Someday']);
  await s.change(s.sectionRows()[2].find((n) => n.className === 'section-name'), 'Later on');
  assert.strictEqual(s.storedConfig().sections[2].name, 'Later on');
  await s.click(s.sectionRows()[2].find((n) => n.tagName === 'BUTTON' && n.textContent === '↑'));
  assert.deepStrictEqual(s.storedConfig().sections.map((x) => x.name), ['Next', 'Later on', 'Later']);
  await s.click(s.sectionRows()[2].find((n) => n.tagName === 'BUTTON' && n.textContent === 'Delete'));
  const cfg = s.storedConfig();
  assert.deepStrictEqual(cfg.sections.map((x) => x.name), ['Next', 'Later on']);
  assert.strictEqual(cfg.projects.p1.membership.b1, undefined, 'tasks of the deleted section lose it, in every project');
  const dialog = s.host.calls.find((c) => c.method === 'openDialog').args[0];
  assert.ok(dialog.htmlContent.includes('&quot;Later&quot;') && dialog.htmlContent.includes('2'));
  const cancelled = await startScreen({ dialogAnswer: undefined });
  await cancelled.click(cancelled.sectionRows()[0].find((n) => n.tagName === 'BUTTON' && n.textContent === 'Delete'));
  assert.strictEqual(cancelled.storedConfig().sections.length, 2);
});

test('settings page: the standard sections are added once, in the app language', async () => {
  const s = await startScreen();
  const names = () => s.storedConfig().sections.map((x) => x.name);
  const presets = (lang) => core.PRESET_SECTION_KEYS.map((k) => core.lookup(TRANSLATIONS[lang], k));
  await s.click(s.button(TRANSLATIONS.en.UI.SECTIONS.PRESET.ADD));
  assert.deepStrictEqual(names(), ['Next', 'Later'].concat(presets('en')));
  await s.click(s.button(TRANSLATIONS.en.UI.SECTIONS.PRESET.ADD));
  assert.strictEqual(names().length, 6, 'a second click adds nothing');
  const nl = await startScreen({ lang: 'nl' });
  await nl.click(nl.button(TRANSLATIONS.nl.UI.SECTIONS.PRESET.ADD));
  assert.deepStrictEqual(nl.storedConfig().sections.map((x) => x.name), ['Next', 'Later'].concat(presets('nl')));
});

test('settings page: the header-button option, Dutch, late PluginAPI and English fallback', async () => {
  const s = await startScreen();
  await s.change(s.app.find((n) => n.getAttribute('id') === 'opt-header-button'), false);
  assert.strictEqual(s.storedConfig().headerButton, false);
  const nl = await startScreen({ lang: 'nl' });
  assert.strictEqual(nl.app.find((n) => n.tagName === 'H1').textContent, TRANSLATIONS.nl.UI.TITLE);
  const late = await startScreen({ apiLate: true });
  assert.strictEqual(late.sectionRows().length, 2);
  const plain = await startScreen({ noTranslations: true });
  assert.strictEqual(plain.app.find((n) => n.tagName === 'H1').textContent, 'Backlog Sections');
  const broken = await startScreen({ apiOverrides: { loadSyncedData: () => Promise.reject(new Error('storage exploded')) } });
  assert.strictEqual(broken.status.textContent, 'The settings could not be loaded: storage exploded');
});

// ---- i18n, manifest, build ---------------------------------------------------------------------

function collectReferencedKeys(source) {
  const keys = new Set();
  for (const m of source.matchAll(/'((?:UI|BACKGROUND)\.[A-Z0-9_.]+)'/g)) keys.add(m[1]);
  return keys;
}

test('translations: identical keys and placeholders; every key used and defined', () => {
  const en = build.flattenKeys(TRANSLATIONS.en, '');
  const nl = build.flattenKeys(TRANSLATIONS.nl, '');
  assert.deepStrictEqual(nl, en);
  const params = (obj, key) => [...key.split('.').reduce((o, k) => o[k], obj).matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]).sort();
  for (const key of en) assert.deepStrictEqual(params(TRANSLATIONS.nl, key), params(TRANSLATIONS.en, key), key);
  const used = new Set([...collectReferencedKeys(build.readSrc('plugin.js')), ...collectReferencedKeys(build.readSrc('index.html')), ...collectReferencedKeys(build.readSrc('core.js'))]);
  for (const key of used) assert.ok(en.includes(key), `used but not defined: ${key}`);
  for (const key of en) {
    if (key === 'PLUGIN.NAME') continue;
    assert.ok(used.has(key), `defined but never used: ${key}`);
  }
});

test('manifest and build: valid, no menu entry, ZIP round-trips, index.html under the host limit', () => {
  const manifest = build.readManifest();
  assert.ok(!manifest.id.includes(':'));
  assert.strictEqual(manifest.iFrame, true);
  assert.strictEqual(manifest.isSkipMenuEntry, true);
  assert.deepStrictEqual(manifest.i18n.languages, ['en', 'nl']);
  for (const hook of ['projectListUpdate', 'action', 'workContextChange', 'persistedDataChanged']) assert.ok(manifest.hooks.includes(hook), hook);
  const files = build.buildFiles();
  assert.deepStrictEqual(build.validate(files), []);
  const back = build.unzip(build.zip(files, new Date(2026, 0, 1, 12)));
  assert.deepStrictEqual(back.map((e) => e.name), files.map((f) => f.name));
  for (let i = 0; i < files.length; i++) assert.ok(files[i].data.equals(back[i].data), files[i].name);
  assert.ok(files.find((f) => f.name === 'index.html').data.length <= 100 * 1024);
});

test('README exists, is English and documents the essentials', () => {
  const readme = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8');
  for (const needle of ['Backlog Sections', 'backlogTaskIds', 'Settings → Plugins', 'collapse']) {
    assert.ok(readme.includes(needle), needle);
  }
  for (const word of ['het', 'een', 'niet', 'wordt', 'sectie']) {
    assert.ok(!new RegExp(`\\b${word}\\b`, 'i').test(readme), `Dutch word in README: ${word}`);
  }
});

// ---- adopting imported tasks into sections ----------------------------------------------------

const withAssignments = async (payload, fn) => {
  const storage = new FakeStorage();
  if (payload !== null) {
    storage.setItem('sp-backlog-sections.assign.v1', JSON.stringify(payload));
  }
  const saved = globalThis.window;
  globalThis.window = { localStorage: storage };
  try {
    return await fn(storage);
  } finally {
    if (saved === undefined) delete globalThis.window;
    else globalThis.window = saved;
  }
};
const ASSIGN_ON = (assign) => ({ v: 1, updatedAt: 1, source: 'microsoft-todo', enabled: true, assign });

test('a list name finds its section: exact, unique prefix, never ambiguous', () => {
  const sections = [
    { id: 's1', name: '💫 Lange termijn' },
    { id: 's2', name: '💪 Korte termijn' },
    { id: 's3', name: '🎞️ Belegd in de agenda' },
  ];
  assert.strictEqual(core.matchSectionByListName(sections, '💪 Korte termijn'), 's2');
  assert.strictEqual(core.matchSectionByListName(sections, '💫 Lange termijn taken'), 's1');
  // Variation selector: the To Do list has 🎞 without VS16, the section 🎞️ with.
  assert.strictEqual(core.matchSectionByListName(sections, '🎞 Belegd in de agenda'), 's3');
  assert.strictEqual(core.matchSectionByListName(sections, 'Taken'), null);
  assert.strictEqual(
    core.matchSectionByListName(
      [{ id: 'a', name: 'Werk' }, { id: 'b', name: 'Werk privé' }],
      'Werk privé projecten',
    ),
    'b',
    'the more specific prefix chain still resolves through the exact rule order',
  );
  assert.strictEqual(
    core.matchSectionByListName([{ id: 'a', name: 'W' }, { id: 'b', name: 'We' }], 'Werk'),
    'b',
    'the longest prefix candidate wins',
  );
  assert.strictEqual(
    core.matchSectionByListName([{ id: 'a', name: 'Werk A' }, { id: 'b', name: 'Werk B' }], 'Werk'),
    null,
    'a tie in specificity is ambiguous: nothing placed',
  );
});

test('adoptAssignedTasks places published tasks once and only once', () => {
  const project = { sections: [{ id: 's1', name: 'Next' }], membership: { a1: 's1' } };
  const infos = { u1: 'FOLX::T1', u2: 'FOLY::T2', u3: 'FOLZ::T3', m1: null };
  // u2 is published with a name no section has; u3 is not published at all.
  const assign = { 'FOLX::T1': 'Next', 'FOLY::T2': 'Elders' };
  const first = core.adoptAssignedTasks(project, ['u1', 'u2', 'u3', 'a1', 'z9'], infos, assign, {});
  assert.deepStrictEqual(first.additions, { u1: 's1' });
  // Considered: published tasks, matched or not. u3 and z9 are left for a
  // later pass (the importer may publish them yet); a1 already has a section.
  assert.deepStrictEqual(first.considered.sort(), ['u1', 'u2']);
  const adopted = {};
  first.considered.forEach((id) => (adopted[id] = true));
  const second = core.adoptAssignedTasks(project, ['u1', 'u2', 'a1'], infos, assign, adopted);
  assert.deepStrictEqual(second.additions, {});
  assert.deepStrictEqual(second.considered, []);
});

test('the published payload is only accepted when it is sound and enabled', () => {
  assert.strictEqual(core.parseAssignPayload(null), null);
  assert.strictEqual(core.parseAssignPayload('not json'), null);
  assert.strictEqual(core.parseAssignPayload('{"enabled":false,"assign":{"a":"b"}}'), null);
  assert.strictEqual(core.parseAssignPayload('{"enabled":true}'), null);
  assert.deepStrictEqual(core.parseAssignPayload('{"enabled":true,"assign":{"a":"b"}}'), { a: 'b' });
});

test('a published assignment lands the imported task in its section on start-up', async () => {
  await withAssignments(ASSIGN_ON({ 'FOLX::AAMk1': 'Next' }), async () => {
    const tasks = TASKS.concat([{ id: 'i1', title: 'Imported', projectId: 'p1', tagIds: [], issueId: 'FOLX::AAMk1' }]);
    const host = await startHost({
      tasks,
      projects: [
        { id: 'p1', title: 'Inbox', taskIds: [], backlogTaskIds: ['i1', 'u1', 'a1', 'a2', 'b1', 'b2'], isEnableBacklog: true },
      ],
    });
    const cfg = stored(host);
    assert.strictEqual(cfg.projects.p1.membership.i1, 'next');
    assert.strictEqual(cfg.projects.p1.adopted.i1, true);
    // The backlog follows: i1 moves into the Next block.
    assert.deepStrictEqual(host.project('p1').backlogTaskIds, ['i1', 'a1', 'a2', 'b1', 'b2', 'u1']);
    // The plain task stays unsectioned and unmarked.
    assert.strictEqual(cfg.projects.p1.membership.u1, undefined);
    assert.strictEqual(cfg.projects.p1.adopted.u1, undefined);
  });
});

test('an adopted task the user drags out is not re-placed', async () => {
  await withAssignments(ASSIGN_ON({ 'FOLX::AAMk1': 'Next' }), async () => {
    const tasks = TASKS.concat([{ id: 'i1', title: 'Imported', projectId: 'p1', tagIds: [], issueId: 'FOLX::AAMk1' }]);
    // As stored after the user dragged i1 out: no membership, adopted mark kept.
    const config = {
      ...CONFIG,
      projects: { p1: { membership: MEMBERSHIP, adopted: { i1: true } } },
    };
    const host = await startHost({
      tasks,
      projects: [
        { id: 'p1', title: 'Inbox', taskIds: [], backlogTaskIds: ['i1', 'u1', 'a1', 'a2', 'b1', 'b2'], isEnableBacklog: true },
      ],
      storedConfig: config,
    });
    const cfg = stored(host);
    assert.strictEqual(cfg.projects.p1.membership.i1, undefined, 'the drag-out held');
  });
});

test('without a published payload (or disabled) nothing is placed, no tasks fetched', async () => {
  const tasks = TASKS.concat([{ id: 'i1', title: 'Imported', projectId: 'p1', tagIds: [], issueId: 'FOLX::AAMk1' }]);
  const project = () => [
    { id: 'p1', title: 'Inbox', taskIds: [], backlogTaskIds: ['i1', 'u1', 'a1', 'a2', 'b1', 'b2'], isEnableBacklog: true },
  ];
  await withAssignments(null, async () => {
    const host = await startHost({ tasks, projects: project() });
    assert.strictEqual(stored(host).projects.p1.membership.i1, undefined);
    assert.strictEqual(host.calls.filter((c) => c.method === 'getTasks').length, 0);
  });
  await withAssignments({ v: 1, enabled: false, assign: { 'FOLX::AAMk1': 'Next' } }, async () => {
    const host = await startHost({ tasks, projects: project() });
    assert.strictEqual(stored(host).projects.p1.membership.i1, undefined);
    assert.strictEqual(host.calls.filter((c) => c.method === 'getTasks').length, 0);
  });
});

// ---- moving due tasks out of the backlog ------------------------------------------------------

const ymd = (date) => {
  const pad = (n) => (n < 10 ? '0' : '') + n;
  return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate());
};
const TODAY = new Date();
const TODAY_YMD = ymd(TODAY);
const NEXT_WEEK_YMD = ymd(new Date(TODAY.getFullYear(), TODAY.getMonth(), TODAY.getDate() + 8));

test('planDueMoves picks this week, once per week, and forgets old weeks', () => {
  const monday = core.weekRangeOf(TODAY).start;
  const infos = {
    due: { dueDay: TODAY_YMD, dueWithTime: null, isDone: false },
    timed: { dueDay: null, dueWithTime: TODAY.getTime(), isDone: false },
    next: { dueDay: NEXT_WEEK_YMD, dueWithTime: null, isDone: false },
    done: { dueDay: TODAY_YMD, dueWithTime: null, isDone: true },
    plain: { dueDay: null, dueWithTime: null, isDone: false },
  };
  const first = core.planDueMoves(['due', 'timed', 'next', 'done', 'plain'], infos, { stale: '2020-01-06' }, TODAY);
  assert.deepStrictEqual(first.moveIds, ['due', 'timed']);
  assert.deepStrictEqual(first.movedOut, { due: monday, timed: monday });
  // Already moved this week: stays put, even though it is due.
  const second = core.planDueMoves(['due'], infos, first.movedOut, TODAY);
  assert.deepStrictEqual(second.moveIds, []);
  assert.strictEqual(second.movedOut.due, monday);
});

test('a backlog task due this week moves to the top of the project list', async () => {
  const tasks = TASKS.map((t) => (t.id === 'b1' ? { ...t, dueDay: TODAY_YMD } : t));
  const host = await startHost({ tasks, storedConfig: { ...CONFIG, moveDueThisWeek: true } });
  assert.deepStrictEqual(host.project('p1').taskIds, ['b1', 'm1'], 'moved to the front of the list');
  assert.ok(!host.project('p1').backlogTaskIds.includes('b1'), 'gone from the backlog');
  const cfg = stored(host);
  assert.strictEqual(cfg.projects.p1.movedOut.b1, core.weekRangeOf(TODAY).start);
  assert.strictEqual(cfg.projects.p1.membership.b1, undefined, 'membership pruned with the move');
  // The remaining backlog is still in section order.
  assert.deepStrictEqual(host.project('p1').backlogTaskIds, ['a1', 'a2', 'b2', 'u1']);
});

test('a task put back in the backlog stays there for the rest of the week', async () => {
  const tasks = TASKS.map((t) => (t.id === 'b1' ? { ...t, dueDay: TODAY_YMD } : t));
  const monday = core.weekRangeOf(TODAY).start;
  const config = {
    ...CONFIG,
    moveDueThisWeek: true,
    projects: { p1: { membership: MEMBERSHIP, movedOut: { b1: monday } } },
  };
  const host = await startHost({ tasks, storedConfig: config });
  assert.ok(host.project('p1').backlogTaskIds.includes('b1'), 'moved again despite the weekly guard');
  assert.deepStrictEqual(host.project('p1').taskIds, ['m1']);
});

test('with the option off, due dates change nothing', async () => {
  const tasks = TASKS.map((t) => (t.id === 'b1' ? { ...t, dueDay: TODAY_YMD } : t));
  const host = await startHost({ tasks });
  assert.deepStrictEqual(host.project('p1').taskIds, ['m1']);
  assert.ok(host.project('p1').backlogTaskIds.includes('b1'));
});

test('the settings page toggles the due-task move', async () => {
  const screen = await startScreen();
  const checkbox = screen.app.find((n) => n.getAttribute && n.getAttribute('id') === 'opt-move-due');
  assert.ok(checkbox, 'move-due checkbox not rendered');
  await screen.change(checkbox, true);
  assert.strictEqual(screen.storedConfig().moveDueThisWeek, true);
});

// ---- run --------------------------------------------------------------------------------------------

(async () => {
  let failed = 0;
  for (const { name, fn } of tests) {
    try {
      await fn();
      console.log(`  ok    ${name}`);
    } catch (error) {
      failed += 1;
      console.log(`  FAIL  ${name}`);
      console.log(String(error && error.stack ? error.stack : error).replace(/^/gm, '        '));
    }
  }
  console.log(`\n${tests.length - failed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
