from dotenv import load_dotenv

load_dotenv()

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from langchain_community.embeddings import HuggingFaceEmbeddings
from langchain_community.vectorstores import FAISS
from langchain_core.documents import Document
from pydantic import BaseModel, Field
from openai import AsyncOpenAI
from starlette.background import BackgroundTask
import os
import re
import shutil
import subprocess
import tempfile
import logging
from typing import Literal
from fastapi.middleware.cors import CORSMiddleware

# Allow your Vercel frontend to talk to this backend

logger = logging.getLogger(__name__)
app = FastAPI(title="RockyCAD API")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["https://rocky-cad-yufs.vercel.app", "http://localhost:3000"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
vector_store: FAISS | None = None

api_key = os.getenv("OPENROUTER_API_KEY")
client = (
    AsyncOpenAI(base_url="https://openrouter.ai/api/v1", api_key=api_key)
    if api_key
    else None
)


@app.on_event("startup")
async def initialize_vector_store() -> None:
    global vector_store

    embeddings = HuggingFaceEmbeddings(model_name="all-MiniLM-L6-v2")
    documents = [
        Document(page_content=(
            "OpenSCAD parametric CSG: Always put $fn=100; at the top. "
            "Define all variables at the top of the script before geometry."
        )),
        Document(page_content=(
            "To make a hollow tube, use "
            "difference() { cylinder(d=outer); translate([0,0,-1]) "
            "cylinder(d=inner, h=h+2); }. Give the outer cylinder the desired "
            "height h, and extend the inner cutter past both ends."
        )),
        Document(page_content=(
            "Use union() to combine solids and difference() to subtract holes. "
            "Place dimensions in named variables for easy parametric editing."
        )),
        Document(page_content=(
            "For a through-hole, make the cutter longer than the body and offset "
            "it so it extends beyond both faces. Use centered geometry or "
            "explicit translations consistently."
        )),
    ]
    texts = [document.page_content for document in documents]
    vector_store = FAISS.from_texts(texts, embeddings)

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

class ChatHistoryMessage(BaseModel):
    role: Literal["user", "assistant"]
    content: str

class GenerateRequest(BaseModel):
    messages: list[ChatHistoryMessage] | None = None
    prompt: str | None = None
    image_base64: str | None = None
    image_url: str | None = Field(default=None, alias="imageUrl")
    history: list[ChatHistoryMessage] = Field(default_factory=list)

class CompileRequest(BaseModel):
    scad_code: str

class FixRequest(BaseModel):
    scad_code: str

@app.post("/api/generate")
async def generate_scad(request: GenerateRequest):
    try:
        if client is None:
            raise HTTPException(status_code=500, detail="OPENROUTER_API_KEY not set in environment or .env file.")
        if vector_store is None:
            raise HTTPException(status_code=503, detail="The CAD knowledge base is not initialized.")

        if request.messages is not None:
            conversation = [
                {"role": message.role, "content": message.content}
                for message in request.messages
            ]
        elif request.prompt and request.prompt.strip():
            conversation = [
                {"role": message.role, "content": message.content}
                for message in request.history[-6:]
            ]
            conversation.append({"role": "user", "content": request.prompt.strip()})
        else:
            raise HTTPException(status_code=422, detail="Provide a non-empty prompt or chat messages.")

        latest_user_message = next(
            (message for message in reversed(conversation) if message["role"] == "user"),
            None,
        )
        if latest_user_message is None:
            raise HTTPException(status_code=422, detail="Chat history must include a user message.")

        query = latest_user_message["content"]
        if not query.strip():
            raise HTTPException(status_code=422, detail="The latest user message cannot be empty.")

        image_data = request.image_base64 or request.image_url
        if image_data:
            if not image_data.startswith("data:"):
                image_data = f"data:image/png;base64,{image_data}"
            latest_user_message["content"] = [
                {"type": "text", "text": query},
                {"type": "image_url", "image_url": {"url": image_data}},
            ]

        context_documents = vector_store.similarity_search(query, k=2)
        context = "\n\n".join(document.page_content for document in context_documents)
        system_prompt = f"""You are a CAD assistant. Instead of raw OpenSCAD code, output a JSON array of primitive shapes matching the frontend scene state. Valid types are "box", "cylinder", "sphere", and "cone". Each object must include "type", "position" [x, y, z], "scale" [x, y, z], "rotation" [x, y, z], and "params".
For "box", the "params" object MUST contain exactly "width", "length", and "height" as numbers. Never use "thickness", "depth", or "size". Example: {{"width": 50, "length": 50, "height": 5}}.
For "cylinder", the "params" object MUST contain "radius" (number) and "height" (number). Do not use "diameter". To model regular polygonal prisms (such as a hexagonal hole or nut), use type "cylinder" and include a "segments" key in the "params" object (e.g., {{"radius": 10, "height": 20, "segments": 6}}). For smooth circles, omit "segments". For "cone", use radius and height keys. For "sphere", use "radius" (number).
CRITICAL: NEVER use the `scale` array to set physical dimensions. The `scale` array MUST ALWAYS be exactly `[1, 1, 1]`. You must define all sizes strictly inside the `params` object (e.g., `radius`, `height`, `width`).
Always place objects so they rest ON the floor. Because origins are center-based, the "position" Z-coordinate MUST always be exactly half of the object's height (e.g., if height is 40, position Z is 20).
To subtract geometry (make a hole), add "isHole": true. Put the complete JSON array strictly inside a ```json ... ``` block. You may add a short, natural language explanation outside the block; do not output OpenSCAD code.

You are also an expert mechanical engineer. Use the retrieved OpenSCAD references below when relevant:
<retrieved_context>
{context}
</retrieved_context>

Understand the requested dimensions and CSG operations carefully. If a crucial dimension or requirement is missing, ask a concise clarifying question and do not invent shapes. Return an empty JSON array only when the user is asking a question rather than requesting geometry.
Keep coordinate calculations strictly under 3 sentences before outputting the final JSON array. Ensure every subtracting object explicitly includes `"isHole": true`."""
        prompt_messages = [
            {"role": "system", "content": system_prompt},
            *conversation,
        ]

        try:
            response = await client.chat.completions.create(
                model="meta-llama/llama-3.3-70b-instruct:free",
                messages=prompt_messages,
            )
        except Exception:
            logger.warning("Primary model failed; retrying generation with openrouter/free", exc_info=True)
            response = await client.chat.completions.create(
                model="openrouter/free",
                messages=prompt_messages,
            )
        response_text = response.choices[0].message.content or ""
        json_match = re.search(
            r"```json\b\s*([\s\S]*?)```",
            response_text,
            re.IGNORECASE,
        )
        json_payload = json_match.group(1).strip() if json_match else ""
        message = (
            f"{response_text[:json_match.start()]}{response_text[json_match.end():]}".strip()
            if json_match
            else response_text.strip()
        )

        return {"message": message, "json_payload": json_payload}
    except HTTPException:
        raise
    except Exception as error:
        logger.exception("OpenRouter CAD generation failed")
        raise HTTPException(status_code=502, detail=f"CAD generation failed: {error}") from error

@app.post("/api/fix")
async def fix_scad(request: FixRequest):
    if client is None:
        raise HTTPException(status_code=500, detail="OPENROUTER_API_KEY not set in environment or .env file.")

    system_prompt = f"""You are a CAD assistant. Instead of raw OpenSCAD code, output a JSON array of primitive shapes matching the frontend scene state. Valid types are "box", "cylinder", "sphere", and "cone". Each object must include "type", "position" [x, y, z], "scale" [1, 1, 1], "rotation" [x, y, z], and "params".
For "box", "params" MUST contain exactly "width", "length", and "height".
For "cylinder", "params" MUST contain "radius" and "height" (include "segments" for polygons).
For "cone", use "radius" and "height". For "sphere", use "radius".
CRITICAL: The `scale` array MUST ALWAYS be exactly `[1, 1, 1]`. Define all sizes strictly inside `params`.
Always place objects so they rest ON the floor. The "position" Z-coordinate MUST always be exactly half of the object's height.

Study these exact examples to understand spatial placement and avoid overlapping meshes:

Example 1 (Basic Floor Placement):
User: "Generate a 50x50 base plate that is 5mm thick."
Assistant: ```json
[
  {{
    "type": "box",
    "position": [0, 0, 2.5],
    "scale": [1, 1, 1],
    "rotation": [0, 0, 0],
    "params": {{"width": 50, "length": 50, "height": 5}}
  }}
]
Example 2 (Holes and Subtractions):
User: "Create a washer with a 20mm outer radius, a 10mm inner hole radius, and 4mm height."
Assistant: ```json
[
{{
"type": "cylinder",
"position": [0, 0, 2],
"scale": [1, 1, 1],
"rotation": [0, 0, 0],
"params": {{"radius": 20, "height": 4}}
}},
{{
"type": "cylinder",
"position": [0, 0, 2],
"scale": [1, 1, 1],
"rotation": [0, 0, 0],
"params": {{"radius": 10, "height": 4}},
"isHole": true
}}
]


Example 3 (Touching but NOT Overlapping - L Bracket):
User: "An L-bracket. A 40x40x5 base plate with a 5x40x35 vertical wall on the left edge."
Assistant: ```json
[
  {{
    "type": "box",
    "position": [0, 0, 2.5],
    "scale": [1, 1, 1],
    "rotation": [0, 0, 0],
    "params": {{"width": 40, "length": 40, "height": 5}}
  }},
  {{
    "type": "box",
    "position": [-17.5, 0, 22.5],
    "scale": [1, 1, 1],
    "rotation": [0, 0, 0],
    "params": {{"width": 5, "length": 40, "height": 35}}
  }}
]
<retrieved_context>
{context}
</retrieved_context>

Understand the requested dimensions carefully. If a crucial dimension is missing, ask a concise clarifying question. Keep non-JSON text strictly under 3 sentences."""

    try:
        response = await client.chat.completions.create(
            model="openrouter/free",
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": request.scad_code},
            ],
            temperature=0.1,
        )

        scad_code = response.choices[0].message.content or ""
        code_match = re.search(r"```[a-zA-Z0-9_-]*\s*\r?\n([\s\S]*?)```", scad_code)
        if code_match:
            scad_code = code_match.group(1)
        scad_code = scad_code.strip()
        if not scad_code:
            raise HTTPException(status_code=502, detail="OpenRouter returned no corrected OpenSCAD code.")

        return {"scad_code": scad_code}

    except Exception as e:
        if isinstance(e, HTTPException):
            raise
        logger.exception("OpenRouter Auto-Fix failed")
        raise HTTPException(status_code=502, detail=f"OpenRouter Auto-Fix error: {str(e)}")

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