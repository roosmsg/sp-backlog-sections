/*
 * A stand-in for the Super Productivity plugin host, just large enough for
 * plugin.js. Mirrors what the plugin depends on:
 *
 * - plugin.js is evaluated through the same `new Function('plugin',
 *   'PluginAPI', …)` wrapper the host uses;
 * - projects carry backlogTaskIds; updateProject applies the change and fires
 *   PROJECT_LIST_UPDATE with the whole project state, as the host's effect
 *   does for updateProject; a user drag fires PROJECT_LIST_UPDATE first and
 *   the ACTION hook (with the move action's payload) right after, in that
 *   order — the order the host's effects are subscribed in;
 * - persistDataSynced fires PERSISTED_DATA_CHANGED;
 * - translate() is synchronous and reads the real en/nl files.
 */
'use strict';

const build = require('../build.js');

const TRANSLATIONS = {
  en: JSON.parse(build.readSrc('i18n/en.json')),
  nl: JSON.parse(build.readSrc('i18n/nl.json')),
};

const HOOKS = {
  TASK_CREATED: 'taskCreated',
  TASK_COMPLETE: 'taskComplete',
  TASK_UPDATE: 'taskUpdate',
  TASK_DELETE: 'taskDelete',
  CURRENT_TASK_CHANGE: 'currentTaskChange',
  FINISH_DAY: 'finishDay',
  LANGUAGE_CHANGE: 'languageChange',
  PERSISTED_DATA_CHANGED: 'persistedDataChanged',
  ACTION: 'action',
  ANY_TASK_UPDATE: 'anyTaskUpdate',
  PROJECT_LIST_UPDATE: 'projectListUpdate',
  WORK_CONTEXT_CHANGE: 'workContextChange',
};

const MOVE_IN_BACKLOG = '[Project] Move Task in Backlog';
const MOVE_TO_BACKLOG = '[Project] Move Task from regular to backlog';

const clone = (value) => JSON.parse(JSON.stringify(value));

function lookup(obj, key) {
  let current = obj;
  for (const part of key.split('.')) {
    if (current && typeof current === 'object' && part in current) {
      current = current[part];
    } else {
      return key;
    }
  }
  return typeof current === 'string' ? current : key;
}

function translate(lang, key, params) {
  let text = lookup(TRANSLATIONS[lang] || {}, key);
  if (text === key && lang !== 'en') {
    text = lookup(TRANSLATIONS.en, key);
  }
  if (params && text !== key) {
    text = text.replace(/\{\{(\w+)\}\}/g, (m, name) => (name in params ? String(params[name]) : m));
  }
  return text;
}

class MockHost {
  constructor(options = {}) {
    this.lang = options.lang || 'en';
    this.projects = clone(options.projects || []);
    this.tasks = clone(options.tasks || []);
    this.storage = {};
    this.shortcuts = {};
    this.embedded = false;
    this.focusedTask = options.focusedTask || null;
    if (options.storedConfig !== undefined) {
      this.storage[''] =
        typeof options.storedConfig === 'string' ? options.storedConfig : JSON.stringify(options.storedConfig);
    }
    this.noTranslations = !!options.noTranslations;
    this.activeContext = options.activeContext || null;
    this.failUpdateFor = new Set();

    this.hooks = {};
    this.hookInvocations = {};
    this.pending = [];
    this.readyFns = [];
    this.unloadFn = null;
    this.logs = [];
    this.calls = [];
    this.workContextButtons = [];
    this.configHandler = null;
    this.api = this._createApi();
  }

  projectState() {
    const entities = {};
    this.projects.forEach((p) => {
      entities[p.id] = clone(p);
    });
    return { ids: this.projects.map((p) => p.id), entities };
  }

