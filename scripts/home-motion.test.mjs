import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import test from "node:test";

const source = readFileSync(new URL("../home-motion.js", import.meta.url), "utf8");

function element() {
  const listeners = new Map();
  const classes = new Set();
  return {
    hidden: false,
    paused: true,
    children: [],
    attributes: new Map(),
    classList: {
      add(name) { classes.add(name); },
      contains(name) { return classes.has(name); },
      remove(name) { classes.delete(name); },
      toggle(name, enabled) {
        if (enabled) classes.add(name);
        else classes.delete(name);
      }
    },
    addEventListener(name, callback) {
      const callbacks = listeners.get(name) || [];
      callbacks.push(callback);
      listeners.set(name, callbacks);
    },
    appendChild(child) { this.children.push(child); },
    dispatch(name) {
      for (const callback of listeners.get(name) || []) callback();
    },
    getAttribute(name) { return this.attributes.get(name); },
    load() { this.loaded = true; },
    pause() {
      this.paused = true;
      this.dispatch("pause");
    },
    play() {
      this.playCalls = (this.playCalls || 0) + 1;
      this.paused = false;
      return this.playBehavior();
    },
    setAttribute(name, value) { this.attributes.set(name, value); }
  };
}

function boot(options = {}) {
  const scene = element();
  const video = element();
  const toggle = element();
  const fallback = element();
  const mediaQuery = {
    matches: !!options.reducedMotion,
    addEventListener() {}
  };
  const stored = options.storedPause ? "1" : null;
  const document = {
    activeElement: null,
    createElement: element,
    getElementById(id) {
      return {
        "hero-scene": scene,
        "hero-video": video,
        "hero-motion": toggle,
        "hero-fallback": fallback
      }[id] || null;
    }
  };
  const context = {
    URLSearchParams,
    clearTimeout,
    document,
    navigator: { connection: { saveData: !!options.saveData } },
    sessionStorage: {
      getItem() {
        if (options.storageThrows) throw new Error("storage blocked");
        return stored;
      },
      removeItem() {
        if (options.storageThrows) throw new Error("storage blocked");
      },
      setItem() {
        if (options.storageThrows) throw new Error("storage blocked");
      }
    },
    setTimeout,
    window: {
      location: { search: options.search || "" },
      matchMedia() { return mediaQuery; }
    }
  };
  video.playBehavior = options.play || (() => Promise.resolve());
  vm.runInNewContext(source, context);
  return { fallback, mediaQuery, scene, toggle, video };
}

async function settle() {
  await Promise.resolve();
  await Promise.resolve();
}

test("reduced motion, data saver, motion=0, and a saved pause skip autoplay", async () => {
  for (const options of [
    { reducedMotion: true, storageThrows: true },
    { saveData: true, storageThrows: true },
    { search: "?motion=0", storageThrows: true },
    { storedPause: true }
  ]) {
    const state = boot(options);
    await settle();
    assert.equal(state.video.playCalls || 0, 0);
    assert.equal(state.toggle.getAttribute("aria-label"), "Play motion");
    assert.equal(state.toggle.hidden, false);
  }
});

test("a rejected autoplay leaves a working manual play control", async () => {
  let attempts = 0;
  const state = boot({
    play() {
      attempts += 1;
      return attempts === 1 ? Promise.reject(new Error("autoplay blocked")) : Promise.resolve();
    }
  });
  await settle();
  assert.equal(state.toggle.getAttribute("aria-label"), "Play motion");
  assert.equal(state.toggle.hidden, false);
  state.toggle.dispatch("click");
  await settle();
  assert.equal(state.video.playCalls, 2);
  assert.equal(state.toggle.getAttribute("aria-label"), "Pause motion");
  assert.equal(state.scene.classList.contains("is-playing"), true);
});

test("a source load error exposes the still-image fallback and accessible control", async () => {
  const state = boot();
  await settle();
  state.video.children[0].dispatch("error");
  assert.equal(state.fallback.hidden, false);
  assert.equal(state.toggle.getAttribute("aria-label"), "Play motion");
  assert.equal(state.toggle.hidden, false);
});

test("the motion control is a native keyboard-operable button", () => {
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  assert.match(html, /<button class="motion-control" id="hero-motion" type="button"[^>]*aria-label="Play motion"/);
});
