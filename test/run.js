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
const { backlogDocument, FakeMutationObserver, FakeStorage, FakeElement } = require('./fake-host-dom.js');

const PLUGIN_JS = build.assemblePluginJs();
const INDEX_SCRIPTS = [...build.assembleIndexHtml().matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join('\n');
const core = new Function(`${build.readSrc('core.js')}\nreturn BacklogSectionsCore;`)();

// ---- fixtures -------------------------------------------------------------------

const PROJECT_CFG = {
  sections: [
    { id: 'next', name: 'Next' },
    { id: 'later', name: 'Later' },
  ],
  membership: { a1: 'next', a2: 'next', b1: 'later', b2: 'later' },
};
const CONFIG = { version: 1, projects: { p1: PROJECT_CFG }, headerButton: true };
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
    projects: {
      p1: { sections: [{ id: 'a', name: ' Next ' }, 'Later', { id: 'a', name: 'dup' }, 7], membership: { t1: 'a', t2: 'gone', t3: 9 } },
      p2: {},
      p3: 'x',
      '': { sections: [{ id: 'z', name: 'z' }] },
    },
  });
  assert.strictEqual(cfg.headerButton, true);
  assert.deepStrictEqual(Object.keys(cfg.projects), ['p1'], 'empty and malformed projects are dropped');
  const p1 = cfg.projects.p1;
  assert.strictEqual(p1.sections.length, 3);
  assert.deepStrictEqual(p1.sections[0], { id: 'a', name: 'Next' });
  assert.strictEqual(p1.sections[1].name, 'Later');
  assert.notStrictEqual(p1.sections[2].id, 'a');
  assert.deepStrictEqual(p1.membership, { t1: 'a' }, 'unknown sections and non-string values dropped');
  assert.deepStrictEqual(core.normalizeConfig(JSON.stringify(cfg)), cfg, 'idempotent through JSON');
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
  const infer = (after, moved) => core.inferMembership(ORDER, after, PROJECT_CFG, moved || null);
  assert.deepStrictEqual(infer(['a2', 'b1', 'a1', 'b2', 'u1']), { a2: 'next', b1: 'later', a1: 'later', b2: 'later' }, 'into the middle of Later');
  assert.deepStrictEqual(infer(['a2', 'a1', 'b1', 'b2', 'u1']).a1, 'next', 'to the end of its own section: stays');
  assert.deepStrictEqual(infer(['a1', 'a2', 'b2', 'b1', 'u1']).b2, 'later', 'to the top of its own section: stays');
  assert.deepStrictEqual(infer(['a1', 'a2', 'u1', 'b1', 'b2']).u1, 'later', 'loose task dropped on a boundary goes under the next header');
  assert.deepStrictEqual(infer(['u1', 'a1', 'a2', 'b1', 'b2']).u1, 'next', 'to the very top: first section');
  assert.strictEqual(infer(['a2', 'b1', 'b2', 'u1', 'a1']).a1, undefined, 'to the very end behind a loose task: no section');
  assert.deepStrictEqual(infer(['a1', 'a2', 'b1', 'b2', 'u1', 'n1']).n1, undefined, 'new task without a hint: no section');
  // With the host's move hint the ambiguity of a one-step swap disappears.
  assert.deepStrictEqual(infer(['a1', 'a2', 'b1', 'u1', 'b2'], ['u1']), { a1: 'next', a2: 'next', b1: 'later', b2: 'later', u1: 'later' });
  assert.deepStrictEqual(infer(['a1', 'a2', 'b1', 'u1', 'b2'], ['b2']), { a1: 'next', a2: 'next', b1: 'later' }, 'b2 moved below the loose task: leaves its section');
  // A task new to the backlog but named by the hint is placed like a moved one.
  assert.deepStrictEqual(infer(['a1', 'n1', 'a2', 'b1', 'b2', 'u1'], ['n1']).n1, 'next');
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
  assert.strictEqual(host.calls.filter((c) => c.method === 'showIndexHtmlAsView').length, 1);
  assert.strictEqual(host.workContextButtons.length, 1);
  assert.deepStrictEqual(host.workContextButtons[0].showFor, ['PROJECT']);
  assert.strictEqual(host.workContextButtons[0].label, 'Backlog sections');
  host.workContextButtons[0].onClick(CONTEXT_P1);
  assert.strictEqual(host.calls.filter((c) => c.method === 'showIndexHtmlAsView').length, 2);
  for (const method of ['registerHeaderButton', 'registerMenuEntry', 'registerSidePanelButton', 'registerShortcut']) {
    assert.strictEqual(host.calls.filter((c) => c.method === method).length, 0, method);
  }
  assert.strictEqual(build.readManifest().isSkipMenuEntry, true);
  const off = await startHost({ storedConfig: { ...CONFIG, headerButton: false } });
  assert.strictEqual(off.workContextButtons.length, 0);
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
  // A loose task dropped between the last Next task and the first Later task sits under the Later header…
  await host.userDragsInBacklog('p1', 'u1', ['a2', 'u1', 'b1', 'a1', 'b2']);
  assert.strictEqual(stored(host).projects.p1.membership.u1, 'later');
  // …dragged to the very top it goes under the Next header…
  await host.userDragsInBacklog('p1', 'u1', ['u1', 'a2', 'b1', 'a1', 'b2']);
  assert.strictEqual(stored(host).projects.p1.membership.u1, 'next');
  // …and moved down to the end of Next (the same boundary) it stays in Next.
  await host.userDragsInBacklog('p1', 'u1', ['a2', 'u1', 'b1', 'a1', 'b2']);
  assert.strictEqual(stored(host).projects.p1.membership.u1, 'next');
  assert.strictEqual(host.writes().length, 0);
});

