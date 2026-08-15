const dropzone = document.getElementById("drop");
const fileInput = document.getElementById("file-input");
const progressSection = document.getElementById("progress-section");
const progressLabel = document.getElementById("progress-label");
const progressPct = document.getElementById("progress-pct");
const progressFill = document.getElementById("progress-fill");
const errorSection = document.getElementById("error-section");
const resultsSection = document.getElementById("results-section");
const resultsTitle = document.getElementById("results-title");
const loadingWaveforms = document.getElementById("loading-waveforms");
const tracksEl = document.getElementById("tracks");
const downloadAllBtn = document.getElementById("download-all");
const downloadMixBtn = document.getElementById("download-mix");
const resetBtn = document.getElementById("reset-btn");

const transportEl = document.getElementById("transport");
const playBtn = document.getElementById("play-btn");
const stopBtn = document.getElementById("stop-btn");
const timeDisplay = document.getElementById("time-display");
const loopToggle = document.getElementById("loop-toggle");
const masterVolumeInput = document.getElementById("master-volume");
const resetMixBtn = document.getElementById("reset-mix-btn");
const masterSeek = document.getElementById("master-seek");
const masterSeekFill = document.getElementById("master-seek-fill");

const STEM_META = {
  vocals: { icon: "🎤", color: "#7c6cff" },
  drums: { icon: "🥁", color: "#ff6b6b" },
  bass: { icon: "🎸", color: "#5ce1c9" },
  guitar: { icon: "🎸", color: "#ffb84c" },
  piano: { icon: "🎹", color: "#4cc9ff" },
  other: { icon: "🎛️", color: "#c792ea" },
};

let currentJobId = null;
let pollTimer = null;

// ---------- Upload / job polling ----------

function showOnly(section) {
  [progressSection, errorSection, resultsSection].forEach((s) => s.classList.add("hidden"));
  if (section) section.classList.remove("hidden");
}

function resetUI() {
  player.teardown();
  showOnly(null);
  fileInput.value = "";
  currentJobId = null;
  if (pollTimer) clearInterval(pollTimer);
}

dropzone.addEventListener("click", () => fileInput.click());
dropzone.addEventListener("dragover", (e) => {
  e.preventDefault();
  dropzone.classList.add("dragover");
});
dropzone.addEventListener("dragleave", () => dropzone.classList.remove("dragover"));
dropzone.addEventListener("drop", (e) => {
  e.preventDefault();
  dropzone.classList.remove("dragover");
  if (e.dataTransfer.files.length) uploadFile(e.dataTransfer.files[0]);
});
fileInput.addEventListener("change", () => {
  if (fileInput.files.length) uploadFile(fileInput.files[0]);
});
resetBtn.addEventListener("click", resetUI);

async function uploadFile(file) {
  player.teardown();
  showOnly(progressSection);
  progressLabel.textContent = "Uploading…";
  progressPct.textContent = "0%";
  progressFill.style.width = "0%";

  const formData = new FormData();
  formData.append("file", file);

  try {
    const res = await fetch("/api/jobs", { method: "POST", body: formData });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.detail || `Upload failed (${res.status})`);
    }
    const data = await res.json();
    currentJobId = data.job_id;
    progressLabel.textContent = "Separating stems…";
    pollTimer = setInterval(() => pollJob(currentJobId), 1500);
  } catch (err) {
    showError(err.message);
  }
}

async function pollJob(jobId) {
  try {
    const res = await fetch(`/api/jobs/${jobId}`);
    if (!res.ok) throw new Error("Lost track of the job.");
    const job = await res.json();

    if (job.status === "error") {
      clearInterval(pollTimer);
      showError(job.error || "Separation failed.");
      return;
    }

    const pct = job.progress || 0;
    progressPct.textContent = `${pct}%`;
    progressFill.style.width = `${pct}%`;
    progressLabel.textContent = job.status === "queued" ? "Queued…" : "Separating stems…";

    if (job.status === "done") {
      clearInterval(pollTimer);
      showResults(jobId, job);
    }
  } catch (err) {
    clearInterval(pollTimer);
    showError(err.message);
  }
}

function showError(message) {
  errorSection.textContent = `⚠️ ${message}`;
  showOnly(errorSection);
}

// ---------- Web Audio multi-track player ----------

