from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from openai import OpenAI
from starlette.background import BackgroundTask
import os
import shutil
import subprocess
import tempfile
from dotenv import load_dotenv
from fastapi.middleware.cors import CORSMiddleware

load_dotenv()

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
    base_url="https://api.tokenfactory.nebius.com/v1/",
    api_key=os.environ.get("NEBIUS_API_KEY")
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

class GenerateRequest(BaseModel):
    prompt: str
    model: str = "nvidia/nemotron-3-super-120b-a12b"

class CompileRequest(BaseModel):
    scad_code: str

@app.post("/api/generate")
async def generate_scad(request: GenerateRequest):
    if not os.environ.get("NEBIUS_API_KEY"):
        raise HTTPException(status_code=500, detail="NEBIUS_API_KEY not set in environment or .env file.")

    system_prompt = """
    You are an expert mechanical CAD engineer. Generate ONLY valid, deterministic OpenSCAD code.
    Do not output markdown code blocks, conversational introductions, or explanations.
    Always define parametric variables at the top of the file.
    Center all primary parts at origin [0,0,0].

    CRITICAL OPENSCAD RULES YOU MUST FOLLOW:
    1. NEVER assign 3D shapes to variables (e.g., "shape = cube();" is ILLEGAL). Variables can ONLY hold numbers, vectors, or strings.
    2. NEVER use bitwise operators like | or & to combine shapes.
    3. ALWAYS combine shapes using standard nested boolean modules: union() { ... }, difference() { ... }, or intersection() { ... }.
    4. Construct complex parts by nesting geometry directly inside these boolean blocks.
    """

    try:
        response = client.chat.completions.create(
            model=request.model,
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": request.prompt}
            ],
            temperature=0.1
        )

        scad_code = response.choices[0].message.content.strip()

        # Strip accidental markdown fencing from the model
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