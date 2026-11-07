-- Unit test for backend/main.lua with stand-ins for Millennium's Lua modules.
-- Run from the plugin folder: luajit tests/backend_test.lua backend/main.lua

local logs, config, http_calls, http_queue = {}, {}, {}, {}

-- Minimal JSON encoder (enough for the backend's output) and a decoder stub.
local function encode(v)
  local t = type(v)
  if t == "string" then return '"' .. v:gsub('[%c"\\]', function(c) return string.format("\\u%04x", c:byte()) end) .. '"' end
  if t == "number" or t == "boolean" then return tostring(v) end
  if t == "nil" then return "null" end
  if #v > 0 then
    local parts = {}
    for _, x in ipairs(v) do parts[#parts + 1] = encode(x) end
    return "[" .. table.concat(parts, ",") .. "]"
  end
  local keys = {}
  for k in pairs(v) do keys[#keys + 1] = k end
  table.sort(keys)
  local parts = {}
  for _, k in ipairs(keys) do parts[#parts + 1] = encode(k) .. ":" .. encode(v[k]) end
  return "{" .. table.concat(parts, ",") .. "}"
end
package.preload["json"] = function()
  return { encode = encode, decode = function(s)
    local r = s:match('"reason_phrase"%s*:%s*"([^"]*)"')
    if r then return { reason_phrase = r } end
    error("stub can't decode")
  end }
end
package.preload["logger"] = function()
  local l = {}
  function l:info(m) logs[#logs + 1] = "INFO " .. m end
  function l:warn(m) logs[#logs + 1] = "WARN " .. m end
  function l:error(m) logs[#logs + 1] = "ERROR " .. m end
  return l
end
package.preload["millennium"] = function()
  return {
    ready = function() return true end,
    version = function() return "3.6.2" end,
    config = {
      get = function(k) return config[k] end,
      set = function(k, v) config[k] = v; return true end,
    },
  }
end
package.preload["http"] = function()
  return { request = function(url, opts)
    http_calls[#http_calls + 1] = { url = url, opts = opts }
    local r = table.remove(http_queue, 1) or { status = 200, body = "{}" }
    if r.fail then return nil, r.fail end
    return r
  end }
end

-- The log file goes to the current folder (via MILLENNIUM__LOGS_PATH).
local LOG_FILE = "./price-history.log"
local created_dirs = {}
os.remove(LOG_FILE)
os.remove("./price-history.old.log")
package.preload["utils"] = function()
  return { getenv = function(name) if name == "MILLENNIUM__LOGS_PATH" then return "." end return nil end }
end
package.preload["fs"] = function()
  return {
    create_directories = function(p) created_dirs[#created_dirs + 1] = p; return false end,
    file_size = function(p)
      local f = io.open(p, "rb")
      if not f then return nil, "missing" end
      local n = f:seek("end"); f:close(); return n
    end,
    remove = function(p) return os.remove(p) ~= nil end,
    rename = function(a, b) return os.rename(a, b) ~= nil end,
  }
end

local mod = dofile(arg[1])
mod.on_load()

local failures, count = 0, 0
local function eq(name, got, want)
  count = count + 1
  if got ~= want then
    failures = failures + 1
    print(("FAIL %s\n  got:  %s\n  want: %s"):format(name, tostring(got), tostring(want)))
  end
end

-- settings
eq("default settings", get_settings(), '{"detected":"","has_key":false,"region":"","wait_days":30}')
eq("set region lowercase", set_region("vn"), "")
eq("region stored upper", config.region, "VN")
eq("bad region", set_region("xyz"), "region must be empty or a two-letter country code")
eq("clear region", set_region(""), "")
eq("wait ok", set_wait_days(61), "")
eq("wait bad", set_wait_days(45), "not one of the choices")
eq("detected bad", set_detected_country("x1"), false)
eq("detected ok", set_detected_country("CA"), true)
eq("settings after", get_settings(), '{"detected":"CA","has_key":false,"region":"","wait_days":61}')

-- requests
eq("url not allowed", http_json("https://evil.example/api", ""), '{"error":"URL not allowed"}')
eq("lookalike host", http_json("https://api.isthereanydeal.com.evil.org/x", ""), '{"error":"URL not allowed"}')
eq("itad without key", http_json("https://api.isthereanydeal.com/games/lookup/v1?appid=1", ""), '{"error":"no IsThereAnyDeal API key"}')
eq("no http call yet", #http_calls, 0)

http_queue = { { status = 200, body = '{"ok":1}' } }
local steam = "https://store.steampowered.com/api/appdetails?appids=1&cc=ca"
eq("steam GET", http_json(steam, ""), '{"body":"{\\u0022ok\\u0022:1}","status":200}')
eq("steam no key header", http_calls[1].opts.headers["ITAD-API-Key"], nil)
eq("steam method default", http_calls[1].opts.method, nil)
http_json(steam, "")
eq("steam cached", #http_calls, 1)

eq("save key trims", set_api_key("  abc123 "), "")
eq("key stored", config.itad_api_key, "abc123")
http_queue = { { status = 200, body = "[]" } }
local itad = "https://api.isthereanydeal.com/games/prices/v3?country=CA&shops=61"
http_json(itad, '["id"]')
local c = http_calls[#http_calls]
eq("itad key header", c.opts.headers["ITAD-API-Key"], "abc123")
eq("itad POST", c.opts.method, "POST")
eq("itad body", c.opts.data, '["id"]')
eq("itad content type", c.opts.headers["Content-Type"], "application/json")

http_queue = { { status = 429, body = "{}" } }
local hist = "https://api.isthereanydeal.com/games/history/v2?x"
eq("429 passed through", http_json(hist, ""), '{"body":"{}","status":429}')
http_queue = { { status = 200, body = "[]" } }
local before = #http_calls
http_json(hist, "")
eq("non-200 not cached", #http_calls, before + 1)

http_queue = { { fail = "timeout" } }
eq("network failure", http_json("https://api.isthereanydeal.com/games/lookup/v1?appid=9", ""), '{"error":"timeout"}')

before = #http_calls
set_api_key("newkey")
http_queue = { { status = 200, body = "{}" } }
http_json(steam, "")
eq("cache cleared on key change", #http_calls, before + 1)

-- key test
http_queue = { { status = 403, body = '{"status_code":403,"reason_phrase":"Forbidden"}' } }
eq("test key 403", test_api_key("bad"), "HTTP 403 (Forbidden)")
eq("test key used given key", http_calls[#http_calls].opts.headers["ITAD-API-Key"], "bad")
http_queue = { { status = 200, body = "{}" } }
eq("test key ok", test_api_key("good"), "")
eq("test key empty", test_api_key("  "), "empty key")
eq("saved key unchanged by test", config.itad_api_key, "newkey")

-- checks
eq("no problems", get_problems(), "[]")
report_check("Thing A", false, "gone")
report_check("Thing A", false, "gone")
eq("problem listed", get_problems(), '["Thing A: gone"]')
report_check("Thing A", true, "")
eq("problem cleared", get_problems(), "[]")
local fails, oks = 0, 0
for _, l in ipairs(logs) do
  if l:find("[FAIL] Thing A", 1, true) then fails = fails + 1 end
  if l:find("[OK] Thing A", 1, true) then oks = oks + 1 end
end
eq("fail logged once", fails, 1)
eq("ok logged once", oks, 1)
eq("log levels", (log("warning", "w") and logs[#logs]), "WARN w")

-- cache bound: 300+ distinct successful URLs never grow past the cap
for i = 1, 650 do
  http_queue = { { status = 200, body = "{}" } }
  http_json(steam .. "&n=" .. i, "")
end
before = #http_calls
http_json(steam .. "&n=650", "")
eq("newest entry still cached", #http_calls, before)
http_json(steam .. "&n=1", "")
eq("oldest entry evicted (cache is bounded)", #http_calls, before + 1)

-- log file
local function read_log()
  local f = io.open(LOG_FILE, "rb")
  if not f then return "" end
  local s = f:read("*a"); f:close(); return s
end
eq("log folder created", created_dirs[1], ".")
local text = read_log()
eq("load line in file", text:find("INFO Price History backend loaded", 1, true) ~= nil, true)
eq("failed check in file", text:find("ERROR [FAIL] Thing A: gone", 1, true) ~= nil, true)
eq("warning level in file", text:find("WARN w", 1, true) ~= nil, true)
eq("api key itself never logged", text:find("abc123", 1, true), nil)
log("info", "two\nlines")
eq("newlines flattened", read_log():find("INFO two lines\n", 1, true) ~= nil, true)
-- Rotation: past 1 MB the file moves to price-history.old.log.
local f = io.open(LOG_FILE, "ab"); f:write(string.rep("x", 1024 * 1024 + 1)); f:close()
log("info", "after rotation")
local old = io.open("./price-history.old.log", "rb")
eq("old log kept", old ~= nil, true)
if old then old:close() end
eq("new log starts fresh", read_log():match("^%S+ %S+ INFO after rotation\n$") ~= nil, true)
os.remove(LOG_FILE)
os.remove("./price-history.old.log")

print(("%d/%d passed"):format(count - failures, count))
os.exit(failures == 0 and 0 or 1)
