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
  // ?debug=1 enables verbose logging and the game debug panel
  // (spawn any tier, collision wireframes, FPS, force game over / win).
  debugParam: "debug",

  /* ==== GAME — every tunable value, per design doc section 5 ==============
     All values are STARTING values with test plans in the design doc.
     Tuning days 7-9 happens in this block and nowhere else.               */
  game: {
    /* container, logical units; canvas scales to fit, no device advantage */
    container: {
      width: 380,
      height: 640,
      dropZoneBottom: 100,   // drop zone = top 100
      heldY: 60,             // held item rest position
      dangerY: 120           // loss line
    },

    /* physics */
    physics: {
      gravityY: 1.0,
      restitution: 0.1,
      friction: 0.3,
      frictionStatic: 0.5,
      frictionAir: 0.010,
      density: 0.001         // constant across tiers: bigger = heavier by area
    },

    /* tier ladder: radius (logical px), product, brand.
       7 tiers over the same container: ratio steepened to ~1.45 (from the
       9-tier 1.32) so the win still takes 5-8 minutes, per the doc's logic. */
    tiers: [
      { radius: 18,  name: "Falcon tube",    brand: "Corning" },
      { radius: 26,  name: "Spor-Klenz RTU", brand: "STERIS" },
      { radius: 38,  name: "Cleanroom mop",  brand: "Hydroflex" },
      { radius: 55,  name: "Plate reader",   brand: "Tecan" },
      { radius: 80,  name: "Bioreactor",     brand: "Infors" },
      { radius: 116, name: "ULT freezer",    brand: "PHCbi" },
      { radius: 168, name: "SciMed logo",    brand: "SciMed" }
    ],
    // artwork swap path: /assets/tier-01.png .. /assets/tier-07.png
    tierImagePath: function (i) { return "assets/tier-0" + (i + 1) + ".png"; },

    /* drops: tiers 1-3 only — a plate reader is built, never dropped */
    spawnWeights: [45, 35, 20],
    dropCooldownMs: 350,

    /* scoring: per-merge score by the tier the merge CREATES (user-set).
       Index 0 (T1) is unreachable — nothing merges into tier 1. */
    mergeScores: [20, 28, 39, 55, 77, 108, 151],
    // cascade bonus: merge score x chain position since last drop, capped
    cascadeCapX: 5,

    /* win / loss */
    graceMs: 2000,             // continuous time above danger line to lose
    stillSpeed: 0.2,           // below this counts as "near-zero velocity"
    mergesPerStepCap: 10,      // runaway-cascade safety valve

    /* attempts */
    maxAttempts: 3,

    /* performance */
    bodyCountCap: 130,         // hard cap; drops locked while at cap

    /* feel */
    popMs: 180,                // merge scale-pop duration
    particleCount: 12,         // per merge burst (0 disables)
    toastMs: 1200              // product-name toast per merge
  }
};
