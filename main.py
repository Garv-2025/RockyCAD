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

class FixRequest(BaseModel):
    scad_code: str
    model: str = "nvidia/nemotron-3-super-120b-a12b"

@app.post("/api/generate")
async def generate_scad(request: GenerateRequest):
    if not os.environ.get("NEBIUS_API_KEY"):
        raise HTTPException(status_code=500, detail="NEBIUS_API_KEY not set in environment or .env file.")

    system_prompt = """
    You are RockyCAD, an expert mechanical CAD engineer and interactive AI assistant. Your goal is to help users design 3D models and generate strictly valid, printable OpenSCAD code.

    === PHASE 1: CONVERSE & CLARIFY (STRICT LIMIT) ===
    1. If a user provides a decent starting point, move immediately to code generation.
    2. If the request is incredibly vague, ask a MAXIMUM of 1 or 2 essential clarifying questions. DO NOT output long lists.
    3. INVENT REASONABLE DEFAULTS: Make professional engineering guesses for missing dimensions. The user will tweak them later.

    === PHASE 2: CODE GENERATION & STRICT CAD PROTOCOL ===
    You lack visual spatial awareness, so you MUST follow this rigid Order of Operations to prevent disconnected, floating parts.

    THE SOLID BODY PROTOCOL:
    1. POSITIVE MASS FIRST: Always build the entire positive solid body first.
    2. THE HULL SHORTCUT: If a design requires connecting multiple columns, pegs, or mounts (like a bracket), DO NOT just guess their translations and hope they touch. Place the components, and wrap them in a `hull()` block. `hull()` acts as geometric shrink-wrap, mathematically guaranteeing a single, unified solid bridge between the parts.
    3. DIFFERENCE LAST: Wrap the finalized positive mass in a `difference()` block, and subtract all holes, cuts, and negative spaces at the very end. 
    4. Z-FIGHTING PREVENTION: Any negative cylinder/cube MUST be explicitly extended (e.g., `h = thickness + 2`) to punch cleanly through the positive mass.

    OPENSCAD SYNTAX RULES:
    - ALWAYS put `$fn = 64;` at the absolute top.
    - NO UNCALLED MODULES: Declare the geometry flatly in the global scope so it actually renders.
    - NO SHAPE VARIABLES: NEVER assign 3D shapes to variables (e.g., `shape = cube();` is ILLEGAL).
    - SEMICOLONS: Ensure every variable and module call ends with a semicolon (;).

    === OUTPUT FORMAT ===
    Output the code strictly inside a single Markdown block at the end. 
    
    EXAMPLE OF CORRECT TOPOLOGY (e.g., Flanged Bearing Block):
    ```openscad
    $fn = 64;
    
    // Parameters
    cyl_dia = 30; 
    cyl_h = 20; 
    tab_ext = 15; 
    tab_width = 30; 
    tab_thick = 5; 
    bearing_dia = 22; 
    screw_dia = 5;
    
    // Geometry
    difference() {
        // 1. Positive Mass (Ensure components physically overlap)
        union() {
            cylinder(d=cyl_dia, h=cyl_h); // Main body
            
            // Right tab overlapping into the cylinder
            translate([cyl_dia/2, -tab_width/2, 0]) 
                cube([tab_ext, tab_width, tab_thick]); 
                
            // Left tab overlapping into the cylinder
            translate([-cyl_dia/2 - tab_ext, -tab_width/2, 0]) 
                cube([tab_ext, tab_width, tab_thick]);
        }
        
        // 2. Negative Space (All holes extended by +2 height to prevent z-fighting)
        translate([0, 0, -1]) 
            cylinder(d=bearing_dia, h=cyl_h + 2); // Center hole
            
        translate([cyl_dia/2 + tab_ext/2, 0, -1]) 
            cylinder(d=screw_dia, h=tab_thick + 2); // Right screw hole
            
        translate([-cyl_dia/2 - tab_ext/2, 0, -1]) 
            cylinder(d=screw_dia, h=tab_thick + 2); // Left screw hole
    }
    ```
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