// Entry point for Steam's web pages (the store, community, …). Millennium
// loads this into each of them and calls main(); the button only appears on
// store.steampowered.com/app/<id> pages (see page.ts).

import { pageScript } from "./page";
import { loadPrices } from "./prices";

export default async function main() {
  const start = () =>
    pageScript({
      buttonId: "price-history-plugin-button",
      overlayId: "price-history-plugin-dialog",
      stateKey: "__priceHistoryPlugin",
      requestPrices: loadPrices,
    });
  // main() can run before the page has a <body>; pageScript waits for
  // DOMContentLoaded itself when the document is still loading.
  start();
}
