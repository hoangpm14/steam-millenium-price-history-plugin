// Run: node tests/ffi_test.cjs
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");

async function scenario(decoded) {
  const calls = [];
  const settings = { region: "CA", wait_days: 61, has_key: true, detected: "CA" };
  const transport = (value) => decoded ? value : JSON.stringify(value);
  const backend = {
    get_settings: async () => transport(settings),
    http_json: async (url) => {
      calls.push(url);
      const body = url.includes("appdetails")
        ? { 620: { success: true, data: { is_free: false } } }
        : url.includes("lookup") ? { found: true, game: { id: "test-game" } }
        : url.includes("history")
          ? [{ timestamp: "2026-01-01T00:00:00Z", deal: {
              price: { amount: 5, currency: "CAD" }, regular: { amount: 10 }, cut: 50,
            } }]
          : [];
      return transport({ status: 200, body: JSON.stringify(body) });
    },
  };
  const modules = new Map();
  function load(filename) {
    if (modules.has(filename)) return modules.get(filename).exports;
    const mod = { exports: {} };
    modules.set(filename, mod);
    const code = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    }).outputText;
    vm.runInNewContext(code, {
      module: mod, exports: mod.exports, backend,
      require: (name) => name.endsWith("/health")
        ? { check: (_name, ok) => ok, log: () => {} }
        : load(path.resolve(path.dirname(filename), name + ".ts")),
    }, { filename });
    return mod.exports;
  }
  const root = path.resolve(__dirname, "..");
  const { parseSettings } = load(path.join(root, "common/constants.ts"));
  assert.equal(parseSettings(transport(settings)).has_key, true);
  assert.equal(parseSettings(transport({ ...settings, has_key: false })).has_key, false);
  const { decodeBackendJson } = load(path.join(root, "common/backend-json.ts"));
  assert.equal(decodeBackendJson(transport(["test problem"]))[0], "test problem");
  const { loadPrices } = load(path.join(root, "webview/prices.ts"));
  const result = await loadPrices("620", "CA");
  assert.equal(result.historyError, null);
  assert.equal(result.history.length, 1);
  assert.equal(result.history[0].price, 5);
  assert.equal(result.waitDays, 61);
  assert.equal(calls.filter((url) => url.includes("api.isthereanydeal.com")).length, 4);
}

(async () => {
  await scenario(true);
  await scenario(false);
  console.log("FFI regression checks passed for decoded objects and JSON strings.");
})().catch((error) => { console.error(error); process.exitCode = 1; });
