// Fetches a game's prices for the dialog.
//
// - Current price: Steam's own store API (no key needed).
// - History, lowest price, sale end date: IsThereAnyDeal (ITAD), filtered to
//   the Steam shop in your Steam store country. ITAD needs a free API key,
//   see README.md.
//
// Requests go through the plugin's backend (backend.http_json in
// backend/main.lua), which adds the ITAD key there (so the key never reaches
// the web page), avoids the browser's cross-site (CORS) checks and caches
// answers for 10 minutes.
//
// The country is your Steam account's store country, which the store page
// tells us (see page.ts); prices come in that country's Steam currency.

import { parseSettings } from "../common/constants";
import { decodeBackendJson } from "../common/backend-json";
import { check, log } from "../common/health";

const ITAD = "https://api.isthereanydeal.com";
const ITAD_STEAM_SHOP = 61;
const SETTINGS_HINT = "Steam menu → Millennium Library Manager → Price History";

export interface PricePoint {
  t: number; // time of the change, ms since 1970
  price: number;
  regular: number;
  cut: number; // discount percent, 0 = none
}

// How Steam writes a price in this currency, read from one of its own price
// strings, e.g. "CDN$ 12.99" → prefix "CDN$ ", "12,99€" → suffix "€" with a
// decimal comma, "₩ 12,000" → no decimals.
export interface PriceFormat {
  prefix: string;
  suffix: string;
  decimals: number;
  decimalSep: string;
  thousandsSep: string;
}

export interface PriceData {
  appId: string;
  country: string; // two-letter Steam store country, e.g. "CA"
  currency: string; // e.g. "CAD"
  format: PriceFormat | null; // how Steam writes prices in this currency; null = use the browser's
  steam: { free: boolean; final: number | null; initial: number | null; discount: number } | null;
  dealEnds: number | null;
  low: { price: number; cut: number; t: number | null } | null;
  history: PricePoint[] | null; // oldest first
  historyError: string | null; // why there's no history, shown in the dialog
  waitDays: number; // the "willing to wait" setting, for the sale guess
  // Set when ITAD has no history in this region's currency: past prices are
  // then estimated from the discounts in its history in `from` (e.g. "USD").
  estimated: { from: string } | null;
}

// GET (no body) or JSON POST through the backend; returns the parsed JSON.
async function getJson(url: string, body?: unknown): Promise<any> {
  const answer = await backend.http_json(url, body === undefined ? "" : JSON.stringify(body));
  let res: any;
  try {
    res = decodeBackendJson(answer);
  } catch {
    throw new Error("bad answer from the plugin's backend");
  }
  if (res?.error) throw new Error(String(res.error));
  let json: any = null;
  try {
    json = JSON.parse(res.body);
  } catch {
    /* not JSON */
  }
  if (res.status !== 200) {
    const reason = json?.reason_phrase ?? "";
    throw new Error(`HTTP ${res.status}${reason ? ` (${reason})` : ""}`);
  }
  if (json === null) throw new Error("answer wasn't JSON");
  return json;
}

const itadJson = (path: string, body?: unknown) => getJson(`${ITAD}${path}`, body);

