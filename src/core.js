/*
 * Backlog Sections — shared logic.
 *
 * Inlined by the build into plugin.js (background script) and index.html
 * (settings page), so both agree on the configuration shape and on how a
 * backlog order is read. Pure functions only: no PluginAPI, no DOM — which is
 * also what makes them testable with plain node.
 */
var BacklogSectionsCore = (function () {
  'use strict';

  var CONFIG_VERSION = 1;

  function isPlainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  }

  function randomSuffix() {
    return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
  }

  function newSectionId() {
    return 's-' + randomSuffix();
  }

  function createDefaultConfig() {
    return { version: CONFIG_VERSION, projects: {}, headerButton: true };
  }

  function emptyProject() {
    return { sections: [], membership: {} };
  }

  /*
   * One project's sections and memberships, repaired field by field: section
   * ids unique non-empty strings, names trimmed strings, membership only
   * string -> existing section id.
   */
  function normalizeProject(raw) {
    var project = emptyProject();
    if (!isPlainObject(raw)) {
      return project;
    }
    var seen = {};
    var sectionsIn = Array.isArray(raw.sections) ? raw.sections : [];
    for (var i = 0; i < sectionsIn.length; i++) {
      var s = sectionsIn[i];
      var id = '';
      var name = '';
      if (typeof s === 'string') {
        name = s.trim();
      } else if (isPlainObject(s)) {
        id = typeof s.id === 'string' ? s.id.trim() : '';
        name = typeof s.name === 'string' ? s.name.trim() : '';
      } else {
        continue;
      }
      if (!id || seen[id]) {
        id = newSectionId();
      }
      seen[id] = true;
      project.sections.push({ id: id, name: name });
    }
    var membershipIn = isPlainObject(raw.membership) ? raw.membership : {};
    Object.keys(membershipIn).forEach(function (taskId) {
      var sectionId = membershipIn[taskId];
      if (typeof taskId === 'string' && taskId.trim() && typeof sectionId === 'string' && seen[sectionId]) {
        project.membership[taskId.trim()] = sectionId;
      }
    });
    return project;
  }

  function normalizeConfig(raw) {
    var config = createDefaultConfig();
    var input = raw;
    if (typeof input === 'string') {
      try {
        input = JSON.parse(input);
      } catch (e) {
        return config;
      }
    }
    if (!isPlainObject(input)) {
      return config;
    }
    if (typeof input.headerButton === 'boolean') {
      config.headerButton = input.headerButton;
    }
    var projectsIn = isPlainObject(input.projects) ? input.projects : {};
    Object.keys(projectsIn).forEach(function (projectId) {
      if (typeof projectId !== 'string' || !projectId.trim()) {
        return;
      }
      var project = normalizeProject(projectsIn[projectId]);
      // An entry without sections and without memberships carries nothing.
      if (project.sections.length || Object.keys(project.membership).length) {
        config.projects[projectId.trim()] = project;
      }
    });
    return config;
  }

  /* Read access that never creates: a missing project reads as empty. */
  function getProject(config, projectId) {
    return (config && config.projects && config.projects[projectId]) || emptyProject();
  }

  function ensureProject(config, projectId) {
    if (!config.projects[projectId]) {
      config.projects[projectId] = emptyProject();
    }
    return config.projects[projectId];
  }

  function sectionIndex(project) {
    var index = {};
    project.sections.forEach(function (section, i) {
      index[section.id] = i;
    });
    return index;
  }

  /* The section of a task, or null when it has none or its section is gone. */
  function sectionOf(project, taskId) {
    var sectionId = project.membership[taskId];
    if (typeof sectionId !== 'string') {
      return null;
    }
    return Object.prototype.hasOwnProperty.call(sectionIndex(project), sectionId) ? sectionId : null;
  }

  /* Longest common subsequence of two id lists — the tasks that kept their relative place. */
  function lcs(a, b) {
    var n = a.length;
    var m = b.length;
    if (!n || !m) {
      return [];
    }
    var table = [];
    for (var i = 0; i <= n; i++) {
      table.push(new Array(m + 1).fill(0));
    }
    for (i = n - 1; i >= 0; i--) {
      for (var j = m - 1; j >= 0; j--) {
        table[i][j] = a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
      }
    }
    var out = [];
    i = 0;
    var k = 0;
    while (i < n && k < m) {
      if (a[i] === b[k]) {
        out.push(a[i]);
        i++;
        k++;
      } else if (table[i + 1][k] >= table[i][k + 1]) {
        i++;
      } else {
        k++;
      }
    }
    return out;
  }

  /*
   * After the backlog order changed, decide which section every task is in.
   * Tasks that kept their relative place (the longest common subsequence of
   * old and new order) keep their section. A task that moved adopts the
   * section of its new neighbours: when the neighbours disagree it takes the
   * following task's section — that is where the drag placeholder is drawn,
   * under that section's header — and at the end of the list the preceding
   * one's. Tasks that are new to the backlog stay without a section; the
   * order enforcement then puts them in the trailing block. When the host
   * named the moved task (movedIds), only that task moves and everything else
   * is an anchor — exact where the order alone is ambiguous. Returns a new
   * membership object.
   */
  function inferMembership(oldOrder, newOrder, project, movedIds) {
    var before = Array.isArray(oldOrder) ? oldOrder : [];
    var after = Array.isArray(newOrder) ? newOrder : [];
    var known = {};
    before.forEach(function (id) {
      known[id] = true;
    });
    var kept = {};
    if (Array.isArray(movedIds) && movedIds.length) {
      var moved = {};
      movedIds.forEach(function (id) {
        moved[id] = true;
        known[id] = true; // a hinted newcomer is placed like a moved task
      });
      after.forEach(function (id) {
        if (known[id] && !moved[id]) {
          kept[id] = true;
        }
      });
    } else {
      lcs(before, after).forEach(function (id) {
        kept[id] = true;
      });
    }
    var result = {};
    var i;
    // Anchors first: their sections are the reference for everything else.
    for (i = 0; i < after.length; i++) {
      if (kept[after[i]]) {
        var own = sectionOf(project, after[i]);
        if (own) {
          result[after[i]] = own;
        }
      }
    }
    for (i = 0; i < after.length; i++) {
      var id = after[i];
      if (kept[id]) {
        continue;
      }
      if (!known[id]) {
        continue; // new to the backlog: no section
      }
      var prev = null;
      var next = null;
      var j;
      for (j = i - 1; j >= 0; j--) {
        if (kept[after[j]]) {
          prev = after[j];
          break;
        }
      }
      for (j = i + 1; j < after.length; j++) {
        if (kept[after[j]]) {
          next = after[j];
          break;
        }
      }
      var prevSection = prev ? result[prev] || null : null;
      var nextSection = next ? result[next] || null : null;
      var oldSection = sectionOf(project, id);
      var chosen;
      if (!prev && !next) {
        chosen = oldSection;
      } else if (!next) {
        chosen = prevSection;
      } else if (!prev) {
        chosen = nextSection;
      } else if (prevSection === nextSection) {
        chosen = prevSection;
      } else if (oldSection === prevSection || oldSection === nextSection) {
        // On a boundary next to its own section the task stayed in it: moved
        // to the end or the top of that section, not across.
        chosen = oldSection;
      } else {
        chosen = nextSection;
      }
      if (chosen) {
        result[id] = chosen;
      }
    }
    return result;
  }

  /* Membership restricted to tasks that are still in the backlog. */
  function pruneMembership(membership, backlogTaskIds) {
    var present = {};
    (backlogTaskIds || []).forEach(function (id) {
      present[id] = true;
    });
    var out = {};
    Object.keys(membership || {}).forEach(function (taskId) {
      if (present[taskId]) {
        out[taskId] = membership[taskId];
      }
    });
    return out;
  }

  /*
   * The order the backlog should have: one block per section in section
   * order, tasks without a section last; inside a block the current relative
   * order is kept.
   */
  function desiredOrder(backlogTaskIds, project) {
    var order = Array.isArray(backlogTaskIds) ? backlogTaskIds : [];
    var buckets = {};
    project.sections.forEach(function (section) {
      buckets[section.id] = [];
    });
    var loose = [];
    order.forEach(function (taskId) {
      var sectionId = sectionOf(project, taskId);
      if (sectionId) {
        buckets[sectionId].push(taskId);
      } else {
        loose.push(taskId);
      }
    });
    var out = [];
    project.sections.forEach(function (section) {
      out = out.concat(buckets[section.id]);
    });
    return out.concat(loose);
  }

  /*
   * Consecutive runs of one section in the given order — what the headers
   * decorate. Computed from the actual order, so it is right even before an
   * enforcement write has landed.
   */
  function blocks(backlogTaskIds, project) {
    var order = Array.isArray(backlogTaskIds) ? backlogTaskIds : [];
    var out = [];
    var current = null;
    order.forEach(function (taskId) {
      var sectionId = sectionOf(project, taskId);
      if (!current || current.sectionId !== sectionId) {
        current = { sectionId: sectionId, taskIds: [] };
        out.push(current);
      }
      current.taskIds.push(taskId);
    });
    return out;
  }

  function sameList(a, b) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
      return false;
    }
    for (var i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) {
        return false;
      }
    }
    return true;
  }

  function sameMembership(a, b) {
    var ka = Object.keys(a || {});
    var kb = Object.keys(b || {});
    if (ka.length !== kb.length) {
      return false;
    }
    for (var i = 0; i < ka.length; i++) {
      if (a[ka[i]] !== b[ka[i]]) {
        return false;
      }
    }
    return true;
  }

  /* All dotted leaf keys of a nested translation object, sorted. */
  function flattenKeys(obj, prefix) {
    var keys = [];
    if (!isPlainObject(obj)) {
      return keys;
    }
    Object.keys(obj).forEach(function (key) {
      var full = prefix ? prefix + '.' + key : key;
      if (isPlainObject(obj[key])) {
        keys = keys.concat(flattenKeys(obj[key], full));
      } else {
        keys.push(full);
      }
    });
    return keys.sort();
  }

  /* Nested lookup of a dotted key; returns the key itself when absent, like the host. */
  function lookup(strings, key) {
    var current = strings;
    var parts = String(key).split('.');
    for (var i = 0; i < parts.length; i++) {
      if (current !== null && typeof current === 'object' && Object.prototype.hasOwnProperty.call(current, parts[i])) {
        current = current[parts[i]];
      } else {
        return key;
      }
    }
    return typeof current === 'string' ? current : key;
  }

  /* Same placeholder syntax as the host's translate(): {{name}} */
  function interpolate(text, params) {
    if (!params || typeof text !== 'string') {
      return text;
    }
    return text.replace(/\{\{(\w+)\}\}/g, function (match, name) {
      return Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match;
    });
  }

  return {
    CONFIG_VERSION: CONFIG_VERSION,
    newSectionId: newSectionId,
    createDefaultConfig: createDefaultConfig,
    normalizeProject: normalizeProject,
    normalizeConfig: normalizeConfig,
    getProject: getProject,
    ensureProject: ensureProject,
    sectionOf: sectionOf,
    lcs: lcs,
    inferMembership: inferMembership,
    pruneMembership: pruneMembership,
    desiredOrder: desiredOrder,
    blocks: blocks,
    sameList: sameList,
    sameMembership: sameMembership,
    flattenKeys: flattenKeys,
    lookup: lookup,
    interpolate: interpolate,
  };
})();
