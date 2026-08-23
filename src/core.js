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

  var CONFIG_VERSION = 2;

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
    return {
      version: CONFIG_VERSION,
      sections: [],
      projects: {},
      headerButton: true,
      clickSelectsTask: true,
      autoAssignFromLists: false,
    };
  }

  function emptyProject() {
    return { membership: {}, adopted: {} };
  }

  /*
   * Preset sections that were added before their emoji changed. Only these
   * exact names follow along; a name the user typed or edited is never
   * touched. Renaming one afterwards simply takes it out of this list.
   */
  var RENAMED_SECTIONS = {
    '🌟 Medium term': '☀️ Medium term',
    '🌙 Long term': '💫 Long term',
    '🌟 Middellange termijn': '☀️ Middellange termijn',
    '🌙 Lange termijn': '💫 Lange termijn',
  };

  /*
   * The one list of sections that every project's backlog uses: ids unique
   * non-empty strings, names trimmed. A bare string counts as a name.
   */
  function normalizeSections(raw) {
    var sections = [];
    var seen = {};
    var input = Array.isArray(raw) ? raw : [];
    for (var i = 0; i < input.length; i++) {
      var s = input[i];
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
      sections.push({ id: id, name: Object.prototype.hasOwnProperty.call(RENAMED_SECTIONS, name) ? RENAMED_SECTIONS[name] : name });
    }
    return sections;
  }

  /* One project: only which task sits in which of the shared sections. */
  function normalizeProject(raw, knownSectionIds) {
    var project = emptyProject();
    if (!isPlainObject(raw)) {
      return project;
    }
    var membershipIn = isPlainObject(raw.membership) ? raw.membership : {};
    Object.keys(membershipIn).forEach(function (taskId) {
      var sectionId = membershipIn[taskId];
      if (typeof taskId === 'string' && taskId.trim() && typeof sectionId === 'string' && knownSectionIds[sectionId]) {
        project.membership[taskId.trim()] = sectionId;
      }
    });
    var adoptedIn = isPlainObject(raw.adopted) ? raw.adopted : {};
    Object.keys(adoptedIn).forEach(function (taskId) {
      if (typeof taskId === 'string' && taskId.trim() && adoptedIn[taskId] === true) {
        project.adopted[taskId.trim()] = true;
      }
    });
    return project;
  }

  /*
   * Version 1 kept a sections list per project. They are merged into the one
   * shared list, by name and case-insensitively, in the order the projects
   * are read; every project's memberships are remapped onto the merged ids.
   * Returns { sections, remap: { projectId: { oldId: newId } } }.
   */
  function migrateProjectSections(projectsIn) {
    var sections = [];
    var byName = {};
    var remap = {};
    Object.keys(projectsIn).forEach(function (projectId) {
      var raw = projectsIn[projectId];
      if (!isPlainObject(raw)) {
        return;
      }
      var map = {};
      normalizeSections(raw.sections).forEach(function (section) {
        var key = section.name.toLowerCase();
        if (!Object.prototype.hasOwnProperty.call(byName, key)) {
          byName[key] = section.id;
          sections.push(section);
        }
        map[section.id] = byName[key];
      });
      remap[projectId] = map;
    });
    return { sections: sections, remap: remap };
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
    if (typeof input.clickSelectsTask === 'boolean') {
      config.clickSelectsTask = input.clickSelectsTask;
    }
    if (typeof input.autoAssignFromLists === 'boolean') {
      config.autoAssignFromLists = input.autoAssignFromLists;
    }
    var projectsIn = isPlainObject(input.projects) ? input.projects : {};
    var remap = null;
    if (Array.isArray(input.sections)) {
      config.sections = normalizeSections(input.sections);
    } else {
      var migrated = migrateProjectSections(projectsIn);
      config.sections = migrated.sections;
      remap = migrated.remap;
    }
    var knownSectionIds = {};
    config.sections.forEach(function (section) {
      knownSectionIds[section.id] = true;
    });
    Object.keys(projectsIn).forEach(function (projectId) {
      if (typeof projectId !== 'string' || !projectId.trim()) {
        return;
      }
      var source = projectsIn[projectId];
      if (remap && isPlainObject(source) && isPlainObject(source.membership)) {
        var map = remap[projectId] || {};
        var moved = {};
        Object.keys(source.membership).forEach(function (taskId) {
          var old = source.membership[taskId];
          moved[taskId] = typeof old === 'string' && map[old] ? map[old] : old;
        });
        source = { membership: moved };
      }
      var project = normalizeProject(source, knownSectionIds);
      // An entry without memberships or adoption marks carries nothing.
      if (Object.keys(project.membership).length || Object.keys(project.adopted).length) {
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

  /*
   * What the rest of the code works with: the shared sections plus one
   * project's memberships. Everything below takes such a view, so the section
   * list being global is invisible to the ordering and header logic.
   */
  function projectView(config, projectId) {
    return {
      sections: (config && Array.isArray(config.sections) ? config.sections : []),
      membership: getProject(config, projectId).membership,
    };
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

  /*
   * The sections that hold no task in this order — the ones whose header is
   * empty in the backlog. A task may be counted out (the one being placed).
   */
  function emptySections(project, order, exceptTaskId) {
    var used = {};
    (order || []).forEach(function (taskId) {
      if (taskId === exceptTaskId) {
        return;
      }
      var sectionId = sectionOf(project, taskId);
      if (sectionId) {
        used[sectionId] = true;
      }
    });
    return project.sections
      .filter(function (section) {
        return !used[section.id];
      })
      .map(function (section) {
        return section.id;
      });
  }

  /*
   * The first section without tasks that sits between two sections in the
   * configured order — from the start when there is nothing before, up to the
   * end when there is nothing after. Dropping a task on such a boundary is
   * the only way to fill an empty section: its header has no rows of its own
   * to drop between, so the boundary is where the user aims.
   */
  function firstEmptySectionBetween(project, order, fromSectionId, toSectionId, taskId) {
    var index = sectionIndex(project);
    var from = typeof index[fromSectionId] === 'number' ? index[fromSectionId] + 1 : 0;
    var to = typeof index[toSectionId] === 'number' ? index[toSectionId] : project.sections.length;
    if (to <= from) {
      return null;
    }
    var empty = {};
    emptySections(project, order, taskId).forEach(function (id) {
      empty[id] = true;
    });
    for (var i = from; i < to; i++) {
      if (empty[project.sections[i].id]) {
        return project.sections[i].id;
      }
    }
    return null;
  }

  /*
   * The stops a task passes when it is moved section by section: "no section"
   * on top, where the unsorted tasks live, and then every section in order.
   */
  function sectionStops(project) {
    return [null].concat(
      project.sections.map(function (section) {
        return section.id;
      })
    );
  }

  /*
   * Was the task the first (or the last) of the run of tasks that share its
   * section in this order — the top or the bottom row of its block? That is
   * what tells a move inside a block from a move out of it.
   */
  function edgeOfBlock(order, project, taskId) {
    var index = (order || []).indexOf(taskId);
    if (index === -1) {
      return { first: false, last: false };
    }
    var own = sectionOf(project, taskId);
    var before = index > 0 ? sectionOf(project, order[index - 1]) : null;
    var after = index < order.length - 1 ? sectionOf(project, order[index + 1]) : null;
    return {
      first: index === 0 || before !== own,
      last: index === order.length - 1 || after !== own,
    };
  }

  /*
   * "Move up" and "move down" from the edge of a block mean one section up or
   * down — including into a section that holds no task here, which a move by
   * rows can never reach because it has no rows to stop at. Returns undefined
   * when the move stays inside the block, so the caller keeps its section.
   */
  function stepSection(oldOrder, project, taskId, kind) {
    var edge = edgeOfBlock(oldOrder, project, taskId);
    if ((kind === 'up' && !edge.first) || (kind === 'down' && !edge.last)) {
      return undefined;
    }
    var stops = sectionStops(project);
    var current = stops.indexOf(sectionOf(project, taskId));
    var next = current + (kind === 'up' ? -1 : 1);
    if (current === -1 || next < 0 || next >= stops.length) {
      return undefined;
    }
    return stops[next];
  }

  function firstSectionId(project) {
    return project.sections.length ? project.sections[0].id : null;
  }

  function lastSectionId(project) {
    return project.sections.length ? project.sections[project.sections.length - 1].id : null;
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
  function inferMembership(oldOrder, newOrder, project, movedIds, kind) {
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
        // Only a task the user dropped somewhere is placed like a moved one.
        // Anything else that is new to this backlog stays without a section.
        if (kind === 'drag') {
          known[id] = true;
        }
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
      var stepped;
      // "To the top" and "to the bottom" say where the task belongs without
      // any inference: above every section, and in the last one.
      if (kind === 'top') {
        chosen = null;
      } else if (kind === 'bottom') {
        chosen = lastSectionId(project);
      } else if ((kind === 'up' || kind === 'down') && (stepped = stepSection(before, project, id, kind)) !== undefined) {
        // Moved off the edge of its block: one section further, no matter how
        // many empty ones lie between it and the next block of rows.
        chosen = stepped;
      } else if ((kind === 'up' || kind === 'down') && sectionOf(project, id) !== null) {
        chosen = sectionOf(project, id); // moved inside its own block
      } else if (!prev && !next) {
        chosen = oldSection;
      } else if (!next) {
        chosen = prevSection;
      } else if (prev && prevSection === nextSection) {
        // Inside one block: nothing to decide.
        chosen = prevSection;
      } else {
        // On a boundary. An empty section there is what the user aimed at: it
        // has no rows to drop between, so the boundary is its only target.
        // Once it holds a task the ordinary rules apply to it as well.
        var empty = prev ? firstEmptySectionBetween(project, after, prevSection, nextSection, id) : null;
        if (empty) {
          chosen = empty;
        } else if (!prev) {
          // Above every row is above every section: the unsorted block.
          chosen = null;
        } else if (oldSection === prevSection || oldSection === nextSection) {
          // On a boundary next to its own section the task stayed in it: moved
          // to the end or the top of that section, not across.
          chosen = oldSection;
        } else {
          chosen = nextSection;
        }
      }
      if (chosen) {
        result[id] = chosen;
      }
    }
    return result;
  }

  /*
   * The sections the user asked for out of the box: the three horizons plus
   * the tasks that already have a slot in the calendar. Only the translation
   * keys live here — the names are resolved in the app language and then
   * stored as plain text, so renaming one later is an ordinary rename.
   */
  var PRESET_SECTION_KEYS = [
    'UI.SECTIONS.PRESET.SHORT_TERM',
    'UI.SECTIONS.PRESET.MID_TERM',
    'UI.SECTIONS.PRESET.LONG_TERM',
    'UI.SECTIONS.PRESET.CALENDAR',
  ];

  /*
   * Append the preset sections that the shared list does not have yet, comparing
   * names case-insensitively so a second click adds nothing. Mutates the
   * config and returns the names that were added.
   */
  function addPresetSections(config, names) {
    var have = {};
    config.sections.forEach(function (section) {
      have[String(section.name).trim().toLowerCase()] = true;
    });
    var added = [];
    (names || []).forEach(function (name) {
      var trimmed = String(name || '').trim();
      var key = trimmed.toLowerCase();
      if (!trimmed || have[key]) {
        return;
      }
      have[key] = true;
      config.sections.push({ id: newSectionId(), name: trimmed });
      added.push(trimmed);
    });
    return added;
  }


  // ---- automatic sectioning of imported tasks --------------------------------------

  /*
   * The Microsoft To Do plugin publishes {listKey: listName} under this
   * localStorage key (same host window). A task imported by it carries an
   * issueId of the form <listKey>::<taskKey>, which is what ties a backlog
   * task back to the To Do list it came from.
   */
  var LIST_MAP_STORAGE_KEY = 'sp-mstodo.lists.v1';

  function normalizeListName(name) {
    return String(name == null ? '' : name)
      .replace(/[︎️]/g, '') // emoji variation selectors: 🎞 and 🎞️ are one name
      .replace(/s+/g, ' ')
      .trim()
      .toLowerCase();
  }

  /*
   * The section a To Do list maps onto: an exact match on the normalised name
   * first, then a unique prefix relation in either direction — the section
   * "💫 Lange termijn" takes the list "💫 Lange termijn taken". Two candidates
   * mean the name is ambiguous, and nothing is placed.
   */
  function matchSectionByListName(sections, listName) {
    var wanted = normalizeListName(listName);
    if (!wanted) {
      return null;
    }
    var exact = null;
    var byPrefix = [];
    (sections || []).forEach(function (section) {
      var have = normalizeListName(section.name);
      if (!have) {
        return;
      }
      if (have === wanted) {
        exact = exact || section.id;
      } else if (wanted.indexOf(have) === 0 || have.indexOf(wanted) === 0) {
        byPrefix.push({ id: section.id, length: have.length });
      }
    });
    if (exact) {
      return exact;
    }
    // The most specific candidate wins ("Werk privé" over "Werk"); only a
    // tie in length is truly ambiguous.
    byPrefix.sort(function (a, b) {
      return b.length - a.length;
    });
    if (!byPrefix.length || (byPrefix.length > 1 && byPrefix[0].length === byPrefix[1].length)) {
      return null;
    }
    return byPrefix[0].id;
  }

  function listKeyOfIssueId(issueId) {
    var raw = String(issueId == null ? '' : issueId);
    var sep = raw.indexOf('::');
    return sep > 0 ? raw.slice(0, sep) : '';
  }

  /*
   * Which unsectioned tasks should be placed, based on the To Do list their
   * issueId points into. Every task is considered exactly once (the caller
   * marks the returned considered-ids in the project's adopted map), so a
   * task the user later drags out of the section stays out, and old tasks are
   * never grabbed retroactively when sections change.
   */
  function adoptTasksFromLists(project, order, taskInfos, listNames, adopted) {
    var additions = {};
    var considered = [];
    (order || []).forEach(function (taskId) {
      if (sectionOf(project, taskId) || (adopted && adopted[taskId])) {
        return;
      }
      var issueId = taskInfos ? taskInfos[taskId] : null;
      if (!issueId) {
        return; // not an imported task (or unknown yet): reconsider next pass
      }
      considered.push(taskId);
      var key = listKeyOfIssueId(issueId);
      var name = key && listNames ? listNames[key] : '';
      var sectionId = name ? matchSectionByListName(project.sections, name) : null;
      if (sectionId) {
        additions[taskId] = sectionId;
      }
    });
    return { additions: additions, considered: considered };
  }

  /* The adopted marks restricted to tasks still in the backlog. */
  function pruneAdopted(adopted, backlogTaskIds) {
    var present = {};
    (backlogTaskIds || []).forEach(function (id) {
      present[id] = true;
    });
    var out = {};
    Object.keys(adopted || {}).forEach(function (taskId) {
      if (present[taskId]) {
        out[taskId] = true;
      }
    });
    return out;
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
   * The order the backlog should have: the tasks without a section first —
   * that is where new tasks arrive and where they are sorted from — then one
   * block per section in section order. Inside a block the current relative
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
    var out = loose;
    project.sections.forEach(function (section) {
      out = out.concat(buckets[section.id]);
    });
    return out;
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
    PRESET_SECTION_KEYS: PRESET_SECTION_KEYS,
    addPresetSections: addPresetSections,
    createDefaultConfig: createDefaultConfig,
    normalizeSections: normalizeSections,
    normalizeProject: normalizeProject,
    normalizeConfig: normalizeConfig,
    getProject: getProject,
    projectView: projectView,
    ensureProject: ensureProject,
    sectionOf: sectionOf,
    lcs: lcs,
    emptySections: emptySections,
    firstEmptySectionBetween: firstEmptySectionBetween,
    firstSectionId: firstSectionId,
    lastSectionId: lastSectionId,
    sectionStops: sectionStops,
    edgeOfBlock: edgeOfBlock,
    stepSection: stepSection,
    inferMembership: inferMembership,
    pruneMembership: pruneMembership,
    LIST_MAP_STORAGE_KEY: LIST_MAP_STORAGE_KEY,
    normalizeListName: normalizeListName,
    matchSectionByListName: matchSectionByListName,
    listKeyOfIssueId: listKeyOfIssueId,
    adoptTasksFromLists: adoptTasksFromLists,
    pruneAdopted: pruneAdopted,
    desiredOrder: desiredOrder,
    blocks: blocks,
    sameList: sameList,
    sameMembership: sameMembership,
    flattenKeys: flattenKeys,
    lookup: lookup,
    interpolate: interpolate,
  };
})();