// Works out a PriceFormat from Steam's text for a price and its value in
// cents. Returns null if the text doesn't look like that price.
export function parsePriceFormat(text: string, cents: number): PriceFormat | null {
  const m = text.match(/\d(?:[\d.,'\s  ]*\d)?/);
  if (!m || m.index === undefined) return null;
  const prefix = text.slice(0, m.index);
  let suffix = text.slice(m.index + m[0].length);
  const num = m[0];
  const digits = num.replace(/\D/g, "");
  const seps = num.replace(/\d/g, "");
  // Thousands separator: the one Steam used, "" if it wrote a 4+ digit number
  // without one (e.g. "3599 руб."), or a guess for short prices.
  const thousandsOf = (wholeDigits: number, found: string | undefined, guess: string) =>
    found ?? (wholeDigits >= 4 ? "" : guess);
  // Euro prices with no cents are written "20,--€".
  const dashes = suffix.match(/^([.,])--/);
  if (dashes && digits === String(cents / 100)) {
    suffix = suffix.slice(3);
    return { prefix, suffix, decimals: 2, decimalSep: dashes[1], thousandsSep: thousandsOf(digits.length, seps[0], dashes[1] === "," ? "." : ",") };
  }
  if (digits === String(cents)) {
    const decimalSep = num[num.length - 3];
    if (!decimalSep || /\d/.test(decimalSep)) return null;
    const thousands = num.slice(0, -3).replace(/\d/g, "");
    return { prefix, suffix, decimals: 2, decimalSep, thousandsSep: thousandsOf(digits.length - 2, thousands[0], decimalSep === "," ? "." : ",") };
  }
  if (cents % 100 === 0 && digits === String(cents / 100)) {
    return { prefix, suffix, decimals: 0, decimalSep: ".", thousandsSep: thousandsOf(digits.length, seps[0], ",") };
  }
  return null;
}

async function steamPrice(appId: string, country: string) {
  // "basic" adds is_free (and some text we ignore); price_overview is the price.
  const json = await getJson(
    `https://store.steampowered.com/api/appdetails?appids=${appId}&cc=${country.toLowerCase()}&filters=basic,price_overview`
  );
  const entry = json?.[appId];
  if (!entry?.success) return null;
  const p = entry.data?.price_overview;
  // No price_overview: free, or not sold on its own (e.g. only in bundles).
  if (!p) return { price: { free: entry.data?.is_free === true, final: null, initial: null, discount: 0 }, currency: "", format: null };
  const finalCents = Number(p.final);
  const initialCents = Number(p.initial);
  if (!isFinite(finalCents) || !isFinite(initialCents)) return null;
  const price = { free: false, final: finalCents / 100, initial: initialCents / 100, discount: Math.round(Number(p.discount_percent) || 0) };
  const format =
    parsePriceFormat(String(p.final_formatted ?? ""), finalCents) ??
    (p.initial_formatted ? parsePriceFormat(String(p.initial_formatted), initialCents) : null);
  return { price, currency: String(p.currency ?? ""), format };
}

async function itadData(appId: string, country: string) {
  const lookup = await itadJson(`/games/lookup/v1?appid=${appId}`);
  const id = lookup?.found ? (lookup.game?.id as string) : null;
  if (!id) return null;
  const q = `country=${country}&shops=${ITAD_STEAM_SHOP}`;
  const [history, lows, prices] = await Promise.all([
    itadJson(`/games/history/v2?${q}&id=${id}&since=2000-01-01T00:00:00Z`),
    itadJson(`/games/storelow/v2?${q}`, [id]),
    itadJson(`/games/prices/v3?${q}`, [id]),
  ]);

  // Each entry carries its own currency: some regions changed currency
  // (e.g. Steam Turkey went from lira to US dollars in 2023), so the history
  // can mix them. Keep only the newest currency; ITAD lists newest first.
  // Everything from ITAD is checked to be a real number here: these values
  // end up in the dialog's HTML on the store page.
  const entries = (Array.isArray(history) ? history : []).filter((h: any) => h?.deal?.price); // deal null = not sold then
  const currency = String(entries[0]?.deal.price.currency ?? "");
  const points: PricePoint[] = entries
    .filter((h: any) => h.deal.price.currency === currency)
    .map((h: any) => ({
      t: Date.parse(h.timestamp),
      price: Number(h.deal.price.amount),
      regular: Number(h.deal.regular?.amount),
      cut: Math.round(Number(h.deal.cut) || 0),
    }))
    .filter((p: PricePoint) => isFinite(p.t) && isFinite(p.price) && p.cut >= 0 && p.cut <= 100);
  points.sort((a, b) => a.t - b.t);

  const l = (lows as any[])?.[0]?.lows?.find((x: any) => x.shop?.id === ITAD_STEAM_SHOP);
  const lowPrice = Number(l?.price?.amount);
  const lowTime = l?.timestamp ? Date.parse(l.timestamp) : NaN;
  let low = l && l.price?.currency === currency && isFinite(lowPrice)
    ? { price: lowPrice, cut: Math.round(Number(l.cut) || 0), t: isFinite(lowTime) ? lowTime : null }
    : null;
  // ITAD's lowest price was in an older currency: use the lowest in this one.
  if (l && !low && points.length) {
    const p = points.reduce((a, b) => (b.price <= a.price ? b : a));
    low = { price: p.price, cut: p.cut, t: p.t };
  }
  // ITAD dates the lowest price by its first time; when it came back in later
  // sales, show the most recent one.
  if (low) {
    const latest = [...points].reverse().find((p) => Math.abs(p.price - low!.price) < 0.005);
    if (latest && (low.t === null || latest.t > low.t)) low = { ...low, cut: latest.cut, t: latest.t };
  }
  const deal = (prices as any[])?.[0]?.deals?.find((x: any) => x.shop?.id === ITAD_STEAM_SHOP);
  const expiry = deal?.expiry ? Date.parse(deal.expiry) : NaN;
  const dealEnds = isFinite(expiry) ? expiry : null;
  return { points, low, dealEnds, currency: currency || String(l?.price?.currency ?? deal?.price?.currency ?? "") };
}

// The store page asked for a game's prices. `pageCountry` is the store
// country the page reported ("" if it couldn't).
export async function loadPrices(appId: string, pageCountry: string): Promise<PriceData> {
  const settings = parseSettings(await backend.get_settings());
  let country = pageCountry.toUpperCase();
  if (
    check(
      "Store country from the store page (#application_config)",
      /^[A-Z]{2}$/.test(country),
      "using US prices instead (a region can be chosen in the plugin's settings)"
    )
  ) {
    if (country !== settings.detected) backend.set_detected_country(country).catch(() => {});
  } else {
    country = "US";
  }
  // A region chosen in the plugin's settings wins over the detected one.
  if (/^[A-Z]{2}$/.test(settings.region)) country = settings.region;
  try {
    return await getPriceData(appId, country, settings.has_key, settings.wait_days);
  } catch (e) {
    log("error", `loading prices for app ${appId} (${country}) failed: ${e}`);
    throw e;
  }
}

async function getPriceData(appId: string, country: string, hasKey: boolean, waitDays: number): Promise<PriceData> {
  const [steamRes, itadRes] = await Promise.allSettled([
    steamPrice(appId, country),
    hasKey ? itadData(appId, country) : Promise.resolve(undefined),
  ]);

  check(
    "Steam store price lookup (store.steampowered.com/api/appdetails)",
    steamRes.status === "fulfilled",
    steamRes.status === "rejected" ? `app ${appId} (${country}): ${steamRes.reason?.message ?? steamRes.reason}` : ""
  );
  const steamInfo = steamRes.status === "fulfilled" ? steamRes.value : null;
  const steam = steamInfo?.price ?? null;
  let itad = itadRes.status === "fulfilled" ? itadRes.value : undefined;
  let historyError: string | null = null;
  if (!hasKey) {
    historyError = `To see the price history, add a free IsThereAnyDeal API key: ${SETTINGS_HINT}.`;
  } else if (itadRes.status === "rejected") {
    const msg = String(itadRes.reason?.message ?? itadRes.reason);
    historyError = msg.includes("403") || msg.includes("401")
      ? `IsThereAnyDeal didn't accept the API key (${msg}). Check it in the plugin's settings (${SETTINGS_HINT}).`
      : msg.includes("429")
        ? "Too many price lookups in the last few minutes (IsThereAnyDeal allows 100 per 5 minutes). Try again shortly."
        : `Couldn't load the price history from IsThereAnyDeal (${msg}).`;
  } else if (itad === null) {
    historyError = "IsThereAnyDeal has no price history for this game.";
  } else if (itad && !itad.points.length) {
    historyError = `IsThereAnyDeal has no Steam price history for this game in your region (${country}).`;
  }

  // ITAD doesn't track every Steam currency (e.g. for Vietnam it only has US
  // dollar prices). Prices in two currencies can't be compared, but Steam
  // sales mostly run on the same dates with the same discount everywhere, so
  // keep the dates and discounts and apply them to this region's full price.
  // Every comparison (lowest price, verdict) then works on discounts.
  let estimated: PriceData["estimated"] = null;
  if (itad && itad.points.length && steamInfo?.currency && itad.currency && itad.currency !== steamInfo.currency) {
    const full = steam?.initial ?? null;
    if (full) {
      estimated = { from: itad.currency };
      const at = (cut: number) => full * (1 - cut / 100);
      itad = {
        ...itad,
        currency: steamInfo.currency,
        points: itad.points.map((p: PricePoint) => ({ ...p, price: at(p.cut), regular: full })),
        low: itad.low ? { ...itad.low, price: at(itad.low.cut) } : null,
      };
    } else {
      historyError =
        `IsThereAnyDeal has no history in ${steamInfo.currency} for your region (${country}), ` +
        `only in ${itad.currency}, so it can't be compared.`;
      itad = { ...itad, points: [], low: null, dealEnds: null };
    }
  }

  const currency = steamInfo?.currency || itad?.currency || "";
  return {
    appId,
    country,
    currency,
    format: steamInfo?.format ?? null,
    steam,
    dealEnds: itad?.dealEnds ?? null,
    low: itad?.low ?? null,
    history: itad?.points.length ? itad.points : null,
    historyError,
    waitDays,
    estimated,
  };
}