const player = {
  audioCtx: null,
  masterGain: null,
  tracks: [], // { name, buffer, gainNode, source, muted, soloed, volume, row, canvas, waveformImg }
  duration: 0,
  playing: false,
  startCtxTime: 0,
  startOffset: 0,
  loop: false,
  rafId: null,

  effectiveGain(t) {
    if (t.muted) return 0;
    const anySolo = this.tracks.some((x) => x.soloed);
    if (anySolo && !t.soloed) return 0;
    return t.volume;
  },

  applyGains() {
    const now = this.audioCtx.currentTime;
    this.tracks.forEach((t) => {
      t.gainNode.gain.setTargetAtTime(this.effectiveGain(t), now, 0.015);
    });
    this.tracks.forEach((t) => updateTrackVisual(t));
  },

  currentPosition() {
    if (!this.playing) return this.startOffset;
    return this.startOffset + (this.audioCtx.currentTime - this.startCtxTime);
  },

  play() {
    if (this.playing || this.tracks.length === 0) return;
    this.audioCtx.resume();
    const offset = Math.max(0, Math.min(this.startOffset, this.duration));
    const when = this.audioCtx.currentTime + 0.06;
    this.tracks.forEach((t) => {
      const src = this.audioCtx.createBufferSource();
      src.buffer = t.buffer;
      src.connect(t.gainNode);
      src.start(when, offset);
      t.source = src;
    });
    this.startCtxTime = when;
    this.startOffset = offset;
    this.playing = true;
    this.applyGains();
    playBtn.textContent = "⏸";
  },

  pause() {
    if (!this.playing) return;
    this.startOffset = this.currentPosition();
    this.tracks.forEach((t) => {
      if (t.source) {
        try { t.source.stop(); } catch (e) {}
        t.source = null;
      }
    });
    this.playing = false;
    playBtn.textContent = "▶";
  },

  stop() {
    this.pause();
    this.startOffset = 0;
    updateTimeUI(0);
    drawAllWaveforms();
  },

  seek(time) {
    const wasPlaying = this.playing;
    if (this.playing) {
      this.tracks.forEach((t) => {
        if (t.source) {
          try { t.source.stop(); } catch (e) {}
          t.source = null;
        }
      });
      this.playing = false;
    }
    this.startOffset = Math.max(0, Math.min(time, this.duration));
    if (wasPlaying) this.play();
    else {
      updateTimeUI(this.startOffset);
      drawAllWaveforms();
    }
  },

  toggleMute(name) {
    const t = this.tracks.find((x) => x.name === name);
    if (!t) return;
    t.muted = !t.muted;
    this.applyGains();
  },

  toggleSolo(name) {
    const t = this.tracks.find((x) => x.name === name);
    if (!t) return;
    t.soloed = !t.soloed;
    this.applyGains();
  },

  setVolume(name, vol) {
    const t = this.tracks.find((x) => x.name === name);
    if (!t) return;
    t.volume = vol;
    this.applyGains();
  },

  resetMix() {
    this.tracks.forEach((t) => {
      t.muted = false;
      t.soloed = false;
      t.volume = 1;
      const row = t.row;
      row.querySelector(".mute-btn").classList.remove("active");
      row.querySelector(".solo-btn").classList.remove("active");
      row.querySelector(".track-volume").value = 1;
    });
    masterVolumeInput.value = 1;
    this.masterGain.gain.setTargetAtTime(1, this.audioCtx.currentTime, 0.01);
    this.applyGains();
  },

  teardown() {
    this.pause();
    if (this.audioCtx) {
      this.audioCtx.close().catch(() => {});
    }
    if (this.rafId) cancelAnimationFrame(this.rafId);
    this.audioCtx = null;
    this.masterGain = null;
    this.tracks = [];
    this.duration = 0;
    this.startOffset = 0;
    this.playing = false;
  },

  async loadTracks(jobId, stemNames) {
    this.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    this.masterGain = this.audioCtx.createGain();
    this.masterGain.gain.value = parseFloat(masterVolumeInput.value);
    this.masterGain.connect(this.audioCtx.destination);

    const loaded = await Promise.all(
      stemNames.map(async (name) => {
        const res = await fetch(`/api/jobs/${jobId}/stems/${name}`);
        const arrBuf = await res.arrayBuffer();
        const buffer = await this.audioCtx.decodeAudioData(arrBuf);
        return { name, buffer };
      })
    );

    this.duration = Math.max(...loaded.map((t) => t.buffer.duration));
    this.tracks = loaded.map(({ name, buffer }) => {
      const gainNode = this.audioCtx.createGain();
      gainNode.connect(this.masterGain);
      return {
        name,
        buffer,
        gainNode,
        source: null,
        muted: false,
        soloed: false,
        volume: 1,
        row: null,
        canvas: null,
        waveformImg: null,
      };
    });
  },
};

