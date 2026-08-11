/* =============================================================================
   Phase 1 — capture path.
   Invariants, in priority order:
   1. Submit blocks on a confirmed server write. No optimistic success.
   2. lead_id is generated client-side before submit; the server upserts on it,
      so retries and typo fixes can never create a second row.
   3. localStorage is an outbox only — a safety net wrapped in try/catch,
      never a dependency. Storage failure must not stop a submit.
   4. The shadow Google Form write fires in parallel with the primary on every
      attempt, so the backup lands even if the primary hangs on attempt one.
============================================================================= */
(function () {
  "use strict";

  /* ---- lead_id ------------------------------------------------------------
     crypto.randomUUID needs a secure context and Safari >= 15.4; older
     Android webviews (the in-app browser population) lack it entirely.
     Fallback chain ends at Math.random, which is collision-safe enough
     for < 300 leads and infinitely better than a crash. */
  function generateLeadId() {
    try {
      if (window.crypto && typeof crypto.randomUUID === "function") {
        return crypto.randomUUID();
      }
    } catch (e) { /* fall through */ }
    try {
      if (window.crypto && typeof crypto.getRandomValues === "function") {
        var b = crypto.getRandomValues(new Uint8Array(16));
        b[6] = (b[6] & 0x0f) | 0x40;
        b[8] = (b[8] & 0x3f) | 0x80;
        var h = [];
        for (var i = 0; i < 16; i++) h.push((b[i] + 0x100).toString(16).slice(1));
        return h.slice(0, 4).join("") + "-" + h.slice(4, 6).join("") + "-" +
               h.slice(6, 8).join("") + "-" + h.slice(8, 10).join("") + "-" +
               h.slice(10).join("");
      }
    } catch (e) { /* fall through */ }
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, function (c) {
      var r = (Math.random() * 16) | 0;
      return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
    });
  }

  /* ---- outbox — every touch wrapped, failure is always non-fatal ---------- */
  var outbox = {
    write: function (payload) {
      try { localStorage.setItem(CONFIG.outboxKey, JSON.stringify(payload)); }
      catch (e) { debugLog("outbox write failed (non-fatal)", e); }
    },
    read: function () {
      try {
        var raw = localStorage.getItem(CONFIG.outboxKey);
        return raw ? JSON.parse(raw) : null;
      } catch (e) { return null; }
    },
    clear: function () {
      try { localStorage.removeItem(CONFIG.outboxKey); }
      catch (e) { /* non-fatal */ }
    }
  };

  function debugLog() {
    try {
      var q = new URLSearchParams(location.search);
      if (q.get(CONFIG.debugParam)) console.log.apply(console, ["[capture]"].concat([].slice.call(arguments)));
    } catch (e) { /* never let logging break the flow */ }
  }

  /* ---- screens ------------------------------------------------------------ */
  var screens = ["inapp", "form", "saving", "still-saving", "confirm",
                 "game-intro", "game", "game-end", "postgame", "leaderboard"];
  function showScreen(name) {
    screens.forEach(function (s) {
      document.getElementById("screen-" + s).hidden = (s !== name);
    });
    window.scrollTo(0, 0);
  }
  window.showScreen = showScreen;           // game.js drives its own screens
  window.getLeadId = function () { return leadId; };  // game results key on it

  /* ---- in-app browser detection (screen 16) ------------------------------- */
  function isInAppBrowser() {
    var ua = navigator.userAgent || "";
    return CONFIG.inAppBrowserTokens.some(function (t) { return ua.indexOf(t) !== -1; });
  }

  /* ---- form --------------------------------------------------------------- */
  var leadId = null;

  function el(id) { return document.getElementById(id); }

  function populateProductOptions() {
    var select = el("in-product");
    CONFIG.productInterestOptions.forEach(function (opt) {
      var o = document.createElement("option");
      o.value = opt;
      o.textContent = opt;
      select.appendChild(o);
    });
  }

  function setFieldValidity(fieldName, ok) {
    var wrap = document.querySelector('.field[data-field="' + fieldName + '"]');
    if (wrap) wrap.classList.toggle("invalid", !ok);
    return ok;
  }

  // Deliberately permissive: catches "no @" and "no dot after @", nothing more.
  // The confirmation echo is the real typo defence.
  var EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  function validate() {
    var ok = true;
    ok = setFieldValidity("name", el("in-name").value.trim().length > 0) && ok;
    ok = setFieldValidity("company", el("in-company").value.trim().length > 0) && ok;
    ok = setFieldValidity("email", EMAIL_RE.test(el("in-email").value.trim())) && ok;
    ok = setFieldValidity("product_interest", el("in-product").value !== "") && ok;
    return ok;
  }

  function collectPayload() {
    return {
      lead_id: leadId,
      name: el("in-name").value.trim(),
      company: el("in-company").value.trim(),
      email: el("in-email").value.trim(),
      product_interest: el("in-product").value,
      position: el("in-position").value.trim(),
      phone: el("in-phone").value.trim(),
      consent_version: CONFIG.consentVersion,
      secret: CONFIG.sharedSecret
    };
  }

  function refillForm(payload) {
    el("in-name").value = payload.name || "";
    el("in-company").value = payload.company || "";
    el("in-email").value = payload.email || "";
    el("in-product").value = payload.product_interest || "";
    el("in-position").value = payload.position || "";
    el("in-phone").value = payload.phone || "";
  }

  /* ---- shadow write -------------------------------------------------------
     Fire-and-forget to the Google Form on EVERY attempt, in parallel with
     the primary. Response is opaque (no-cors) by design; duplicates in the
     shadow sheet are expected and fine — rows carry lead_id. */
  function fireShadowWrite(payload) {
    var cfg = CONFIG.endpoints.shadowForm;
    if (!cfg || !cfg.actionUrl) return;
    try {
      var body = new URLSearchParams();
      Object.keys(cfg.fieldIds).forEach(function (key) {
        if (payload[key] !== undefined) body.append(cfg.fieldIds[key], payload[key]);
      });
      fetch(cfg.actionUrl, {
        method: "POST",
        mode: "no-cors",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: body.toString()
      }).catch(function (e) { debugLog("shadow write failed (non-fatal)", e); });
    } catch (e) { debugLog("shadow write threw (non-fatal)", e); }
  }

  /* ---- primary write ------------------------------------------------------
     text/plain body keeps it a CORS "simple request" — Apps Script cannot
     answer a preflight. Success means HTTP 200 AND a JSON body echoing
     {ok: true, lead_id: <ours>}. Anything else is a failure. */
  function attemptPrimaryWrite(payload) {
    var controller = ("AbortController" in window) ? new AbortController() : null;
    var timer = controller
      ? setTimeout(function () { controller.abort(); }, CONFIG.submit.requestTimeoutMs)
      : null;

    return fetch(CONFIG.endpoints.appsScriptUrl, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify(payload),
      signal: controller ? controller.signal : undefined
    }).then(function (res) {
      if (!res.ok) throw new Error("HTTP " + res.status);
      return res.json();
    }).then(function (json) {
      if (!json || json.ok !== true || json.lead_id !== payload.lead_id) {
        throw new Error("server did not confirm: " + JSON.stringify(json));
      }
      return json;
    }).finally(function () {
      if (timer) clearTimeout(timer);
    });
  }

  function sleep(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }

  /* ---- submit loop --------------------------------------------------------
     Runs until confirmed, forever. Timeline:
       t=0        attempt 1 (shadow fires in parallel)
       fast fail  silent retries after silentRetryDelaysMs waits
       t=10s      "still saving" screen appears (a hung request times out
                  here too, so the screens and the abort coincide)
       after      retries continue behind the screen at backoffDelaysMs,
                  last delay repeating, shadow refiring each time. */
  var submitting = false;

  function runSubmitLoop(payload) {
    if (submitting) return;
    submitting = true;

    outbox.write(payload);       // safety net; failure logged and ignored
    showScreen("saving");

    var stillSavingTimer = setTimeout(function () {
      if (submitting) showScreen("still-saving");
    }, CONFIG.submit.stillSavingAfterMs);

    var attempt = 0;

    function nextDelay() {
      var silent = CONFIG.submit.silentRetryDelaysMs;
      var backoff = CONFIG.submit.backoffDelaysMs;
      // attempt has already been incremented; attempt 1 failed -> index 0
      var failedIndex = attempt - 1;
      if (failedIndex < silent.length) return silent[failedIndex];
      var b = failedIndex - silent.length;
      return backoff[Math.min(b, backoff.length - 1)];
    }

    function loop() {
      attempt += 1;
      debugLog("attempt", attempt);
      fireShadowWrite(payload);                    // parallel, every attempt
      attemptPrimaryWrite(payload).then(function () {
        debugLog("confirmed on attempt", attempt);
        clearTimeout(stillSavingTimer);
        submitting = false;
        outbox.clear();
        el("confirm-email").textContent = payload.email;
        showScreen("confirm");
      }).catch(function (err) {
        debugLog("attempt " + attempt + " failed:", err && err.message);
        sleep(nextDelay()).then(loop);
      });
    }
    loop();
  }

  /* ---- wiring ------------------------------------------------------------- */
  function init() {
    populateProductOptions();

    el("btn-submit").addEventListener("click", function () {
      if (!validate()) {
        var firstInvalid = document.querySelector(".field.invalid input, .field.invalid select");
        if (firstInvalid) firstInvalid.focus();
        return;
      }
      runSubmitLoop(collectPayload());
    });

    // Typo fix: back to the form with the same lead_id. The server upserts,
    // so resubmitting updates the row instead of duplicating it.
    el("btn-fix-typo").addEventListener("click", function () {
      showScreen("form");
    });

    el("btn-continue-anyway").addEventListener("click", function () {
      showScreen("form");
    });

    // Resume: an outbox entry on load means a submit never confirmed
    // (page was reloaded or the tab was killed mid-save). Pick it up.
    var pending = outbox.read();
    if (pending && pending.lead_id) {
      leadId = pending.lead_id;
      refillForm(pending);
      debugLog("resuming unconfirmed submit", leadId);
      runSubmitLoop(pending);
      return;
    }

    leadId = generateLeadId();
    debugLog("lead_id", leadId);

    showScreen(isInAppBrowser() ? "inapp" : "form");
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
