/*
 * The smallest DOM that index.html needs: createElement/createTextNode,
 * appendChild, attributes, listeners, textContent and innerHTML = ''. Enough to
 * render the settings screen in node and to drive its buttons and inputs from
 * a test; not a general-purpose DOM.
 */
'use strict';

class Node {
  constructor(tagName) {
    this.tagName = tagName ? tagName.toUpperCase() : '#text';
    this.children = [];
    this.attributes = {};
    this.listeners = {};
    this.parentNode = null;
    this.className = '';
    this.value = '';
    this.checked = false;
    this.disabled = false;
    this.selected = false;
    this._text = '';
  }

  appendChild(child) {
    child.parentNode = this;
    this.children.push(child);
    return child;
  }

  setAttribute(name, value) {
    this.attributes[name] = String(value);
  }

  getAttribute(name) {
    return Object.prototype.hasOwnProperty.call(this.attributes, name) ? this.attributes[name] : null;
  }

  addEventListener(type, fn) {
    (this.listeners[type] = this.listeners[type] || []).push(fn);
  }

  dispatch(type, event) {
    const e = Object.assign({ type, target: this, preventDefault() {} }, event || {});
    for (const fn of this.listeners[type] || []) {
      fn(e);
    }
  }

  get textContent() {
    if (this.tagName === '#text') {
      return this._text;
    }
    return this.children.map((c) => c.textContent).join('');
  }

  set textContent(value) {
    if (this.tagName === '#text') {
      this._text = String(value);
      return;
    }
    this.children = [];
    if (value !== '') {
      const text = new Node(null);
      text._text = String(value);
      this.appendChild(text);
    }
  }

  set innerHTML(value) {
    if (value !== '') {
      throw new Error('dom-stub only supports innerHTML = ""');
    }
    this.children = [];
  }

  /* Depth-first search helpers for tests. */
  find(predicate) {
    if (predicate(this)) {
      return this;
    }
    for (const child of this.children) {
      const hit = child.find(predicate);
      if (hit) {
        return hit;
      }
    }
    return null;
  }

  findAll(predicate, out = []) {
    if (predicate(this)) {
      out.push(this);
    }
    for (const child of this.children) {
      child.findAll(predicate, out);
    }
    return out;
  }
}

function createDocument() {
  const body = new Node('body');
  const app = new Node('div');
  app.setAttribute('id', 'app');
  const status = new Node('div');
  status.setAttribute('id', 'status');
  body.appendChild(app);
  body.appendChild(status);
  const byId = { app, status };
  return {
    body,
    createElement: (tag) => new Node(tag),
    createTextNode: (text) => {
      const node = new Node(null);
      node._text = String(text);
      return node;
    },
    getElementById: (id) => byId[id] || null,
  };
}

module.exports = { Node, createDocument };
