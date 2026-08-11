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
      var gained = G.mergeScores[newTier] * mult;
      score += gained;
      if (newTier > highestTier) {
        highestTier = newTier;
        lastReachedTier = newTier;
        lastReachedFlashAt = now();
      }

      spawnFeedback(nx, ny, newTier, mult, gained);

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

  /* ---- feedback: four channels, none audio (design: merge moment) --------
     canvas pop + gold burst · toast strip fills pine with the product name ·
     HUD score delta flash · ladder rail dot flash. */
  var lastGain = 0, lastGainAt = 0, lastReachedFlashAt = 0, lastReachedTier = -1;
  function spawnFeedback(x, y, tier, mult, gained) {
    pops.push({ x: x, y: y, tier: tier, at: now() });
    if (!reducedMotion) {
      for (var i = 0; i < G.particleCount; i++) {
        var ang = (Math.PI * 2 * i) / G.particleCount;
        var sp = 2 + Math.random() * 3;
        particles.push({ x: x, y: y, vx: Math.cos(ang) * sp, vy: Math.sin(ang) * sp, life: 1 });
      }
    }
    var t = G.tiers[tier];
    toasts.push({ text: t.name + (mult > 1 ? " ×" + mult : ""), tier: tier, at: now() });
    if (toasts.length > 3) toasts.shift();
    lastGain = gained; lastGainAt = now();
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
  var graceMaxMs = 0;   // largest accumulated above-line time, drives the countdown
  function checkLoss(dtMs) {
    var bodies = M.Composite.allBodies(world);
    graceMaxMs = 0;
    for (var i = 0; i < bodies.length; i++) {
      var b = bodies[i];
      if (b.isStatic || b.plugin.tier === undefined) continue;
      var above = b.bounds.min.y < G.container.dangerY;
      var still = M.Vector.magnitude(b.velocity) < G.stillSpeed;
      if (above && still) {
        b.plugin.aboveMs += dtMs;
        if (b.plugin.aboveMs > graceMaxMs) graceMaxMs = b.plugin.aboveMs;
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

  // four-step escalation per the design: far / near / touching / critical
  function dangerBucket() {
    if (graceMaxMs > 0) return "critical";
    var d = dangerProximity();
    if (d >= 0.9) return "touching";
    if (d >= 0.55) return "near";
    return "far";
  }

  /* ---- run lifecycle ----------------------------------------------------- */
  function startRun() {
    if (engine) { M.Events.off(engine); M.Engine.clear(engine); }
    setupEngine();
    score = 0; chainSinceDrop = 0; highestTier = 0;
    runOver = false; lastDropped = null; lastDropAt = 0;
    particles = []; pops = []; toasts = []; mergeQueue = [];
    graceMaxMs = 0; lastGain = 0; lastReachedTier = -1;
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
      el("end-title").textContent = won ? "You built the whole company" : "Pile hit the line";
      el("screen-game-end").classList.toggle("won", won);
      el("end-score").textContent = String(score);
      var t9 = G.tiers.length - 1;
      el("end-tier").textContent = won
        ? "Tier 9 · the SciMed logo"
        : "Tier " + (highestTier + 1) + " · " + G.tiers[highestTier].name;
      el("end-disc").src = G.tierImagePath(won ? t9 : highestTier);
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

    // container bg comes from CSS on the canvas element (colour + optional
    // assets/bg-game.png) — the canvas itself stays transparent

    // danger line: four steps, thickness carries the escalation, not just
    // alpha — a sunlit screen loses alpha before it loses geometry
    var bucket = dangerBucket();
    var lineAlpha, lineWidth, dash;
    if (bucket === "critical") {
      var pulse = reducedMotion ? 0 : (Math.sin(now() / 111) + 1) / 2;   // ~700ms cycle
      lineAlpha = 0.85 + pulse * 0.15; lineWidth = 6; dash = [];
    } else if (bucket === "touching") { lineAlpha = 0.85; lineWidth = 4; dash = []; }
    else if (bucket === "near")       { lineAlpha = 0.55; lineWidth = 3; dash = [8, 6]; }
    else                              { lineAlpha = 0.35; lineWidth = 3; dash = [8, 6]; }
    ctx.strokeStyle = "rgba(" + getCss("--game-danger-rgb") + "," + lineAlpha + ")";
    ctx.lineWidth = lineWidth;
    ctx.setLineDash(dash);
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
    el("hud-score").textContent = String(score);

    // score delta flash: border, label and numeral go green for 600ms
    var gaining = lastGain > 0 && now() - lastGainAt < 600;
    el("hud-score-block").classList.toggle("gained", gaining);
    el("hud-score-label").textContent = gaining ? "Score +" + lastGain : "Score";

    // rail flash on a newly reached tier
    if (lastReachedTier >= 0) {
      var dots = document.querySelectorAll("#hud-ladder .ladder-dot");
      var flashing = now() - lastReachedFlashAt < 600;
      dots.forEach(function (dot, i) {
        dot.classList.toggle("just-reached", flashing && i === lastReachedTier);
      });
    }

    // toast strip: danger countdown takes over at critical, else merge name
    var tEl = el("hud-toast");
    var txt = el("toast-text");
    var disc = el("toast-disc");
    var bucket = dangerBucket();
    el("game-stage").setAttribute("data-danger", bucket);
    if (bucket === "critical" && !runOver) {
      var left = Math.max(0, Math.ceil((G.graceMs - graceMaxMs) / 1000));
      tEl.className = "danger-critical";
      txt.textContent = "Clear the top — " + left + " second" + (left === 1 ? "" : "s");
    } else {
      var live = toasts.filter(function (t) { return now() - t.at < G.toastMs; });
      if (live.length) {
        var last = live[live.length - 1];
        tEl.className = "merged";
        disc.src = G.tierImagePath(last.tier);
        txt.textContent = last.text;
      } else {
        tEl.className = "";
        txt.textContent = "Tap the top to drop";
      }
    }
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

  /* ---- leaderboard --------------------------------------------------------
     Winners lead on time (the ranked value, in gold); the board leads on
     score in a quiet ledger. data-rank + .is-you drive the styling. */
  function fmtRow(r, i, isWinner, you) {
    var li = document.createElement("li");
    li.setAttribute("data-rank", String(i + 1));
    if (you && you.rank === i + 1 &&
        ((isWinner && you.section === "winners") || (!isWinner && you.section === "board"))) {
      li.classList.add("is-you");
    }
    var rank = document.createElement("span");
    rank.className = "lb-rank";
    rank.textContent = isWinner ? String(i + 1) : String(i + 1);
    var name = document.createElement("span");
    name.className = "lb-name";
    name.textContent = r.name;
    li.appendChild(rank);
    li.appendChild(name);
    if (isWinner) {
      var time = document.createElement("span");
      time.className = "lb-time";
      time.textContent = fmtTime(r.run_ms);
      var sc = document.createElement("span");
      sc.className = "lb-score";
      sc.textContent = r.score + " pts";
      li.appendChild(time);
      li.appendChild(sc);
    } else {
      var nums = document.createElement("span");
      nums.className = "lb-nums-group";
      nums.textContent = r.score + " · " + fmtTime(r.run_ms);
      li.appendChild(nums);
    }
    return li;
  }

  function loadLeaderboard() {
    var url = CONFIG.endpoints.appsScriptUrl + "?view=leaderboard&lead_id=" +
      encodeURIComponent(window.getLeadId ? window.getLeadId() : "");
    return fetch(url).then(function (r) { return r.json(); }).then(function (json) {
      if (!json || !json.ok) return;
      var w = el("lb-winners"), o = el("lb-others");
      w.innerHTML = ""; o.innerHTML = "";
      json.winners.forEach(function (r, i) { w.appendChild(fmtRow(r, i, true, json.you)); });
      json.others.forEach(function (r, i) { o.appendChild(fmtRow(r, i, false, json.you)); });
      el("lb-no-winners").hidden = json.winners.length > 0;
      el("lb-no-others").hidden = json.others.length > 0;
      var youLine = el("lb-you-line");
      if (json.you) {
        var label = json.you.section === "winners"
          ? "Winner #" + json.you.rank
          : "#" + json.you.rank + " on the board";
        el("pg-rank").textContent = "  ·  " + label;
        youLine.innerHTML = "You're <strong>" + label + "</strong> · " + bestScore + " pts";
        youLine.hidden = false;
      } else {
        youLine.hidden = true;
      }
    }).catch(function () { /* board is nice-to-have; never block the flow */ });
  }

  /* ---- post-game screen (the rep opener, design doc 5.7) ----------------- */
  function showPostGame() {
    el("pg-rank").textContent = "";
    loadLeaderboard();
    el("pg-score").textContent = String(bestScore);
    el("pg-tier-img").src = G.tierImagePath(sessionBestTier);
    el("pg-tier-name").textContent = everWon
      ? "Tier 9 · the logo"
      : "Tier " + (sessionBestTier + 1) + " · " + G.tiers[sessionBestTier].name;
    el("pg-reached-card").classList.toggle("pg-won", everWon);
    // ladder listed summit-first, reached tiers at full strength
    var ladder = el("pg-ladder");
    ladder.innerHTML = "";
    for (var i = G.tiers.length - 1; i >= 0; i--) {
      var t = G.tiers[i];
      var li = document.createElement("li");
      li.className = i <= sessionBestTier ? "reached" : "";
      var img = document.createElement("img");
      img.src = G.tierImagePath(i);
      img.alt = "";
      var item = document.createElement("span");
      item.className = "pg-item";
      item.textContent = t.name + " ";
      if (i < G.tiers.length - 1) {
        var brand = document.createElement("span");
        brand.className = "pg-brand";
        brand.textContent = t.brand;
        item.appendChild(brand);
      }
      var num = document.createElement("span");
      num.className = "pg-num";
      num.textContent = String(i + 1);
      li.appendChild(img);
      li.appendChild(item);
      li.appendChild(num);
      ladder.appendChild(li);
    }
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
    el("btn-show-leaderboard").addEventListener("click", function () {
      loadLeaderboard();
      showScreen("leaderboard");
    });
    el("btn-lb-back").addEventListener("click", function () { showScreen("postgame"); });
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
