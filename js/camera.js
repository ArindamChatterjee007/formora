/* ============================================================
   Formora Camera — in-app camera with live pro filters, a
   paint/doodle tool, photo capture and OPTIMIZED video record
   (MediaRecorder at a capped bitrate + 30s max → small files).
   Filters are baked into the capture via canvas ctx.filter.
   ============================================================ */
const Camera = {
  // big curated filter set (CSS filter strings, baked on capture) — Snapchat-level variety
  FILTERS: [
    { id: "normal", name: "Normal", css: "" },
    { id: "gym", name: "Gym", css: "contrast(1.16) saturate(1.35) brightness(1.03)" },
    { id: "vivid", name: "Vivid", css: "saturate(1.6) contrast(1.15)" },
    { id: "pop", name: "Pop", css: "saturate(1.9) contrast(1.25) brightness(1.02)" },
    { id: "punch", name: "Punch", css: "saturate(2.1) contrast(1.3)" },
    { id: "clarity", name: "Clarity", css: "contrast(1.25) brightness(1.05) saturate(1.15)" },
    { id: "crisp", name: "Crisp", css: "contrast(1.3) brightness(1.04) saturate(1.1)" },
    { id: "sharp", name: "Sharp", css: "contrast(1.35) saturate(1.05)" },
    { id: "bright", name: "Bright", css: "brightness(1.16) saturate(1.1)" },
    { id: "radiant", name: "Radiant", css: "brightness(1.12) saturate(1.4) contrast(1.05)" },
    { id: "glow", name: "Glow", css: "brightness(1.14) saturate(1.22) contrast(.97)" },
    { id: "halo", name: "Halo", css: "brightness(1.2) contrast(.92) saturate(1.15)" },
    { id: "sunlit", name: "Sunlit", css: "brightness(1.12) sepia(.15) saturate(1.4) contrast(1.03)" },
    { id: "warm", name: "Warm", css: "sepia(.32) saturate(1.5) brightness(1.05) contrast(1.05)" },
    { id: "sunny", name: "Sunny", css: "sepia(.22) saturate(1.55) brightness(1.1) hue-rotate(-8deg)" },
    { id: "golden", name: "Golden", css: "sepia(.5) saturate(1.7) hue-rotate(-8deg) brightness(1.08) contrast(1.05)" },
    { id: "honey", name: "Honey", css: "sepia(.42) saturate(1.6) hue-rotate(-6deg) brightness(1.06)" },
    { id: "amber", name: "Amber", css: "sepia(.55) saturate(1.75) hue-rotate(-12deg) brightness(1.04)" },
    { id: "caramel", name: "Caramel", css: "sepia(.5) saturate(1.5) hue-rotate(-14deg) brightness(1.02) contrast(1.05)" },
    { id: "bronze", name: "Bronze", css: "sepia(.6) saturate(1.4) hue-rotate(-16deg) brightness(.98) contrast(1.08)" },
    { id: "rust", name: "Rust", css: "sepia(.6) saturate(1.9) hue-rotate(-22deg) contrast(1.1) brightness(.98)" },
    { id: "peach", name: "Peach", css: "sepia(.25) saturate(1.45) hue-rotate(-18deg) brightness(1.08)" },
    { id: "apricot", name: "Apricot", css: "sepia(.3) saturate(1.5) hue-rotate(-20deg) brightness(1.07)" },
    { id: "coral", name: "Coral", css: "sepia(.28) saturate(1.7) hue-rotate(-24deg) brightness(1.05)" },
    { id: "sunset", name: "Sunset", css: "sepia(.25) saturate(1.6) hue-rotate(-15deg) brightness(1.06)" },
    { id: "sunrise", name: "Sunrise", css: "sepia(.2) saturate(1.5) hue-rotate(-10deg) brightness(1.1) contrast(.98)" },
    { id: "dusk", name: "Dusk", css: "brightness(.92) contrast(1.15) saturate(1.2) hue-rotate(-10deg)" },
    { id: "ember", name: "Ember", css: "sepia(.4) saturate(1.8) hue-rotate(-20deg) contrast(1.1) brightness(1.02)" },
    { id: "clay", name: "Clay", css: "sepia(.45) saturate(1.3) hue-rotate(-18deg) contrast(1.05)" },
    { id: "sand", name: "Sand", css: "sepia(.4) saturate(1.15) brightness(1.08) contrast(.98)" },
    { id: "desert", name: "Desert", css: "sepia(.5) saturate(1.25) hue-rotate(-5deg) brightness(1.06) contrast(1.02)" },
    { id: "rose", name: "Rose", css: "sepia(.2) saturate(1.5) hue-rotate(-25deg) brightness(1.05) contrast(1.03)" },
    { id: "blush", name: "Blush", css: "sepia(.15) saturate(1.35) hue-rotate(-22deg) brightness(1.06) contrast(1.02)" },
    { id: "cherry", name: "Cherry", css: "saturate(1.7) hue-rotate(-18deg) contrast(1.15)" },
    { id: "crimson", name: "Crimson", css: "saturate(1.8) hue-rotate(-14deg) contrast(1.2) brightness(.98)" },
    { id: "ruby", name: "Ruby", css: "saturate(1.9) hue-rotate(-10deg) contrast(1.18)" },
    { id: "flamingo", name: "Flamingo", css: "saturate(1.6) hue-rotate(-28deg) brightness(1.06) contrast(1.02)" },
    { id: "candy", name: "Candy", css: "saturate(1.9) hue-rotate(-30deg) brightness(1.05) contrast(1.05)" },
    { id: "bubblegum", name: "Bubblegum", css: "saturate(2) hue-rotate(-34deg) brightness(1.06)" },
    { id: "berry", name: "Berry", css: "saturate(1.7) hue-rotate(-38deg) contrast(1.1) brightness(.98)" },
    { id: "wine", name: "Wine", css: "saturate(1.5) hue-rotate(-40deg) contrast(1.15) brightness(.9)" },
    { id: "magenta", name: "Magenta", css: "saturate(1.9) hue-rotate(-44deg) contrast(1.1)" },
    { id: "violet", name: "Violet", css: "saturate(1.6) hue-rotate(-50deg) brightness(1.02) contrast(1.05)" },
    { id: "orchid", name: "Orchid", css: "saturate(1.5) hue-rotate(-55deg) brightness(1.05)" },
    { id: "lavender", name: "Lavender", css: "saturate(1.3) hue-rotate(-60deg) brightness(1.08) contrast(.98)" },
    { id: "plum", name: "Plum", css: "saturate(1.5) hue-rotate(-58deg) contrast(1.1) brightness(.95)" },
    { id: "grape", name: "Grape", css: "saturate(1.6) hue-rotate(-64deg) contrast(1.08) brightness(.96)" },
    { id: "amethyst", name: "Amethyst", css: "saturate(1.55) hue-rotate(-70deg) brightness(1.02)" },
    { id: "ultra", name: "Ultra", css: "saturate(1.8) hue-rotate(-80deg) contrast(1.12)" },
    { id: "cool", name: "Cool", css: "contrast(1.05) brightness(1.05) saturate(1.2) hue-rotate(12deg)" },
    { id: "chill", name: "Chill", css: "brightness(1.05) contrast(1.02) saturate(1.1) hue-rotate(16deg)" },
    { id: "ice", name: "Ice", css: "brightness(1.14) contrast(.95) saturate(.95) hue-rotate(14deg)" },
    { id: "arctic", name: "Arctic", css: "brightness(1.12) contrast(.98) saturate(.85) hue-rotate(20deg)" },
    { id: "frost", name: "Frost", css: "brightness(1.12) contrast(.95) saturate(.9) hue-rotate(10deg)" },
    { id: "glacier", name: "Glacier", css: "brightness(1.1) contrast(1.02) saturate(1) hue-rotate(24deg)" },
    { id: "winter", name: "Winter", css: "brightness(1.06) contrast(1.05) saturate(.9) hue-rotate(18deg)" },
    { id: "steel", name: "Steel", css: "contrast(1.1) saturate(.8) hue-rotate(15deg)" },
    { id: "denim", name: "Denim", css: "saturate(1.2) hue-rotate(25deg) contrast(1.05) brightness(.98)" },
    { id: "cobalt", name: "Cobalt", css: "saturate(1.5) hue-rotate(30deg) contrast(1.1) brightness(.98)" },
    { id: "sapphire", name: "Sapphire", css: "saturate(1.6) hue-rotate(35deg) contrast(1.12) brightness(.96)" },
    { id: "ocean", name: "Ocean", css: "saturate(1.4) hue-rotate(40deg) brightness(1.02) contrast(1.05)" },
    { id: "azure", name: "Azure", css: "saturate(1.35) hue-rotate(45deg) brightness(1.06)" },
    { id: "sky", name: "Sky", css: "saturate(1.25) hue-rotate(38deg) brightness(1.1) contrast(.98)" },
    { id: "marine", name: "Marine", css: "saturate(1.45) hue-rotate(50deg) contrast(1.08) brightness(.98)" },
    { id: "teal", name: "Teal", css: "saturate(1.5) hue-rotate(60deg) brightness(1.02)" },
    { id: "aqua", name: "Aqua", css: "saturate(1.45) hue-rotate(55deg) brightness(1.04)" },
    { id: "seafoam", name: "Seafoam", css: "saturate(1.2) hue-rotate(70deg) brightness(1.08) contrast(.98)" },
    { id: "mint", name: "Mint", css: "saturate(1.3) hue-rotate(75deg) brightness(1.05) contrast(1.03)" },
    { id: "jade", name: "Jade", css: "saturate(1.5) hue-rotate(85deg) contrast(1.05)" },
    { id: "emerald", name: "Emerald", css: "saturate(1.6) hue-rotate(90deg) contrast(1.08) brightness(.98)" },
    { id: "sage", name: "Sage", css: "saturate(1.1) hue-rotate(80deg) brightness(1.04) contrast(.98)" },
    { id: "matcha", name: "Matcha", css: "sepia(.2) saturate(1.4) hue-rotate(60deg) brightness(1.02)" },
    { id: "lime", name: "Lime", css: "saturate(1.7) hue-rotate(100deg) brightness(1.05)" },
    { id: "forest", name: "Forest", css: "saturate(1.4) hue-rotate(95deg) contrast(1.1) brightness(.92)" },
    { id: "moss", name: "Moss", css: "sepia(.25) saturate(1.3) hue-rotate(70deg) brightness(.98) contrast(1.05)" },
    { id: "pine", name: "Pine", css: "saturate(1.35) hue-rotate(110deg) contrast(1.08) brightness(.9)" },
    { id: "neon", name: "Neon", css: "saturate(2) contrast(1.3) brightness(1.05)" },
    { id: "electric", name: "Electric", css: "saturate(2.2) contrast(1.35) brightness(1.06) hue-rotate(10deg)" },
    { id: "cyber", name: "Cyber", css: "contrast(1.3) saturate(1.6) hue-rotate(-30deg) brightness(1.02)" },
    { id: "laser", name: "Laser", css: "saturate(2.3) contrast(1.4) hue-rotate(-20deg)" },
    { id: "vapor", name: "Vapor", css: "saturate(1.6) hue-rotate(-45deg) brightness(1.1) contrast(1.05)" },
    { id: "disco", name: "Disco", css: "saturate(2.1) hue-rotate(-60deg) contrast(1.2) brightness(1.02)" },
    { id: "prism", name: "Prism", css: "saturate(2) hue-rotate(120deg) contrast(1.15)" },
    { id: "drama", name: "Drama", css: "contrast(1.42) saturate(1.1) brightness(.96)" },
    { id: "bold", name: "Bold", css: "contrast(1.5) saturate(1.2) brightness(.95)" },
    { id: "moody", name: "Moody", css: "contrast(1.3) saturate(.9) brightness(.9)" },
    { id: "midnight", name: "Midnight", css: "brightness(.82) contrast(1.25) saturate(1.15) hue-rotate(10deg)" },
    { id: "shadow", name: "Shadow", css: "brightness(.85) contrast(1.3) saturate(.95)" },
    { id: "storm", name: "Storm", css: "brightness(.88) contrast(1.2) saturate(.85) hue-rotate(15deg)" },
    { id: "eclipse", name: "Eclipse", css: "brightness(.8) contrast(1.35) saturate(1.1)" },
    { id: "ink", name: "Ink", css: "grayscale(.6) contrast(1.4) brightness(.9)" },
    { id: "fade", name: "Fade", css: "contrast(.9) brightness(1.09) saturate(.82)" },
    { id: "faded", name: "Faded", css: "contrast(.85) brightness(1.12) saturate(.7)" },
    { id: "soft", name: "Soft", css: "contrast(.92) brightness(1.08) saturate(.95)" },
    { id: "dream", name: "Dream", css: "contrast(.88) brightness(1.14) saturate(1.1) sepia(.1)" },
    { id: "haze", name: "Haze", css: "contrast(.85) brightness(1.16) saturate(.9) sepia(.08)" },
    { id: "mist", name: "Mist", css: "contrast(.9) brightness(1.12) saturate(.8) hue-rotate(10deg)" },
    { id: "pastel", name: "Pastel", css: "saturate(.75) brightness(1.1) contrast(.95)" },
    { id: "muted", name: "Muted", css: "saturate(.65) contrast(1.02) brightness(1.03)" },
    { id: "vintage", name: "Vintage", css: "sepia(.5) contrast(.96) brightness(1.05) saturate(1.3)" },
    { id: "retro", name: "Retro", css: "sepia(.4) contrast(1.1) saturate(1.2) brightness(1.02) hue-rotate(-5deg)" },
    { id: "film", name: "Film", css: "sepia(.3) contrast(1.08) brightness(1.02) saturate(1.1)" },
    { id: "polaroid", name: "Polaroid", css: "sepia(.35) contrast(.95) brightness(1.1) saturate(1.15)" },
    { id: "sepia", name: "Sepia", css: "sepia(.8) contrast(1.05) brightness(1.05)" },
    { id: "toast", name: "Toast", css: "sepia(.7) saturate(1.4) hue-rotate(-10deg) contrast(1.05)" },
    { id: "velvet", name: "Velvet", css: "contrast(1.15) saturate(1.25) brightness(.98) sepia(.1)" },
    { id: "mono", name: "Mono", css: "grayscale(1) contrast(1.16)" },
    { id: "silver", name: "Silver", css: "grayscale(1) contrast(1.05) brightness(1.1)" },
    { id: "noir", name: "Noir", css: "grayscale(1) contrast(1.55) brightness(.9)" },
    { id: "graphite", name: "Graphite", css: "grayscale(1) contrast(1.3) brightness(.95)" },
    { id: "pearl", name: "Pearl", css: "grayscale(.9) contrast(.95) brightness(1.15)" },
    { id: "slate", name: "Slate", css: "grayscale(.85) contrast(1.15) hue-rotate(15deg)" },
    { id: "thermal", name: "Thermal", css: "saturate(2.5) hue-rotate(140deg) contrast(1.3)" },
    { id: "infrared", name: "Infrared", css: "saturate(2) hue-rotate(200deg) contrast(1.2) brightness(1.05)" },
    { id: "xray", name: "X-Ray", css: "invert(1) hue-rotate(180deg) contrast(1.1)" },
  ],
  PAINT_COLORS: ["#ff3d7f", "#ff6b3d", "#ffd23d", "#3dff88", "#3dd0ff", "#8b5cff", "#ffffff", "#101014"],
  stream: null, facing: "user", filterIdx: 0, target: "story", mode: "photo",
  recorder: null, chunks: [], recording: false, recTimer: null, recRAF: null,
  paintOn: false, paintColor: "#ff3d7f", _draft: null,

  supported() { return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.MediaRecorder); },
  cssFilter() { return (this.FILTERS[this.filterIdx] || {}).css || "none"; },

  async open(target) {
    if (!this.supported()) { alert("Your browser doesn't support the in-app camera — use the gallery option instead."); return false; }
    this.target = target || "story";
    this.paintOn = false;
    this.mode = "photo";
    this.buildUI();
    try {
      await this.start();
      return true;
    } catch (e) {
      this.close();
      alert("Couldn't access your camera. Please allow camera permission (and use HTTPS), or pick from your gallery instead.");
      return false;
    }
  },
  async start() {
    this.stop();
    const constraints = { audio: true, video: { facingMode: this.facing, width: { ideal: 1280 }, height: { ideal: 1280 } } };
    this.stream = await navigator.mediaDevices.getUserMedia(constraints);
    const v = document.getElementById("cam-video");
    if (v) { v.srcObject = this.stream; v.style.transform = this.facing === "user" ? "scaleX(-1)" : "none"; await v.play().catch(() => {}); }
  },
  stop() {
    if (this.stream) { this.stream.getTracks().forEach((t) => t.stop()); this.stream = null; }
  },
  async flip() {
    this.facing = this.facing === "user" ? "environment" : "user";
    try { await this.start(); } catch (e) { this.facing = this.facing === "user" ? "environment" : "user"; }
  },
  setFilter(i) {
    this.filterIdx = (i + this.FILTERS.length) % this.FILTERS.length;
    const v = document.getElementById("cam-video");
    if (v) v.style.filter = this.cssFilter();
    const btns = document.querySelectorAll(".cam-filter");
    btns.forEach((el, idx) => el.classList.toggle("active", idx === this.filterIdx));
    const active = btns[this.filterIdx];
    if (active && active.scrollIntoView) active.scrollIntoView({ inline: "center", block: "nearest", behavior: "smooth" });
    const label = document.getElementById("cam-filter-name");
    if (label) { label.textContent = (this.FILTERS[this.filterIdx] || {}).name || ""; label.classList.remove("show"); void label.offsetWidth; label.classList.add("show"); }
  },
  nextFilter() { this.setFilter(this.filterIdx + 1); },
  prevFilter() { this.setFilter(this.filterIdx - 1); },

  buildUI() {
    let ov = document.getElementById("camera-ov");
    if (!ov) { ov = document.createElement("div"); ov.id = "camera-ov"; document.body.appendChild(ov); }
    ov.className = "camera-ov";
    ov.innerHTML = `
      <div class="cam-stage">
        <video id="cam-video" playsinline autoplay muted></video>
        <canvas id="cam-canvas" class="cam-canvas"></canvas>
        <div class="cam-filter-name" id="cam-filter-name"></div>
        <div class="cam-top">
          <button class="cam-ic" onclick="Camera.close()">✕</button>
          <div class="cam-rec-time" id="cam-rec-time"></div>
          <button class="cam-ic" onclick="Camera.flip()">🔄</button>
        </div>
        <div class="cam-filters" id="cam-filters">
          ${this.FILTERS.map((f, i) => `<button class="cam-filter ${i === 0 ? "active" : ""}" onclick="Camera.setFilter(${i})">${esc(f.name)}</button>`).join("")}
        </div>
        <div class="cam-bottom">
          <div class="cam-hint" id="cam-hint">Tap to take a photo · swipe for filters</div>
          <div class="cam-modes">
            <button class="cam-mode active" id="cam-mode-photo" onclick="Camera.setMode('photo')">Photo</button>
            <button class="cam-mode" id="cam-mode-video" onclick="Camera.setMode('video')">Video</button>
          </div>
          <button class="cam-shutter" id="cam-shutter"><span></span></button>
        </div>
      </div>`;
    const sh = document.getElementById("cam-shutter");
    let held = false, timer = null;
    const startHold = (e) => { if (e.cancelable) e.preventDefault(); held = false; clearTimeout(timer); if (this.mode === "photo") timer = setTimeout(() => { held = true; this.startRec(); }, 280); };
    const endHold = (e) => {
      if (e && e.cancelable) e.preventDefault();
      clearTimeout(timer);
      if (this.recording) this.stopRec();
      else if (this.mode === "video") this.startRec();
      else if (!held) this.snapPhoto();
      held = false;
    };
    // Pointer Events unify mouse + touch → no double-fire (the old touch+mouse binding could accidentally start recording)
    sh.addEventListener("pointerdown", (e) => { try { sh.setPointerCapture(e.pointerId); } catch (er) {} startHold(e); });
    sh.addEventListener("pointerup", endHold);
    sh.addEventListener("pointercancel", () => { clearTimeout(timer); if (this.recording) this.stopRec(); held = false; });
    // swipe left/right anywhere on the preview to change filters (Snapchat-style)
    const stage = ov.querySelector(".cam-stage");
    let sx = null, sy = null;
    stage.addEventListener("pointerdown", (e) => { if (e.target.closest(".cam-shutter,.cam-filters,.cam-modes,.cam-ic,.cam-top,.cam-bottom")) { sx = null; return; } sx = e.clientX; sy = e.clientY; });
    stage.addEventListener("pointerup", (e) => { if (sx === null) return; const dx = e.clientX - sx, dy = e.clientY - sy; sx = null; if (Math.abs(dx) > 45 && Math.abs(dx) > Math.abs(dy)) { if (dx < 0) this.nextFilter(); else this.prevFilter(); } });
    const v = document.getElementById("cam-video"); if (v) v.style.filter = this.cssFilter();
  },
  setMode(m) {
    if (this.recording) return;
    this.mode = m;
    const ph = document.getElementById("cam-mode-photo"), vd = document.getElementById("cam-mode-video"), hint = document.getElementById("cam-hint");
    if (ph) ph.classList.toggle("active", m === "photo");
    if (vd) vd.classList.toggle("active", m === "video");
    if (hint) hint.textContent = m === "video" ? "Tap to start · tap again to stop" : "Tap to take a photo";
    const sh = document.getElementById("cam-shutter"); if (sh) sh.classList.toggle("video-mode", m === "video");
  },

  _frameCanvas() {
    const v = document.getElementById("cam-video");
    const canvas = document.createElement("canvas");
    const w = v.videoWidth || 1080, h = v.videoHeight || 1080;
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (this.facing === "user") { ctx.translate(w, 0); ctx.scale(-1, 1); }
    try { ctx.filter = this.cssFilter(); } catch (e) {}
    ctx.drawImage(v, 0, 0, w, h);
    return canvas;
  },
  snapPhoto() {
    const canvas = this._frameCanvas();
    canvas.toBlob((blob) => { if (blob) this.openEditor(blob, false); }, "image/jpeg", 0.9);
  },
  startRec() {
    if (this.recording || !this.stream) return;
    const v = document.getElementById("cam-video");
    const w = Math.min(v.videoWidth || 720, 1080), h = Math.min(v.videoHeight || 1280, 1920);
    const canvas = document.getElementById("cam-canvas");
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext("2d");
    const drawFilter = this.cssFilter(), mirror = this.facing === "user";
    const draw = () => {
      if (!this.recording) return;
      ctx.save();
      if (mirror) { ctx.translate(w, 0); ctx.scale(-1, 1); }
      try { ctx.filter = drawFilter; } catch (e) {}
      ctx.drawImage(v, 0, 0, w, h);
      ctx.restore();
      this.recRAF = requestAnimationFrame(draw);
    };
    const canvasStream = canvas.captureStream(30);
    const audio = this.stream.getAudioTracks();
    const mixed = new MediaStream([...canvasStream.getVideoTracks(), ...audio]);
    const mime = ["video/mp4;codecs=h264,aac", "video/mp4", "video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"].find((m) => MediaRecorder.isTypeSupported(m)) || "";
    try { this.recorder = new MediaRecorder(mixed, mime ? { mimeType: mime, videoBitsPerSecond: 2500000 } : { videoBitsPerSecond: 2500000 }); }
    catch (e) { this.recorder = new MediaRecorder(mixed); }
    this.chunks = [];
    this.recorder.ondataavailable = (e) => { if (e.data && e.data.size) this.chunks.push(e.data); };
    this.recorder.onstop = () => {
      cancelAnimationFrame(this.recRAF);
      const type = (this.recorder && this.recorder.mimeType) || "video/webm";
      const blob = new Blob(this.chunks, { type });
      this.openEditor(blob, true);
    };
    this.recording = true;
    this.recorder.start();
    draw();
    document.getElementById("cam-shutter").classList.add("recording");
    const started = Date.now(), max = 30000;
    this.recTimer = setInterval(() => {
      const s = Math.floor((Date.now() - started) / 1000);
      const el = document.getElementById("cam-rec-time"); if (el) el.textContent = "● " + s + "s";
      if (Date.now() - started >= max) this.stopRec();
    }, 200);
  },
  stopRec() {
    if (!this.recording) return;
    this.recording = false;
    clearInterval(this.recTimer);
    const el = document.getElementById("cam-rec-time"); if (el) el.textContent = "";
    const sh = document.getElementById("cam-shutter"); if (sh) sh.classList.remove("recording");
    try { this.recorder.stop(); } catch (e) {}
  },

  // post-capture editor: photos get a paint/doodle tool; both get Share/Use
  openEditor(blob, isVid) {
    this.stop();
    if (this._draft && this._draft.url) URL.revokeObjectURL(this._draft.url);
    this._draft = { blob, isVid, url: URL.createObjectURL(blob) };
    const ov = document.getElementById("camera-ov");
    if (!ov) return;
    const shareLabel = this.target === "story" ? "Next → Story" : "Use " + (isVid ? "Flex" : "photo") + " →";
    const media = isVid
      ? `<video id="cam-edit-media" class="cam-edit-media" src="${this._draft.url}" playsinline autoplay loop></video>`
      : `<img id="cam-edit-media" class="cam-edit-media" src="${this._draft.url}" alt="capture" draggable="false"><canvas id="paint-canvas" class="paint-canvas"></canvas>`;
    ov.innerHTML = `<div class="cam-stage">
      ${media}
      <div class="cam-top">
        <button class="cam-ic" onclick="Camera.retake()">↩︎</button>
        ${isVid ? "" : `<button class="cam-ic" id="paint-toggle" onclick="Camera.togglePaint()">🎨</button>`}
        <button class="cam-ic" onclick="Camera.close()">✕</button>
      </div>
      ${isVid ? "" : `<div class="paint-colors hidden" id="paint-colors">${this.PAINT_COLORS.map((c) => `<button class="paint-color" style="background:${c}" onclick="Camera.setPaint('${c}')"></button>`).join("")}<button class="paint-undo" onclick="Camera.undoPaint()">⟲</button></div>`}
      <div class="cam-bottom">
        <button class="btn cam-share" onclick="Camera.finish()">${shareLabel}</button>
      </div>
    </div>`;
    if (!isVid) this.setupPaint();
  },
  retake() { if (this._draft && this._draft.url) URL.revokeObjectURL(this._draft.url); this._draft = null; this.open(this.target); },

  // ---- paint / doodle (photos) ----
  setupPaint() {
    const img = document.getElementById("cam-edit-media");
    const cvs = document.getElementById("paint-canvas");
    if (!img || !cvs) return;
    const size = () => { const r = img.getBoundingClientRect(); cvs.width = r.width; cvs.height = r.height; cvs.style.width = r.width + "px"; cvs.style.height = r.height + "px"; };
    if (img.complete) size(); else img.onload = size;
    this._paintCtx = cvs.getContext("2d");
    this._paintStack = [];
    let drawing = false;
    const pos = (e) => { const r = cvs.getBoundingClientRect(); const t = e.touches ? e.touches[0] : e; return { x: t.clientX - r.left, y: t.clientY - r.top }; };
    const down = (e) => { if (!this.paintOn) return; e.preventDefault(); drawing = true; try { this._paintStack.push(this._paintCtx.getImageData(0, 0, cvs.width, cvs.height)); } catch (er) {} const p = pos(e); this._paintCtx.beginPath(); this._paintCtx.moveTo(p.x, p.y); };
    const move = (e) => { if (!drawing || !this.paintOn) return; e.preventDefault(); const p = pos(e); const c = this._paintCtx; c.lineTo(p.x, p.y); c.strokeStyle = this.paintColor; c.lineWidth = 7; c.lineCap = "round"; c.lineJoin = "round"; c.stroke(); };
    const up = () => { drawing = false; };
    cvs.addEventListener("touchstart", down, { passive: false }); cvs.addEventListener("touchmove", move, { passive: false }); cvs.addEventListener("touchend", up);
    cvs.addEventListener("mousedown", down); cvs.addEventListener("mousemove", move); window.addEventListener("mouseup", up);
  },
  togglePaint() {
    this.paintOn = !this.paintOn;
    const pc = document.getElementById("paint-colors"); if (pc) pc.classList.toggle("hidden", !this.paintOn);
    const pt = document.getElementById("paint-toggle"); if (pt) pt.classList.toggle("on", this.paintOn);
    const cvs = document.getElementById("paint-canvas"); if (cvs) cvs.style.pointerEvents = this.paintOn ? "auto" : "none";
  },
  setPaint(c) { this.paintColor = c; this.paintOn = true; const pc = document.getElementById("paint-colors"); if (pc) pc.classList.remove("hidden"); const cvs = document.getElementById("paint-canvas"); if (cvs) cvs.style.pointerEvents = "auto"; },
  undoPaint() { if (!this._paintStack || !this._paintStack.length) { if (this._paintCtx) this._paintCtx.clearRect(0, 0, 9999, 9999); return; } this._paintCtx.putImageData(this._paintStack.pop(), 0, 0); },

  // flatten paint onto the photo, then hand off to the story/composer flow
  async finish() {
    const d = this._draft; if (!d) return;
    let finalBlob = d.blob;
    if (!d.isVid) {
      const img = document.getElementById("cam-edit-media");
      const pcvs = document.getElementById("paint-canvas");
      const out = document.createElement("canvas");
      out.width = img.naturalWidth || 1080; out.height = img.naturalHeight || 1080;
      const ctx = out.getContext("2d");
      ctx.drawImage(img, 0, 0, out.width, out.height);
      if (pcvs && pcvs.width) ctx.drawImage(pcvs, 0, 0, out.width, out.height);
      finalBlob = await new Promise((r) => out.toBlob(r, "image/jpeg", 0.9)) || d.blob;
    }
    const isVid = d.isVid;
    const ext = isVid ? ((finalBlob.type.includes("mp4")) ? "mp4" : "webm") : "jpg";
    const file = new File([finalBlob], (isVid ? "clip." : "shot.") + ext, { type: finalBlob.type || (isVid ? "video/webm" : "image/jpeg") });
    const url = URL.createObjectURL(finalBlob);
    this.hardClose();
    if (this.target === "story") {
      if (Social._storyDraft && Social._storyDraft.url) URL.revokeObjectURL(Social._storyDraft.url);
      Social._storyDraft = { file, isVid, url };
      Social.storyPreview();
    } else {
      if (isVid) Social.attachReel(file, url);
      else Social.attachPhoto(file);
    }
  },
  hardClose() { this.stop(); if (this.recording) { this.recording = false; clearInterval(this.recTimer); } const ov = document.getElementById("camera-ov"); if (ov) ov.remove(); },
  close() { const d = this._draft; if (d && d.url) URL.revokeObjectURL(d.url); this._draft = null; this.hardClose(); },
};
