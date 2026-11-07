// The button, dialog and chart on Steam store game pages.
//
// Millennium runs preload.ts (which calls pageScript) in every Steam web page,
// in a separate JavaScript "world": it shares the page's HTML but not its
// variables. What it does:
// - adds a floating "Price History" button on store.steampowered.com/app/<id>
// - when clicked, opens a dialog in "Loading…" state and calls
//   cfg.requestPrices (prices.ts, which asks the plugin's backend)
// - fills the dialog with the price table and chart when the data arrives
//
// Ported from the Decky plugin's src/page.ts; the dialog code is unchanged
// apart from desktop wording and sizes.

import type { PriceData } from "./prices";

export interface PageConfig {
  buttonId: string;
  overlayId: string;
  stateKey: string; // global the script keeps its state in
  requestPrices: (appId: string, country: string) => Promise<PriceData>;
}

export function pageScript(cfg: PageConfig) {
  const w = window as any;
  // Only the page itself, not frames inside it (videos, widgets).
  if (w.top !== w) return;
  // Already running (e.g. the script was loaded twice): undo the old copy
  // first, so the newest code is the one in use.
  if (w[cfg.stateKey]) {
    try {
      w[cfg.stateKey].destroy();
    } catch (e) {
      /* old version without destroy */
    }
  }

  const CHART_W = 600;
  const CHART_H = 200;
  const PAD = { l: 8, r: 44, t: 10, b: 24 };
  const RANGES: [string, number][] = [
    ["6m", 6],
    ["1y", 12],
    ["2y", 24],
    ["All", 0],
  ];
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  // How the "willing to wait" choices read in a sentence ("within a month").
  const WAIT_LABELS: Record<number, string> = { 14: "2 weeks", 30: "a month", 61: "2 months", 91: "3 months", 182: "6 months" };
  const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

  let currentAppId: string | null = null;
  let requestTimer: number | null = null;
  let requestCount = 0;

  const esc = (s: any) =>
    String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
  // A price written the way Steam writes it for this currency (e.g.
  // "CDN$ 12.99", "12,99€"), or the browser's own format if we don't know it.
  const money = (data: PriceData, n: number | null | undefined) => {
    if (n === null || n === undefined) return "—";
    const f = data.format;
    if (!f) {
      try {
        return new Intl.NumberFormat(undefined, { style: "currency", currency: data.currency }).format(n);
      } catch {
        return n.toFixed(2);
      }
    }
    const [whole, frac] = n.toFixed(f.decimals).split(".");
    const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, f.thousandsSep);
    return f.prefix + grouped + (frac ? f.decimalSep + frac : "") + f.suffix;
  };
  // The Steam account's store country, which the store puts in its page
  // config (e.g. "CA"). Falls back to the store's own country setting.
  const storeCountry = () => {
    const el = document.getElementById("application_config");
    for (const [attr, key] of [["data-userinfo", "country_code"], ["data-config", "COUNTRY"]]) {
      try {
        const v = JSON.parse(el?.getAttribute(attr) || "{}")[key];
        if (typeof v === "string" && /^[A-Za-z]{2}$/.test(v)) return v.toUpperCase();
      } catch {
        /* missing or not JSON */
      }
    }
    return "";
  };
  const shortDate = (t: number) => {
    const d = new Date(t);
    return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
  };
  const longDate = (t: number) => {
    const d = new Date(t);
    return `${DAYS[d.getDay()]}, ${MONTHS[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
  };
  const ago = (t: number) => {
    const days = Math.floor((Date.now() - t) / 86400000);
    if (days < 1) return "today";
    if (days < 60) return `${days} day${days === 1 ? "" : "s"} ago`;
    const months = Math.round(days / 30.4);
    if (months < 24) return `${months} months ago`;
    return `${Math.round(days / 365)} years ago`;
  };

  // Today's price for comparing with the history. In regions where past prices
  // are estimated (full price × (1 − discount)), today's price goes through
  // the same formula, so Steam's rounding of real sale prices can't make an
  // equal discount look worse than the estimate.
  const comparablePrice = (data: PriceData) => {
    const s = data.steam;
    if (!s || s.final === null) return null;
    return data.estimated && s.initial ? s.initial * (1 - s.discount / 100) : s.final;
  };

  // ---- the floating button ------------------------------------------------
  const update = () => {
    const match = location.hostname === "store.steampowered.com" && location.pathname.match(/^\/app\/(\d+)/);
    const existing = document.getElementById(cfg.buttonId);
    if (!match) {
      existing?.remove();
      closeDialog();
      currentAppId = null;
      return;
    }
    if (match[1] !== currentAppId) closeDialog();
    currentAppId = match[1];
    if (!document.body || existing) return;

    const b = document.createElement("button");
    b.id = cfg.buttonId;
    b.type = "button";
    // Bottom right of the store window. Smaller than on the Deck: desktop
    // Steam is used with a mouse.
    b.style.cssText = [
      "position: fixed",
      "right: 20px",
      "bottom: 20px",
      "z-index: 999999",
      "display: flex",
      "align-items: center",
      "gap: 8px",
      "height: 34px",
      "padding: 0 14px",
      "box-sizing: border-box",
      "border-radius: 6px",
      "background: #1b2838",
      "border: 2px solid #66c0f4",
      "color: #ffffff",
      "font-size: 15px",
      "font-family: 'Motiva Sans', Arial, sans-serif",
      "white-space: nowrap",
      "box-shadow: 0 4px 12px rgba(0,0,0,0.5)",
      "cursor: pointer",
    ].join(";");
    b.innerHTML =
      '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="#66c0f4" stroke-width="2.5" ' +
      'stroke-linecap="round" stroke-linejoin="round"><polyline points="3 17 9 11 13 15 21 7"/>' +
      '<polyline points="15 7 21 7 21 13"/></svg><span>Price History</span>';
    b.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (document.getElementById(cfg.overlayId)) closeDialog();
      else openDialog();
    });
    document.body.appendChild(b);
  };

  // ---- the dialog ---------------------------------------------------------
  function closeDialog() {
    if (requestTimer !== null) w.clearTimeout(requestTimer);
    requestTimer = null;
    document.getElementById(cfg.overlayId)?.remove();
    document.getElementById(cfg.overlayId + "-backdrop")?.remove();
  }

  function buttonStyle(active: boolean) {
    return (
      "padding:6px 14px;font-size:14px;font-weight:bold;border-radius:4px;cursor:pointer;" +
      "font-family:inherit;border:1px solid " +
      (active ? "#66c0f4;background:#66c0f4;color:#1b2838;" : "rgba(102,192,244,0.5);background:transparent;color:#66c0f4;")
    );
  }

  function openDialog() {
    if (!currentAppId) return;
    closeDialog();
    const backdrop = document.createElement("div");
    backdrop.id = cfg.overlayId + "-backdrop";
    backdrop.style.cssText = "position:fixed;inset:0;z-index:9999998;background:rgba(0,0,0,0.45);";
    backdrop.addEventListener("click", closeDialog);

    const ov = document.createElement("div");
    ov.id = cfg.overlayId;
    ov.style.cssText =
      "position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);z-index:9999999;" +
      "background:#1a1d23;border-radius:8px;padding:20px;width:640px;max-width:92vw;max-height:84vh;" +
      "overflow-y:auto;box-sizing:border-box;box-shadow:0 8px 32px rgba(0,0,0,0.6);color:#e0e0e0;" +
      "font-family:'Motiva Sans',Arial,sans-serif;font-size:14px;";
    ov.addEventListener("click", (e) => e.stopPropagation());
    ov.innerHTML =
      '<div style="display:flex;align-items:baseline;justify-content:space-between;margin-bottom:12px;">' +
      '<h3 style="margin:0;color:#fff;font-size:18px;font-weight:bold;">Price History</h3>' +
      '<span data-ph="source" style="color:#7ab3f0;font-size:11px;"></span></div>' +
      '<div data-ph="body" style="padding:30px 0;text-align:center;color:#aaa;">Loading prices…</div>' +
      '<div style="margin-top:14px;display:flex;justify-content:flex-end;">' +
      '<button data-ph="close" type="button" style="background:rgb(100,120,150);color:#fff;border:none;' +
      'border-radius:6px;padding:10px 28px;cursor:pointer;font-size:16px;min-height:44px;font-family:inherit;">' +
      "Close</button></div>";
    document.body.appendChild(backdrop);
    document.body.appendChild(ov);
    const closeBtn = ov.querySelector('[data-ph="close"]') as HTMLButtonElement;
    closeBtn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      closeDialog();
    });
    closeBtn.focus();

    // Ask the plugin for this game's prices.
    requestTimer = w.setTimeout(() => {
      requestTimer = null;
      showError("No answer from the Price History plugin. Check that it's enabled in Millennium.");
    }, 30000);
    const appId = currentAppId;
    // Answers to an earlier dialog (closed and reopened while loading) are ignored.
    const request = ++requestCount;
    cfg.requestPrices(appId, storeCountry()).then((data) => {
      if (request === requestCount) show(data);
    }, (e: any) => {
      if (request !== requestCount || appId !== currentAppId) return;
      if (requestTimer !== null) w.clearTimeout(requestTimer);
      requestTimer = null;
      showError(`Couldn't load prices (${e?.message ?? e}).`);
    });
  }

  function showError(text: string) {
    const body = document.querySelector(`#${cfg.overlayId} [data-ph="body"]`) as HTMLElement | null;
    if (!body) return;
    body.style.cssText = "padding:30px 0;text-align:center;color:#f87171;";
    body.textContent = text;
  }

  // Called by the plugin with the data for one game.
  function show(data: PriceData) {
    const ov = document.getElementById(cfg.overlayId);
    if (!ov || data.appId !== currentAppId) return;
    if (requestTimer !== null) w.clearTimeout(requestTimer);
    requestTimer = null;
    const body = ov.querySelector('[data-ph="body"]') as HTMLElement;
    (ov.querySelector('[data-ph="source"]') as HTMLElement).textContent =
      `Steam prices for ${data.country}${data.currency ? ` in ${data.currency}` : ""}` +
      (data.history ? (data.estimated ? " · history estimated · IsThereAnyDeal" : " · data: IsThereAnyDeal") : "");
    body.style.cssText = "";

    const rowStyle = "border-bottom:1px solid rgba(255,255,255,0.06);";
    const th = 'style="padding:8px 10px;text-align:left;color:#ccc;font-weight:bold;white-space:nowrap;"';
    const td = 'style="padding:8px 10px;color:#fff;"';
    const cut = (n: number) => `<span style="color:#a4d007;font-weight:bold;">-${n}%</span> `;
    const rows: [string, string][] = [];

    const s = data.steam;
    if (s) {
      if (s.free) rows.push(["Current price", "Free"]);
      else if (s.final !== null)
        rows.push([
          "Current price",
          (s.discount ? cut(s.discount) : "") +
            `<b>${esc(money(data, s.final))}</b>` +
            (s.discount ? ` <span style="color:#888;text-decoration:line-through;">${esc(money(data, s.initial))}</span>` : ""),
        ]);
      else rows.push(["Current price", "Not sold on its own"]);
      if (s.discount && data.dealEnds) rows.push(["Sale ends", esc(longDate(data.dealEnds))]);
    } else {
      rows.push(["Current price", '<span style="color:#888;">Couldn\'t load from Steam</span>']);
    }

    if (data.low) {
      rows.push([
        "Lowest recorded price",
        (data.low.cut ? cut(data.low.cut) : "") +
          `<b>${esc(money(data, data.low.price))}</b>` +
          (data.low.t ? ` <span style="color:#888;">(${esc(shortDate(data.low.t))}, ${esc(ago(data.low.t))})</span>` : ""),
      ]);
    }
    const hist = data.history;
    if (hist && hist.length) {
      const yearAgo = Date.now() - 365 * 86400000;
      const low1y = lowestSince(hist, yearAgo, comparablePrice(data));
      if (low1y !== null) rows.push(["Lowest in the last year", `<b>${esc(money(data, low1y))}</b>`]);
      const lastSale = [...hist].reverse().find((p) => p.cut > 0);
      if (lastSale && !(s && s.discount))
        rows.push([
          "Last on sale",
          cut(lastSale.cut) + `${esc(money(data, lastSale.price))} <span style="color:#888;">(${esc(shortDate(lastSale.t))}, ${esc(ago(lastSale.t))})</span>`,
        ]);
      const sales = hist.filter((p, i) => p.cut > 0 && (i === 0 || hist[i - 1].cut === 0) && p.t >= yearAgo).length;
      rows.push(["Sales in the last year", String(sales)]);
    }

    let html = verdictBanner(data);
    if (data.estimated && hist && hist.length) {
      html +=
        '<div style="margin:-4px 0 12px;padding:8px 12px;border-radius:4px;background:rgba(102,192,244,0.08);' +
        'color:#a9c4d8;font-size:12px;line-height:1.4;">' +
        esc(
          `Past prices are estimates: IsThereAnyDeal only has ${data.estimated.from} prices for this region, ` +
            `so its sale dates and discounts are applied to today's full price (${money(data, s ? s.initial : null)}).`
        ) +
        "</div>";
    }
    html +=
      '<table style="width:100%;border-collapse:collapse;background:rgba(255,255,255,0.03);border-radius:4px;">' +
      rows.map(([k, v]) => `<tr style="${rowStyle}"><td ${th}>${esc(k)}</td><td ${td}>${v}</td></tr>`).join("") +
      "</table>";

    if (hist && hist.length) {
      html +=
        '<div style="display:flex;align-items:center;gap:8px;margin:16px 0 8px;">' +
        '<span style="color:#aaa;font-size:13px;margin-right:4px;">Zoom</span>' +
        RANGES.map(([label], i) => `<button type="button" data-ph-range="${i}" style="${buttonStyle(false)}">${label}</button>`).join("") +
        "</div>" +
        '<div data-ph="chart" style="position:relative;"></div>' +
        '<div style="color:#aaa;font-size:12px;margin-top:4px;">Point at the chart to see the price on a day.</div>' +
        '<h4 style="margin:16px 0 6px;color:#fff;font-size:14px;">Price changes</h4>' +
        changesTable(data, hist);
    } else if (data.historyError) {
      html += `<div style="margin-top:14px;padding:12px;border-radius:4px;background:rgba(255,255,255,0.04);color:#ccc;">${esc(data.historyError)}</div>`;
    }
    body.innerHTML = html;

    if (hist && hist.length) {
      const chartBox = body.querySelector('[data-ph="chart"]') as HTMLElement;
      const buttons = Array.from(body.querySelectorAll("[data-ph-range]")) as HTMLButtonElement[];
      const select = (i: number) => {
        buttons.forEach((btn, j) => (btn.style.cssText = buttonStyle(i === j)));
        drawChart(chartBox, data, hist, RANGES[i][1]);
      };
      buttons.forEach((btn, i) =>
        btn.addEventListener("click", (e) => {
          e.preventDefault();
          e.stopPropagation();
          select(i);
        })
      );
      select(0); // 6m by default
    }
  }

  // "Is buying at today's price a good idea?" in one coloured line:
  // - Good: on sale at the lowest price of the last year (or ever).
  // - Bad: full price, but it was on sale in the last year (waiting likely pays off).
  // - Normal: full price and no sales in the last year, or on sale but it has
  //   been cheaper this year.
  // Nothing is shown without a price and some history to compare with.
  function verdictBanner(data: PriceData) {
    const s = data.steam;
    const hist = data.history;
    if (!s || s.free || s.final === null || !hist || !hist.length) return "";
    const now = comparablePrice(data)!;
    const yearAgo = Date.now() - 365 * 86400000;
    const near = (a: number, b: number) => a <= b + 0.005;

    // Lowest price in the last year (including the price in effect a year ago),
    // and when it was last seen.
    let low1y: { price: number; t: number } | null = null;
    let before: { price: number; t: number } | null = null;
    for (const p of hist) {
      if (p.t < yearAgo) before = p;
      else if (!low1y || p.price <= low1y.price) low1y = p;
    }
    if (before && (!low1y || before.price < low1y.price)) low1y = { price: before.price, t: yearAgo };
    const lastSale = [...hist].reverse().find((p) => p.cut > 0 && p.t >= yearAgo);
    const sales = hist.filter((p, i) => p.cut > 0 && (i === 0 || hist[i - 1].cut === 0) && p.t >= yearAgo).length;

    let kind: "good" | "normal" | "maybe" | "bad";
    let title: string;
    // Most important first: headline (when / why it matters), then supporting
    // facts, then the reasoning in small text at the bottom.
    let detail = "";
    let facts: string[] = [];
    let why: string[] = [];
    if (s.discount > 0) {
      if (data.low && near(now, data.low.price)) {
        kind = "good";
        title = "Good deal: lowest price ever";
        detail = `${money(data, s.final)} matches the all-time low on Steam.`;
      } else if (!low1y || near(now, low1y.price)) {
        kind = "good";
        title = "Good deal: lowest price this year";
        detail = data.low ? `The all-time low was ${money(data, data.low.price)}${data.low.t ? ` (${shortDate(data.low.t)})` : ""}.` : "";
      } else {
        kind = "normal";
        title = "Normal sale: it has been cheaper";
        detail = `It was ${money(data, low1y.price)} on ${shortDate(low1y.t)}. A better sale may come.`;
      }
    } else if (lastSale) {
      const windowDays = data.waitDays || 30;
      const within = WAIT_LABELS[windowDays] || `${windowDays} days`;
      const guess = predictSale(hist, windowDays, within);
      const recent =
        `Last sale: ${money(data, lastSale.price)} (-${lastSale.cut}%) on ${shortDate(lastSale.t)} · ` +
        `${sales} sale${sales === 1 ? "" : "s"} in the last year`;
      if (!guess) {
        kind = "bad";
        title = "Bad time to buy: wait for a sale";
        detail = "Not enough sales yet to guess when the next one comes.";
        facts = [recent];
      } else {
        kind = guess.level === "likely" ? "bad" : guess.level === "possible" ? "maybe" : "normal";
        title =
          guess.level === "likely"
            ? `Wait: a sale is likely within ${within}`
            : guess.level === "possible"
              ? `Maybe wait: a sale is possible within ${within}`
              : `Normal price: no sale expected within ${within}`;
        detail = nextSaleText(data, now, guess.next);
        facts = [recent];
        why = [...guess.reasons, "A guess from this game's past sales, not a promise."];
      }
    } else {
      kind = "normal";
      title = "Normal price";
      detail = "No sales in the last year, so a discount may not come soon.";
    }
    const look = {
      good: { bg: "rgba(164,208,7,0.16)", border: "#a4d007", color: "#beee11", icon: "✔" },
      normal: { bg: "rgba(143,152,160,0.14)", border: "#8f98a0", color: "#c6d4df", icon: "•" },
      maybe: { bg: "rgba(250,204,21,0.12)", border: "#facc15", color: "#fde047", icon: "?" },
      bad: { bg: "rgba(248,113,113,0.14)", border: "#f87171", color: "#fca5a5", icon: "✖" },
    }[kind];
    return (
      `<div style="display:flex;gap:12px;align-items:flex-start;margin-bottom:12px;padding:12px 14px;border-radius:6px;` +
      `background:${look.bg};border-left:4px solid ${look.border};">` +
      `<span style="font-size:22px;line-height:24px;color:${look.color};">${look.icon}</span>` +
      `<div><div style="font-size:17px;font-weight:bold;color:${look.color};">${esc(title)}</div>` +
      (detail ? `<div style="font-size:14px;color:#ffffff;margin-top:3px;">${esc(detail)}</div>` : "") +
      facts.map((f) => `<div style="font-size:13px;color:#c6d4df;margin-top:2px;">${esc(f)}</div>`).join("") +
      (why.length
        ? `<div style="font-size:12px;color:#8f98a0;margin-top:8px;line-height:1.4;">Why: ${why.map(esc).join(" ")}</div>`
        : "") +
      "</div></div>"
    );
  }

  // "Next sale expected: around Dec 18, last year -35% (about CDN$ 51.99)".
  function nextSaleText(data: PriceData, price: number, next: { t: number; cut: number | null; yearsAgo: number } | null) {
    if (!next) return "No clear date for the next sale yet.";
    const days = (next.t - Date.now()) / 86400000;
    const when = days < 4 ? "any day now" : `around ${MONTHS[new Date(next.t).getMonth()]} ${new Date(next.t).getDate()}`;
    const ago = next.yearsAgo === 1 ? "last year" : `${next.yearsAgo} years ago`;
    const cut = next.cut ? `, ${ago} -${next.cut}% (about ${money(data, price * (1 - next.cut / 100))})` : "";
    return `Next sale expected: ${when}${cut}`;
  }

  // Rough guess whether a sale starts within the next `windowDays` (the
  // user's "willing to wait" setting, default 30), from this
  // game's own history. Two signals, averaged:
  // - rhythm: of the past waits between sales that lasted at least as long as
  //   the current one, how many ended with a sale within `windowDays` more?
  // - time of year: was it on sale in the same upcoming window last year and
  //   the year before (only years the history covers)?
  // Returns null when there are fewer than 3 sales in the last 2 years.
  function predictSale(hist: PriceData["history"] & {}, windowDays: number, within: string) {
    const DAY = 86400000;
    const now = Date.now();
    // Sales as [start, end) periods; consecutive discounted points (e.g.
    // -30% then -50%) are one sale. end = null while it's still running.
    const periods: { start: number; end: number | null; cut: number }[] = [];
    for (let i = 0; i < hist.length; i++) {
      const p = hist[i];
      const cur = periods.length ? periods[periods.length - 1] : null;
      const open = cur && cur.end === null;
      if (p.cut > 0 && !open) periods.push({ start: p.t, end: null, cut: p.cut });
      else if (p.cut > 0 && cur) cur.cut = Math.max(cur.cut, p.cut);
      else if (p.cut === 0 && open) cur!.end = p.t;
    }
    const last = periods[periods.length - 1];
    if (!last || last.end === null) return null; // on sale now: nothing to predict
    const recent = periods.filter((x) => x.start >= now - 730 * DAY);
    if (recent.length < 3) return null;

    const reasons: string[] = [];
    const scores: number[] = [];

    // Rhythm.
    const gaps: number[] = [];
    for (let i = 1; i < recent.length; i++) gaps.push((recent[i].start - recent[i - 1].end!) / DAY);
    const waited = (now - last.end) / DAY;
    const sorted = [...gaps].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    const asLong = gaps.filter((g) => g >= waited);
    const fmtDays = (d: number) => (d < 14 ? `${Math.round(d)} days` : d < 70 ? `${Math.round(d / 7)} weeks` : `${Math.round(d / 30.4)} months`);
    reasons.push(`Usually about ${fmtDays(median)} between sales; the last one ended ${fmtDays(waited)} ago.`);
    if (asLong.length >= 2) {
      const soon = asLong.filter((g) => g <= waited + windowDays).length;
      scores.push(soon / asLong.length);
      reasons.push(`After a wait this long, a sale started within ${within} ${soon} of ${asLong.length} times.`);
    } else {
      // Longer than (almost) every past wait: either a sale is due, or the
      // pattern changed. Count it as "maybe".
      scores.push(0.5);
      reasons.push("It has been longer than usual since the last sale.");
    }

    // Time of year.
    const first = hist[0].t;
    const hitYears: number[] = [];
    const missYears: number[] = [];
    for (let k = 1; k <= 2; k++) {
      const from = now - k * 365 * DAY;
      const to = from + windowDays * DAY;
      if (first > from) continue; // history doesn't reach back that far
      const year = new Date(from).getFullYear();
      if (periods.some((x) => x.start < to && (x.end === null || x.end > from))) hitYears.push(year);
      else missYears.push(year);
    }
    const years = hitYears.length + missYears.length;
    if (years) {
      scores.push(hitYears.length / years);
      const a = new Date(now);
      const b = new Date(now + windowDays * DAY);
      const span = `${MONTHS[a.getMonth()]} ${a.getDate()} – ${MONTHS[b.getMonth()]} ${b.getDate()}`;
      const parts: string[] = [];
      if (hitYears.length) parts.push(`on sale in ${hitYears.join(" and ")}`);
      if (missYears.length) parts.push(`not in ${missYears.join(" or ")}`);
      reasons.push(`Same dates in past years (${span}): ${parts.join(", ")}.`);
    }

    // Best guess for the date of the next sale, the earlier of:
    // - when it next went on sale after today's date last year (or, if the
    //   history doesn't cover last year, 2 years ago), moved forward to this
    //   year, with that sale's discount. The most recent year wins because
    //   it's the closest to how the game is priced now.
    // - the usual rhythm (last sale's end + typical gap), if that's still ahead
    //   (when it's already past, the rhythm says nothing about the date)
    let next: { t: number; cut: number | null; yearsAgo: number } | null = null;
    for (let k = 1; k <= 2 && !next; k++) {
      const from = now - k * 365 * DAY;
      if (first > from) continue;
      const p = periods.find((x) => (x.end === null || x.end > from) && x.start < from + 365 * DAY);
      if (p) next = { t: Math.max(p.start, from) + k * 365 * DAY, cut: p.cut, yearsAgo: k };
    }
    const byRhythm = last.end + median * DAY;
    if (byRhythm > now && (!next || byRhythm < next.t)) next = { t: byRhythm, cut: null, yearsAgo: 0 };

    const score = scores.reduce((a, b) => a + b, 0) / scores.length;
    const level = score >= 0.6 ? "likely" : score >= 0.3 ? "possible" : "unlikely";
    return { level, score, reasons, next } as const;
  }

  // Lowest price paid at any moment since `since` (including the price that
  // was in effect at that moment, and the current price).
  function lowestSince(hist: PriceData["history"] & {}, since: number, current: number | null) {
    let low: number | null = current;
    let before: number | null = null;
    for (const p of hist) {
      if (p.t < since) before = p.price;
      else low = low === null ? p.price : Math.min(low, p.price);
    }
    if (before !== null) low = low === null ? before : Math.min(low, before);
    return low;
  }

  function changesTable(data: PriceData, hist: PriceData["history"] & {}) {
    const recent = hist.slice(-40).reverse();
    const cell = "padding:5px 10px;";
    return (
      '<table style="width:100%;border-collapse:collapse;font-size:13px;">' +
      `<tr style="color:#aaa;"><td style="${cell}">Date</td><td style="${cell}">Price</td><td style="${cell}">Discount</td></tr>` +
      recent
        .map(
          (p) =>
            `<tr style="border-top:1px solid rgba(255,255,255,0.06);"><td style="${cell}color:#ccc;">${esc(shortDate(p.t))}</td>` +
            `<td style="${cell}color:#fff;">${esc(money(data, p.price))}</td>` +
            `<td style="${cell}${p.cut ? "color:#a4d007;font-weight:bold;" : "color:#888;"}">${p.cut ? "-" + p.cut + "%" : "None"}</td></tr>`
        )
        .join("") +
      "</table>" +
      (hist.length > recent.length ? `<div style="color:#888;font-size:12px;padding:4px 10px;">Showing the latest ${recent.length} of ${hist.length} changes.</div>` : "")
    );
  }

  // Step chart of the price over time, like SteamDB's.
  function drawChart(box: HTMLElement, data: PriceData, hist: PriceData["history"] & {}, months: number) {
    const now = Date.now();
    const first = hist[0].t;
    let start = months ? now - months * 30.44 * 86400000 : first;
    if (start < first) start = first;
    // The price in effect at `start`, then each change after it.
    let startPrice = hist[0].price;
    let startCut = hist[0].cut;
    const pts: { t: number; price: number; cut: number }[] = [];
    for (const p of hist) {
      if (p.t <= start) {
        startPrice = p.price;
        startCut = p.cut;
      } else pts.push(p);
    }
    pts.unshift({ t: start, price: startPrice, cut: startCut });
    const current = data.steam && data.steam.final !== null ? data.steam.final : null;

    let maxP = 0;
    let minP = Infinity;
    for (const p of pts) {
      maxP = Math.max(maxP, p.price);
      minP = Math.min(minP, p.price);
    }
    if (current !== null) {
      maxP = Math.max(maxP, current);
      minP = Math.min(minP, current);
    }
    // A round step giving about 4 gridlines at any price scale (e.g. 10 for a
    // CDN$ 25.99 game, 250k for a 990.000₫ one), and a top that's a multiple of it.
    const rough = Math.max(maxP * 1.08, 1) / 4;
    const mag = Math.pow(10, Math.floor(Math.log10(rough)));
    const step = ([1, 2, 2.5, 5, 10].find((m) => m * mag >= rough) || 10) * mag;
    const top = Math.max(step, Math.ceil((maxP * 1.08) / step) * step);
    const axisLabel = (v: number) =>
      v >= 1e6 ? `${+(v / 1e6).toFixed(2)}M` : v >= 1e4 ? `${+(v / 1e3).toFixed(1)}k` : `${+v.toFixed(2)}`;
    const plotW = CHART_W - PAD.l - PAD.r;
    const plotH = CHART_H - PAD.t - PAD.b;
    const x = (t: number) => PAD.l + ((t - start) / Math.max(1, now - start)) * plotW;
    const y = (p: number) => PAD.t + plotH - (p / top) * plotH;

    let line = `M${x(pts[0].t).toFixed(1)},${y(pts[0].price).toFixed(1)}`;
    for (let i = 1; i < pts.length; i++) {
      line += `H${x(pts[i].t).toFixed(1)}V${y(pts[i].price).toFixed(1)}`;
    }
    line += `H${x(now).toFixed(1)}`;
    const area = `${line}V${y(0).toFixed(1)}H${x(pts[0].t).toFixed(1)}Z`;

    let grid = "";
    for (let v = 0; v <= top + 0.001; v += step) {
      grid +=
        `<line x1="${PAD.l}" x2="${CHART_W - PAD.r}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}" stroke="rgba(255,255,255,0.08)"/>` +
        `<text x="${CHART_W - PAD.r + 6}" y="${(y(v) + 4).toFixed(1)}" fill="#8f98a0" font-size="11">${axisLabel(v)}</text>`;
    }
    // Month labels: about six across the chart.
    const spanMonths = Math.max(1, (now - start) / (30.44 * 86400000));
    const every = [1, 2, 3, 4, 6, 12, 24, 36, 60].find((n) => spanMonths / n <= 6) || 120;
    let labels = "";
    const d = new Date(start);
    d.setDate(1);
    d.setHours(0, 0, 0, 0);
    d.setMonth(d.getMonth() + 1);
    // Label months whose number (counted from year 0) is a multiple of
    // `every`, so 3 → Jan/Apr/Jul/Oct and 12 → each January.
    while (d.getTime() < now) {
      if ((d.getFullYear() * 12 + d.getMonth()) % every === 0) {
        const lx = x(d.getTime());
        if (lx > PAD.l + 24 && lx < CHART_W - PAD.r - 24)
          labels += `<text x="${lx.toFixed(1)}" y="${CHART_H - 6}" fill="#8f98a0" font-size="11" text-anchor="middle">${MONTHS[d.getMonth()]} ${d.getFullYear()}</text>`;
      }
      d.setMonth(d.getMonth() + 1);
    }
    const lowY = y(minP).toFixed(1);

    box.innerHTML =
      `<svg viewBox="0 0 ${CHART_W} ${CHART_H}" style="width:100%;height:auto;display:block;background:#16202d;border-radius:4px;touch-action:none;">` +
      '<defs><linearGradient id="ph-fill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#66c0f4" stop-opacity="0.35"/>' +
      '<stop offset="1" stop-color="#66c0f4" stop-opacity="0.03"/></linearGradient></defs>' +
      grid +
      labels +
      `<path d="${area}" fill="url(#ph-fill)"/>` +
      `<line x1="${PAD.l}" x2="${CHART_W - PAD.r}" y1="${lowY}" y2="${lowY}" stroke="#a4d007" stroke-dasharray="4 4" stroke-opacity="0.7"/>` +
      `<path d="${line}" fill="none" stroke="#66c0f4" stroke-width="2"/>` +
      '<line data-ph="guide" y1="' + PAD.t + '" y2="' + (CHART_H - PAD.b) + '" stroke="#fff" stroke-opacity="0.5" style="display:none;"/>' +
      '<circle data-ph="dot" r="4" fill="#fff" style="display:none;"/>' +
      "</svg>" +
      '<div data-ph="tip" style="display:none;position:absolute;pointer-events:none;background:rgba(220,222,225,0.95);color:#1b2838;' +
      'border-radius:4px;padding:6px 10px;font-size:13px;line-height:1.45;white-space:nowrap;box-shadow:0 2px 8px rgba(0,0,0,0.4);"></div>';

    const svg = box.querySelector("svg") as SVGSVGElement;
    const guide = box.querySelector('[data-ph="guide"]') as SVGLineElement;
    const dot = box.querySelector('[data-ph="dot"]') as SVGCircleElement;
    const tip = box.querySelector('[data-ph="tip"]') as HTMLElement;
    const pointAt = (t: number) => {
      let p = pts[0];
      for (const q of pts) if (q.t <= t) p = q;
      return p;
    };
    const onPointer = (e: PointerEvent) => {
      const r = svg.getBoundingClientRect();
      const sx = ((e.clientX - r.left) / r.width) * CHART_W;
      if (sx < PAD.l || sx > CHART_W - PAD.r) return;
      const t = start + ((sx - PAD.l) / plotW) * (now - start);
      const p = pointAt(t);
      guide.setAttribute("x1", sx.toFixed(1));
      guide.setAttribute("x2", sx.toFixed(1));
      guide.style.display = "";
      dot.setAttribute("cx", sx.toFixed(1));
      dot.setAttribute("cy", y(p.price).toFixed(1));
      dot.style.display = "";
      tip.innerHTML =
        `${esc(longDate(t))}<br>Price: <b>${esc(money(data, p.price))}</b><br>` +
        (p.cut ? `<span style="color:#4c6b22;font-weight:bold;">-${p.cut}% discount</span>` : "No discount") +
        `<br><i>Lowest here: ${esc(money(data, minP))}</i>`;
      tip.style.display = "";
      const px = (sx / CHART_W) * r.width;
      const left = px + 12 + tip.offsetWidth > r.width ? px - 12 - tip.offsetWidth : px + 12;
      tip.style.left = Math.max(0, left) + "px";
      tip.style.top = "8px";
    };
    svg.addEventListener("pointermove", onPointer);
    svg.addEventListener("pointerdown", onPointer);
    svg.addEventListener("pointerleave", () => {
      guide.style.display = "none";
      dot.style.display = "none";
      tip.style.display = "none";
    });
  }

  // ---- start ----------------------------------------------------------------
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape" && document.getElementById(cfg.overlayId)) closeDialog();
  };
  document.addEventListener("keydown", onKey, true);
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", update);
  } else {
    update();
  }
  // Catch in-page navigation (the store sometimes changes the URL without
  // reloading). Comparing one string a second costs nothing noticeable.
  let lastHref = location.href;
  const timer = w.setInterval(() => {
    if (location.href !== lastHref) {
      lastHref = location.href;
      update();
    }
  }, 1000);

  w[cfg.stateKey] = {
    update,
    show,
    showError,
    destroy() {
      w.clearInterval(timer);
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("DOMContentLoaded", update);
      closeDialog();
      document.getElementById(cfg.buttonId)?.remove();
      delete w[cfg.stateKey];
    },
  };
}
