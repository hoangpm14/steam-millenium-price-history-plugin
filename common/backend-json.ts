// Millennium can decode JSON returned by Lua before delivering the FFI result.
// Accept both decoded values and the JSON strings used by other host versions.
export function decodeBackendJson(value: unknown): any {
  return typeof value === "string" ? JSON.parse(value) : value;
}
