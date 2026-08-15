import os
import re
import shutil
import subprocess
import sys
import threading
import time
import uuid
import zipfile
from pathlib import Path

import imageio_ffmpeg
from fastapi import Body, FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

BASE_DIR = Path(__file__).resolve().parent
JOBS_DIR = BASE_DIR / "jobs"
JOBS_DIR.mkdir(exist_ok=True)
FRONTEND_DIR = BASE_DIR.parent / "frontend"

MODEL_NAME = "htdemucs_6s"
STEMS = ["vocals", "drums", "bass", "guitar", "piano", "other"]

# Bundle a static ffmpeg binary (no system ffmpeg / Homebrew required) and
# put its directory on PATH so demucs (and torchaudio) can find "ffmpeg".
_ffmpeg_exe = Path(imageio_ffmpeg.get_ffmpeg_exe())
os.environ["PATH"] = f"{_ffmpeg_exe.parent}{os.pathsep}{os.environ.get('PATH', '')}"
os.environ.setdefault("FFMPEG_BINARY", str(_ffmpeg_exe))

app = FastAPI(title="Stem Splitter")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# job_id -> {status, progress, error, stems: {name: path}, filename}
JOBS: dict[str, dict] = {}
JOBS_LOCK = threading.Lock()

PROGRESS_RE = re.compile(r"(\d+(?:\.\d+)?)%\|")


def _set_job(job_id: str, **fields):
    with JOBS_LOCK:
        JOBS[job_id].update(fields)


def _run_separation(job_id: str, input_path: Path, job_dir: Path):
    try:
        _set_job(job_id, status="processing", progress=1)

        out_dir = job_dir / "out"
        out_dir.mkdir(exist_ok=True)

        cmd = [
            sys.executable,
            "-m",
            "demucs",
            "-n",
            MODEL_NAME,
            "--mp3",
            "-o",
            str(out_dir),
            str(input_path),
        ]

        proc = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            bufsize=1,
        )

        last_progress = 1
        tail_lines = []
        for line in proc.stdout:
            tail_lines.append(line)
            tail_lines[:] = tail_lines[-20:]
            match = PROGRESS_RE.findall(line)
            if match:
                try:
                    pct = float(match[-1])
                    last_progress = max(last_progress, min(99, int(pct)))
                    _set_job(job_id, progress=last_progress)
                except ValueError:
                    pass

        returncode = proc.wait()
        if returncode != 0:
            print(f"[job {job_id}] demucs failed:\n" + "".join(tail_lines))
            detail = "".join(tail_lines).strip().splitlines()
            short = detail[-1] if detail else "unknown error"
            _set_job(job_id, status="error", error=f"Demucs separation failed: {short}")
            return

        track_name = input_path.stem
        stem_dir = out_dir / MODEL_NAME / track_name
        stem_paths = {}
        for stem in STEMS:
            candidate = stem_dir / f"{stem}.mp3"
            if candidate.exists():
                stem_paths[stem] = candidate

        if not stem_paths:
            _set_job(job_id, status="error", error="Separation finished but no stem files were found.")
            return

        _set_job(job_id, status="done", progress=100, stems=stem_paths)
    except Exception as exc:  # noqa: BLE001
        _set_job(job_id, status="error", error=str(exc))


@app.post("/api/jobs")
async def create_job(file: UploadFile = File(...)):
    if not file.filename.lower().endswith((".mp3", ".wav", ".flac", ".m4a", ".ogg")):
        raise HTTPException(400, "Please upload an audio file (mp3, wav, flac, m4a, ogg).")

    job_id = uuid.uuid4().hex[:12]
    job_dir = JOBS_DIR / job_id
    job_dir.mkdir(parents=True, exist_ok=True)

    safe_stem = re.sub(r"[^A-Za-z0-9_-]+", "_", Path(file.filename).stem)[:60] or "track"
    ext = Path(file.filename).suffix or ".mp3"
    input_path = job_dir / f"{safe_stem}{ext}"

    with open(input_path, "wb") as f:
        shutil.copyfileobj(file.file, f)

    with JOBS_LOCK:
        JOBS[job_id] = {
            "status": "queued",
            "progress": 0,
            "error": None,
            "stems": {},
            "filename": file.filename,
        }

    thread = threading.Thread(
        target=_run_separation, args=(job_id, input_path, job_dir), daemon=True
    )
    thread.start()

    return {"job_id": job_id}


