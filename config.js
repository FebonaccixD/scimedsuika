/* =============================================================================
   CONFIG — every tunable value in the app lives in this one object.
   Phase 2 adds the game section (radii, gravity, restitution, friction,
   spawn weights, cooldown, grace period, score table) to this same object.
   Nothing tunable is allowed to live anywhere else.

   Plain script (not an ES module) so the app also works when opened over
   file:// for local testing. Loaded before app.js in index.html.
============================================================================= */

const CONFIG = {

  /* ---- endpoints — paste real values per README-deploy.md ---------------- */
  endpoints: {
    // Apps Script web app URL, ends in /exec
    appsScriptUrl: "https://script.google.com/macros/s/AKfycbwgR-zTtKJi_oiiqa1FdebX-zRSOM2rBzeI3nWV0oiW4lCur9NIBzIGOI-o2m5LRWCS/exec",

    // Shadow Google Form. actionUrl is the form's /formResponse URL.
    // fieldIds map payload keys to the form's entry.NNNNNNN ids.
    // Set actionUrl to "" to disable the shadow write (e.g. before the form exists).
    shadowForm: {
      actionUrl: "https://docs.google.com/forms/d/e/1FAIpQLScYqCf-qNZu4OUlrrWyEFGByyR37HfCHZQBXqyX-oC4P3_Rzg/formResponse",
      fieldIds: {
        lead_id:          "entry.706679058",
        name:             "entry.1847444450",
        company:          "entry.1238154531",
        email:            "entry.1054621099",
        product_interest: "entry.1137125183",
        position:         "entry.1891734544",
        phone:            "entry.1437549258",
        consent_version:  "entry.2032351118"
      }
    }
  },

  /* ---- shared secret — must match SHARED_SECRET in apps-script/Code.gs --- */
  sharedSecret: "4f41525f89298dfff683399893dedefd4540627dc991962e",

  /* ---- consent ----------------------------------------------------------- */
  consentVersion: "v1-2026-08",

  /* ---- form -------------------------------------------------------------- */
  productInterestOptions: [
    "Sterilisation & decontamination (STERIS)",
    "Labware & consumables (Corning)",
    "Cleanroom consumables (Hydroflex)",
    "Plate readers & liquid handling (Tecan)",
    "Bioreactors & incubation (Infors)",
    "Cold storage (PHCbi)",
    "Other / just browsing"
  ],

  /* ---- submit behaviour --------------------------------------------------
     requestTimeoutMs   per-request abort on the primary write
     stillSavingAfterMs total elapsed time before the "still saving" screen
     silentRetryDelaysMs delays between the fast silent retries (quick
                         failures only — a hung request eats the whole 10s)
     backoffDelaysMs    delays once in "still saving"; last value repeats  */
  submit: {
    requestTimeoutMs: 10000,
    stillSavingAfterMs: 10000,
    silentRetryDelaysMs: [1000, 2000],
    backoffDelaysMs: [5000, 10000, 20000, 30000]
  },

  /* ---- outbox — safety net only, never a dependency ---------------------- */
  outboxKey: "scimed-booth-outbox-v1",

  /* ---- in-app browser detection ------------------------------------------
     UA substrings that identify webviews known to break localStorage / PWA.
     Matching shows the "open in browser" interstitial (continue allowed). */
  inAppBrowserTokens: [
    "FBAN", "FBAV", "FB_IAB",        // Facebook
    "Instagram",
    "LinkedInApp",
    "MicroMessenger",                 // WeChat
    "Line/",
    "TikTok", "musical_ly",
    "GSA/",                           // Google app iOS
    "; wv)"                           // generic Android WebView marker
  ],

  /* ---- debug ------------------------------------------------------------- */
  // Debug panel (phase 2) activates at ?debug=1. Phase 1 only logs verbosely.
  debugParam: "debug"
};