test('drag to a boundary: the hinted task is the one that moved, even when the order alone is ambiguous', async () => {
  const host = await startHost();
  // b2 dragged below the loose task: it leaves Later. Without the hint this
  // could also read as "u1 moved up into Later".
  await host.userDragsInBacklog('p1', 'b2', ['a1', 'a2', 'b1', 'u1', 'b2']);
  const m = stored(host).projects.p1.membership;
  assert.strictEqual(m.b2, undefined);
  assert.strictEqual(m.u1, undefined);
  assert.strictEqual(host.writes().length, 0, 'u1 and b2 now form the trailing loose block: no write');
  const host2 = await startHost();
  await host2.userDragsInBacklog('p1', 'u1', ['a1', 'a2', 'b1', 'u1', 'b2']);
  assert.strictEqual(stored(host2).projects.p1.membership.u1, 'later');
});

test('moving a task from the main list into the backlog: placed where it was dropped, appended ones stay loose', async () => {
  const host = await startHost();
  await host.userMovesToBacklog('p1', 'm1', ['a1', 'm1', 'a2', 'b1', 'b2', 'u1']);
  assert.strictEqual(stored(host).projects.p1.membership.m1, 'next');
  assert.strictEqual(host.writes().length, 0);
  const host2 = await startHost();
  await host2.userMovesToBacklog('p1', 'm1', ['a1', 'a2', 'b1', 'b2', 'u1', 'm1']);
  assert.strictEqual(stored(host2).projects.p1.membership.m1, undefined, 'appended after the loose block: loose');
  assert.strictEqual(host2.writes().length, 0);
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
  next.projects.p1.sections.unshift({ id: 'now', name: 'Now' });
  next.projects.p1.membership.b1 = 'next';
  next.projects.p1.membership.u1 = 'now';
  await host.api.persistDataSynced(JSON.stringify(next));
  await host.settle();
  assert.deepStrictEqual(host.project('p1').backlogTaskIds, ['u1', 'a1', 'a2', 'b1', 'b2']);
  assert.strictEqual(host.writes().length, 1);
});

test('projects without sections are never written to or persisted', async () => {
  const host = await startHost();
  await host.userDragsInBacklog('p2', 'x2', ['x2', 'x1']);
  assert.strictEqual(host.writes().length, 0);
  assert.strictEqual(host.calls.filter((c) => c.method === 'persistDataSynced').length, 0);
  const empty = await startHost({ storedConfig: undefined, projects: projects(['b2', 'a1']) });
  await empty.userDragsInBacklog('p1', 'a1', ['a1', 'b2']);
  assert.strictEqual(empty.writes().length, 0);
  assert.strictEqual(empty.calls.filter((c) => c.method === 'persistDataSynced').length, 0);
});