@app.get("/api/jobs/{job_id}")
async def get_job(job_id: str):
    with JOBS_LOCK:
        job = JOBS.get(job_id)
        if not job:
            raise HTTPException(404, "Job not found.")
        return {
            "status": job["status"],
            "progress": job["progress"],
            "error": job["error"],
            "filename": job["filename"],
            "stems": sorted(job["stems"].keys()),
        }


@app.get("/api/jobs/{job_id}/stems/{stem_name}")
async def get_stem(job_id: str, stem_name: str):
    with JOBS_LOCK:
        job = JOBS.get(job_id)
        if not job:
            raise HTTPException(404, "Job not found.")
        path = job["stems"].get(stem_name)
    if not path or not path.exists():
        raise HTTPException(404, "Stem not found.")
    return FileResponse(path, media_type="audio/mpeg", filename=f"{stem_name}.mp3")


@app.get("/api/jobs/{job_id}/zip")
async def get_zip(job_id: str):
    with JOBS_LOCK:
        job = JOBS.get(job_id)
        if not job:
            raise HTTPException(404, "Job not found.")
        stems = dict(job["stems"])
        filename = job["filename"]
    if not stems:
        raise HTTPException(404, "No stems available yet.")

    base = re.sub(r"[^A-Za-z0-9_-]+", "_", Path(filename).stem)[:60] or "track"
    zip_path = JOBS_DIR / job_id / f"{base}_stems.zip"
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as zf:
        for stem_name, path in stems.items():
            zf.write(path, arcname=f"{stem_name}.mp3")

    return FileResponse(zip_path, media_type="application/zip", filename=f"{base}_stems.zip")


@app.post("/api/jobs/{job_id}/mix")
async def render_mix(job_id: str, payload: dict = Body(...)):
    with JOBS_LOCK:
        job = JOBS.get(job_id)
        if not job:
            raise HTTPException(404, "Job not found.")
        stems = dict(job["stems"])
        filename = job["filename"]
    if not stems:
        raise HTTPException(404, "No stems available yet.")

    gains = payload.get("gains", {})
    stem_names = [s for s in STEMS if s in stems]

    def clean_gain(name: str) -> float:
        try:
            value = float(gains.get(name, 1.0))
        except (TypeError, ValueError):
            value = 1.0
        return max(0.0, min(4.0, value))

    active = [(name, clean_gain(name)) for name in stem_names]
    if not any(gain > 0 for _, gain in active):
        raise HTTPException(400, "All tracks are silent — unmute or unsolo at least one track.")

    inputs = []
    filter_parts = []
    for i, (name, gain) in enumerate(active):
        inputs += ["-i", str(stems[name])]
        filter_parts.append(f"[{i}:a]volume={gain}[a{i}]")

    mix_labels = "".join(f"[a{i}]" for i in range(len(active)))
    filter_complex = (
        ";".join(filter_parts)
        + f";{mix_labels}amix=inputs={len(active)}:normalize=0[mixed]"
        + ";[mixed]alimiter=limit=0.9[out]"
    )

    base = re.sub(r"[^A-Za-z0-9_-]+", "_", Path(filename).stem)[:60] or "track"
    out_path = JOBS_DIR / job_id / f"{base}_mix.mp3"

    cmd = [
        str(_ffmpeg_exe),
        "-y",
        *inputs,
        "-filter_complex",
        filter_complex,
        "-map",
        "[out]",
        "-c:a",
        "libmp3lame",
        "-q:a",
        "2",
        str(out_path),
    ]
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0 or not out_path.exists():
        raise HTTPException(500, f"Mix render failed: {result.stderr[-500:]}")

    return FileResponse(out_path, media_type="audio/mpeg", filename=f"{base}_mix.mp3")


app.mount("/", StaticFiles(directory=str(FRONTEND_DIR), html=True), name="frontend")
