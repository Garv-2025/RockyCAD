from dotenv import load_dotenv

load_dotenv()

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
from openai import AsyncOpenAI, OpenAI
from starlette.background import BackgroundTask
import os
import re
import shutil
import subprocess
import tempfile
import traceback
from fastapi.middleware.cors import CORSMiddleware

app = FastAPI(title="RockyCAD API")

# Whitelist the Next.js frontend to allow API requests
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

client = OpenAI(
    base_url="https://openrouter.ai/api/v1",
    api_key=os.getenv("OPENROUTER_API_KEY")
)
openrouter_client = AsyncOpenAI(
    base_url="https://openrouter.ai/api/v1",
    api_key=os.getenv("OPENROUTER_API_KEY"),
)

def find_openscad_binary():
    """Detects OpenSCAD on Windows or Linux, resolving PATH or standard install paths."""
    binary = shutil.which("openscad") or shutil.which("openscad.com") or shutil.which("openscad.exe")
    if binary:
        return binary

    standard_paths = [
        r"C:\Program Files\OpenSCAD\openscad.exe",
        r"C:\Program Files\OpenSCAD\openscad.com",
        r"C:\Program Files (x86)\OpenSCAD\openscad.exe",
        os.path.expandvars(r"%LOCALAPPDATA%\Programs\OpenSCAD\openscad.exe"),
    ]
    for path in standard_paths:
        if os.path.isfile(path):
            return path
    return None

def cleanup_files(*file_paths):
    """Deletes temporary files after the response has finished streaming."""
    for path in file_paths:
        try:
            if os.path.exists(path):
                os.remove(path)
        except OSError:
            pass

class PromptRequest(BaseModel):
    prompt: str
    image_base64: str | None = None
    image_url: str | None = Field(default=None, alias="imageUrl")

class CompileRequest(BaseModel):
    scad_code: str

class FixRequest(BaseModel):
    scad_code: str
    model: str = "nvidia/nemotron-3-super-120b-a12b"

@app.post("/api/generate")
async def generate_scad(request: PromptRequest):
    try:
        if not os.getenv("OPENROUTER_API_KEY"):
            raise HTTPException(status_code=500, detail="OPENROUTER_API_KEY not set in environment or .env file.")

        system_prompt = (
            "You are RockyCAD, an expert parametric CAD assistant.\n"
            "For general conversation, greetings, or questions, communicate naturally and conversationally.\n"
            "When the user asks to design, generate, or build a 3D component, you must output ONLY valid OpenSCAD code enclosed within ```openscad and ``` markdown blocks. Use clean parameters at the top."
        )

        user_content: str | list[dict[str, object]] = request.prompt
        image_data = request.image_base64 or request.image_url
        if image_data:
            if not image_data.startswith("data:"):
                image_data = f"data:image/png;base64,{image_data}"
            user_content = [
                {"type": "text", "text": request.prompt},
                {"type": "image_url", "image_url": {"url": image_data}},
            ]

        messages = [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": "a 15 cm cylindrical rod with 1.5mm thickness"},
            {
                "role": "assistant",
                "content": "```openscad\n// Parameters\nlength = 150; // 15cm in mm\ndiameter = 1.5; // 1.5mm diameter\n$fn = 64;\n// Solid rod\ncylinder(h=length, d=diameter);\n```",
            },
            {"role": "user", "content": user_content},
        ]

        response = await openrouter_client.chat.completions.create(
            model="openrouter/free",
            messages=messages,
            temperature=0.1
        )

        response_text = response.choices[0].message.content or ""
        code_match = re.search(r"```[a-zA-Z0-9_-]*\s*\r?\n([\s\S]*?)```", response_text)
        scad_code = code_match.group(1).strip() if code_match else response_text.strip()

        return {"scad_code": scad_code}

    except Exception as e:
        print(traceback.format_exc())
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/api/fix")
async def fix_scad(request: FixRequest):
    if not os.environ.get("NEBIUS_API_KEY"):
        raise HTTPException(status_code=500, detail="NEBIUS_API_KEY not set in environment or .env file.")

    system_prompt = """You are an OpenSCAD topology corrector. The provided code may have disconnected parts, floating geometry, or z-fighting.
1. PRESERVE INTENTIONAL CORNERS: ONLY use `hull()` if parts are completely floating and disconnected in mid-air. If the parts are already flush, touching, or overlapping (like an L-bracket), use a standard `union()` instead to preserve sharp inner corners. Do not turn L-shapes into solid wedges.
2. Group all positive mass inside a single `union()`.
3. Wrap the entire assembly in a `difference()` block and subtract the holes LAST.
4. GUARANTEE THROUGH-HOLES: Ensure all subtractive cylinders/cubes are sufficiently long (e.g., h=200) and explicitly set to `center=true` to completely and cleanly pierce the positive mass. Do not leave blind holes or shallow dents.
5. Output ONLY the raw OpenSCAD code inside a markdown block. Do not output conversational text."""

    try:
        response = client.chat.completions.create(
            model=request.model,
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": request.scad_code},
            ],
            temperature=0.1,
        )

        scad_code = response.choices[0].message.content.strip()

        if scad_code.startswith("```"):
            lines = scad_code.split("\n")
            scad_code = "\n".join([line for line in lines if not line.startswith("```")])

        return {"scad_code": scad_code.strip()}

    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Nebius API error: {str(e)}")

@app.post("/api/compile")
async def compile_scad(request: CompileRequest):
    openscad_bin = find_openscad_binary()
    if not openscad_bin:
        raise HTTPException(
            status_code=500,
            detail="OpenSCAD executable not found. Make sure OpenSCAD is installed in 'C:\\Program Files\\OpenSCAD' or added to your PATH."
        )

    scad_path = None
    stl_path = None

    try:
        with tempfile.NamedTemporaryFile(delete=False, suffix=".scad", mode="w", encoding="utf-8") as scad_file:
            scad_file.write(request.scad_code)
            scad_path = scad_file.name

        stl_path = scad_path.replace(".scad", ".stl")

        # Run OpenSCAD CLI to produce STL mesh
        result = subprocess.run(
            [openscad_bin, "-o", stl_path, scad_path],
            capture_output=True,
            text=True,
            timeout=45
        )

        if result.returncode != 0:
            stderr_output = result.stderr.strip() or "Unknown compilation error."
            raise HTTPException(status_code=400, detail=f"OpenSCAD compile failure: {stderr_output}")

        if not os.path.exists(stl_path) or os.path.getsize(stl_path) == 0:
            raise HTTPException(status_code=400, detail="OpenSCAD completed without producing a valid mesh file.")

        return FileResponse(
            stl_path,
            media_type="application/sla",
            filename="model.stl",
            background=BackgroundTask(cleanup_files, scad_path, stl_path)
        )

    except subprocess.TimeoutExpired:
        if scad_path and os.path.exists(scad_path):
            cleanup_files(scad_path)
        raise HTTPException(status_code=504, detail="OpenSCAD compilation timed out (exceeded 45 seconds).")
    except HTTPException:
        if scad_path and os.path.exists(scad_path):
            cleanup_files(scad_path)
        raise
    except Exception as e:
        if scad_path and os.path.exists(scad_path):
            cleanup_files(scad_path)
        raise HTTPException(status_code=500, detail=f"Server compiler error: {str(e)}")

# Ensure static assets directory exists and mount UI
os.makedirs("static", exist_ok=True)
app.mount("/", StaticFiles(directory="static", html=True), name="static")