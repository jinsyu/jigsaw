// Read-only test hooks (window.__puzzle, window.__puzzleDemo, window.__overview) for the
// Playwright tests. They exist only where the site talks to the local Supabase stack
// (config.js: localhost, LAN addresses, *.local), never on the deployed site.
import { pickConfig } from './config.js';

export function hooksAllowed(hostname) {
  return pickConfig(hostname).env === 'local';
}

// Sets window[name] = value when allowed. Returns a function that removes it again.
export function exposeTestHook(name, value) {
  if (!hooksAllowed(location.hostname)) return () => {};
  window[name] = value;
  return () => {
    if (window[name] === value) delete window[name];
  };
}
