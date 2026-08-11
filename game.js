/* =============================================================================
   Phase 2 — merge game. Requires config.js, vendor/matter.min.js, app.js.
   All tunable values come from CONFIG.game; nothing numeric lives here that
   a tuner would want to touch.

   Flow: confirmation -> game-intro -> game -> game-end (win or loss)
         -> play again (attempts left) or post-game screen.
   Results POST to the Apps Script endpoint with action:"game"; the server
   enforces the 3-attempt cap and keeps the best result.
============================================================================= */
(function () {
  "use strict";

  var G = CONFIG.game;
  var M = window.Matter;

  /* ---- assets ------------------------------------------------------------ */
  var tierImages = G.tiers.map(function (_, i) {
    var img = new Image();
    img.src = G.tierImagePath(i);
    return img;
  });

  /* ---- debug ------------------------------------------------------------- */
  var DEBUG = false;
  try { DEBUG = !!new URLSearchParams(location.search).get(CONFIG.debugParam); } catch (e) {}

  /* ---- state ------------------------------------------------------------- */
  var engine = null, world = null;
  var running = false;          // physics + timer active
  var runOver = false;
  var heldTier = 0, nextTier = 0, heldX = G.container.width / 2;
  var lastDropAt = 0, lastDropped = null;
  var score = 0, chainSinceDrop = 0;
  var highestTier = 0;          // 0-based index of highest tier reached
  var runAccumMs = 0, segStart = 0;   // timer with pause support
  var attemptsUsed = 0;         // best known; server is authoritative
  var bestScore = 0, everWon = false, sessionBestTier = 0;
  var particles = [], pops = [], toasts = [];
  var showWireframes = false;
  var fps = 0, fpsFrames = 0, fpsLast = 0;
  var reducedMotion = false;
  try { reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches; } catch (e) {}

  var canvas, ctx, dpr = Math.max(1, window.devicePixelRatio || 1);

  function el(id) { return document.getElementById(id); }
  function now() { return performance.now(); }
  function runElapsed() { return runOver || !running ? runAccumMs : runAccumMs + (now() - segStart); }

  /* ---- timer pause on backgrounding (design doc 5.6) --------------------- */
  document.addEventListener("visibilitychange", function () {
    if (!engine || runOver) return;
    if (document.hidden && running) {
      runAccumMs += now() - segStart;
      running = false;
    } else if (!document.hidden && !running) {
      segStart = now();
      running = true;
    }
  });

  /* ---- spawn tier picker ------------------------------------------------- */
  function pickSpawnTier() {
    var total = G.spawnWeights.reduce(function (a, b) { return a + b; }, 0);
    var r = Math.random() * total;
    for (var i = 0; i < G.spawnWeights.length; i++) {
      r -= G.spawnWeights[i];
      if (r <= 0) return i;
    }
    return 0;
  }

  /* ---- physics setup ----------------------------------------------------- */
  function makeBody(tier, x, y, vx, vy) {
    var body = M.Bodies.circle(x, y, G.tiers[tier].radius, {
      restitution: G.physics.restitution,
      friction: G.physics.friction,
      frictionStatic: G.physics.frictionStatic,
      frictionAir: G.physics.frictionAir,
      density: G.physics.density
    });
    body.plugin.tier = tier;
    body.plugin.aboveMs = 0;
    body.plugin.born = now();
    if (vx || vy) M.Body.setVelocity(body, { x: vx, y: vy });
    return body;
  }

  function setupEngine() {
    engine = M.Engine.create();
    engine.gravity.y = G.physics.gravityY;
    world = engine.world;
    var w = G.container.width, h = G.container.height, t = 60; // wall thickness
    M.Composite.add(world, [
      M.Bodies.rectangle(w / 2, h + t / 2, w + t * 2, t, { isStatic: true }),   // floor
      M.Bodies.rectangle(-t / 2, h / 2, t, h * 2, { isStatic: true }),          // left
      M.Bodies.rectangle(w + t / 2, h / 2, t, h * 2, { isStatic: true })        // right
    ]);
    M.Events.on(engine, "collisionStart", onCollisions);
  }

  /* ---- merging ----------------------------------------------------------- */
  var mergeQueue = [];
  function onCollisions(evt) {
    for (var i = 0; i < evt.pairs.length; i++) {
      var a = evt.pairs[i].bodyA, b = evt.pairs[i].bodyB;
      if (a.isStatic || b.isStatic) continue;
      if (a.plugin.tier === undefined || a.plugin.tier !== b.plugin.tier) continue;
      mergeQueue.push([a, b]);
    }
  }

  function processMerges() {
    var merges = 0;
    var consumed = {};
    while (mergeQueue.length && merges < G.mergesPerStepCap) {
      var pair = mergeQueue.shift();
      var a = pair[0], b = pair[1];
      // earliest pair wins; a body already merged this step leaves the odd one out
      if (consumed[a.id] || consumed[b.id]) continue;
      if (!M.Composite.get(world, a.id, "body") || !M.Composite.get(world, b.id, "body")) continue;
      consumed[a.id] = consumed[b.id] = true;
      merges++;

      var tier = a.plugin.tier;
      var nx = (a.position.x + b.position.x) / 2;
      var ny = (a.position.y + b.position.y) / 2;
      var vx = (a.velocity.x + b.velocity.x) / 2;
      var vy = (a.velocity.y + b.velocity.y) / 2;
      M.Composite.remove(world, a);
      M.Composite.remove(world, b);

      var newTier = tier + 1;
      chainSinceDrop++;
      var mult = Math.min(chainSinceDrop, G.cascadeCapX);
      score += G.mergeScores[newTier] * mult;
      if (newTier > highestTier) highestTier = newTier;

      spawnFeedback(nx, ny, newTier, mult);

      if (newTier === G.tiers.length - 1) {
        // tier 9, the SciMed logo: run ends immediately on the first logo
        var winBody = makeBody(newTier, nx, Math.min(ny, G.container.height - G.tiers[newTier].radius), 0, 0);
        M.Composite.add(world, winBody);
        endRun(true);
        return;
      }
      M.Composite.add(world, makeBody(newTier, nx, ny, vx, vy));
    }
    mergeQueue.length = 0;
  }

  /* ---- feedback: two visual channels minimum (pop + burst) + name toast -- */
  function spawnFeedback(x, y, tier, mult) {
    pops.push({ x: x, y: y, tier: tier, at: now() });
    if (!reducedMotion) {
      for (var i = 0; i < G.particleCount; i++) {
        var ang = (Math.PI * 2 * i) / G.particleCount;
        var sp = 2 + Math.random() * 3;
        particles.push({ x: x, y: y, vx: Math.cos(ang) * sp, vy: Math.sin(ang) * sp, life: 1 });
      }
    }
    var t = G.tiers[tier];
    toasts.push({ text: t.name + (mult > 1 ? "  x" + mult : ""), at: now() });
    if (toasts.length > 3) toasts.shift();
  }

  /* ---- drop -------------------------------------------------------------- */
  function dropZoneClear() {
    if (!lastDropped) return true;
    if (!M.Composite.get(world, lastDropped.id, "body")) return true; // merged away
    return lastDropped.bounds.min.y > G.container.dropZoneBottom;
  }

  function bodyCount() {
    return M.Composite.allBodies(world).filter(function (b) { return !b.isStatic; }).length;
  }

  function tryDrop(x) {
    if (!running || runOver) return;
    var t = now();
    if (t - lastDropAt < G.dropCooldownMs) return;
    if (!dropZoneClear()) return;
    if (bodyCount() >= G.bodyCountCap) return;
    var r = G.tiers[heldTier].radius;
    heldX = Math.max(r, Math.min(G.container.width - r, x));
    var body = makeBody(heldTier, heldX, G.container.heldY, 0, 0);
    M.Composite.add(world, body);
    lastDropped = body;
    lastDropAt = t;
    chainSinceDrop = 0;
    heldTier = nextTier;
    nextTier = pickSpawnTier();
    updateHud();
  }

  /* ---- loss detection ---------------------------------------------------- */
  function checkLoss(dtMs) {
    var bodies = M.Composite.allBodies(world);
    for (var i = 0; i < bodies.length; i++) {
      var b = bodies[i];
      if (b.isStatic || b.plugin.tier === undefined) continue;
      var above = b.bounds.min.y < G.container.dangerY;
      var still = M.Vector.magnitude(b.velocity) < G.stillSpeed;
      if (above && still) {
        b.plugin.aboveMs += dtMs;
        if (b.plugin.aboveMs >= G.graceMs) { endRun(false); return; }
      } else {
        b.plugin.aboveMs = 0;
      }
    }
  }

  // 0..1 how close the pile is to the danger line, for the escalating telegraph
  function dangerProximity() {
    var minTop = Infinity;
    var bodies = M.Composite.allBodies(world);
    for (var i = 0; i < bodies.length; i++) {
      var b = bodies[i];
      if (b.isStatic || b.plugin.tier === undefined || b === lastDropped) continue;
      if (M.Vector.magnitude(b.velocity) > 1) continue;
      if (b.bounds.min.y < minTop) minTop = b.bounds.min.y;
    }
    if (minTop === Infinity) return 0;
    var range = 180; // px above which danger display starts to escalate
    return Math.max(0, Math.min(1, 1 - (minTop - G.container.dangerY) / range));
  }

  /* ---- run lifecycle ----------------------------------------------------- */
  function startRun() {
    if (engine) { M.Events.off(engine); M.Engine.clear(engine); }
    setupEngine();
    score = 0; chainSinceDrop = 0; highestTier = 0;
    runOver = false; lastDropped = null; lastDropAt = 0;
    particles = []; pops = []; toasts = []; mergeQueue = [];
    heldTier = pickSpawnTier(); nextTier = pickSpawnTier();
    heldX = G.container.width / 2;
    runAccumMs = 0; segStart = now(); running = true;
    showScreen("game");
    fitCanvas();   // must run AFTER the screen is visible or it measures 0x0
    updateHud();
  }

  function endRun(won) {
    if (runOver) return;
    runOver = true;
    if (running) { runAccumMs += now() - segStart; running = false; }
    var runMs = Math.round(runAccumMs);
    if (score > bestScore) bestScore = score;
    if (highestTier > sessionBestTier) sessionBestTier = highestTier;
    if (won) everWon = true;

    submitResult(won, runMs);

    var isFinal;
    setTimeout(function () {
      el("end-title").textContent = won ? "You built the SciMed logo!" : "The board filled up";
      el("screen-game-end").classList.toggle("won", won);
      el("end-score").textContent = String(score);
      el("end-tier").textContent = G.tiers[highestTier].name + " (" + G.tiers[highestTier].brand + ")";
      el("end-time").textContent = fmtTime(runMs);
      isFinal = attemptsUsed >= G.maxAttempts;
      el("end-attempts").textContent = isFinal
        ? "All " + G.maxAttempts + " attempts used — best score counts"
        : "Attempt " + attemptsUsed + " of " + G.maxAttempts;
      el("btn-play-again").hidden = isFinal;
      showScreen("game-end");
    }, won ? 1400 : 600);   // let the win moment breathe before the screen changes
  }

  function fmtTime(ms) {
    var s = Math.floor(ms / 1000);
    return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
  }

  /* ---- server ------------------------------------------------------------ */
  function submitResult(won, runMs) {
    attemptsUsed = Math.min(attemptsUsed + 1, G.maxAttempts); // optimistic; server corrects
    var payload = {
      action: "game",
      lead_id: window.getLeadId ? window.getLeadId() : null,
      secret: CONFIG.sharedSecret,
      score: score,
      won: won,
      run_ms: runMs,
      highest_tier_index: highestTier
    };
    fetch(CONFIG.endpoints.appsScriptUrl, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify(payload)
    }).then(function (r) { return r.json(); }).then(function (json) {
      if (json && typeof json.attempts === "number") {
        attemptsUsed = json.attempts;
        if (typeof json.best_score === "number") bestScore = json.best_score;
        el("btn-play-again").hidden = attemptsUsed >= G.maxAttempts;
        el("end-attempts").textContent = attemptsUsed >= G.maxAttempts
          ? "All " + G.maxAttempts + " attempts used — best score counts"
          : "Attempt " + attemptsUsed + " of " + G.maxAttempts;
      }
    }).catch(function () { /* score loss on network failure is acceptable; lead is safe */ });
  }

  function submitProducts() {
    var picked = [];
    document.querySelectorAll("#products-list input:checked").forEach(function (cb) {
      picked.push(cb.value);
    });
    fetch(CONFIG.endpoints.appsScriptUrl, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify({
        action: "products",
        lead_id: window.getLeadId ? window.getLeadId() : null,
        secret: CONFIG.sharedSecret,
        products_used: picked
      })
    }).catch(function () {});
    el("products-done").hidden = false;
    el("btn-products-save").hidden = true;
  }

  /* ---- render ------------------------------------------------------------ */
  function draw() {
    var w = G.container.width, h = G.container.height;
    ctx.setTransform(dpr * canvasScale, 0, 0, dpr * canvasScale, 0, 0);
    ctx.clearRect(0, 0, w, h);

    // container bg
    ctx.fillStyle = getCss("--color-surface");
    ctx.fillRect(0, 0, w, h);

    // danger line, escalating with proximity
    var danger = dangerProximity();
    var pulse = danger > 0.6 && !reducedMotion ? (Math.sin(now() / 120) + 1) / 2 : 0;
    ctx.strokeStyle = "rgba(" + getCss("--game-danger-rgb") + "," + (0.25 + danger * 0.6 + pulse * 0.15) + ")";
    ctx.lineWidth = 1.5 + danger * 2.5;
    ctx.setLineDash(danger > 0.85 ? [] : [8, 6]);
    ctx.beginPath();
    ctx.moveTo(0, G.container.dangerY);
    ctx.lineTo(w, G.container.dangerY);
    ctx.stroke();
    ctx.setLineDash([]);

    // bodies
    var bodies = M.Composite.allBodies(world);
    var tNow = now();
    for (var i = 0; i < bodies.length; i++) {
      var b = bodies[i];
      if (b.isStatic || b.plugin.tier === undefined) continue;
      var tier = b.plugin.tier;
      var r = G.tiers[tier].radius;
      var age = tNow - b.plugin.born;
      var scale = 1;
      if (!reducedMotion && age < G.popMs) scale = 0.6 + 0.4 * (age / G.popMs);
      drawDisc(tier, b.position.x, b.position.y, r * scale, b.angle);
      if (showWireframes) {
        ctx.strokeStyle = "rgba(0,0,0,0.6)";
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(b.position.x, b.position.y, r, 0, Math.PI * 2);
        ctx.stroke();
      }
    }

    // held item at top
    if (!runOver) {
      ctx.globalAlpha = 0.95;
      drawDisc(heldTier, heldX, G.container.heldY, G.tiers[heldTier].radius, 0);
      ctx.globalAlpha = 1;
      // aim guide
      ctx.strokeStyle = "rgba(" + getCss("--game-aim-rgb") + ",0.25)";
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 5]);
      ctx.beginPath();
      ctx.moveTo(heldX, G.container.heldY + G.tiers[heldTier].radius);
      ctx.lineTo(heldX, h);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // particles
    for (var p = particles.length - 1; p >= 0; p--) {
      var pt = particles[p];
      pt.x += pt.vx; pt.y += pt.vy; pt.vy += 0.08; pt.life -= 0.03;
      if (pt.life <= 0) { particles.splice(p, 1); continue; }
      ctx.fillStyle = "rgba(" + getCss("--game-particle-rgb") + "," + pt.life + ")";
      ctx.fillRect(pt.x - 2, pt.y - 2, 4, 4);
    }

    if (DEBUG) {
      ctx.fillStyle = "rgba(0,0,0,0.55)";
      ctx.font = "10px monospace";
      ctx.fillText(fps + " fps  bodies:" + bodyCount(), 6, h - 8);
    }
  }

  function drawDisc(tier, x, y, r, angle) {
    var img = tierImages[tier];
    if (img.complete && img.naturalWidth) {
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(angle || 0);
      ctx.drawImage(img, -r, -r, r * 2, r * 2);
      ctx.restore();
    } else {
      ctx.fillStyle = "#c0c0c0";
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  function getCss(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || "#fff";
  }

  /* ---- HUD --------------------------------------------------------------- */
  function updateHud() {
    el("hud-score").textContent = String(score);
    var nextImg = el("hud-next-img");
    nextImg.src = G.tierImagePath(nextTier);
    // live ladder: reached tiers highlighted (design doc 5.7)
    var items = document.querySelectorAll("#hud-ladder .ladder-dot");
    items.forEach(function (dot, i) {
      dot.classList.toggle("reached", i <= highestTier);
    });
  }

  function updateHudTimer() {
    el("hud-time").textContent = fmtTime(runElapsed());
    // toasts
    var tEl = el("hud-toast");
    var live = toasts.filter(function (t) { return now() - t.at < G.toastMs; });
    tEl.textContent = live.length ? live[live.length - 1].text : "";
    el("hud-score").textContent = String(score);
  }

  /* ---- main loop --------------------------------------------------------- */
  var lastFrame = 0, acc = 0;
  var STEP = 1000 / 60;
  function stepOnce() {
    M.Engine.update(engine, STEP);
    processMerges();
    if (!runOver) checkLoss(STEP);
  }
  function frame(t) {
    requestAnimationFrame(frame);
    if (!engine) return;
    if (!lastFrame) lastFrame = t;
    var dt = Math.min(t - lastFrame, 100);
    lastFrame = t;

    if (running && !runOver) {
      acc += dt;
      while (acc >= STEP) {
        stepOnce();
        acc -= STEP;
      }
    }
    if (!document.getElementById("screen-game").hidden) {
      draw();
      updateHudTimer();
    }
    fpsFrames++;
    if (t - fpsLast > 1000) { fps = fpsFrames; fpsFrames = 0; fpsLast = t; }
  }

  /* ---- canvas sizing ----------------------------------------------------- */
  var canvasScale = 1;
  function fitCanvas() {
    var stage = el("game-stage");
    var availW = stage.clientWidth;
    var availH = stage.clientHeight;
    canvasScale = Math.min(availW / G.container.width, availH / G.container.height);
    canvas.style.width = (G.container.width * canvasScale) + "px";
    canvas.style.height = (G.container.height * canvasScale) + "px";
    canvas.width = Math.round(G.container.width * canvasScale * dpr);
    canvas.height = Math.round(G.container.height * canvasScale * dpr);
  }

  /* ---- input: tap anywhere sets x and drops in one action ---------------- */
  function onPointer(e) {
    var rect = canvas.getBoundingClientRect();
    var x = (e.clientX - rect.left) / canvasScale;
    tryDrop(x);
    e.preventDefault();
  }

  /* ---- post-game screen (the rep opener, design doc 5.7) ----------------- */
  function showPostGame() {
    el("pg-score").textContent = String(bestScore);
    el("pg-tier-img").src = G.tierImagePath(sessionBestTier);
    el("pg-tier-name").textContent = G.tiers[sessionBestTier].name;
    var ladder = el("pg-ladder");
    ladder.innerHTML = "";
    G.tiers.forEach(function (t, i) {
      var li = document.createElement("li");
      li.className = i <= sessionBestTier ? "reached" : "";
      var img = document.createElement("img");
      img.src = G.tierImagePath(i);
      img.alt = "";
      var span = document.createElement("span");
      span.textContent = t.name + " — " + t.brand;
      li.appendChild(img);
      li.appendChild(span);
      ladder.appendChild(li);
    });
    var list = el("products-list");
    if (!list.children.length) {
      G.tiers.slice(0, 8).forEach(function (t) {
        var label = document.createElement("label");
        var cb = document.createElement("input");
        cb.type = "checkbox";
        cb.value = t.name;
        label.appendChild(cb);
        label.appendChild(document.createTextNode(" " + t.name + " (" + t.brand + ")"));
        list.appendChild(label);
      });
    }
    showScreen("postgame");
  }

  /* ---- debug panel -------------------------------------------------------- */
  function setupDebug() {
    if (!DEBUG) return;
    var panel = el("debug-panel");
    panel.hidden = false;
    var spawns = el("debug-spawns");
    G.tiers.forEach(function (t, i) {
      var b = document.createElement("button");
      b.type = "button";
      b.textContent = "T" + (i + 1);
      b.addEventListener("click", function () {
        if (!engine) return;
        M.Composite.add(world, makeBody(i, G.container.width / 2 + (Math.random() - 0.5) * 60, G.container.heldY, 0, 0));
        if (i > highestTier) highestTier = i;
        updateHud();
      });
      spawns.appendChild(b);
    });
    el("debug-wireframes").addEventListener("click", function () { showWireframes = !showWireframes; });
    el("debug-gameover").addEventListener("click", function () { if (engine && !runOver) endRun(false); });
    el("debug-win").addEventListener("click", function () { if (engine && !runOver) { highestTier = G.tiers.length - 1; endRun(true); } });
  }

  /* ---- test hooks (debug only) ------------------------------------------- */
  if (DEBUG) {
    window.GAME_TEST = {
      state: function () {
        return { score: score, highestTier: highestTier, attemptsUsed: attemptsUsed,
                 runOver: runOver, running: running, bodies: engine ? bodyCount() : 0,
                 runMs: Math.round(runElapsed()) };
      },
      drop: tryDrop,
      spawn: function (tier, x, y) { M.Composite.add(world, makeBody(tier, x, y, 0, 0)); },
      start: startRun,
      // deterministic stepping for automated tests (rAF halts in hidden tabs)
      tick: function (steps) {
        for (var i = 0; i < steps && engine && !runOver; i++) stepOnce();
      }
    };
  }

  /* ---- wiring ------------------------------------------------------------ */
  function init() {
    canvas = el("game-canvas");
    ctx = canvas.getContext("2d");

    // build the live ladder dots once
    var ladder = el("hud-ladder");
    G.tiers.forEach(function (t, i) {
      var dot = document.createElement("div");
      dot.className = "ladder-dot";
      dot.title = t.name;
      var img = document.createElement("img");
      img.src = G.tierImagePath(i);
      img.alt = "T" + (i + 1);
      dot.appendChild(img);
      ladder.appendChild(dot);
    });

    el("btn-play").addEventListener("click", function () { showScreen("game-intro"); });
    el("btn-start-run").addEventListener("click", startRun);
    el("btn-play-again").addEventListener("click", function () {
      if (attemptsUsed >= G.maxAttempts) return;
      startRun();
    });
    el("btn-finish").addEventListener("click", showPostGame);
    el("btn-products-save").addEventListener("click", submitProducts);
    canvas.addEventListener("pointerdown", onPointer);
    window.addEventListener("resize", function () { if (canvas.width) fitCanvas(); });

    setupDebug();
    requestAnimationFrame(frame);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