  _createApi() {
    const host = this;
    const record = (method, ...args) => host.calls.push({ method, args: clone(args) });
    const logger = (level) => (...args) => host.logs.push({ level, args });
    return {
      cfg: { theme: 'light', appVersion: '18.19.0', platform: 'web', isDev: false, lang: { code: host.lang } },
      Hooks: { ...HOOKS },
      registerHook(hook, fn) {
        record('registerHook', hook);
        (host.hooks[hook] = host.hooks[hook] || []).push(fn);
      },
      onReady(fn) {
        host.readyFns.push(fn);
      },
      onUnload(fn) {
        host.unloadFn = fn;
      },
      log: {
        critical: logger('critical'),
        err: logger('err'),
        error: logger('error'),
        log: logger('log'),
        info: logger('info'),
        verbose: logger('verbose'),
        debug: logger('debug'),
        normal: logger('normal'),
        warn: logger('warn'),
      },
      translate: (key, params) => (host.noTranslations ? key : translate(host.lang, key, params)),
      getCurrentLanguage: () => host.lang,
      async getAllProjects() {
        record('getAllProjects');
        return clone(host.projects);
      },
      async getTasks() {
        record('getTasks');
        return clone(host.tasks);
      },
      async getActiveWorkContext() {
        record('getActiveWorkContext');
        return host.activeContext ? clone(host.activeContext) : null;
      },
      async updateProject(projectId, updates) {
        record('updateProject', projectId, updates);
        if (host.failUpdateFor.has(projectId)) {
          throw new Error(`forced failure for ${projectId}`);
        }
        const project = host.projects.find((p) => p.id === projectId);
        if (!project) {
          throw new Error(`Project not found: ${projectId}`);
        }
        Object.assign(project, clone(updates));
        // The host's projectListUpdate$ effect reacts to updateProject.
        host.fireHook(HOOKS.PROJECT_LIST_UPDATE, { action: '[Project] Update Project', projectState: host.projectState() });
        host.fireHook(HOOKS.ACTION, { action: { type: '[Project] Update Project', project: { id: projectId, changes: clone(updates) } } });
      },
      async persistDataSynced(dataStr, key) {
        record('persistDataSynced', key || '');
        host.storage[key || ''] = dataStr;
        host.fireHook(HOOKS.PERSISTED_DATA_CHANGED);
      },
      async loadSyncedData(key) {
        record('loadSyncedData', key || '');
        const value = host.storage[key || ''];
        return value === undefined ? null : value;
      },
      async openDialog() {
        record('openDialog');
        return undefined;
      },
      showSnack(cfg) {
        record('showSnack', cfg);
      },
      registerWorkContextHeaderButton(cfg) {
        record('registerWorkContextHeaderButton', { label: cfg.label, icon: cfg.icon, showFor: cfg.showFor });
        if (!cfg || !cfg.label || typeof cfg.onClick !== 'function' || !Array.isArray(cfg.showFor) || !cfg.showFor.length) {
          throw new Error('registerWorkContextHeaderButton requires label, onClick and showFor');
        }
        host.workContextButtons.push(cfg);
      },
      registerConfigHandler(fn) {
        record('registerConfigHandler');
        host.configHandler = fn;
      },
      showIndexHtmlAsView() {
        record('showIndexHtmlAsView');
      },
      showInWorkContext() {
        record('showInWorkContext');
        host.embedded = true;
      },
      closeWorkContextView() {
        record('closeWorkContextView');
        host.embedded = false;
      },
      async getFocusedTask() {
        record('getFocusedTask');
        return host.focusedTask ? clone(host.focusedTask) : null;
      },
      async getSelectedTask() {
        record('getSelectedTask');
        return host.focusedTask ? clone(host.focusedTask) : null;
      },
      registerHeaderButton: (...a) => record('registerHeaderButton', ...a),
      registerMenuEntry: (...a) => record('registerMenuEntry', ...a),
      registerSidePanelButton: (...a) => record('registerSidePanelButton', ...a),
      registerShortcut(cfg) {
        record('registerShortcut', cfg.id);
        host.shortcuts[cfg.id] = cfg;
      },
    };
  }

  /* Evaluate plugin.js exactly as PluginRunner does. */
  loadPlugin(code) {
    MockHost.instances.push(this);
    const fn = new Function('plugin', 'PluginAPI', `'use strict';\ntry {\n${code}\n} catch (error) { throw error; }`);
    fn(this.api, this.api);
  }

  async ready() {
    for (const fn of this.readyFns) {
      await fn();
    }
    await this.settle();
  }

