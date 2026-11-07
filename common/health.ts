// Logging and self-checks, so a Steam update that breaks this plugin leaves a trace.
//
// Steam doesn't document the things this plugin relies on (the store page's
// layout and config, Steam's internal functions, its web APIs), and an update
// can change them. Each place that depends on one calls check(). Results go to
// price-history.log (written by backend/main.lua into Millennium's log
// folder, see the main README) as well as the developer console, and failed
// checks are listed in the plugin's settings panel.
//
// A check is only sent when its result changes, so it's fine to call it often.
//
// `backend` is defined by Millennium's compiler (starlight) from the ---@ffi
// functions in backend/main.lua; it exists in both the page and the panel.

type Level = "info" | "warning" | "error";

const PREFIX = "[Price History]";
const results = new Map<string, boolean>();

export function log(level: Level, message: string) {
  const write = level === "error" ? console.error : level === "warning" ? console.warn : console.log;
  write(PREFIX, message);
  backend.log(level, message).catch(() => {
    /* backend not running: the console line above is all we can do */
  });
}

// Records whether something this plugin relies on works. Returns `ok`, so it
// can be used inline: `if (!check("…", !!thing)) return;`
export function check(name: string, ok: boolean, detail = ""): boolean {
  if (results.get(name) !== ok) {
    results.set(name, ok);
    if (!ok) console.error(PREFIX, `[FAIL] ${name}${detail ? `: ${detail}` : ""}`);
    backend.report_check(name, ok, detail).catch(() => {
      /* backend not running */
    });
  }
  return ok;
}
