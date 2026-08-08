#!/usr/bin/env node
// Real-browser gate for the request/reply browser primitive. It intentionally uses a tiny
// fixture, never Bramble production code or manifests; production unit tests enforce that
// Bramble itself uses this direct request/reply transport.
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const root = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.join(root, "fixture");
const firefox = process.env.FIREFOX_BINARY;
const webExt = process.env.WEB_EXT ?? path.resolve(root, "../../node_modules/.bin/web-ext");
const sentinel = "BRAMBLE_TRANSPORT_SENTINEL";
const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const transportBrowsers = process.env.TRANSPORT_BROWSERS ?? "all";

if (!new Set(["all", "chromium", "firefox"]).has(transportBrowsers)) {
  throw new Error("TRANSPORT_BROWSERS must be one of: all, chromium, firefox");
}

function newState() {
  return { aPagehide: false, bObserved: false, diagnostics: [], events: [], notify() {}, release: false };
}

function record(state, event) {
  state.events.push(event);
  if (event.kind === "observed" && event.role === "b") state.bObserved = true;
  if (event.kind === "pagehide" && event.role === "a") state.aPagehide = true;
  state.notify();
}

function server() {
  const runs = new Map();
  const http = createServer(async (request, response) => {
    const url = new URL(request.url, `http://${request.headers.host}`);
    const run = url.searchParams.get("run");
    if (url.pathname === "/report" && request.method === "POST") {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const state = runs.get(run);
      if (state) record(state, JSON.parse(Buffer.concat(chunks).toString()));
      response.statusCode = 204;
      response.end();
      return;
    }
    if (url.pathname === "/release") {
      const state = runs.get(run);
      response.end(state?.release && state.bObserved && state.aPagehide ? "release" : "hold");
      return;
    }
    if (url.pathname === "/parent") {
      response.setHeader("content-type", "text/html");
      response.end('<!doctype html><body><script src="/parent.js"></script></body>');
      return;
    }
    if (url.pathname === "/top-a") {
      response.setHeader("content-type", "text/html");
      response.end('<!doctype html><body><script src="/bfcache-a.js"></script></body>');
      return;
    }
    if (url.pathname === "/top-b") {
      response.setHeader("content-type", "text/html");
      response.end('<!doctype html><body><script src="/bfcache-b.js"></script></body>');
      return;
    }
    if (url.pathname === "/child") {
      response.setHeader("content-type", "text/html");
      response.end("<!doctype html><title>child</title>");
      return;
    }
    if (["/bfcache-a.js", "/bfcache-b.js", "/content.js", "/parent.js"].includes(url.pathname)) {
      response.setHeader("content-type", "text/javascript");
      response.end(await readFile(path.join(fixture, url.pathname.slice(1))));
      return;
    }
    response.statusCode = 404;
    response.end();
  });
  return { http, runs };
}

async function waitFor(state, predicate, description) {
  const deadline = Date.now() + 15_000;
  while (!predicate(state.events)) {
    if (state.processError) throw new Error(state.processError);
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error(`transport fixture timed out waiting for ${description}`);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        state.notify = () => {};
        reject(
          new Error(
            `transport fixture timed out waiting for ${description}: ${JSON.stringify({ diagnostics: state.diagnostics, eventCount: state.events.length, events: state.events.slice(-30) })}`,
          ),
        );
      }, remaining);
      state.notify = () => {
        clearTimeout(timer);
        state.notify = () => {};
        resolve();
      };
    });
  }
}

function documentNonce(events, role) {
  const nonces = new Set(
    events.filter((event) => event.role === role && event.documentNonce).map((event) => event.documentNonce),
  );
  if (nonces.size !== 1) throw new Error(`${role}: document nonce was not stable`);
  return nonces.values().next().value;
}

function assertContract(events, mode, requiresFrame) {
  const a = events.filter((event) => event.role === "a");
  const b = events.filter((event) => event.role === "b");
  const aObserved = a.find((event) => event.kind === "observed");
  const bObserved = b.find((event) => event.kind === "observed");

  if (requiresFrame && !events.some((event) => event.kind === "frame" && event.reused)) {
    throw new Error(`${mode}: browsing context was not reused`);
  }
  if (!aObserved || !bObserved || aObserved.frameId !== bObserved.frameId) {
    throw new Error(`${mode}: background did not observe the same reused frame ID`);
  }
  if (mode === "bfcache" && (aObserved.frameId !== 0 || bObserved.frameId !== 0)) {
    throw new Error("bfcache: the top-level browsing context must use frame ID 0");
  }
  if (documentNonce(events, "a") === documentNonce(events, "b")) {
    throw new Error(`${mode}: distinct documents shared a nonce`);
  }
  if (!a.some((event) => event.kind === "pagehide")) {
    throw new Error(`${mode}: A did not cancel on pagehide`);
  }
  if (a.some((event) => event.sentinel === sentinel || event.kind === "applied")) {
    throw new Error(`${mode}: old or restored A received/applied the sentinel`);
  }
  if (b.some((event) => event.sentinel === sentinel || event.kind === "applied")) {
    throw new Error(`${mode}: replacement B received/applied the sentinel`);
  }
  if (mode === "bfcache" && !a.some((event) => event.kind === "restored")) {
    throw new Error("bfcache: A did not restore from BFCache");
  }
}

