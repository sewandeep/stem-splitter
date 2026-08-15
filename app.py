"""
Entry point for Hugging Face Spaces (Gradio SDK).

Spaces expects a Gradio app so it can use its free, managed CPU runtime.
Our real app is a plain FastAPI + HTML/JS app (backend/main.py, frontend/),
so here we mount a tiny placeholder Gradio page at /gradio (just to satisfy
the platform) and mount our actual app at the root path, unchanged.
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent / "backend"))

from fastapi import FastAPI
import gradio as gr

from main import app as backend_app

with gr.Blocks(title="Stem Splitter") as demo:
    gr.Markdown(
        "### Stem Splitter is running.\n\n"
        "This tab is just a status page required by Hugging Face Spaces — "
        "open the Space's main app view to use it."
    )

root = FastAPI()
root = gr.mount_gradio_app(root, demo, path="/gradio")
root.mount("/", backend_app)

app = root

if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=7860)
