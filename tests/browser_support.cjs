"use strict";

// No production dependency: resolve the caller's optional development install.
const playwright = require(process.env.AFTERLIFE_PLAYWRIGHT_MODULE || "playwright");
const engine = process.env.AFTERLIFE_BROWSER || "chromium";
if (!["chromium", "firefox", "webkit"].includes(engine)) {
  throw new Error("AFTERLIFE_BROWSER must be chromium, firefox, or webkit");
}

exports.launch = async () => {
  const executablePath = process.env.AFTERLIFE_BROWSER_EXECUTABLE ||
    (engine === "chromium" ? process.env.AFTERLIFE_CHROMIUM : undefined);
  const browser = await playwright[engine].launch({headless: true,
    ...(executablePath ? {executablePath} : {})});
  console.log(`Browser: ${engine} ${browser.version()}`);
  return browser;
};

exports.offlineContext = async (browser, options = {}) => {
  if (engine !== "webkit") return browser.newContext({...options, offline: true});
  // WebKit 26.5 fails even a minimal file: navigation with Playwright's
  // offline flag. Block HTTP(S) explicitly; run this engine in a container
  // with --network none for independent transport-level offline evidence.
  const context = await browser.newContext({...options, offline: false, serviceWorkers: "block"});
  await context.route(/^https?:/, route => route.abort("internetdisconnected"));
  return context;
};
