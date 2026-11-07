// Values used by both the store-page script (webview/) and the settings panel
// (frontend/).

import { decodeBackendJson } from "./backend-json";

export const PLUGIN_NAME = "Price History";
export const ITAD_APPS_URL = "https://isthereanydeal.com/apps/my/";

// Regions for the override dropdown: every Steam store currency, plus the
// larger countries that share one (names only; the dialog shows the currency).
export const REGIONS: [code: string, name: string][] = [
  ["AR", "Argentina"], ["AU", "Australia"], ["AT", "Austria"], ["BE", "Belgium"], ["BR", "Brazil"],
  ["CA", "Canada"], ["CL", "Chile"], ["CN", "China"], ["CO", "Colombia"], ["CR", "Costa Rica"],
  ["CZ", "Czechia"], ["DK", "Denmark"], ["FI", "Finland"], ["FR", "France"], ["DE", "Germany"],
  ["GR", "Greece"], ["HK", "Hong Kong"], ["HU", "Hungary"], ["IN", "India"], ["ID", "Indonesia"],
  ["IE", "Ireland"], ["IL", "Israel"], ["IT", "Italy"], ["JP", "Japan"], ["KZ", "Kazakhstan"],
  ["KW", "Kuwait"], ["MY", "Malaysia"], ["MX", "Mexico"], ["NL", "Netherlands"], ["NZ", "New Zealand"],
  ["NO", "Norway"], ["PE", "Peru"], ["PH", "Philippines"], ["PL", "Poland"], ["PT", "Portugal"],
  ["QA", "Qatar"], ["RO", "Romania"], ["SA", "Saudi Arabia"], ["SG", "Singapore"], ["ZA", "South Africa"],
  ["KR", "South Korea"], ["ES", "Spain"], ["SE", "Sweden"], ["CH", "Switzerland"], ["TW", "Taiwan"],
  ["TH", "Thailand"], ["TR", "Turkey"], ["UA", "Ukraine"], ["AE", "United Arab Emirates"],
  ["GB", "United Kingdom"], ["US", "United States"], ["UY", "Uruguay"], ["VN", "Vietnam"],
];

// Regions where ITAD's Steam history isn't in the local currency, so past
// prices are estimated from discounts (checked against ITAD on 2026-11-06;
// the plugin detects this itself at runtime, this only labels the dropdown).
export const ESTIMATED_REGIONS = new Set([
  "CL", "CO", "CR", "HK", "IL", "KZ", "KW", "MY", "MX", "NO", "PE",
  "QA", "SA", "SG", "ZA", "CH", "TH", "UA", "AE", "UY", "VN",
]);

// "Willing to wait" choices, in days (the page has matching sentence labels,
// and backend/main.lua accepts only these).
export const WAIT_CHOICES = [
  { days: 14, label: "2 weeks" },
  { days: 30, label: "1 month" },
  { days: 61, label: "2 months" },
  { days: 91, label: "3 months" },
  { days: 182, label: "6 months" },
];

export interface Settings {
  region: string; // "" = automatic
  wait_days: number;
  has_key: boolean;
  detected: string; // store country last seen on a store page, "" = none yet
}

// backend.get_settings() answer, with safe defaults for anything missing.
export function parseSettings(text: unknown): Settings {
  let s: any = {};
  try {
    s = decodeBackendJson(text) ?? {};
  } catch {
    /* keep defaults */
  }
  return {
    region: typeof s.region === "string" ? s.region : "",
    wait_days: typeof s.wait_days === "number" ? s.wait_days : 30,
    has_key: s.has_key === true,
    detected: typeof s.detected === "string" ? s.detected : "",
  };
}
