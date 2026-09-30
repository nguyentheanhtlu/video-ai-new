import { api } from "./lib.js";

// Small cache for data that rarely changes while the app is open.
const cache = new Map();

function cached(key, url) {
  return (fresh = false) => {
    if (fresh || !cache.has(key)) cache.set(key, api("GET", url).catch((e) => { cache.delete(key); throw e; }));
    return cache.get(key);
  };
}

export const store = {
  templates: cached("templates", "/api/templates"),
  sfx: cached("sfx", "/api/sfx"),
  voices: cached("voices", "/api/voices"),
  invalidate: (key) => cache.delete(key),
};