function averageChannels(buffer) {
  const ch0 = buffer.getChannelData(0);
  if (buffer.numberOfChannels === 1) return ch0;
  const out = new Float32Array(ch0.length);
  out.set(ch0);
  for (let c = 1; c < buffer.numberOfChannels; c++) {
    const ch = buffer.getChannelData(c);
    for (let i = 0; i < ch.length; i++) out[i] += ch[i];
  }
  for (let i = 0; i < out.length; i++) out[i] /= buffer.numberOfChannels;
  return out;
}

function computePeaks(buffer, numBuckets) {
  const data = averageChannels(buffer);
  const bucketSize = Math.max(1, Math.floor(data.length / numBuckets));
  const peaks = new Array(numBuckets);
  for (let i = 0; i < numBuckets; i++) {
    const start = i * bucketSize;
    const end = Math.min(start + bucketSize, data.length);
    let min = 0;
    let max = 0;
    for (let j = start; j < end; j++) {
      const v = data[j];
      if (v < min) min = v;
      if (v > max) max = v;
    }
    peaks[i] = [min, max];
  }
  return peaks;
}

function buildWaveformImage(peaks, width, height, color) {
  const off = document.createElement("canvas");
  off.width = width;
  off.height = height;
  const ctx = off.getContext("2d");
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  const mid = height / 2;
  const n = peaks.length;
  for (let i = 0; i < n; i++) {
    const x = (i / n) * width;
    const [min, max] = peaks[i];
    ctx.beginPath();
    ctx.moveTo(x, mid + min * mid * 0.9);
    ctx.lineTo(x, mid + max * mid * 0.9);
    ctx.stroke();
  }
  return off;
}

function drawTrackWaveform(t) {
  const canvas = t.canvas;
  if (!canvas || !t.waveformImg) return;
  const dpr = window.devicePixelRatio || 1;
  const cssW = canvas.clientWidth || 600;
  const cssH = canvas.clientHeight || 64;
  if (canvas.width !== Math.round(cssW * dpr) || canvas.height !== Math.round(cssH * dpr)) {
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
  }
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);
  ctx.globalCompositeOperation = "source-over";
  ctx.drawImage(t.waveformImg, 0, 0, cssW, cssH);

  const fraction = player.duration ? player.currentPosition() / player.duration : 0;
  const playedX = Math.max(0, Math.min(1, fraction)) * cssW;

  ctx.save();
  ctx.globalCompositeOperation = "source-atop";
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, playedX, cssH);
  ctx.restore();

  ctx.strokeStyle = "rgba(255,255,255,0.8)";
  ctx.beginPath();
  ctx.moveTo(playedX, 0);
  ctx.lineTo(playedX, cssH);
  ctx.stroke();
}

function drawAllWaveforms() {
  player.tracks.forEach(drawTrackWaveform);
  const fraction = player.duration ? player.currentPosition() / player.duration : 0;
  masterSeekFill.style.width = `${Math.max(0, Math.min(1, fraction)) * 100}%`;
}

function updateTrackVisual(t) {
  if (!t.row) return;
  const silenced = player.effectiveGain(t) === 0;
  t.row.classList.toggle("silenced", silenced);
}