test('a refused write is logged, the plugin keeps working and the write guard bounds retries', async () => {
  const host = await startHost();
  host.failUpdateFor.add('p1');
  const next = JSON.parse(JSON.stringify(CONFIG));
  next.projects.p1.membership.u1 = 'next';
  await host.api.persistDataSynced(JSON.stringify(next));
  await host.settle();
  assert.ok(host.logs.some((l) => l.level === 'err'));
  assert.strictEqual(host.logs.filter((l) => l.level === 'hook-error').length, 0);
  host.failUpdateFor.clear();
  await host.userDragsInBacklog('p1', 'a2', ['a2', 'a1', 'b1', 'b2', 'u1']);
  assert.deepStrictEqual(host.project('p1').backlogTaskIds, ['a2', 'a1', 'u1', 'b1', 'b2'], 'the pending membership change is now enforced');
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
    assert.deepStrictEqual(headersOf(doc), ['x1', 'x2'], 'p2 has no sections');
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

test('headers: without a document the background still works', async () => {
  const host = await startHost();
  await host.userDragsInBacklog('p1', 'a1', ['a2', 'a1', 'b1', 'b2', 'u1']);
  assert.strictEqual(host.logs.filter((l) => l.level === 'hook-error' || l.level === 'err').length, 0);
});

// ---- settings page ----------------------------------------------------------------------------

test('settings page: shows the active project, its sections with counts, and the backlog tasks with section selects', async () => {
  const s = await startScreen();
  const select = s.app.find((n) => n.tagName === 'SELECT' && n.getAttribute('aria-label') === 'Project');
  assert.strictEqual(select.value, 'p1');
  assert.deepStrictEqual(s.sectionRows().map((r) => r.find((n) => n.className === 'section-name').value), ['Next', 'Later']);
  assert.deepStrictEqual(s.sectionRows().map((r) => r.find((n) => n.className === 'count').textContent), ['2 tasks', '2 tasks']);
  assert.strictEqual(s.taskSelect('a1').value, 'next');
  assert.strictEqual(s.taskSelect('u1').value, '');
  assert.ok(s.app.textContent.includes('Alpha one'));
  await s.change(select, 'p2');
  assert.ok(s.app.textContent.includes('No sections yet'));
  assert.ok(s.taskSelect('x1'));
});

test('settings page: add, rename, reorder and delete sections; assign tasks', async () => {
  const s = await startScreen({ dialogAnswer: 'Delete' });
  const input = s.app.find((n) => n.tagName === 'INPUT' && n.getAttribute('placeholder') === 'Section name' && n.className !== 'section-name');
  input.value = ' Someday ';
  await s.click(s.button('Add section'));
  let cfg = s.storedConfig();
  assert.deepStrictEqual(cfg.projects.p1.sections.map((x) => x.name), ['Next', 'Later', 'Someday']);
  await s.change(s.sectionRows()[2].find((n) => n.className === 'section-name'), 'Later on');
  assert.strictEqual(s.storedConfig().projects.p1.sections[2].name, 'Later on');
  await s.click(s.sectionRows()[2].find((n) => n.tagName === 'BUTTON' && n.textContent === '↑'));
  assert.deepStrictEqual(s.storedConfig().projects.p1.sections.map((x) => x.name), ['Next', 'Later on', 'Later']);
  await s.change(s.taskSelect('u1'), 'next');
  assert.strictEqual(s.storedConfig().projects.p1.membership.u1, 'next');
  await s.change(s.taskSelect('a1'), '');
  assert.strictEqual(s.storedConfig().projects.p1.membership.a1, undefined);
  await s.click(s.sectionRows()[2].find((n) => n.tagName === 'BUTTON' && n.textContent === 'Delete'));
  cfg = s.storedConfig();
  assert.deepStrictEqual(cfg.projects.p1.sections.map((x) => x.name), ['Next', 'Later on']);
  assert.strictEqual(cfg.projects.p1.membership.b1, undefined, 'tasks of the deleted section are loose');
  const dialog = s.host.calls.find((c) => c.method === 'openDialog').args[0];
  assert.ok(dialog.htmlContent.includes('&quot;Later&quot;') && dialog.htmlContent.includes('2 tasks'));
  const cancelled = await startScreen({ dialogAnswer: undefined });
  await cancelled.click(cancelled.sectionRows()[0].find((n) => n.tagName === 'BUTTON' && n.textContent === 'Delete'));
  assert.strictEqual(cancelled.storedConfig().projects.p1.sections.length, 2);
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
  const used = new Set([...collectReferencedKeys(build.readSrc('plugin.js')), ...collectReferencedKeys(build.readSrc('index.html'))]);
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