async function exercise(state, mode, requiresFrame) {
  await waitFor(
    state,
    (events) =>
        events.some((event) => event.role === "b" && event.kind === "observed") &&
        (!requiresFrame || events.some((event) => event.kind === "frame" && event.reused)) &&
      events.some((event) => event.role === "a" && event.kind === "pagehide"),
    "B frame observation and A pagehide",
  );
  if (mode === "bfcache") {
    await waitFor(state, (events) => events.some((event) => event.kind === "restored"), "A BFCache restore");
  }
  state.release = true;
  await waitFor(state, (events) => events.some((event) => event.kind === "reply-sent"), "held async reply");
  await delay(150);
  assertContract(state.events, mode, requiresFrame);
}

async function runCase(open, base, runs, testCase) {
  const id = `${testCase.mode}-${crypto.randomUUID()}`;
  const state = newState();
  runs.set(id, state);
  const role = testCase.mode === "bfcache" ? "&role=a" : "";
  const page = await open(`${base}${testCase.path}?run=${id}&mode=${testCase.mode}${role}`, state);
  try {
    await exercise(state, testCase.mode, testCase.requiresFrame);
  } finally {
    await page?.close();
    runs.delete(id);
  }
}

async function chromiumGate(base, runs) {
  const profile = await mkdtemp(path.join(tmpdir(), "bramble-transport-chromium-"));
  let browser;
  try {
    try {
      browser = await chromium.launchPersistentContext(profile, {
        args: [`--disable-extensions-except=${fixture}`, `--load-extension=${fixture}`, "--no-sandbox"],
        channel: "chromium",
        headless: true,
        // Playwright disables BFCache by default, but BFCache restoration is the
        // point of one of the three transport-contract cases.
        ignoreDefaultArgs: ["--disable-back-forward-cache"],
      });
    } catch (error) {
      throw new Error(
        `Chromium prerequisite unavailable. Run \`pnpm exec playwright install chromium\` and retry. ${error.message}`,
      );
    }
    for (const testCase of [
      { mode: "same-origin", path: "/parent", requiresFrame: true },
      { mode: "cross-origin", path: "/parent", requiresFrame: true },
      { mode: "bfcache", path: "/top-a", requiresFrame: false },
    ]) {
      await runCase(async (url, state) => {
        const page = await browser.newPage();
        page.on("console", (message) => {
          if (message.type() === "error") state.diagnostics.push(`console: ${message.text()}`);
        });
        page.on("pageerror", (error) => state.diagnostics.push(`pageerror: ${error.message}`));
        await page.goto(url);
        return page;
      }, base, runs, testCase);
    }
  } finally {
    await browser?.close();
    await rm(profile, { force: true, recursive: true });
  }
}

async function stop(child, state) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  state.stopping = true;
  const exited = once(child, "exit");
  child.kill("SIGTERM");
  await Promise.race([exited, delay(10_000)]);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await exited;
  }
}

async function firefoxGate(base, runs) {
  if (!firefox) {
    throw new Error("FIREFOX_BINARY must name Firefox ESR 128+ or current Firefox; no frame-target fallback is permitted");
  }
  for (const testCase of [
    { mode: "same-origin", path: "/parent", requiresFrame: true },
    { mode: "cross-origin", path: "/parent", requiresFrame: true },
    { mode: "bfcache", path: "/top-a", requiresFrame: false },
  ]) {
    const id = `${testCase.mode}-${crypto.randomUUID()}`;
    const state = newState();
    runs.set(id, state);
    const firefoxArgs = [
      "run",
      "--source-dir",
      fixture,
      "--firefox",
      firefox,
      "--no-reload",
      "--start-url",
      `${base}${testCase.path}?run=${id}&mode=${testCase.mode}${testCase.mode === "bfcache" ? "&role=a" : ""}`,
    ];
    if (process.env.FIREFOX_HEADLESS !== "0") firefoxArgs.push("--arg=-headless");
    const child = spawn(
      webExt,
      firefoxArgs,
      { stdio: "inherit" },
    );
    child.once("error", (error) => {
      state.processError = `web-ext could not start Firefox: ${error.message}`;
      state.notify();
    });
    child.once("exit", (code, signal) => {
      if (!state.stopping) {
        state.processError = `web-ext exited before the transport contract completed (code ${code}, signal ${signal})`;
        state.notify();
      }
    });
    try {
      await exercise(state, testCase.mode, testCase.requiresFrame);
    } finally {
      await stop(child, state);
      runs.delete(id);
    }
  }
}

const { http, runs } = server();
await new Promise((resolve) => http.listen(0, "0.0.0.0", resolve));
const base = `http://127.0.0.1:${http.address().port}`;
try {
  if (transportBrowsers === "all" || transportBrowsers === "chromium") await chromiumGate(base, runs);
  if (transportBrowsers === "all" || transportBrowsers === "firefox") await firefoxGate(base, runs);
  console.log(`transport-race contract passed in ${transportBrowsers}`);
} finally {
  await new Promise((resolve) => http.close(resolve));
}
