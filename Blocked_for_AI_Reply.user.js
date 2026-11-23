// ==UserScript==
// @name         Blocked for AI Reply
// @namespace    https://local.x-block-list
// @version      1.4.3
// @description  Block the levels.io “Blocked for AI Reply” spam list on X — block by user ID, skip missing/already-blocked, unblock if removed from list, cache + rate-limit aware
// @author       glaurossi
// @license      MIT
// @downloadURL  https://raw.githubusercontent.com/glaurossi/userscripts/main/Blocked_for_AI_Reply.user.js
// @updateURL    https://raw.githubusercontent.com/glaurossi/userscripts/main/Blocked_for_AI_Reply.user.js
// @match        https://x.com/*
// @match        https://twitter.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @connect      blockedforaireply.com
// @connect      x.com
// @connect      twitter.com
// @run-at       document-idle
// ==/UserScript==

(function () {
  "use strict";

  // Config

  // Plain-text list from levelsio (one numeric user ID per line).
  const LIST_URL = "https://blockedforaireply.com/api/ids.txt";
  // Public X web client bearer — not a user secret.
  const BEARER =
    "Bearer AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA";
  // X rotates GraphQL query IDs occasionally — if lookups start failing, update this.
  const USER_BY_REST_ID = "mxaYWwt52eAb6OAzYHMVzg";
  // Feature flags the UserByRestId query expects.
  const FEATURES = {
    hidden_profile_subscriptions_enabled: true,
    profile_label_improvements_pcf_label_in_post_enabled: true,
    responsive_web_profile_redirect_enabled: false,
    rweb_tipjar_consumption_enabled: true,
    verified_phone_label_enabled: false,
    subscriptions_verification_info_is_identity_verified_enabled: true,
    subscriptions_verification_info_verified_since_enabled: true,
    highlights_tweets_tab_ui_enabled: true,
    responsive_web_twitter_article_notes_tab_enabled: true,
    subscriptions_feature_can_gift_premium: true,
    creator_subscriptions_tweet_preview_api_enabled: true,
    responsive_web_graphql_timeline_navigation_enabled: true,
  };
  const FIELD_TOGGLES = {
    withPayments: true,
    withDmBlocks: true,
    withAuxiliaryUserLabels: false,
  };

  // Tampermonkey storage keys (progress, block cache, panel position).
  // Cache v2 stores numeric user IDs (v1 was handles).
  const STORAGE_KEY = "xBlockListProgress_v1";
  const CACHE_KEY = "xBlockListBlockedCache_v2";
  const UI_KEY = "xBlockListUi_v1";

  // Pacing: real blocks wait 3–5s; skips are faster so re-runs don't drag.
  const DELAY_MIN_MS = 3000;
  const DELAY_MAX_MS = 5000;
  const SKIP_DELAY_MS = 400; // after a network lookup that we intentionally skip
  const CACHE_SKIP_DELAY_MS = 50; // known-blocked from local cache — no API call
  const RATE_LIMIT_WAIT_MS = 15 * 60 * 1000; // full window; conservative on purpose

  // Runtime state

  const state = {
    running: false,
    stopping: false,
    users: [],
    index: 0,
    blocked: 0,
    unblocked: 0,
    skippedAlready: 0,
    skippedMissing: 0,
    skippedMismatch: 0,
    skippedCached: 0,
    failed: 0,
    current: "",
    lastAction: "idle",
    lastDetail: "",
    rateLimited: false,
    logLines: [],
    blockedCache: new Set(),
    minimized: false,
    panelAnchor: "bottom", // "top" | "bottom" — which vertical edge we pin
  };

  const LOG_MAX = 200;

  // Small helpers

  function ts() {
    return new Date().toLocaleTimeString(undefined, { hour12: false });
  }

  // Append a line to the on-panel log (and keep it from growing forever).
  function log(msg) {
    const line = "[" + ts() + "] " + msg;
    state.logLines.push(line);
    if (state.logLines.length > LOG_MAX) {
      state.logLines.splice(0, state.logLines.length - LOG_MAX);
    }
    const box = document.querySelector("#x-block-list-panel [data-f=log]");
    if (box) {
      box.textContent = state.logLines.join("\n");
      box.scrollTop = box.scrollHeight;
    }
  }

  function friendlyError(err) {
    return String(
      err && err.message ? err.message : err && err.name ? err.name + ": " + err : err
    );
  }

  // GM_xmlhttpRequest keeps session cookies without needing page-realm fetch.
  function pageFetch(url, init) {
    const method = (init && init.method) || "GET";
    const headers = Object.assign(
      {
        // Match what the web app sends so X accepts the session.
        referer: "https://x.com/",
        origin: "https://x.com",
      },
      (init && init.headers) || {}
    );

    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method,
        url: String(url),
        headers,
        data: init && init.body != null ? init.body : undefined,
        anonymous: false,
        onload: (res) => {
          resolve({
            status: res.status || 0,
            text: res.responseText == null ? "" : String(res.responseText),
          });
        },
        onerror: () => reject(new Error("X API request failed (network)")),
        ontimeout: () => reject(new Error("X API request timed out")),
      });
    });
  }

  // Normalize a list / cache user ID (digits only).
  function normId(id) {
    const s = String(id || "").trim();
    return /^\d+$/.test(s) ? s : "";
  }

  // Log / progress label: "@handle (id …)" when known, else "id …".
  function userLabel(userId, screenName) {
    const id = normId(userId) || String(userId || "");
    const handle = String(screenName || "").trim();
    if (handle) return "@" + handle + " (id " + id + ")";
    return "id " + id;
  }

  // Persistence: block cache + progress
  function loadBlockedCache() {
    try {
      const raw = GM_getValue(CACHE_KEY, null);
      if (!raw) return;
      const arr = typeof raw === "string" ? JSON.parse(raw) : raw;
      if (!Array.isArray(arr)) return;
      state.blockedCache = new Set(arr.map(normId).filter(Boolean));
    } catch (_) {}
  }

  function saveBlockedCache() {
    GM_setValue(CACHE_KEY, JSON.stringify(Array.from(state.blockedCache)));
  }

  // Remember an ID we blocked (or confirmed already blocked) for fast re-runs.
  function rememberBlocked(userId) {
    const key = normId(userId);
    if (!key || state.blockedCache.has(key)) return;
    state.blockedCache.add(key);
    saveBlockedCache();
  }

  // Drop an ID from cache after unblock / confirmed no longer blocked.
  function forgetBlocked(userId) {
    const key = normId(userId);
    if (!key || !state.blockedCache.has(key)) return;
    state.blockedCache.delete(key);
    saveBlockedCache();
  }

  function loadProgress() {
    try {
      const raw = GM_getValue(STORAGE_KEY, null);
      if (!raw) return;
      const p = typeof raw === "string" ? JSON.parse(raw) : raw;
      if (typeof p.index === "number") state.index = p.index;
      state.blocked = p.blocked || 0;
      state.unblocked = p.unblocked || 0;
      state.skippedAlready = p.skippedAlready || 0;
      state.skippedMissing = p.skippedMissing || 0;
      state.skippedMismatch = p.skippedMismatch || 0;
      state.skippedCached = p.skippedCached || 0;
      state.failed = p.failed || 0;
    } catch (_) {}
  }

  function saveProgress() {
    GM_setValue(
      STORAGE_KEY,
      JSON.stringify({
        index: state.index,
        blocked: state.blocked,
        unblocked: state.unblocked,
        skippedAlready: state.skippedAlready,
        skippedMissing: state.skippedMissing,
        skippedMismatch: state.skippedMismatch,
        skippedCached: state.skippedCached,
        failed: state.failed,
        updatedAt: Date.now(),
      })
    );
  }

  // Counters/index only — does not wipe the blocked-ID cache.
  function resetProgress() {
    state.index = 0;
    state.blocked = 0;
    state.unblocked = 0;
    state.skippedAlready = 0;
    state.skippedMissing = 0;
    state.skippedMismatch = 0;
    state.skippedCached = 0;
    state.failed = 0;
    state.current = "";
    state.lastAction = "reset";
    state.lastDetail = "";
    saveProgress();
    render();
  }

  function clearBlockedCache() {
    state.blockedCache.clear();
    saveBlockedCache();
    log("blocked cache cleared");
    render();
  }

  // Pause-friendly delays
  let sleepCanceler = null;

  // Sleep that Pause can interrupt immediately (instead of waiting out 3–5s).
  function sleep(ms) {
    return new Promise((resolve) => {
      const id = setTimeout(() => {
        sleepCanceler = null;
        resolve();
      }, ms);
      sleepCanceler = () => {
        clearTimeout(id);
        sleepCanceler = null;
        resolve();
      };
    });
  }

  function abortSleep() {
    if (sleepCanceler) sleepCanceler();
  }

  function requestPause() {
    if (!state.running) return;
    state.stopping = true;
    state.lastAction = "pausing…";
    log("pause requested");
    abortSleep();
    render();
  }

  function isFinished() {
    return state.users.length > 0 && state.index >= state.users.length;
  }

  // idle → Start, running → Pause, paused mid-list → Resume, finished → Start
  function primaryMode() {
    if (state.running) return "pause";
    if (state.index > 0 && !isFinished()) return "resume";
    return "start";
  }

  function randDelay() {
    return DELAY_MIN_MS + Math.floor(Math.random() * (DELAY_MAX_MS - DELAY_MIN_MS + 1));
  }

  // X API helpers

  // CSRF token from the logged-in session cookie.
  function getCt0() {
    const hit = document.cookie
      .split(";")
      .map((s) => s.trim())
      .find((s) => s.startsWith("ct0="));
    if (!hit) throw new Error("Missing ct0 cookie — are you logged in on x.com?");
    return decodeURIComponent(hit.slice(4));
  }

  function authHeaders(formBody) {
    const h = {
      authorization: BEARER,
      "x-csrf-token": getCt0(),
      "x-twitter-auth-type": "OAuth2Session",
      "x-twitter-active-user": "yes",
      "x-twitter-client-language": "en",
      accept: "*/*",
    };
    h["content-type"] = formBody
      ? "application/x-www-form-urlencoded"
      : "application/json";
    return h;
  }

  // Cross-origin list download (bypasses page CORS via GM).
  function gmGet(url) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: "GET",
        url,
        anonymous: false,
        onload: (res) => resolve(res),
        onerror: (err) => reject(err),
        ontimeout: () => reject(new Error("timeout")),
      });
    });
  }

  async function fetchUserIds() {
    const res = await gmGet(LIST_URL);
    if (res.status < 200 || res.status >= 300) {
      throw new Error("List download failed: HTTP " + res.status);
    }
    return String(res.responseText || "")
      .split(/\r?\n/)
      .map((s) => normId(s))
      .filter(Boolean);
  }

  // Resolve a user ID → user object (handle + whether we already block them).
  async function lookupUser(userId) {
    try {
      const variables = { userId: String(userId), withSafetyModeUserFields: true };
      const url =
        "https://x.com/i/api/graphql/" +
        USER_BY_REST_ID +
        "/UserByRestId?variables=" +
        encodeURIComponent(JSON.stringify(variables)) +
        "&features=" +
        encodeURIComponent(JSON.stringify(FEATURES)) +
        "&fieldToggles=" +
        encodeURIComponent(JSON.stringify(FIELD_TOGGLES));

      const res = await pageFetch(url, {
        credentials: "include",
        headers: authHeaders(false),
      });
      const text = res.text;
      let json = null;
      try {
        json = JSON.parse(text);
      } catch (_) {}
      return { status: res.status, json, text };
    } catch (e) {
      throw new Error(friendlyError(e));
    }
  }

  // Actually create the block — only called after ID lookup.
  async function blockUserId(userId) {
    try {
      const res = await pageFetch("https://x.com/i/api/1.1/blocks/create.json", {
        method: "POST",
        credentials: "include",
        headers: authHeaders(true),
        body: "user_id=" + encodeURIComponent(userId),
      });
      const text = res.text;
      let json = null;
      try {
        json = JSON.parse(text);
      } catch (_) {}
      return { status: res.status, json, text };
    } catch (e) {
      throw new Error(friendlyError(e));
    }
  }

  // Remove a block — used when a cached ID is no longer on the list.
  async function unblockUserId(userId) {
    try {
      const res = await pageFetch("https://x.com/i/api/1.1/blocks/destroy.json", {
        method: "POST",
        credentials: "include",
        headers: authHeaders(true),
        body: "user_id=" + encodeURIComponent(userId),
      });
      const text = res.text;
      let json = null;
      try {
        json = JSON.parse(text);
      } catch (_) {}
      return { status: res.status, json, text };
    } catch (e) {
      throw new Error(friendlyError(e));
    }
  }

  function isRateLimited(status, json, text) {
    if (status === 429) return true;
    const blob = JSON.stringify(json || {}) + (text || "");
    return /rate.?limit|too many requests|StatusCode:429/i.test(blob);
  }

  function summarizeLookupFailure(look) {
    if (!look) return "no response";
    if (look.status === 401 || look.status === 403) {
      return "HTTP " + look.status + " (auth/cookie issue)";
    }
    const errs = look.json && look.json.errors;
    if (errs && errs.length) {
      return "HTTP " + look.status + " errors: " + JSON.stringify(errs).slice(0, 160);
    }
    const result =
      look.json &&
      look.json.data &&
      look.json.data.user &&
      look.json.data.user.result;
    if (result && result.__typename) {
      return "typename=" + result.__typename;
    }
    if (!look.json) return "HTTP " + look.status + " non-JSON: " + String(look.text || "").slice(0, 80);
    return "HTTP " + look.status + " empty user";
  }

  function extractScreenName(result) {
    if (!result) return "";
    if (result.legacy && result.legacy.screen_name) return result.legacy.screen_name;
    if (result.core && result.core.screen_name) return result.core.screen_name;
    return "";
  }

  function extractBlocking(result) {
    if (!result) return false;
    if (result.legacy && result.legacy.blocking === true) return true;
    if (
      result.relationship_perspectives &&
      result.relationship_perspectives.blocking === true
    ) {
      return true;
    }
    return false;
  }

  function extractUserId(result) {
    if (!result) return null;
    return result.rest_id || (result.legacy && result.legacy.id_str) || null;
  }

  // Sit out a full 15 minutes (or until Pause), then the caller retries the same user.
  async function waitOutRateLimit(reason) {
    state.rateLimited = true;
    state.lastAction = "rate_limit:" + reason;
    render();
    const until = Date.now() + RATE_LIMIT_WAIT_MS;
    while (Date.now() < until) {
      if (state.stopping) break;
      const left = Math.ceil((until - Date.now()) / 1000);
      state.lastAction = "rate_limit wait " + left + "s";
      render();
      await sleep(1000);
    }
    state.rateLimited = false;
  }

  // Per-ID pipeline
  // Returns how the main loop should advance:
  // advance / advance_fast / advance_cache / retry / paused_mid

  async function processOne(userId) {
    const id = normId(userId);
    state.current = id;
    state.lastDetail = "";

    // Local cache: IDs we already blocked / confirmed blocked — no API call.
    if (state.blockedCache.has(id)) {
      state.skippedCached++;
      state.lastAction = "skip_cached";
      log("skip cached id " + id);
      return "advance_cache";
    }

    state.lastAction = "lookup";
    log("lookup id " + id);
    render();

    const look = await lookupUser(id);
    if (isRateLimited(look.status, look.json, look.text)) {
      log("rate-limited on lookup id " + id + " — waiting 15m");
      await waitOutRateLimit("lookup");
      return "retry";
    }

    const result =
      look.json &&
      look.json.data &&
      look.json.data.user &&
      look.json.data.user.result;

    const handle = extractScreenName(result);
    const resolvedId = extractUserId(result);
    const label = userLabel(id, handle);

    if (
      !result ||
      result.__typename === "UserUnavailable" ||
      !resolvedId
    ) {
      // Do NOT cache missing — suspended accounts can return / list can change.
      state.skippedMissing++;
      state.lastAction = "skip_missing";
      state.lastDetail = summarizeLookupFailure(look);
      log("skip missing " + label + " — " + state.lastDetail);
      return "advance_fast";
    }

    // Safety: never block unless the API rest_id matches the list entry.
    if (normId(resolvedId) !== id) {
      state.skippedMismatch++;
      state.lastAction = "skip_mismatch:" + resolvedId;
      state.lastDetail = "";
      log("skip mismatch id " + id + " → id " + resolvedId);
      return "advance_fast";
    }

    state.current = handle ? "@" + handle : id;

    if (extractBlocking(result)) {
      rememberBlocked(id);
      state.skippedAlready++;
      state.lastAction = "skip_already";
      state.lastDetail = "";
      log("skip already blocked " + label);
      return "advance_fast";
    }

    // Pause was clicked during lookup — don't block; retry this index on resume.
    if (state.stopping) return "paused_mid";

    state.lastAction = "block";
    log("blocking " + label);
    render();

    const block = await blockUserId(id);
    if (isRateLimited(block.status, block.json, block.text)) {
      log("rate-limited on block " + label + " — waiting 15m");
      await waitOutRateLimit("block");
      return "retry";
    }

    const blockedName = block.json && block.json.screen_name;
    const blockedId =
      (block.json && (block.json.id_str || String(block.json.id || ""))) || "";
    if (
      block.status >= 200 &&
      block.status < 300 &&
      (!blockedId || normId(blockedId) === id)
    ) {
      rememberBlocked(id);
      state.blocked++;
      state.lastAction = "blocked";
      state.lastDetail = "";
      log("blocked " + userLabel(id, blockedName || handle));
      return "advance";
    }

    const errMsg = JSON.stringify((block.json && block.json.errors) || block.text || "").slice(
      0,
      200
    );
    if (/already|blocked/i.test(errMsg)) {
      rememberBlocked(id);
      state.skippedAlready++;
      state.lastAction = "skip_already_err";
      state.lastDetail = "";
      log("skip already blocked " + label + " (api)");
      return "advance_fast";
    }

    state.failed++;
    state.lastAction = "fail";
    state.lastDetail = "HTTP " + block.status + " " + errMsg;
    log("FAIL " + label + " — " + state.lastDetail);
    return "advance";
  }

  // Cache IDs that are no longer on the live list → candidates to unblock.
  function cacheIdsNotOnList() {
    const onList = new Set(state.users.map(normId));
    return Array.from(state.blockedCache).filter((u) => !onList.has(u));
  }

  // Unblock one cached ID that left the list. Same outcome codes as processOne.
  async function processUnblockOne(userId) {
    const id = normId(userId);
    state.current = id;
    state.lastDetail = "";
    state.lastAction = "lookup_unblock";
    log("lookup (unblock) id " + id);
    render();

    const look = await lookupUser(id);
    if (isRateLimited(look.status, look.json, look.text)) {
      log("rate-limited on unblock-lookup id " + id + " — waiting 15m");
      await waitOutRateLimit("unblock_lookup");
      return "retry";
    }

    const result =
      look.json &&
      look.json.data &&
      look.json.data.user &&
      look.json.data.user.result;

    const handle = extractScreenName(result);
    const resolvedId = extractUserId(result);
    const label = userLabel(id, handle);

    if (
      !result ||
      result.__typename === "UserUnavailable" ||
      !resolvedId
    ) {
      // Gone / unavailable — drop from cache; nothing left to unblock.
      forgetBlocked(id);
      state.lastAction = "unblock_skip_missing";
      state.lastDetail = summarizeLookupFailure(look);
      log("unblock skip missing " + label + " — dropped from cache");
      return "advance_fast";
    }

    if (normId(resolvedId) !== id) {
      forgetBlocked(id);
      state.lastAction = "unblock_skip_mismatch:" + resolvedId;
      log("unblock skip mismatch id " + id + " → id " + resolvedId + " — dropped from cache");
      return "advance_fast";
    }

    state.current = handle ? "@" + handle : id;

    if (!extractBlocking(result)) {
      forgetBlocked(id);
      state.lastAction = "unblock_already";
      log("already unblocked " + label + " — dropped from cache");
      return "advance_fast";
    }

    if (state.stopping) return "paused_mid";

    state.lastAction = "unblock";
    log("unblocking " + label);
    render();

    const unb = await unblockUserId(id);
    if (isRateLimited(unb.status, unb.json, unb.text)) {
      log("rate-limited on unblock " + label + " — waiting 15m");
      await waitOutRateLimit("unblock");
      return "retry";
    }

    const unblockedName = unb.json && unb.json.screen_name;
    const unblockedId =
      (unb.json && (unb.json.id_str || String(unb.json.id || ""))) || "";
    if (
      unb.status >= 200 &&
      unb.status < 300 &&
      (!unblockedId || normId(unblockedId) === id)
    ) {
      forgetBlocked(id);
      state.unblocked++;
      state.lastAction = "unblocked";
      state.lastDetail = "";
      log("unblocked " + userLabel(id, unblockedName || handle));
      return "advance";
    }

    const errMsg = JSON.stringify((unb.json && unb.json.errors) || unb.text || "").slice(
      0,
      200
    );
    if (/not blocking|you are not blocking|not blocked/i.test(errMsg)) {
      forgetBlocked(id);
      state.lastAction = "unblock_already_err";
      log("already unblocked " + label + " (api) — dropped from cache");
      return "advance_fast";
    }

    state.failed++;
    state.lastAction = "unblock_fail";
    state.lastDetail = "HTTP " + unb.status + " " + errMsg;
    log("FAIL unblock " + label + " — " + state.lastDetail);
    return "advance";
  }

  // Main loop

  async function runLoop() {
    if (state.running) return;

    // Finished list → start over from top (keeps blocked cache)
    if (isFinished()) {
      log("list finished — resetting progress to start again");
      resetProgress();
    }

    state.running = true;
    state.stopping = false;
    state.lastAction = "starting";
    log(
      "starting from index " +
        state.index +
        " · blocked-cache " +
        state.blockedCache.size
    );
    render();

    try {
      getCt0();
      if (!document.cookie.includes("ct0=")) {
        throw new Error("Not logged in (no ct0)");
      }

      // Always refresh so removals from the live list can be unblocked.
      state.lastAction = "downloading list";
      log("downloading ID list…");
      render();
      state.users = await fetchUserIds();
      log("loaded " + state.users.length + " user IDs");
      render();

      // Phase 1: unblock cached IDs that left the list (cache shrinks as we go).
      const removed = cacheIdsNotOnList();
      if (removed.length) {
        log("unban check — " + removed.length + " cached ID(s) no longer on list");
        for (let i = 0; i < removed.length; i++) {
          if (state.stopping) break;
          // Re-check: may already have been cleared on a prior resume.
          if (!state.blockedCache.has(normId(removed[i]))) continue;

          const userId = removed[i];
          let outcome;
          try {
            outcome = await processUnblockOne(userId);
          } catch (e) {
            state.failed++;
            state.lastAction = "unblock_exception";
            state.lastDetail = friendlyError(e).slice(0, 220);
            log("exception unblock id " + userId + " — " + state.lastDetail);
            outcome = "advance";
          }

          if (outcome === "retry") {
            i--; // same ID after rate-limit wait
            continue;
          }
          if (outcome === "paused_mid") break;

          saveProgress();
          render();

          if (state.stopping) break;

          let delay = randDelay();
          if (outcome === "advance_fast") delay = SKIP_DELAY_MS;
          await sleep(delay);
        }
      } else {
        log("unban check — none to unblock");
      }

      if (state.stopping) {
        state.lastAction = "paused";
        log("paused at index " + state.index);
        return;
      }

      // Phase 2: block remaining list entries from current index.
      while (state.index < state.users.length) {
        if (state.stopping) break;

        const userId = state.users[state.index];
        let outcome;
        try {
          outcome = await processOne(userId);
        } catch (e) {
          state.failed++;
          state.lastAction = "exception";
          state.lastDetail = friendlyError(e).slice(0, 220);
          log("exception id " + userId + " — " + state.lastDetail);
          outcome = "advance";
        }

        if (outcome === "retry") continue;
        if (outcome === "paused_mid") break; // same index on resume

        state.index++;
        saveProgress();
        render();

        if (state.stopping) break;

        let delay = randDelay();
        if (outcome === "advance_cache") delay = CACHE_SKIP_DELAY_MS;
        else if (outcome === "advance_fast") delay = SKIP_DELAY_MS;
        await sleep(delay);
      }

      state.lastAction = state.stopping ? "paused" : "finished";
      log(state.stopping ? "paused at index " + state.index : "finished");
    } catch (e) {
      state.lastAction = "error";
      state.lastDetail = friendlyError(e).slice(0, 220);
      log("error — " + state.lastDetail);
    } finally {
      state.running = false;
      state.stopping = false;
      state.current = "";
      abortSleep();
      saveProgress();
      render();
    }
  }

  function skippedTotal() {
    return (
      state.skippedAlready +
      state.skippedMissing +
      state.skippedMismatch +
      state.skippedCached
    );
  }

  function formatCount(n) {
    return Number(n).toLocaleString();
  }

  // Panel UI: position, minimize, drag
  function loadUi() {
    try {
      const raw = GM_getValue(UI_KEY, null);
      if (!raw) return null;
      return typeof raw === "string" ? JSON.parse(raw) : raw;
    } catch (_) {
      return null;
    }
  }

  function saveUi(panel) {
    if (!panel) return;
    const rect = panel.getBoundingClientRect();
    GM_setValue(
      UI_KEY,
      JSON.stringify({
        minimized: state.minimized,
        anchor: state.panelAnchor,
        left: Math.round(rect.left),
        right: Math.round(window.innerWidth - rect.right),
        top: Math.round(rect.top),
        bottom: Math.round(window.innerHeight - rect.bottom),
      })
    );
  }

  function preferBottomAnchor(panel) {
    const rect = panel.getBoundingClientRect();
    return rect.top + rect.height / 2 > window.innerHeight / 2;
  }

  // Snap to top+right or bottom+right so resize/collapse keeps the right edge put.
  function applyPanelAnchor(panel, forceAnchor) {
    const rect = panel.getBoundingClientRect();
    const anchor =
      forceAnchor || (preferBottomAnchor(panel) ? "bottom" : "top");
    state.panelAnchor = anchor;

    let right = window.innerWidth - rect.right;
    right = Math.max(8, Math.min(right, window.innerWidth - rect.width - 8));
    panel.style.left = "auto";

    if (anchor === "bottom") {
      const bottom = Math.max(
        8,
        Math.min(window.innerHeight - rect.bottom, window.innerHeight - rect.height - 8)
      );
      panel.style.top = "auto";
      panel.style.bottom = bottom + "px";
      panel.style.right = right + "px";
    } else {
      const top = Math.max(
        8,
        Math.min(rect.top, window.innerHeight - rect.height - 8)
      );
      panel.style.bottom = "auto";
      panel.style.top = top + "px";
      panel.style.right = right + "px";
    }
  }

  // Collapse / expand while pinning the top-right corner, then clamp on-screen.
  function setMinimized(panel, minimized) {
    const rect = panel.getBoundingClientRect();
    const pinRight = window.innerWidth - rect.right;
    const pinTop = rect.top;

    state.minimized = !!minimized;
    panel.classList.toggle("xbl-minimized", state.minimized);
    panel.style.width = state.minimized ? "200px" : "395px";
    void panel.offsetWidth;

    // Keep top-right fixed so the chip shrinks up-right (not down-left).
    panel.style.left = "auto";
    panel.style.bottom = "auto";
    panel.style.right = pinRight + "px";
    panel.style.top = pinTop + "px";
    state.panelAnchor = "top";

    // If the new size would leave the viewport, nudge it back in.
    applyPanelAnchor(panel, "top");

    const btn = panel.querySelector("[data-f=minmax]");
    if (btn) {
      btn.textContent = state.minimized ? "+" : "–";
      btn.title = state.minimized ? "Expand" : "Minimize";
      btn.setAttribute("aria-label", btn.title);
    }
    saveUi(panel);
    render();
  }

  function enablePanelDrag(panel) {
    const handle = panel.querySelector("[data-f=drag]");
    if (!handle) return;

    let dragging = false;
    let startX = 0;
    let startY = 0;
    let origLeft = 0;
    let origTop = 0;
    let moved = false;

    const onMove = (e) => {
      if (!dragging) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      if (Math.abs(dx) + Math.abs(dy) > 3) moved = true;
      const width = panel.offsetWidth;
      const height = panel.offsetHeight;
      let left = origLeft + dx;
      let top = origTop + dy;
      left = Math.max(8, Math.min(left, window.innerWidth - width - 8));
      top = Math.max(8, Math.min(top, window.innerHeight - height - 8));
      panel.style.right = "auto";
      panel.style.bottom = "auto";
      panel.style.left = left + "px";
      panel.style.top = top + "px";
    };

    const onUp = () => {
      if (!dragging) return;
      dragging = false;
      handle.classList.remove("xbl-dragging");
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      applyPanelAnchor(panel);
      saveUi(panel);
    };

    handle.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      if (e.target.closest("[data-f=minmax]")) return;
      dragging = true;
      moved = false;
      handle.classList.add("xbl-dragging");
      const rect = panel.getBoundingClientRect();
      panel.style.right = "auto";
      panel.style.bottom = "auto";
      panel.style.left = rect.left + "px";
      panel.style.top = rect.top + "px";
      startX = e.clientX;
      startY = e.clientY;
      origLeft = rect.left;
      origTop = rect.top;
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      e.preventDefault();
    });

    // Ignore click-to-toggle if the user was dragging.
    handle.addEventListener("click", (e) => {
      if (e.target.closest("[data-f=minmax]")) return;
      if (moved) {
        moved = false;
        return;
      }
      if (state.minimized) setMinimized(panel, false);
    });
  }

  // Refresh all the live bits of the panel (stats, buttons, mini status).
  function render() {
    const el = document.getElementById("x-block-list-panel");
    if (!el) return;
    const total = state.users.length || "?";
    const sub = el.querySelector("[data-f=subtitle]");
    if (sub) {
      const listBit = state.users.length
        ? formatCount(state.users.length) + " accounts · list by @levelsio"
        : "Live list by @levelsio";
      sub.textContent =
        listBit + " · cache " + formatCount(state.blockedCache.size);
    }
    el.querySelector("[data-f=stats]").textContent =
      "Blocked: " +
      state.blocked +
      "\nUnblocked: " +
      state.unblocked +
      "\nSkipped: " +
      skippedTotal() +
      " (already " +
      state.skippedAlready +
      ", missing " +
      state.skippedMissing +
      ", mismatch " +
      state.skippedMismatch +
      ", cached " +
      state.skippedCached +
      ")\nFailed: " +
      state.failed;
    el.querySelector("[data-f=progress]").textContent =
      "Progress: " +
      state.index +
      " / " +
      total +
      (state.current ? " — " + state.current : "");
    el.querySelector("[data-f=action]").textContent =
      "Status: " + state.lastAction + (state.lastDetail ? " — " + state.lastDetail : "");

    const mini = el.querySelector("[data-f=mini-status]");
    if (mini) {
      const mode = primaryMode();
      const modeLabel =
        mode === "pause" ? "running" : mode === "resume" ? "paused" : state.lastAction;
      mini.textContent =
        state.index +
        "/" +
        total +
        " · blocked " +
        state.blocked +
        " · unblocked " +
        state.unblocked +
        " · " +
        modeLabel;
    }

    const primary = el.querySelector("[data-f=primary]");
    const mode = primaryMode();
    if (primary) {
      primary.textContent =
        mode === "pause" ? "Pause" : mode === "resume" ? "Resume" : "Start";
      primary.classList.toggle("xbl-btn-primary", mode !== "pause");
      primary.classList.toggle("xbl-btn-warn", mode === "pause");
      primary.disabled = false;
    }
    el.querySelector("[data-f=reset]").disabled = state.running;
    el.querySelector("[data-f=clearcache]").disabled = state.running;
  }

  // Build the floating panel once (HTML + styles + button handlers).
  function ensurePanel() {
    if (document.getElementById("x-block-list-panel")) return;

    const panel = document.createElement("div");
    panel.id = "x-block-list-panel";
    panel.innerHTML = `
      <style>
        #x-block-list-panel .xbl-chrome {
          display: flex;
          align-items: flex-start;
          gap: 8px;
          margin: -2px -2px 0 0;
        }
        #x-block-list-panel .xbl-drag {
          flex: 1;
          min-width: 0;
          cursor: grab;
          user-select: none;
          padding-right: 4px;
        }
        #x-block-list-panel .xbl-drag.xbl-dragging {
          cursor: grabbing;
        }
        #x-block-list-panel .xbl-title {
          font: 600 13px/1.3 system-ui,sans-serif;
        }
        #x-block-list-panel .xbl-mini-status {
          display: none;
          margin-top: 2px;
          font: 11px/1.35 system-ui,sans-serif;
          opacity: .7;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        #x-block-list-panel.xbl-minimized .xbl-mini-status {
          display: block;
        }
        #x-block-list-panel.xbl-minimized .xbl-body {
          display: none;
        }
        #x-block-list-panel.xbl-minimized {
          width: 200px;
          max-width: calc(100vw - 24px);
          padding: 8px 10px;
        }
        #x-block-list-panel.xbl-minimized .xbl-title {
          font-size: 12px;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        #x-block-list-panel button.xbl-minmax {
          flex: 0 0 auto;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          width: 24px;
          height: 24px;
          margin-top: -1px;
          padding: 0;
          border: none;
          border-radius: 6px;
          background: transparent;
          color: rgba(255,255,255,.45);
          font: 500 15px/1 system-ui,sans-serif;
          cursor: pointer;
        }
        #x-block-list-panel button.xbl-minmax:hover {
          background: rgba(255,255,255,.08);
          color: rgba(255,255,255,.9);
        }
        #x-block-list-panel .xbl-actions {
          display: grid;
          grid-template-columns: 1.35fr 1fr;
          gap: 8px;
          margin-bottom: 2px;
        }
        #x-block-list-panel .xbl-actions-secondary {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 8px;
          margin-top: 8px;
        }
        #x-block-list-panel button.xbl-btn {
          appearance: none;
          border: 1px solid rgba(255,255,255,.14);
          border-radius: 8px;
          padding: 8px 10px;
          font: 600 12px/1.2 system-ui,sans-serif;
          color: #fff;
          background: rgba(255,255,255,.08);
          cursor: pointer;
          transition: background .15s ease, border-color .15s ease, opacity .15s ease, transform .1s ease;
        }
        #x-block-list-panel button.xbl-btn:hover:not(:disabled) {
          background: rgba(255,255,255,.14);
          border-color: rgba(255,255,255,.28);
        }
        #x-block-list-panel button.xbl-btn:active:not(:disabled) {
          transform: translateY(1px);
        }
        #x-block-list-panel button.xbl-btn:disabled {
          opacity: .38;
          cursor: not-allowed;
        }
        #x-block-list-panel button.xbl-btn-primary {
          background: #1d9bf0;
          border-color: #1d9bf0;
          color: #fff;
        }
        #x-block-list-panel button.xbl-btn-primary:hover:not(:disabled) {
          background: #1a8cd8;
          border-color: #1a8cd8;
        }
        #x-block-list-panel button.xbl-btn-danger {
          background: rgba(244, 33, 46, .12);
          border-color: rgba(244, 33, 46, .35);
          color: #ff8a93;
        }
        #x-block-list-panel button.xbl-btn-danger:hover:not(:disabled) {
          background: rgba(244, 33, 46, .2);
          border-color: rgba(244, 33, 46, .5);
        }
        #x-block-list-panel button.xbl-btn-warn {
          background: rgba(255, 212, 0, .14);
          border-color: rgba(255, 212, 0, .4);
          color: #ffe566;
        }
        #x-block-list-panel button.xbl-btn-warn:hover:not(:disabled) {
          background: rgba(255, 212, 0, .22);
          border-color: rgba(255, 212, 0, .55);
        }
        #x-block-list-panel a.xbl-link {
          color: #8ecfff;
          text-decoration: none;
        }
        #x-block-list-panel a.xbl-link:hover {
          text-decoration: underline;
        }
      </style>
      <div class="xbl-chrome">
        <div class="xbl-drag" data-f="drag" title="Drag to move">
          <div class="xbl-title">Blocked for AI Reply</div>
          <div class="xbl-mini-status" data-f="mini-status"></div>
        </div>
        <button type="button" class="xbl-minmax" data-f="minmax" title="Minimize" aria-label="Minimize">–</button>
      </div>
      <div class="xbl-body" data-f="body">
        <div data-f="subtitle" style="font:11px/1.35 system-ui,sans-serif;margin:6px 0 8px;opacity:.7">
          Live list by @levelsio
        </div>
        <div data-f="progress" style="font:12px/1.4 system-ui,sans-serif;margin-bottom:4px"></div>
        <div data-f="stats" style="font:12px/1.45 system-ui,sans-serif;margin-bottom:4px;white-space:pre-line"></div>
        <div data-f="action" style="font:12px/1.4 system-ui,sans-serif;margin-bottom:10px;opacity:.85;word-break:break-word"></div>
        <div class="xbl-actions">
          <button data-f="primary" class="xbl-btn xbl-btn-primary">Start</button>
          <button data-f="reset" class="xbl-btn xbl-btn-danger">Reset</button>
        </div>
        <div class="xbl-actions-secondary">
          <button data-f="clearcache" class="xbl-btn">Clear cache</button>
          <button data-f="clearlog" class="xbl-btn">Clear log</button>
        </div>
        <div style="font:11px/1.35 system-ui,sans-serif;margin-top:10px;opacity:.75">
          Blocks by user ID (rename-safe); unblocks cached IDs removed from the list. Stay on x.com while it runs. Reset keeps your blocked cache.
        </div>
        <div style="font:10px/1.4 system-ui,sans-serif;margin-top:6px;opacity:.65">
          Created by <a class="xbl-link" href="https://x.com/glaurossii" target="_blank" rel="noopener noreferrer">@glaurossi</a>
          · blocklist by <a class="xbl-link" href="https://x.com/levelsio" target="_blank" rel="noopener noreferrer">@levelsio</a>
        </div>
        <pre data-f="log" style="
          margin:8px 0 0;
          padding:8px;
          height:140px;
          overflow:auto;
          resize:vertical;
          font:11px/1.4 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
          background:#0b0b0b;
          color:#b6f5c8;
          border:1px solid #222;
          border-radius:6px;
          white-space:pre-wrap;
          word-break:break-word;
        ">ready.</pre>
      </div>
    `;
    Object.assign(panel.style, {
      position: "fixed",
      right: "12px",
      bottom: "12px",
      zIndex: "2147483646",
      width: "395px",
      maxWidth: "calc(100vw - 24px)",
      padding: "12px",
      borderRadius: "12px",
      background: "rgba(0,0,0,.92)",
      color: "#fff",
      boxShadow: "0 8px 28px rgba(0,0,0,.35)",
      border: "1px solid rgba(255,255,255,.08)",
    });

    panel.querySelector("[data-f=minmax]").addEventListener("click", (e) => {
      e.stopPropagation();
      setMinimized(panel, !state.minimized);
    });
    panel.querySelector("[data-f=primary]").addEventListener("click", () => {
      if (state.running) requestPause();
      else runLoop();
    });
    panel.querySelector("[data-f=reset]").addEventListener("click", () => {
      if (state.running) return;
      if (
        confirm(
          "Reset progress counters and start index to 0?\n\nYour blocked-ID cache is kept so re-runs stay fast."
        )
      ) {
        resetProgress();
        log("progress reset (blocked cache kept: " + state.blockedCache.size + ")");
      }
    });
    panel.querySelector("[data-f=clearcache]").addEventListener("click", () => {
      if (state.running) return;
      if (
        confirm(
          "Clear the local blocked cache (" +
            state.blockedCache.size +
            " IDs)?\n\nNext run will re-lookup those accounts."
        )
      ) {
        clearBlockedCache();
      }
    });
    panel.querySelector("[data-f=clearlog]").addEventListener("click", () => {
      state.logLines = [];
      const box = panel.querySelector("[data-f=log]");
      if (box) box.textContent = "log cleared.";
    });

    document.documentElement.appendChild(panel);
    enablePanelDrag(panel);

    const saved = loadUi();
    if (saved) {
      state.panelAnchor = saved.anchor === "bottom" ? "bottom" : "top";
      panel.style.left = "auto";
      if (typeof saved.right === "number") {
        panel.style.right = saved.right + "px";
      } else if (typeof saved.left === "number") {
        // Older saves used left; convert on the fly.
        panel.style.left = saved.left + "px";
        panel.style.right = "auto";
      }
      if (state.panelAnchor === "bottom") {
        panel.style.top = "auto";
        panel.style.bottom =
          typeof saved.bottom === "number" ? saved.bottom + "px" : "12px";
      } else {
        panel.style.bottom = "auto";
        panel.style.top = typeof saved.top === "number" ? saved.top + "px" : "12px";
      }
      if (saved.minimized) setMinimized(panel, true);
      else applyPanelAnchor(panel, state.panelAnchor);
    } else {
      applyPanelAnchor(panel, "bottom");
    }

    log("panel ready · cache " + state.blockedCache.size);
    render();
  }

  // Boot--

  loadBlockedCache();
  loadProgress();
  ensurePanel();

  // Also expose the main actions from Tampermonkey's menu.
  GM_registerMenuCommand("Blocked for AI Reply: Start / Resume", () => {
    if (!state.running) runLoop();
  });
  GM_registerMenuCommand("Blocked for AI Reply: Pause", () => {
    requestPause();
  });
  GM_registerMenuCommand("Blocked for AI Reply: Reset progress", () => {
    if (!state.running) resetProgress();
  });
  GM_registerMenuCommand("Blocked for AI Reply: Clear blocked cache", () => {
    if (!state.running) clearBlockedCache();
  });
})();
