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

  // The host's own backlog move actions (project.actions.ts), mapped to what
  // the user asked for. The payload names the moved task, which makes the
  // section inference exact; the keyboard moves to the top and to the bottom
  // even say the target outright. Without such an action the plugin falls
  // back to comparing the old and the new order.
  var BACKLOG_MOVE_ACTIONS = {
    '[Project] Move Task in Backlog': 'drag',
    '[Project] Move Task from regular to backlog': 'drag',
    // Not listed on purpose: '[Project] Auto Move Task from regular to
    // backlog'. A task the app puts in the backlog by itself — a new task, a
    // task pushed back at the end of the day — was not aimed anywhere by the
    // user, so it stays out of every section and lands in the trailing block.
    '[Project] Move Task Up in Backlog': 'up',
    '[Project] Move Task Down in Backlog': 'down',
    '[Project] Move Task to Top in Backlog': 'top',
    '[Project] Move Task to Bottom in Backlog': 'bottom',
  };
  var HINT_MAX_AGE_MS = 2000;

  var WRITE_LIMIT = 10;
  var WRITE_WINDOW_MS = 5000;

  var config = core.createDefaultConfig();
  var lastOrder = {}; // projectId -> backlogTaskIds as last seen / written
  var pendingWrites = {}; // projectId -> order written, awaiting the echo
  var recentWrites = {};
  var moveHints = {}; // projectId -> { taskId, kind, at }
  // A task dropped straight onto a header: the user pointed at the section,
  // so nothing has to be inferred — and it is the only way to reach a section
  // that holds no task here, an empty header having no rows to drop between.
  var dropOnHeader = {}; // projectId -> { taskId, key, at }
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
      try {
        log('[backlog-sections] ' + message, error);
      } catch (e) {
        // fall through to the console
      }
    }
    if (typeof console !== 'undefined' && console && typeof console.error === 'function') {
      console.error('[backlog-sections] ' + message, error);
    }
  }

  var DEBUG_KEY = 'backlog-sections:debug';
  var debugOn = false;
  try {
    debugOn = !!(typeof localStorage !== 'undefined' && localStorage.getItem(DEBUG_KEY) === '1');
  } catch (e) {
    debugOn = false;
  }

  function debug() {
    if (!debugOn || typeof console === 'undefined' || !console || typeof console.log !== 'function') {
      return;
    }
    var args = ['[backlog-sections]'];
    for (var i = 0; i < arguments.length; i++) {
      args.push(arguments[i]);
    }
    console.log.apply(console, args);
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
    var project = core.projectView(config, projectId);
    var hasConfig = project.sections.length > 0;
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
    var fresh = hint && Date.now() - hint.at <= HINT_MAX_AGE_MS;
    var movedIds = fresh ? [hint.taskId] : null;
    var moveKind = fresh ? hint.kind : null;
    delete moveHints[projectId];

    // A move command that could not move the task any further leaves the
    // order untouched — at the ends of the backlog that is exactly what "one
    // section further" looks like, so those are still read as a move. A drag
    // that landed where it started changes nothing at all.
    var explicit = moveKind && moveKind !== 'drag';
    var membership =
      !previous || (core.sameList(previous, order) && !explicit)
        ? project.membership
        : core.inferMembership(previous, order, project, movedIds, moveKind);
    debug('reconcile', projectId, {
      sections: project.sections.length,
      previous: previous,
      order: order,
      moved: movedIds,
      kind: moveKind,
      before: project.membership,
      inferred: membership,
    });
    membership = core.pruneMembership(membership, order);
    membership = applyHeaderDrop(projectId, membership, order, project);

    var work = Promise.resolve();
    if (!core.sameMembership(membership, project.membership)) {
      core.ensureProject(config, projectId).membership = membership;
      work = saveConfig();
    }
    var updated = core.projectView(config, projectId);
    var desired = core.desiredOrder(order, updated);
    debug('order', projectId, { desired: desired, changed: !core.sameList(desired, order) });
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

  /*
   * The section the user dropped the task on wins over every rule. Only a
   * fresh drop counts, and only for a task that is really in this backlog.
   */
  function applyHeaderDrop(projectId, membership, order, project) {
    var drop = dropOnHeader[projectId];
    delete dropOnHeader[projectId];
    if (!drop || Date.now() - drop.at > DROP_MAX_AGE_MS || order.indexOf(drop.taskId) === -1) {
      return membership;
    }
    var wanted = null;
    for (var i = 0; i < project.sections.length; i++) {
      if (project.sections[i].id === drop.key) {
        wanted = drop.key;
        break;
      }
    }
    debug('header drop', drop.taskId, wanted);
    var out = {};
    Object.keys(membership).forEach(function (id) {
      out[id] = membership[id];
    });
    if (wanted) {
      out[drop.taskId] = wanted;
    } else {
      delete out[drop.taskId]; // the "no section" header
    }
    return out;
  }

  function reconcileFromProjects(projects) {
    var chain = Promise.resolve();
    (projects || []).forEach(function (project) {
      if (!project || typeof project.id !== 'string') {
        return;
      }
      var order = Array.isArray(project.backlogTaskIds) ? project.backlogTaskIds : [];
      var known = lastOrder[project.id];
      // A move command that hit the end of the backlog leaves the order alone
      // but still asks for another section, so a fresh hint keeps the project
      // in the pass.
      var hint = moveHints[project.id];
      var asked = hint && hint.kind && hint.kind !== 'drag' && Date.now() - hint.at <= HINT_MAX_AGE_MS;
      if (known && core.sameList(known, order) && !pendingWrites[project.id] && !asked) {
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
    debug('collapse', projectId, sectionKey, !!(collapsed[projectId] && collapsed[projectId][sectionKey]));
    decorate();
    reapplySoon();
  }

  /*
   * The app re-renders the backlog rows for reasons of its own, and a fresh
   * row arrives without the attribute that hides it. The observer catches
   * that, and these two passes catch a render that slips past it.
   */
  function reapplySoon() {
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(function () {
        decorate();
      });
    }
    setTimeout(decorate, 250);
  }

  function ensureStyle(doc) {
    if (doc.getElementById(STYLE_ID)) {
      return;
    }
    var style = doc.createElement('style');
    style.id = STYLE_ID;
    style.textContent =
      '.' + HEADER_CLASS + ' { display: flex; align-items: center; gap: 12px; margin: 20px 4px 6px; padding: 10px 10px 10px 6px;' +
      ' min-height: 40px; box-sizing: border-box;' +
      ' border-top: 1px solid var(--divider-color, rgba(128,128,128,.35)); font-size: 1.2rem; font-weight: 600;' +
      ' color: var(--text-color-muted, inherit); user-select: none; }\n' +
      '.' + HEADER_CLASS + ' .bs-toggle { all: unset; cursor: pointer; width: 1.5em; font-size: 1.1em; text-align: center; opacity: .8; }\n' +
      '.' + HEADER_CLASS + ' .bs-toggle:hover { opacity: 1; }\n' +
      '.' + HEADER_CLASS + ' .bs-name { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }\n' +
      '.' + HEADER_CLASS + ' .bs-count { flex: none; font-weight: 400; font-size: .85em; opacity: .8; }\n' +
      '.' + HEADER_CLASS + '.bs-loose { font-style: italic; font-weight: 500; }\n' +
      '.' + HEADER_CLASS + '.bs-empty { opacity: .75; }\n' +
      // During a drag every header is a target and gets room to be hit; the
      // one the pointer is in keeps the page's own background — only a dashed
      // outline says "let go here", so no theme accent shouts at the user.
      // The header sits inside the app's own task list, where hovering paints
      // rows in the theme accent. A header is not a row: it keeps the panel's
      // background and its muted text in every state, and says so loudly
      // enough to beat whatever rule the theme brings.
      '.' + HEADER_CLASS + ', .' + HEADER_CLASS + ':hover, .' + HEADER_CLASS + ':focus, .' + HEADER_CLASS + ':focus-within' +
      ' { background: transparent !important; color: var(--text-color-muted, inherit) !important; }\n' +
      '.' + HEADER_CLASS + ' *, .' + HEADER_CLASS + ':hover * { color: inherit !important; background: transparent !important; }\n' +
      '.' + DRAGGING_CLASS + ' .' + HEADER_CLASS + ' { min-height: 48px; }\n' +
      'task[' + IN_TARGET_ATTR + '="1"] { box-shadow: inset 3px 0 0 var(--text-color-muted, rgba(128,128,128,.6)); }\n' +
      '.' + HEADER_CLASS + '.' + TARGET_CLASS + ', .' + HEADER_CLASS + '.' + TARGET_CLASS + ':hover' +
      ' { background: transparent !important; color: var(--text-color, inherit) !important; border-radius: 4px; opacity: 1;' +
      ' outline: 2px dashed var(--text-color-muted, rgba(128,128,128,.6)); outline-offset: -2px; }\n' +
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
    var key = sectionKey(block.sectionId);
    header.className = HEADER_CLASS + (block.sectionId ? '' : ' bs-loose');
    header.setAttribute(HEADER_ATTR, key);
    var toggle = doc.createElement('button');
    toggle.className = 'bs-toggle';
    toggle.type = 'button';
    toggle.addEventListener('click', function (event) {
      if (event && typeof event.stopPropagation === 'function') {
        event.stopPropagation();
      }
      // The project is read now, not when the header was built: a header
      // outlives the project it was first drawn for — the app re-renders the
      // rows around it when the user switches project, but leaves this
      // element alone — and collapsing is remembered per project.
      toggleCollapsed(activeProjectId, key);
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

  var COLLAPSED_ATTR = 'data-backlog-sections-collapsed';

  function fillHeader(header, projectId, block, project) {
    var isDown = isCollapsed(projectId, sectionKey(block.sectionId));
    if (isDown) {
      if (header.getAttribute(COLLAPSED_ATTR) !== '1') {
        header.setAttribute(COLLAPSED_ATTR, '1');
      }
    } else if (header.hasAttribute(COLLAPSED_ATTR)) {
      header.removeAttribute(COLLAPSED_ATTR);
    }
    // A section without tasks here is dimmed; the class is rewritten only
    // when it actually changes, like the texts below.
    var className = HEADER_CLASS + (block.sectionId ? '' : ' bs-loose') + (block.taskIds.length ? '' : ' bs-empty');
    if (header.className !== className) {
      header.className = className;
    }
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

  function clearBand(doc, list) {
    var marked = (list || doc).querySelectorAll('[' + IN_TARGET_ATTR + ']');
    for (var i = 0; i < marked.length; i++) {
      marked[i].removeAttribute(IN_TARGET_ATTR);
    }
  }

  function removeHeaders(doc, list) {
    clearBand(doc, list);
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

  var DRAG_PLACEHOLDER_SELECTOR = '.cdk-drag-placeholder';
  var DRAG_PREVIEW_SELECTOR = '.cdk-drag-preview';
  var TARGET_CLASS = 'bs-target';
  var DRAGGING_CLASS = 'bs-dragging';
  var IN_TARGET_ATTR = 'data-backlog-sections-in-target';
  var BAND_SLACK_PX = 24;
  // A drop is answered by the host a moment later; give that more room than
  // the plugin's other hints, a slow render should not lose the section.
  var DROP_MAX_AGE_MS = 8000;
  var dragging = false;
  var draggedTaskId = null;
  var targetHeader = null;

  /*
   * The dragged task, read from the elements the CDK clones from its row: the
   * placeholder that keeps its place in the list and the preview that follows
   * the pointer. Both carry the row's data-task-id.
   */
  function draggedTask(doc, list) {
    var nodes = [list.querySelector(DRAG_PLACEHOLDER_SELECTOR), doc.querySelector(DRAG_PREVIEW_SELECTOR)];
    for (var i = 0; i < nodes.length; i++) {
      var id = nodes[i] && typeof nodes[i].getAttribute === 'function' ? nodes[i].getAttribute('data-task-id') : null;
      if (typeof id === 'string' && id) {
        return id;
      }
    }
    return null;
  }

  /* Every row from this header down to the next one, so the band is visible. */
  function markBand(list, header) {
    var children = list.children || [];
    var inBand = false;
    for (var i = 0; i < children.length; i++) {
      var node = children[i];
      if (typeof node.getAttribute !== 'function') {
        continue;
      }
      if (node.getAttribute(HEADER_ATTR)) {
        inBand = node === header;
        continue;
      }
      if (inBand) {
        if (node.getAttribute(IN_TARGET_ATTR) !== '1') {
          node.setAttribute(IN_TARGET_ATTR, '1');
        }
      } else if (node.hasAttribute(IN_TARGET_ATTR)) {
        node.removeAttribute(IN_TARGET_ATTR);
      }
    }
  }

  function markTarget(header) {
    if (targetHeader === header) {
      return;
    }
    if (targetHeader) {
      targetHeader.className = targetHeader.className.split(' ' + TARGET_CLASS).join('');
    }
    targetHeader = header;
    if (targetHeader && targetHeader.className.indexOf(TARGET_CLASS) === -1) {
      targetHeader.className = targetHeader.className + ' ' + TARGET_CLASS;
    }
    var doc = hostDocument();
    var list = doc && typeof doc.querySelector === 'function' ? doc.querySelector(LIST_SELECTOR) : null;
    if (list) {
      markBand(list, header);
    }
  }

  /*
   * The section the pointer is in: a section owns the band from its own
   * header down to the next one, so the whole block is a drop area and not
   * just the strip of the header. The headers keep their place while the CDK
   * shifts the rows around them, so the bands stay where the user saw them.
   */
  function headerAt(list, x, y) {
    var headers = list.querySelectorAll('[' + HEADER_ATTR + ']');
    if (!headers.length) {
      return null;
    }
    var listRect = typeof list.getBoundingClientRect === 'function' ? list.getBoundingClientRect() : null;
    // Only the height bounds the list: how far the pointer strayed sideways
    // says nothing about which section it is over, and a preview dragged over
    // the panel's padding should still count. A list without measurable
    // geometry (a hidden panel) bounds nothing at all.
    if (listRect && listRect.bottom > listRect.top) {
      if (y < listRect.top - BAND_SLACK_PX || y > listRect.bottom + BAND_SLACK_PX) {
        return null;
      }
    }
    var found = null;
    var foundTop = null;
    var highest = null;
    var highestTop = null;
    for (var i = 0; i < headers.length; i++) {
      var rect = typeof headers[i].getBoundingClientRect === 'function' ? headers[i].getBoundingClientRect() : null;
      if (!rect) {
        continue;
      }
      if (highestTop === null || rect.top < highestTop) {
        highestTop = rect.top;
        highest = headers[i];
      }
      if (rect.top <= y && (foundTop === null || rect.top > foundTop)) {
        foundTop = rect.top;
        found = headers[i];
      }
    }
    // Above the first header — the panel's own padding — is the first section.
    return found || highest;
  }

  function onDragMove(event) {
    var doc = hostDocument();
    var list = doc && doc.querySelector(LIST_SELECTOR);
    if (!list) {
      return;
    }
    if (!draggedTaskId) {
      draggedTaskId = draggedTask(doc, list);
    }
    var point = event && typeof event.clientX === 'number' ? event : (event && event.touches && event.touches[0]) || null;
    if (!point) {
      return;
    }
    markTarget(headerAt(list, point.clientX, point.clientY));
  }

  function onDragEnd() {
    if (targetHeader && draggedTaskId && activeProjectId) {
      dropOnHeader[activeProjectId] = {
        taskId: draggedTaskId,
        key: targetHeader.getAttribute(HEADER_ATTR),
        at: Date.now(),
      };
      debug('dropped on header', draggedTaskId, targetHeader.getAttribute(HEADER_ATTR));
    }
    stopDragTracking();
  }

  function stopDragTracking() {
    markTarget(null);
    draggedTaskId = null;
    var doc = hostDocument();
    var list = doc && typeof doc.querySelector === 'function' ? doc.querySelector(LIST_SELECTOR) : null;
    if (list && list.className.indexOf(DRAGGING_CLASS) !== -1) {
      list.className = list.className.split(' ' + DRAGGING_CLASS).join('');
    }
    if (dragging && doc && typeof doc.removeEventListener === 'function') {
      doc.removeEventListener('pointermove', onDragMove, true);
      doc.removeEventListener('touchmove', onDragMove, true);
      doc.removeEventListener('pointerup', onDragEnd, true);
      doc.removeEventListener('pointercancel', onDragEnd, true);
      doc.removeEventListener('touchend', onDragEnd, true);
    }
    dragging = false;
  }

  /*
   * A drag starts when the CDK puts its placeholder in the list — a mutation
   * the observer sees. From then on the pointer is followed until it is
   * released, so a release over a header can be recognised.
   */
  function trackDrag(doc, list) {
    var isDragging = !!list.querySelector(DRAG_PLACEHOLDER_SELECTOR);
    if (!isDragging) {
      if (dragging) {
        stopDragTracking();
      }
      return;
    }
    if (dragging || typeof doc.addEventListener !== 'function') {
      return;
    }
    dragging = true;
    draggedTaskId = draggedTask(doc, list);
    if (list.className.indexOf(DRAGGING_CLASS) === -1) {
      list.className = list.className + ' ' + DRAGGING_CLASS;
    }
    doc.addEventListener('pointermove', onDragMove, true);
    doc.addEventListener('touchmove', onDragMove, true);
    doc.addEventListener('pointerup', onDragEnd, true);
    doc.addEventListener('pointercancel', onDragEnd, true);
    doc.addEventListener('touchend', onDragEnd, true);
    debug('drag started', draggedTaskId);
  }

  var decorating = false;
  // A pass that keeps asking for another pass would lock up the app. The
  // brake bounds how often the headers may be redrawn; it never trips in
  // normal use, where a burst is a handful of passes.
  var DECORATE_BURST = 60;
  var DECORATE_WINDOW_MS = 1000;
  var DECORATE_PAUSE_MS = 2000;
  var decorateCount = 0;
  var decorateSince = 0;
  var decoratePaused = false;

  function decorateAllowed() {
    var now = Date.now();
    if (!decorateSince || now - decorateSince > DECORATE_WINDOW_MS) {
      decorateSince = now;
      decorateCount = 0;
      decoratePaused = false;
    }
    decorateCount += 1;
    if (decorateCount <= DECORATE_BURST) {
      return true;
    }
    if (!decoratePaused) {
      decoratePaused = true;
      logError('The section headers were redrawn too often in a second; pausing them briefly.');
      setTimeout(function () {
        decorateSince = 0;
        decorate();
      }, DECORATE_PAUSE_MS);
    }
    return false;
  }

  /*
   * Make the backlog panel show the active project's blocks. Idempotent: it
   * creates, moves, updates or removes headers as needed and never touches
   * the task rows beyond the hidden attribute. Runs after every reconcile,
   * every collapse toggle and every relevant DOM mutation.
   */
  function decorate() {
    var doc = hostDocument();
    if (!doc || decorating || !decorateAllowed()) {
      return;
    }
    decorating = true;
    try {
      var list = doc.querySelector(LIST_SELECTOR);
      if (!list) {
        debug('decorate: no backlog list in the page');
        return;
      }
      trackDrag(doc, list);
      var project = activeProjectId ? core.projectView(config, activeProjectId) : null;
      var order = activeProjectId ? lastOrder[activeProjectId] : null;
      if (!project || !project.sections.length || !order) {
        debug('decorate: nothing to draw', { project: activeProjectId, sections: project && project.sections.length, order: !!order });
        removeHeaders(doc, list);
        return;
      }
      ensureStyle(doc);
      var blocks = core.blocks(order, project);
      var wanted = {};
      var firstRowByKey = {};
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
        firstRowByKey[key] = first;
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
        if (hide) {
          debug('collapse: hiding', key, block.taskIds.length);
        }
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
      /*
       * The sections that hold no task here still get a header, so every
       * backlog offers the same structure. They are placed from the bottom
       * up, each one directly above whatever must follow it: anchoring them
       * all to the same row instead would make two adjacent empty headers
       * swap places on every pass, and every swap asks for another pass.
       */
      var startOfBlock = function (key) {
        var row = firstRowByKey[key];
        if (!row) {
          return null;
        }
        var prev = row.previousSibling;
        return prev && typeof prev.getAttribute === 'function' && prev.getAttribute(HEADER_ATTR) === key ? prev : row;
      };
      // The unsorted block is the first one now, so a section that holds no
      // task here belongs below every row: the sweep starts at the end.
      var following = null;
      for (var n = project.sections.length - 1; n >= 0; n--) {
        var section = project.sections[n];
        if (wanted[section.id]) {
          following = startOfBlock(section.id) || following;
          continue;
        }
        var emptyBlock = { sectionId: section.id, taskIds: [] };
        var emptyHeader = list.querySelector('[' + HEADER_ATTR + '="' + section.id + '"]');
        if (!emptyHeader) {
          emptyHeader = buildHeader(doc, activeProjectId, emptyBlock, project);
        } else {
          fillHeader(emptyHeader, activeProjectId, emptyBlock, project);
        }
        if (following) {
          if (emptyHeader.nextSibling !== following) {
            list.insertBefore(emptyHeader, following);
          }
        } else if (list.lastChild !== emptyHeader) {
          list.appendChild(emptyHeader);
        }
        wanted[section.id] = true;
        following = emptyHeader;
      }
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

  /*
   * One click on a task's title puts the app straight into editing it
   * (task-title.component.ts: a host click listener calls focusInput). With
   * the option on, a single click only selects the task — the app's own
   * behaviour for a click next to the title — and editing waits for a double
   * click, which is passed on as the click the app expects.
   */
  var TITLE_SELECTOR = 'task-title';
  var SYNTHETIC = '__backlogSectionsSynthetic';
  var clickListenersOn = false;

  function titleOf(event) {
    var target = event && event.target;
    if (!target || typeof target.closest !== 'function') {
      return null;
    }
    if (target.tagName === 'A' || target.tagName === 'TEXTAREA' || target.closest('a')) {
      return null; // links and the open editor keep working as they are
    }
    return target.closest(TITLE_SELECTOR);
  }

  function onTitleClick(event) {
    if (!config.clickSelectsTask || (event && event[SYNTHETIC])) {
      return;
    }
    var title = titleOf(event);
    if (!title || String(title.className || '').indexOf('is-editing') !== -1) {
      return;
    }
    // Captured before the app sees it, so its own handler never runs.
    if (typeof event.stopPropagation === 'function') {
      event.stopPropagation();
    }
    if (typeof event.preventDefault === 'function') {
      event.preventDefault();
    }
    var row = typeof title.closest === 'function' ? title.closest('task') : null;
    if (row && typeof row.focus === 'function') {
      row.focus();
    }
    debug('title click: task selected, not opened for editing');
  }

  function onTitleDblClick(event) {
    if (!config.clickSelectsTask) {
      return;
    }
    var title = titleOf(event);
    if (!title || typeof title.dispatchEvent !== 'function') {
      return;
    }
    if (typeof event.stopPropagation === 'function') {
      event.stopPropagation();
    }
    var click;
    if (typeof MouseEvent === 'function') {
      click = new MouseEvent('click', { bubbles: true, cancelable: true });
    } else {
      click = { type: 'click', bubbles: true, cancelable: true, stopPropagation: function () {}, preventDefault: function () {} };
    }
    click[SYNTHETIC] = true;
    debug('title double click: opening the editor');
    title.dispatchEvent(click);
  }

  function startClickListeners() {
    var doc = hostDocument();
    if (clickListenersOn || !doc || typeof doc.addEventListener !== 'function') {
      return;
    }
    clickListenersOn = true;
    doc.addEventListener('click', onTitleClick, true);
    doc.addEventListener('dblclick', onTitleDblClick, true);
  }

  function stopClickListeners() {
    var doc = hostDocument();
    if (!clickListenersOn) {
      return;
    }
    clickListenersOn = false;
    if (doc && typeof doc.removeEventListener === 'function') {
      doc.removeEventListener('click', onTitleClick, true);
      doc.removeEventListener('dblclick', onTitleDblClick, true);
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
        openSettingsPage();
      });
    } catch (error) {
      logError('The settings entry could not be registered.', error);
    }
  }

  /*
   * The settings page is shown inside the work view, in place of the task
   * list, so the header button that opened it stays on screen and closes it
   * again on the second press. Hosts without the embed API fall back to the
   * full-page route, which has no second press to react to.
   */
  var settingsOpen = false;

  function canEmbedSettings() {
    return typeof api.showInWorkContext === 'function' && typeof api.closeWorkContextView === 'function';
  }

  function openSettings() {
    if (canEmbedSettings()) {
      api.showInWorkContext();
      settingsOpen = true;
      return;
    }
    if (typeof api.showIndexHtmlAsView === 'function') {
      api.showIndexHtmlAsView();
    }
  }

  /*
   * The gear on the plugin's card is pressed from the settings screen, where
   * there is no work view to mount the page into: mounting it there would
   * only show up once the user opened a project by hand. So that button
   * opens the page as its own route instead.
   */
  function openSettingsPage() {
    closeSettings();
    if (typeof api.showIndexHtmlAsView === 'function') {
      debug('settings: opening the page as a view');
      api.showIndexHtmlAsView();
    }
  }

  function closeSettings() {
    if (settingsOpen && canEmbedSettings()) {
      api.closeWorkContextView();
    }
    settingsOpen = false;
  }

  function toggleSettings() {
    if (settingsOpen) {
      debug('settings: closing');
      closeSettings();
    } else {
      debug('settings: opening');
      openSettings();
    }
  }

  function registerHeaderButton() {
    if (!config.headerButton || typeof api.registerWorkContextHeaderButton !== 'function') {
      return;
    }
    try {
      api.registerWorkContextHeaderButton({
        label: t('BACKGROUND.HEADER_BUTTON'),
        icon: 'view_agenda',
        showFor: ['PROJECT'],
        onClick: toggleSettings,
      });
    } catch (error) {
      logError('The header button could not be registered.', error);
    }
  }

  /*
   * Move the task the user has in hand one section up or down — the keyboard
   * way into a section, including one that holds no task yet. The section
   * list is walked as sections in order plus "no section" at the end.
   */
  function moveFocusedTaskBySection(delta) {
    var projectId = activeProjectId;
    if (!projectId) {
      return Promise.resolve();
    }
    var project = core.projectView(config, projectId);
    var order = lastOrder[projectId] || null;
    if (!project.sections.length || !order) {
      return Promise.resolve();
    }
    var read = typeof api.getFocusedTask === 'function' ? api.getFocusedTask : api.getSelectedTask;
    if (typeof read !== 'function') {
      return Promise.resolve();
    }
    return Promise.resolve()
      .then(function () {
        return read();
      })
      .then(function (task) {
        var taskId = task && typeof task.id === 'string' ? task.id : null;
        if (!taskId || order.indexOf(taskId) === -1) {
          debug('section shortcut: no task of this backlog in hand', taskId);
          return;
        }
        var stops = core.sectionStops(project); // "no section" on top, then the sections
        var current = stops.indexOf(core.sectionOf(project, taskId));
        var next = current + delta;
        if (next < 0 || next >= stops.length) {
          return;
        }
        var membership = {};
        Object.keys(project.membership).forEach(function (id) {
          membership[id] = project.membership[id];
        });
        if (stops[next]) {
          membership[taskId] = stops[next];
        } else {
          delete membership[taskId];
        }
        debug('section shortcut', taskId, stops[current], '->', stops[next]);
        core.ensureProject(config, projectId).membership = membership;
        return saveConfig().then(function () {
          return reconcileProject(projectId, order);
        });
      })
      .catch(function (error) {
        logError('The task could not be moved to another section.', error);
      });
  }

  function registerShortcuts() {
    if (typeof api.registerShortcut !== 'function') {
      return;
    }
    try {
      api.registerShortcut({
        id: 'section-up',
        label: t('BACKGROUND.SHORTCUT_UP'),
        onExec: function () {
          moveFocusedTaskBySection(-1);
        },
      });
      api.registerShortcut({
        id: 'section-down',
        label: t('BACKGROUND.SHORTCUT_DOWN'),
        onExec: function () {
          moveFocusedTaskBySection(1);
        },
      });
    } catch (error) {
      logError('The keyboard shortcuts could not be registered.', error);
    }
  }

  api.registerHook(HOOK_PROJECT_LIST, function (payload) {
    debug('hook projectListUpdate', payload && payload.action, 'state?', !!(payload && payload.projectState));
    latestProjectState = payload && payload.projectState ? payload.projectState : latestProjectState;
    scheduleReconcile();
  });

  api.registerHook(HOOK_ACTION, function (payload) {
    var action = payload && payload.action;
    if (action && typeof action.type === 'string' && action.type.indexOf('Backlog') !== -1) {
      debug('hook action', action.type, action.taskId, action.workContextId || action.projectId);
    }
    if (!action || !BACKLOG_MOVE_ACTIONS[action.type] || typeof action.taskId !== 'string') {
      return;
    }
    var projectId = typeof action.workContextId === 'string' ? action.workContextId : action.projectId;
    if (typeof projectId === 'string') {
      moveHints[projectId] = { taskId: action.taskId, kind: BACKLOG_MOVE_ACTIONS[action.type], at: Date.now() };
    }
  });

  api.registerHook(HOOK_WORK_CONTEXT, function (ctx) {
    debug('hook workContextChange', ctx && ctx.type, ctx && ctx.id);
    var previous = activeProjectId;
    activeProjectId = ctx && ctx.type === 'PROJECT' && typeof ctx.id === 'string' ? ctx.id : null;
    if (settingsOpen && previous !== activeProjectId) {
      closeSettings();
    }
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
    debug('starting');
    return loadConfig().then(function () {
      debug('config', { sections: config.sections.length, projects: Object.keys(config.projects) });
      registerSettingsEntry();
      registerHeaderButton();
      registerShortcuts();
      startObserver();
      startClickListeners();
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
        debug('active context', activeProjectId);
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
      dropOnHeader = {};
      stopDragTracking();
      stopClickListeners();
      closeSettings();
    });
  }
})();
