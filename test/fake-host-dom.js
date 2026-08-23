/*
 * A small fake of the host document for the parts of plugin.js that decorate
 * the backlog panel: elements with children, attributes, listeners and text,
 * getElementById, and querySelector(All) for compound selectors of the form
 * tag.class[attr="value"] (descendant search, no combinators).
 */
'use strict';

class FakeElement {
  constructor(tagName, doc) {
    this.tagName = (tagName || 'div').toLowerCase();
    this.doc = doc;
    this.nodeType = 1;
    this.children = [];
    this.attrs = {};
    this.listeners = {};
    this.parentNode = null;
    this._text = '';
    this.className = '';
    this.title = '';
    this.type = '';
  }
  get id() {
    return this.attrs.id || '';
  }
  set id(value) {
    this.attrs.id = String(value);
  }
  get textContent() {
    return this.children.length ? this.children.map((c) => c.textContent).join('') : this._text;
  }
  set textContent(value) {
    FakeElement.textWrites += 1;
    this.children = [];
    this._text = String(value);
  }
  appendChild(child) {
    if (child.parentNode) child.parentNode.removeChild(child);
    child.parentNode = this;
    this.children.push(child);
    return child;
  }
  insertBefore(child, ref) {
    if (child.parentNode) child.parentNode.removeChild(child);
    child.parentNode = this;
    const index = ref ? this.children.indexOf(ref) : -1;
    if (index < 0) this.children.push(child);
    else this.children.splice(index, 0, child);
    return child;
  }
  removeChild(child) {
    this.children = this.children.filter((c) => c !== child);
    child.parentNode = null;
    return child;
  }
  get nextSibling() {
    if (!this.parentNode) return null;
    const siblings = this.parentNode.children;
    return siblings[siblings.indexOf(this) + 1] || null;
  }
  setAttribute(name, value) {
    this.attrs[name] = String(value);
  }
  getAttribute(name) {
    return name in this.attrs ? this.attrs[name] : null;
  }
  hasAttribute(name) {
    return name in this.attrs;
  }
  removeAttribute(name) {
    delete this.attrs[name];
  }
  addEventListener(type, fn) {
    (this.listeners[type] = this.listeners[type] || []).push(fn);
  }
  dispatch(type) {
    for (const fn of this.listeners[type] || []) fn({ type, target: this, stopPropagation() {} });
  }
  matches(selector) {
    return matchCompound(this, selector);
  }
  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }
  querySelectorAll(selector) {
    const out = [];
    const walk = (node) => {
      for (const child of node.children) {
        if (matchCompound(child, selector)) out.push(child);
        walk(child);
      }
    };
    walk(this);
    return out;
  }
}

function matchCompound(el, selector) {
  const m = selector.trim().match(/^([a-zA-Z][\w-]*)?((?:\.[\w-]+)*)((?:\[[^\]]+\])*)$/);
  if (!m) return false;
  const [, tag, classes, attrs] = m;
  if (tag && el.tagName !== tag.toLowerCase()) return false;
  const classList = (el.className || '').split(/\s+/).filter(Boolean);
  for (const cls of (classes || '').split('.').filter(Boolean)) {
    if (!classList.includes(cls)) return false;
  }
  const attrRe = /\[([\w-]+)(?:="([^"]*)")?\]/g;
  let a;
  while ((a = attrRe.exec(attrs || ''))) {
    if (!(a[1] in el.attrs)) return false;
    if (a[2] !== undefined && el.attrs[a[1]] !== a[2]) return false;
  }
  return true;
}

FakeElement.textWrites = 0;

class FakeDocument {
  constructor() {
    this.body = new FakeElement('body', this);
    this.head = new FakeElement('head', this);
  }
  createElement(tag) {
    return new FakeElement(tag, this);
  }
  getElementById(id) {
    const find = (node) => {
      for (const child of node.children) {
        if (child.id === id) return child;
        const hit = find(child);
        if (hit) return hit;
      }
      return null;
    };
    return find(this.head) || find(this.body);
  }
  querySelector(selector) {
    return this.body.querySelector(selector) || this.head.querySelector(selector);
  }
  querySelectorAll(selector) {
    return this.head.querySelectorAll(selector).concat(this.body.querySelectorAll(selector));
  }
}

/* A backlog list with one <task id="t-…"> row per id, as the host renders it. */
function backlogDocument(taskIds) {
  const doc = new FakeDocument();
  const list = doc.createElement('div');
  list.className = 'task-list-inner';
  list.setAttribute('data-id', 'BACKLOG');
  doc.body.appendChild(list);
  for (const id of taskIds) {
    const row = doc.createElement('task');
    row.id = 't-' + id;
    list.appendChild(row);
  }
  doc.backlogList = list;
  doc.setRows = (ids) => {
    list.children.filter((c) => c.tagName === 'task').forEach((c) => list.removeChild(c));
    for (const id of ids) {
      const row = doc.createElement('task');
      row.id = 't-' + id;
      list.appendChild(row);
    }
  };
  return doc;
}

class FakeMutationObserver {
  constructor(callback) {
    this.callback = callback;
    this.observing = false;
    FakeMutationObserver.instances.push(this);
  }
  observe() {
    this.observing = true;
  }
  disconnect() {
    this.observing = false;
  }
  trigger(records) {
    this.callback(records || [{ type: 'childList', addedNodes: [{ nodeType: 1, getAttribute: () => null }], removedNodes: [] }]);
  }
}
FakeMutationObserver.instances = [];

class FakeStorage {
  constructor() {
    this.data = {};
  }
  getItem(key) {
    return key in this.data ? this.data[key] : null;
  }
  setItem(key, value) {
    this.data[key] = String(value);
  }
}

module.exports = { FakeElement, FakeDocument, backlogDocument, FakeMutationObserver, FakeStorage };
