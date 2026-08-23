/*
 * Backlog Sections — background script.
 *
 * Keeps each project's backlog ordered by section, learns from the user's
 * drags in the native backlog which section a task belongs to, and draws the
 * section headers into the backlog panel. The only write it performs on the
 * app's data is updateProject(projectId, { backlogTaskIds }) with the ids the
 * backlog already holds, in a different order.
 */
/* @@CORE@@ */
(function () {
  'use strict';

  var api = PluginAPI;
  var core = BacklogSectionsCore;

  var hooks = api.Hooks || {};
  var HOOK_PROJECT_LIST = hooks.PROJECT_LIST_UPDATE || 'projectListUpdate';
  var HOOK_ACTION = hooks.ACTION || 'action';
  var HOOK_WORK_CONTEXT = hooks.WORK_CONTEXT_CHANGE || 'workContextChange';
  var HOOK_DATA_CHANGED = hooks.PERSISTED_DATA_CHANGED || 'persistedDataChanged';

  // The host's own backlog move actions (project.actions.ts). Their payload
  // names the moved task, which makes the section inference exact; without it
  // the plugin falls back to comparing the old and new order.
  var BACKLOG_MOVE_ACTIONS = {
    '[Project] Move Task in Backlog': true,
    '[Project] Move Task from regular to backlog': true,
    '[Project] Move Task to Backlog Auto': true,
    '[Project] Move Task Up in Backlog': true,
    '[Project] Move Task Down in Backlog': true,
    '[Project] Move Task to Top in Backlog': true,
    '[Project] Move Task to Bottom in Backlog': true,
  };
  var HINT_MAX_AGE_MS = 2000;

  var WRITE_LIMIT = 10;
  var WRITE_WINDOW_MS = 5000;

  var config = core.createDefaultConfig();
  var lastOrder = {}; // projectId -> backlogTaskIds as last seen / written
  var pendingWrites = {}; // projectId -> order written, awaiting the echo
  var recentWrites = {};
  var moveHints = {}; // projectId -> { taskId, at }
  var latestProjectState = null;
  var reconcileTimer = null;
  var activeProjectId = null;

  // ---- helpers ------------------------------------------------------------------

  // The host translates into the app language; when it has nothing for a key
  // it returns the key itself, and the embedded English strings take over.
  function t(key, params) {
    var text = key;
    try {
      var translated = api.translate(key, params);
      if (typeof translated === 'string') {
        text = translated;
      }
    } catch (e) {
      text = key;
    }
    if (text === key) {
      text = core.interpolate(core.lookup(BacklogSectionsEnglish, key), params);
    }
    return text;
  }

  function logError(message, error) {
    var log = api.log && typeof api.log.err === 'function' ? api.log.err : null;
    if (log) {
      log('[backlog-sections] ' + message, error);
    }
  }

  function loadConfig() {
    return Promise.resolve()
      .then(function () {
        return api.loadSyncedData();
      })
      .then(function (raw) {
        config = core.normalizeConfig(raw);
      })
      .catch(function (error) {
        logError('Configuration could not be loaded; keeping the previous one.', error);
      });
  }

  function saveConfig() {
    return Promise.resolve()
      .then(function () {
        return api.persistDataSynced(JSON.stringify(config));
      })
      .catch(function (error) {
        logError('Configuration could not be saved.', error);
      });
  }

  function writeAllowed(projectId) {
    var now = Date.now();
    var entry = recentWrites[projectId];
    if (!entry || now - entry.since > WRITE_WINDOW_MS) {
      recentWrites[projectId] = { since: now, count: 1 };
      return true;
    }
    entry.count += 1;
    return entry.count <= WRITE_LIMIT;
  }

  // ---- reconciliation -------------------------------------------------------------

  /*
   * Bring one project in line after its backlog order changed (or after the
   * configuration changed): infer memberships from the move, prune them to the
   * tasks still in the backlog, persist when they changed, and enforce the
   * section order — a write only when the order actually differs.
   */
  function reconcileProject(projectId, newOrder) {
    var order = Array.isArray(newOrder) ? newOrder.slice() : [];
    var pending = pendingWrites[projectId];
    if (pending && core.sameList(pending, order)) {
      delete pendingWrites[projectId];
      lastOrder[projectId] = order;
      decorate();
      return Promise.resolve();
    }
    var project = core.getProject(config, projectId);
    var hasConfig = project.sections.length > 0 || Object.keys(project.membership).length > 0;
    if (!hasConfig) {
      lastOrder[projectId] = order;
      decorate();
      return Promise.resolve();
    }

    // Without a known previous order (start-up, or right after the settings
    // page changed the configuration) there is nothing to infer from: the
    // stored memberships are the truth and the order follows them.
    var previous = lastOrder[projectId] || null;
    var hint = moveHints[projectId];
    var movedIds = hint && Date.now() - hint.at <= HINT_MAX_AGE_MS ? [hint.taskId] : null;
    delete moveHints[projectId];

    var membership =
      !previous || core.sameList(previous, order)
        ? project.membership
        : core.inferMembership(previous, order, project, movedIds);
    membership = core.pruneMembership(membership, order);

    var work = Promise.resolve();
    if (!core.sameMembership(membership, project.membership)) {
      core.ensureProject(config, projectId).membership = membership;
      work = saveConfig();
    }
    var updated = core.getProject(config, projectId);
    var desired = core.desiredOrder(order, updated);
    if (!core.sameList(desired, order)) {
      if (writeAllowed(projectId)) {
        pendingWrites[projectId] = desired;
        lastOrder[projectId] = desired;
        work = work.then(function () {
          return Promise.resolve()
            .then(function () {
              return api.updateProject(projectId, { backlogTaskIds: desired });
            })
            .catch(function (error) {
              delete pendingWrites[projectId];
              lastOrder[projectId] = order;
              logError('The backlog of project ' + projectId + ' could not be reordered.', error);
            });
        });
      } else {
        logError('Project ' + projectId + ' keeps changing its backlog order; giving up on it for now.');
        lastOrder[projectId] = order;
      }
    } else {
      lastOrder[projectId] = order;
    }
    return work.then(decorate);
  }

  function reconcileFromProjects(projects) {
    var chain = Promise.resolve();
    (projects || []).forEach(function (project) {
      if (!project || typeof project.id !== 'string') {
        return;
      }
      var order = Array.isArray(project.backlogTaskIds) ? project.backlogTaskIds : [];
      var known = lastOrder[project.id];
      if (known && core.sameList(known, order) && !pendingWrites[project.id]) {
        return;
      }
      chain = chain.then(function () {
        return reconcileProject(project.id, order);
      });
    });
    return chain;
  }

  function projectsFromState(projectState) {
    if (!projectState || !projectState.entities) {
      return [];
    }
    var ids = Array.isArray(projectState.ids) ? projectState.ids : Object.keys(projectState.entities);
    return ids
      .map(function (id) {
        return projectState.entities[id];
      })
      .filter(Boolean);
  }

  // PROJECT_LIST_UPDATE arrives before the ACTION hook of the same dispatch,
  // so the work is deferred one tick to let the move hint land first.
  function scheduleReconcile() {
    if (reconcileTimer) {
      return;
    }
    reconcileTimer = setTimeout(function () {
      reconcileTimer = null;
      var state = latestProjectState;
      latestProjectState = null;
      reconcileFromProjects(projectsFromState(state));
    }, 0);
  }

  function reloadAllProjects() {
    return Promise.resolve()
      .then(function () {
        return api.getAllProjects();
      })
      .then(function (projects) {
        return reconcileFromProjects(projects);
      })
      .catch(function (error) {
        logError('Projects could not be read.', error);
      });
  }

  // ---- headers in the backlog panel -----------------------------------------------

  /*
   * The plugin API has no hook into rendering, so this leans on plugin.js
   * running in the host document: a stylesheet, and a MutationObserver that
   * keeps one header element before the first row of each section block in
   * the backlog list (.task-list-inner[data-id="BACKLOG"], rows task#t-<id>),
   * re-applied synchronously — before paint — and idempotently. Collapsed
   * sections hide their rows; that state is per device (localStorage).
   */
  var STYLE_ID = 'backlog-sections-style';
  var HEADER_CLASS = 'backlog-sections-header';
  var HEADER_ATTR = 'data-backlog-sections-header';
  var HIDDEN_ATTR = 'data-backlog-sections-hidden';
  var LIST_SELECTOR = '.task-list-inner[data-id="BACKLOG"]';
  var STORAGE_KEY = 'backlog-sections:collapsed';
  var observer = null;
  var collapsed = loadCollapsed();

  function hostDocument() {
    return typeof document !== 'undefined' && document && document.body ? document : null;
  }

  // Per-device convenience: the host page's localStorage (plugin.js runs in it).
  function deviceStorage() {
    try {
      return typeof window !== 'undefined' && window && window.localStorage ? window.localStorage : null;
    } catch (e) {
      return null;
    }
  }

  function loadCollapsed() {
    try {
      var store = deviceStorage();
      var raw = store ? store.getItem(STORAGE_KEY) : null;
      var parsed = raw ? JSON.parse(raw) : {};
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch (e) {
      return {};
    }
  }

  function saveCollapsed() {
    try {
      var store = deviceStorage();
      if (store) {
        store.setItem(STORAGE_KEY, JSON.stringify(collapsed));
      }
    } catch (e) {
      // Per-device convenience only; losing it costs nothing.
    }
  }

  function isCollapsed(projectId, sectionKey) {
    return !!(collapsed[projectId] && collapsed[projectId][sectionKey]);
  }

  function toggleCollapsed(projectId, sectionKey) {
    collapsed[projectId] = collapsed[projectId] || {};
    if (collapsed[projectId][sectionKey]) {
      delete collapsed[projectId][sectionKey];
    } else {
      collapsed[projectId][sectionKey] = true;
    }
    saveCollapsed();
    decorate();
  }

  function ensureStyle(doc) {
    if (doc.getElementById(STYLE_ID)) {
      return;
    }
    var style = doc.createElement('style');
    style.id = STYLE_ID;
    style.textContent =
      '.' + HEADER_CLASS + ' { display: flex; align-items: center; gap: 8px; margin: 10px 4px 2px; padding: 4px 6px 4px 2px;' +
      ' border-top: 1px solid var(--divider-color, rgba(128,128,128,.35)); font-size: 0.85rem; font-weight: 600;' +
      ' color: var(--text-color-muted, inherit); user-select: none; }\n' +
      '.' + HEADER_CLASS + ' .bs-toggle { all: unset; cursor: pointer; width: 1.2em; text-align: center; opacity: .8; }\n' +
      '.' + HEADER_CLASS + ' .bs-toggle:hover { opacity: 1; }\n' +
      '.' + HEADER_CLASS + ' .bs-name { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }\n' +
      '.' + HEADER_CLASS + ' .bs-count { flex: none; font-weight: 400; opacity: .8; }\n' +
      '.' + HEADER_CLASS + '.bs-loose { font-style: italic; font-weight: 500; }\n' +
      'task[' + HIDDEN_ATTR + '="1"] { display: none !important; }';
    (doc.head || doc.body).appendChild(style);
  }

  function sectionKey(sectionId) {
    return sectionId || '__none__';
  }

  function headerLabel(project, sectionId) {
    if (!sectionId) {
      return t('BACKGROUND.NO_SECTION');
    }
    for (var i = 0; i < project.sections.length; i++) {
      if (project.sections[i].id === sectionId) {
        return project.sections[i].name || '—';
      }
    }
    return '—';
  }

  function buildHeader(doc, projectId, block, project) {
    var header = doc.createElement('div');
    header.className = HEADER_CLASS + (block.sectionId ? '' : ' bs-loose');
    header.setAttribute(HEADER_ATTR, sectionKey(block.sectionId));
    var toggle = doc.createElement('button');
    toggle.className = 'bs-toggle';
    toggle.type = 'button';
    toggle.addEventListener('click', function (event) {
      if (event && typeof event.stopPropagation === 'function') {
        event.stopPropagation();
      }
      toggleCollapsed(projectId, sectionKey(block.sectionId));
    });
    var name = doc.createElement('span');
    name.className = 'bs-name';
    var count = doc.createElement('span');
    count.className = 'bs-count';
    header.appendChild(toggle);
    header.appendChild(name);
    header.appendChild(count);
    fillHeader(header, projectId, block, project);
    return header;
  }

  function fillHeader(header, projectId, block, project) {
    var isDown = isCollapsed(projectId, sectionKey(block.sectionId));
    var toggle = header.querySelector('.bs-toggle');
    var name = header.querySelector('.bs-name');
    var count = header.querySelector('.bs-count');
    // Write only what changed: every text write is a DOM mutation the
    // observer sees, and an unconditional rewrite would feed itself.
    setText(toggle, isDown ? '▸' : '▾');
    if (toggle) {
      var label = t(isDown ? 'BACKGROUND.EXPAND' : 'BACKGROUND.COLLAPSE');
      if (toggle.title !== label) {
        toggle.title = label;
      }
      if (toggle.getAttribute('aria-label') !== label) {
        toggle.setAttribute('aria-label', label);
      }
      var expanded = isDown ? 'false' : 'true';
      if (toggle.getAttribute('aria-expanded') !== expanded) {
        toggle.setAttribute('aria-expanded', expanded);
      }
    }
    setText(name, headerLabel(project, block.sectionId));
    setText(count, String(block.taskIds.length));
  }

  function setText(node, text) {
    if (node && node.textContent !== text) {
      node.textContent = text;
    }
  }

  function removeHeaders(doc, list) {
    var old = (list || doc).querySelectorAll('[' + HEADER_ATTR + ']');
    for (var i = 0; i < old.length; i++) {
      if (old[i].parentNode) {
        old[i].parentNode.removeChild(old[i]);
      }
    }
    var hidden = (list || doc).querySelectorAll('task[' + HIDDEN_ATTR + ']');
    for (var j = 0; j < hidden.length; j++) {
      hidden[j].removeAttribute(HIDDEN_ATTR);
    }
  }

  var decorating = false;

  /*
   * Make the backlog panel show the active project's blocks. Idempotent: it
   * creates, moves, updates or removes headers as needed and never touches
   * the task rows beyond the hidden attribute. Runs after every reconcile,
   * every collapse toggle and every relevant DOM mutation.
   */
  function decorate() {
    var doc = hostDocument();
    if (!doc || decorating) {
      return;
    }
    decorating = true;
    try {
      var list = doc.querySelector(LIST_SELECTOR);
      if (!list) {
        return;
      }
      var project = activeProjectId ? core.getProject(config, activeProjectId) : null;
      var order = activeProjectId ? lastOrder[activeProjectId] : null;
      if (!project || !project.sections.length || !order) {
        removeHeaders(doc, list);
        return;
      }
      ensureStyle(doc);
      var blocks = core.blocks(order, project);
      var wanted = {};
      blocks.forEach(function (block) {
        var first = null;
        for (var i = 0; i < block.taskIds.length && !first; i++) {
          first = doc.getElementById('t-' + block.taskIds[i]);
        }
        if (!first || first.parentNode !== list) {
          return;
        }
        var key = sectionKey(block.sectionId);
        wanted[key] = true;
        var header = list.querySelector('[' + HEADER_ATTR + '="' + key + '"]');
        if (!header) {
          header = buildHeader(doc, activeProjectId, block, project);
        } else {
          fillHeader(header, activeProjectId, block, project);
        }
        if (header.nextSibling !== first) {
          list.insertBefore(header, first);
        }
        var hide = isCollapsed(activeProjectId, key);
        block.taskIds.forEach(function (taskId) {
          var row = doc.getElementById('t-' + taskId);
          if (!row) {
            return;
          }
          if (hide) {
            if (row.getAttribute(HIDDEN_ATTR) !== '1') {
              row.setAttribute(HIDDEN_ATTR, '1');
            }
          } else if (row.hasAttribute(HIDDEN_ATTR)) {
            row.removeAttribute(HIDDEN_ATTR);
          }
        });
      });
      var existing = list.querySelectorAll('[' + HEADER_ATTR + ']');
      for (var k = 0; k < existing.length; k++) {
        if (!wanted[existing[k].getAttribute(HEADER_ATTR)] && existing[k].parentNode) {
          existing[k].parentNode.removeChild(existing[k]);
        }
      }
    } finally {
      decorating = false;
    }
  }

  function isOwnNode(node) {
    if (!node) {
      return false;
    }
    if (node.nodeType === 1 && typeof node.getAttribute === 'function' && node.getAttribute(HEADER_ATTR)) {
      return true;
    }
    // Text nodes and spans inside a header (counts, names).
    var el = node.nodeType === 1 ? node : node.parentNode;
    return !!(el && typeof el.closest === 'function' && el.closest('[' + HEADER_ATTR + ']'));
  }

  function onMutations(mutations) {
    // Mutations caused by the headers themselves need no second pass.
    var foreign = false;
    for (var i = 0; i < mutations.length && !foreign; i++) {
      var record = mutations[i];
      if (isOwnNode(record.target)) {
        continue;
      }
      var added = record.addedNodes || [];
      var removed = record.removedNodes || [];
      for (var j = 0; j < added.length && !foreign; j++) {
        if (!isOwnNode(added[j])) {
          foreign = true;
        }
      }
      for (var k = 0; k < removed.length && !foreign; k++) {
        if (!isOwnNode(removed[k])) {
          foreign = true;
        }
      }
      if (record.type === 'attributes') {
        foreign = true;
      }
    }
    if (foreign) {
      decorate();
    }
  }

  function startObserver() {
    var doc = hostDocument();
    if (!doc || observer || typeof MutationObserver !== 'function') {
      return;
    }
    observer = new MutationObserver(onMutations);
    observer.observe(doc.body, { childList: true, subtree: true });
  }

  function stopObserver() {
    if (observer) {
      observer.disconnect();
      observer = null;
    }
    var doc = hostDocument();
    if (doc) {
      removeHeaders(doc, null);
      var style = doc.getElementById(STYLE_ID);
      if (style && style.parentNode) {
        style.parentNode.removeChild(style);
      }
    }
  }

  // ---- registrations ------------------------------------------------------------

  function registerSettingsEntry() {
    if (typeof api.registerConfigHandler !== 'function' || typeof api.showIndexHtmlAsView !== 'function') {
      return;
    }
    try {
      api.registerConfigHandler(function () {
        api.showIndexHtmlAsView();
      });
    } catch (error) {
      logError('The settings entry could not be registered.', error);
    }
  }

  function registerHeaderButton() {
    if (
      !config.headerButton ||
      typeof api.registerWorkContextHeaderButton !== 'function' ||
      typeof api.showIndexHtmlAsView !== 'function'
    ) {
      return;
    }
    try {
      api.registerWorkContextHeaderButton({
        label: t('BACKGROUND.HEADER_BUTTON'),
        icon: 'view_agenda',
        showFor: ['PROJECT'],
        onClick: function () {
          api.showIndexHtmlAsView();
        },
      });
    } catch (error) {
      logError('The header button could not be registered.', error);
    }
  }

  api.registerHook(HOOK_PROJECT_LIST, function (payload) {
    latestProjectState = payload && payload.projectState ? payload.projectState : latestProjectState;
    scheduleReconcile();
  });

  api.registerHook(HOOK_ACTION, function (payload) {
    var action = payload && payload.action;
    if (!action || !BACKLOG_MOVE_ACTIONS[action.type] || typeof action.taskId !== 'string') {
      return;
    }
    var projectId = typeof action.workContextId === 'string' ? action.workContextId : action.projectId;
    if (typeof projectId === 'string') {
      moveHints[projectId] = { taskId: action.taskId, at: Date.now() };
    }
  });

  api.registerHook(HOOK_WORK_CONTEXT, function (ctx) {
    activeProjectId = ctx && ctx.type === 'PROJECT' && typeof ctx.id === 'string' ? ctx.id : null;
    decorate();
  });

  // The settings page writes to the same synced storage; memberships and
  // sections changed there are enforced here without a restart.
  api.registerHook(HOOK_DATA_CHANGED, function () {
    // The plugin's own saves come back through this hook as well; a reload
    // that changes nothing must not throw away the known orders, or a drag
    // made in that moment would be judged without its previous order.
    var before = JSON.stringify(config);
    return loadConfig().then(function () {
      if (JSON.stringify(config) === before) {
        return;
      }
      lastOrder = {};
      return reloadAllProjects();
    });
  });

  function start() {
    return loadConfig().then(function () {
      registerSettingsEntry();
      registerHeaderButton();
      startObserver();
      var ctxPromise =
        typeof api.getActiveWorkContext === 'function'
          ? Promise.resolve()
              .then(function () {
                return api.getActiveWorkContext();
              })
              .catch(function () {
                return null;
              })
          : Promise.resolve(null);
      return ctxPromise.then(function (ctx) {
        activeProjectId = ctx && ctx.type === 'PROJECT' && typeof ctx.id === 'string' ? ctx.id : null;
        // Not awaited by design: the host awaits onReady and the first pass
        // over all projects may write a few orders.
        reloadAllProjects();
      });
    });
  }

  if (typeof api.onReady === 'function') {
    api.onReady(start);
  } else {
    start();
  }

  if (typeof api.onUnload === 'function') {
    api.onUnload(function () {
      // Synchronous teardown: the host does not await this callback.
      stopObserver();
      if (reconcileTimer) {
        clearTimeout(reconcileTimer);
        reconcileTimer = null;
      }
      pendingWrites = {};
      moveHints = {};
    });
  }
})();