function formatTime(sec) {
  if (!isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

function updateTimeUI(pos) {
  timeDisplay.textContent = `${formatTime(pos)} / ${formatTime(player.duration)}`;
}

function tick() {
  if (player.playing) {
    const pos = player.currentPosition();
    if (pos >= player.duration) {
      if (player.loop) {
        player.seek(0);
      } else {
        player.pause();
        player.startOffset = 0;
        updateTimeUI(0);
        drawAllWaveforms();
      }
    } else {
      updateTimeUI(pos);
      drawAllWaveforms();
    }
  }
  player.rafId = requestAnimationFrame(tick);
}
requestAnimationFrame(tick);

// ---------- Transport controls ----------

playBtn.addEventListener("click", () => {
  if (player.playing) player.pause();
  else player.play();
});
stopBtn.addEventListener("click", () => player.stop());
loopToggle.addEventListener("change", () => {
  player.loop = loopToggle.checked;
});
masterVolumeInput.addEventListener("input", () => {
  if (!player.audioCtx) return;
  player.masterGain.gain.setTargetAtTime(parseFloat(masterVolumeInput.value), player.audioCtx.currentTime, 0.01);
});
resetMixBtn.addEventListener("click", () => player.resetMix());

masterSeek.addEventListener("click", (e) => {
  if (!player.duration) return;
  const rect = masterSeek.getBoundingClientRect();
  const fraction = (e.clientX - rect.left) / rect.width;
  player.seek(fraction * player.duration);
});

document.addEventListener("keydown", (e) => {
  if (e.code !== "Space") return;
  const tag = document.activeElement && document.activeElement.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "BUTTON") return;
  if (resultsSection.classList.contains("hidden")) return;
  e.preventDefault();
  if (player.playing) player.pause();
  else player.play();
});

// ---------- Results rendering ----------

async function showResults(jobId, job) {
  resultsTitle.textContent = `Stems for "${job.filename}"`;
  tracksEl.innerHTML = "";
  transportEl.classList.add("hidden");
  masterSeek.classList.add("hidden");
  loadingWaveforms.classList.remove("hidden");
  loadingWaveforms.textContent = "Loading waveforms…";
  showOnly(resultsSection);

  downloadAllBtn.onclick = () => {
    window.location.href = `/api/jobs/${jobId}/zip`;
  };

  try {
    await player.loadTracks(jobId, job.stems);
  } catch (err) {
    loadingWaveforms.textContent = `⚠️ Couldn't load audio for playback: ${err.message}`;
    return;
  }

  player.tracks.forEach((t) => {
    const meta = STEM_META[t.name] || { icon: "🎧", color: "#8888ff" };
    const row = document.createElement("div");
    row.className = "track-row";
    row.innerHTML = `
      <div class="track-controls">
        <div class="track-name">${meta.icon} ${t.name}</div>
        <div class="track-buttons">
          <button class="toggle-btn mute-btn" title="Mute">M</button>
          <button class="toggle-btn solo-btn" title="Solo">S</button>
        </div>
        <input class="track-volume" type="range" min="0" max="1.5" step="0.01" value="1" />
        <a class="btn small track-download" download="${t.name}.mp3" href="/api/jobs/${jobId}/stems/${t.name}">Download</a>
      </div>
      <canvas class="waveform"></canvas>
    `;
    tracksEl.appendChild(row);

    t.row = row;
    t.canvas = row.querySelector(".waveform");

    const peaks = computePeaks(t.buffer, 1200);
    t.waveformImg = buildWaveformImage(peaks, 1200, 128, meta.color);

    row.querySelector(".mute-btn").addEventListener("click", (e) => {
      player.toggleMute(t.name);
      e.currentTarget.classList.toggle("active", t.muted);
    });
    row.querySelector(".solo-btn").addEventListener("click", (e) => {
      player.toggleSolo(t.name);
      e.currentTarget.classList.toggle("active", t.soloed);
    });
    row.querySelector(".track-volume").addEventListener("input", (e) => {
      player.setVolume(t.name, parseFloat(e.target.value));
    });
    t.canvas.addEventListener("click", (e) => {
      if (!player.duration) return;
      const rect = t.canvas.getBoundingClientRect();
      const fraction = (e.clientX - rect.left) / rect.width;
      player.seek(fraction * player.duration);
    });
  });

  loadingWaveforms.classList.add("hidden");
  transportEl.classList.remove("hidden");
  masterSeek.classList.remove("hidden");
  updateTimeUI(0);
  drawAllWaveforms();

  window.addEventListener("resize", drawAllWaveforms);

  downloadMixBtn.onclick = async () => {
    const gains = {};
    player.tracks.forEach((t) => {
      gains[t.name] = player.effectiveGain(t);
    });
    downloadMixBtn.disabled = true;
    const originalLabel = downloadMixBtn.textContent;
    downloadMixBtn.textContent = "Rendering…";
    try {
      const res = await fetch(`/api/jobs/${jobId}/mix`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ gains }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.detail || "Mix render failed.");
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "mix.mp3";
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      alert(err.message);
    } finally {
      downloadMixBtn.disabled = false;
      downloadMixBtn.textContent = originalLabel;
    }
  };
}