  fireHook(hook, payload) {
    this.hookInvocations[hook] = (this.hookInvocations[hook] || 0) + 1;
    for (const fn of this.hooks[hook] || []) {
      try {
        const result = fn(payload);
        if (result && typeof result.then === 'function') {
          this.pending.push(result.catch((e) => this.logs.push({ level: 'hook-error', args: [e] })));
        }
      } catch (e) {
        this.logs.push({ level: 'hook-error', args: [e] });
      }
    }
  }

  /*
   * Wait until every handler and everything it kicked off (including the
   * plugin's one-tick reconcile timer) has finished.
   */
  async settle() {
    let idleRounds = 0;
    while (idleRounds < 4) {
      if (this.pending.length) {
        idleRounds = 0;
        const batch = this.pending.splice(0);
        await Promise.all(batch);
      } else {
        idleRounds += 1;
      }
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
  }

  project(id) {
    return this.projects.find((p) => p.id === id);
  }

  writes() {
    return this.calls.filter((c) => c.method === 'updateProject');
  }

  /* A drag inside the backlog: the app reorders, then its effects fire (list update first, then the action). */
  userDragsInBacklog(projectId, taskId, newOrder) {
    const project = this.project(projectId);
    project.backlogTaskIds = newOrder.slice();
    this.fireHook(HOOKS.PROJECT_LIST_UPDATE, { action: MOVE_IN_BACKLOG, projectState: this.projectState() });
    this.fireHook(HOOKS.ACTION, {
      action: { type: MOVE_IN_BACKLOG, taskId, afterTaskId: null, workContextId: projectId },
    });
    return this.settle();
  }

  /* A keyboard move in the backlog: same hooks, another action type. */
  userMovesInBacklog(projectId, taskId, newOrder, actionType) {
    const project = this.project(projectId);
    project.backlogTaskIds = newOrder.slice();
    this.fireHook(HOOKS.PROJECT_LIST_UPDATE, { action: actionType, projectState: this.projectState() });
    this.fireHook(HOOKS.ACTION, {
      action: { type: actionType, taskId, workContextId: projectId, doneBacklogTaskIds: [] },
    });
    return this.settle();
  }

  /* Drag from the main list into the backlog at a position. */
  userMovesToBacklog(projectId, taskId, newOrder) {
    const project = this.project(projectId);
    project.taskIds = (project.taskIds || []).filter((id) => id !== taskId);
    project.backlogTaskIds = newOrder.slice();
    this.fireHook(HOOKS.PROJECT_LIST_UPDATE, { action: MOVE_TO_BACKLOG, projectState: this.projectState() });
    this.fireHook(HOOKS.ACTION, {
      action: { type: MOVE_TO_BACKLOG, taskId, afterTaskId: null, workContextId: projectId },
    });
    return this.settle();
  }

  /* The app moves a task into the backlog by itself (a new task, end of day). */
  taskArrivesInBacklog(projectId, taskId, newOrder) {
    const project = this.project(projectId);
    project.backlogTaskIds = newOrder.slice();
    const type = '[Project] Auto Move Task from regular to backlog';
    this.fireHook(HOOKS.PROJECT_LIST_UPDATE, { action: type, projectState: this.projectState() });
    this.fireHook(HOOKS.ACTION, { action: { type, taskId, projectId } });
    return this.settle();
  }

  /* A change without a move hint (e.g. a task deleted from the backlog). */
  backlogChangedSilently(projectId, newOrder) {
    this.project(projectId).backlogTaskIds = newOrder.slice();
    this.fireHook(HOOKS.PROJECT_LIST_UPDATE, { action: '[Task] Delete Task', projectState: this.projectState() });
    return this.settle();
  }

  userOpensContext(ctx) {
    this.activeContext = ctx;
    this.fireHook(HOOKS.WORK_CONTEXT_CHANGE, clone(ctx));
    return this.settle();
  }
}

MockHost.instances = [];

module.exports = { MockHost, HOOKS, translate, TRANSLATIONS, MOVE_IN_BACKLOG, MOVE_TO_BACKLOG };
