-- Price History backend (runs natively next to Steam, in Millennium's Lua host).
--
-- The store-page script (webview/) and the settings panel (frontend/) call the
-- functions marked ---@ffi below as backend.<name>(...). They:
-- - store the settings (IsThereAnyDeal API key, region override, "willing to
--   wait") in Millennium's config for this plugin
-- - fetch prices from IsThereAnyDeal and Steam's appdetails API for the page,
--   adding the API key here so it never reaches the web page, and caching
--   answers for 10 minutes (IsThereAnyDeal allows 100 requests per 5 minutes)
-- - write log lines and self-check results to Millennium's logger and to the
--   plugin's own price-history.log in Millennium's log folder
--
-- FFI values are kept to strings, numbers and booleans; anything structured
-- is sent as a JSON string.

local logger     = require("logger")
local millennium = require("millennium")
local http       = require("http")
local json       = require("json")
local fs         = require("fs")
local utils      = require("utils")

local ITAD = "https://api.isthereanydeal.com/"
local CACHE_SECONDS = 10 * 60
local CACHE_MAX = 300
-- "Willing to wait" choices for the sale guess, in days (see common/constants.ts).
local WAIT_CHOICES = { [14] = true, [30] = true, [61] = true, [91] = true, [182] = true }
local DEFAULT_WAIT_DAYS = 30
local LOG_NAME = "price-history.log"
local LOG_MAX_BYTES = 1024 * 1024 -- then it's moved to price-history.old.log

-- ---- log file -----------------------------------------------------------------
-- Millennium (checked in 3.6.2) keeps a plugin's logger lines only in its
-- in-app log viewer, not on disk, so this plugin also writes its own file in
-- Millennium's log folder (Windows: <Steam>\millennium\logs; Linux:
-- ~/.local/state/millennium/logs). Logging must never break the plugin, so
-- every file operation is allowed to fail quietly.

local function env(name)
    local ok, value = pcall(utils.getenv, name)
    if ok and type(value) == "string" and value ~= "" then return value end
    return nil
end

local function logs_dir()
    local dir = env("MILLENNIUM__LOGS_PATH")
    if dir then return dir end
    if package.config:sub(1, 1) == "\\" then -- Windows: next to millennium\plugins
        local ok, install = pcall(millennium.get_install_path)
        if ok and type(install) == "string" and install ~= "" then return install .. "/logs" end
        return nil
    end
    local state = env("XDG_STATE_HOME") or (env("HOME") and env("HOME") .. "/.local/state")
    return state and (state .. "/millennium/logs") or nil
end

local log_path = nil -- nil = not looked up yet, false = no usable folder

local function append_to_file(level, message)
    if log_path == nil then
        log_path = false
        local ok, dir = pcall(logs_dir)
        if ok and dir then
            pcall(fs.create_directories, dir)
            log_path = dir .. "/" .. LOG_NAME
        end
    end
    if not log_path then return end
    local ok, size = pcall(fs.file_size, log_path)
    if ok and type(size) == "number" and size > LOG_MAX_BYTES then
        local old = (log_path:gsub("%.log$", ".old.log"))
        pcall(fs.remove, old)
        pcall(fs.rename, log_path, old)
    end
    local f = io.open(log_path, "ab") -- binary: "\n" on every OS, not "\r\n" on Windows
    if not f then return end
    f:write(os.date("%Y-%m-%d %H:%M:%S"), " ", level, " ", (message:gsub("[\r\n]+", " ")), "\n")
    f:close()
end

-- Writes to Millennium's logger (its in-app log viewer) and to the log file.
local function write(level, message)
    message = tostring(message or ""):sub(1, 2000)
    if level == "error" then logger:error(message)
    elseif level == "warning" then logger:warn(message)
    else logger:info(message) end
    pcall(append_to_file, level == "error" and "ERROR" or level == "warning" and "WARN" or "INFO", message)
end

-- ---- settings ---------------------------------------------------------------

local function config_string(key)
    local ok, value = pcall(millennium.config.get, key)
    if ok and type(value) == "string" then return value end
    return ""
end

local function config_set(key, value)
    local ok, result, err = pcall(millennium.config.set, key, value)
    if not ok then return tostring(result) end
    if result == false then return tostring(err or "couldn't save the setting") end
    return ""
end

local function valid_region(region)
    return region == "" or (#region == 2 and region:match("^%u%u$") ~= nil)
end

local function wait_days()
    local ok, days = pcall(millennium.config.get, "wait_days")
    if ok and type(days) == "number" and WAIT_CHOICES[days] then return days end
    return DEFAULT_WAIT_DAYS
end

local function region()
    local r = config_string("region")
    return valid_region(r) and r or ""
end

---@ffi
--- Settings for the page and panel, as JSON:
--- { region = "" | "VN", wait_days = 30, has_key = true, detected = "CA" | "" }
---@return string
function get_settings()
    return json.encode({
        region = region(),
        wait_days = wait_days(),
        has_key = config_string("itad_api_key") ~= "",
        detected = config_string("detected_country"),
    })
end

---@ffi
--- The saved IsThereAnyDeal API key (for the settings panel only).
---@return string
function get_api_key()
    return config_string("itad_api_key")
end

-- Answers cached by request; cleared when the key changes.
local cache = {}
local cache_size = 0

local function clear_cache()
    cache = {}
    cache_size = 0
end

---@ffi
--- Saves the API key ("" removes it). Returns "" or why it failed.
---@param key string
---@return string
function set_api_key(key)
    key = tostring(key or ""):match("^%s*(.-)%s*$")
    local err = config_set("itad_api_key", key)
    if err ~= "" then return err end
    clear_cache()
    write("info", "IsThereAnyDeal API key " .. (key ~= "" and "saved" or "cleared"))
    return ""
end

---@ffi
--- Region override: "" = the region detected from the store page, else a
--- two-letter country code. Returns "" or why it failed.
---@param value string
---@return string
function set_region(value)
    value = tostring(value or ""):upper()
    if not valid_region(value) then return "region must be empty or a two-letter country code" end
    return config_set("region", value)
end

---@ffi
--- Returns "" or why it failed.
---@param days number
---@return string
function set_wait_days(days)
    if not WAIT_CHOICES[days] then return "not one of the choices" end
    return config_set("wait_days", days)
end

---@ffi
--- The store page reports the account's store country, so the panel can show
--- "Automatic (Canada)". Only written when it changes.
---@param country string
---@return boolean
function set_detected_country(country)
    country = tostring(country or "")
    if not country:match("^%u%u$") then return false end
    if config_string("detected_country") ~= country then config_set("detected_country", country) end
    return true
end

-- ---- web requests -------------------------------------------------------------

local function cache_get(key)
    local hit = cache[key]
    if hit and os.time() - hit.at < CACHE_SECONDS then return hit.result end
    return nil
end

local function cache_put(key, result)
    if cache_size >= CACHE_MAX then
        -- Drop expired entries; if that's not enough, start over.
        local now = os.time()
        for k, v in pairs(cache) do
            if now - v.at >= CACHE_SECONDS then
                cache[k] = nil
                cache_size = cache_size - 1
            end
        end
        if cache_size >= CACHE_MAX then clear_cache() end
    end
    if not cache[key] then cache_size = cache_size + 1 end
    cache[key] = { at = os.time(), result = result }
end

local function request(url, body, key)
    local headers = {}
    if key then headers["ITAD-API-Key"] = key end
    local options = { headers = headers, timeout = 20, user_agent = "PriceHistoryMillenniumPlugin/1.0" }
    if body ~= "" then
        options.method = "POST"
        options.data = body
        headers["Content-Type"] = "application/json"
    end
    return http.request(url, options)
end

---@ffi
--- Fetches a URL for the store page and returns JSON:
--- { status = 200, body = "<response text>" } or { error = "<why>" }.
--- Only IsThereAnyDeal's API (the key is added here) and Steam's appdetails
--- API are allowed. body = "" sends a GET, otherwise a JSON POST.
---@param url string
---@param body string
---@return string
function http_json(url, body)
    url = tostring(url or "")
    body = tostring(body or "")
    local is_itad = url:sub(1, #ITAD) == ITAD
    local is_steam = url:match("^https://store%.steampowered%.com/api/appdetails%?") ~= nil
    if not is_itad and not is_steam then
        return json.encode({ error = "URL not allowed" })
    end
    local cache_key = url .. "\n" .. body
    local cached = cache_get(cache_key)
    if cached then return cached end

    local key = nil
    if is_itad then
        key = config_string("itad_api_key")
        if key == "" then return json.encode({ error = "no IsThereAnyDeal API key" }) end
    end
    local ok, res, err = pcall(request, url, body, key)
    if not ok then return json.encode({ error = tostring(res) }) end
    if not res then return json.encode({ error = tostring(err or "request failed") }) end
    local result = json.encode({ status = res.status, body = res.body or "" })
    -- Only remember complete answers, so a network hiccup isn't cached.
    if res.status == 200 then cache_put(cache_key, result) end
    return result
end

---@ffi
--- Quick check that a key works, before saving it. Returns "" or the problem.
---@param key string
---@return string
function test_api_key(key)
    key = tostring(key or ""):match("^%s*(.-)%s*$")
    if key == "" then return "empty key" end
    local ok, res, err = pcall(request, ITAD .. "games/lookup/v1?appid=620", "", key)
    if not ok then return tostring(res) end
    if not res then return tostring(err or "request failed") end
    if res.status == 200 then return "" end
    local reason = ""
    local parsed_ok, parsed = pcall(json.decode, res.body or "")
    if parsed_ok and type(parsed) == "table" and type(parsed.reason_phrase) == "string" then
        reason = " (" .. parsed.reason_phrase .. ")"
    end
    return "HTTP " .. tostring(res.status) .. reason
end

-- ---- logging and self-checks --------------------------------------------------
-- Steam updates can break the things this plugin relies on (the store page's
-- layout and config, Steam's APIs). Each of those is checked where it's used
-- (common/health.ts) and reported here; a result is logged when it changes,
-- and failed checks are listed in the settings panel.

local checks = {}

---@ffi
---@param level string
---@param message string
---@return boolean
function log(level, message)
    write(level, message)
    return true
end

---@ffi
---@param name string
---@param ok boolean
---@param detail string
---@return boolean
function report_check(name, ok, detail)
    name = tostring(name or "")
    detail = tostring(detail or "")
    local previous = checks[name]
    if not previous or previous.ok ~= ok then
        if ok then write("info", "[OK] " .. name)
        else write("error", "[FAIL] " .. name .. (detail ~= "" and (": " .. detail) or "")) end
    end
    checks[name] = { ok = ok, detail = detail }
    return true
end

---@ffi
--- Failed checks as a JSON array of strings.
---@return string
function get_problems()
    local list = {}
    for name, r in pairs(checks) do
        if not r.ok then list[#list + 1] = r.detail ~= "" and (name .. ": " .. r.detail) or name end
    end
    if #list == 0 then return "[]" end
    table.sort(list)
    return json.encode(list)
end

-- ---- lifecycle ----------------------------------------------------------------

local function on_load()
    write("info", "Price History backend loaded (Millennium " .. tostring(millennium.version()) .. ")")
    millennium.ready()
end

local function on_unload()
    write("info", "Price History backend unloaded")
end

return {
    on_load = on_load,
    on_unload = on_unload,
}
