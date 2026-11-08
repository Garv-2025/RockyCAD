import requests
import random
import csv
import time
import os

# Local AI and your local Python FastAPI OpenSCAD compiler (100% free local execution)
OLLAMA_URL = "http://127.0.0.1:11434/api/generate"
COMPILER_URL = "http://127.0.0.1:8000/api/compile"

components = [
    "structural L-bracket",
    "flat mounting plate",
    "cylindrical spacer",
    "hexagonal standoff",
    "flanged bushing",
    "shaft collar",
    "U-channel bracket",
    "corner gusset",
    "rectangular project enclosure base",
    "circular pipe flange"
]

csg_constraints = [
    "Include a central through-hole using a difference() subtraction.",
    "Add four circular mounting holes arranged in a rectangular pattern.",
    "Include a 2mm chamfer on the primary outer edges.",
    "Use a union() to combine a thick base plate with a thinner extended mounting tab.",
    "Subtract a hexagonal recess designed to capture a standard metric hex nut.",
    "Ensure all subtracted hole geometries extend past the main body on the Z-axis to prevent 3D rendering artifacts."
]

def run_factory():
    file_exists = os.path.isfile("dataset.csv")
    
    # Open CSV file to log successful training data
    with open("dataset.csv", "a", newline="", encoding="utf-8") as f:
        writer = csv.writer(f)
        if not file_exists:
            writer.writerow(["Prompt", "OpenSCAD_Code"])
        
        print("Synthetic Data Factory Started. Press Ctrl+C to stop.")
        
        while True:
            # 1. Invent a complex mechanical prompt
            base_size = random.randint(20, 100)
            thickness = random.randint(3, 15)
            comp = random.choice(components)
            constraint = random.choice(csg_constraints)
            
            user_prompt = f"Write parameterized OpenSCAD code for a {comp}. The overall size is roughly {base_size}mm with a thickness of {thickness}mm. {constraint}"
            full_prompt = (
                "System: You are an expert OpenSCAD mechanical engineer. "
                "You output ONLY raw OpenSCAD code. No explanations. No markdown blocks. No backticks. "
                "Always use standard CSG operations (union, difference, intersection).\n"
                f"User: {user_prompt}"
            )
            print(f"\n[Prompt] {user_prompt}")
            
            # 2. Ask local Qwen model to write the code
            ai_payload = {
                "model": "qwen2.5-coder:1.5b",
                "prompt": full_prompt,
                "stream": False
            }
            try:
                response = requests.post(OLLAMA_URL, json=ai_payload, timeout=60)
                code = response.json().get("response", "").strip()
            except Exception as e:
                print(f"Local AI offline or timed out ({e}). Retrying...")
                time.sleep(2)
                continue
                
            # 3. Clean markdown and test the generated code in your local OpenSCAD compiler
            code = code.replace("```openscad", "").replace("```scad", "").replace("```", "").strip()
            print(f"\n[AI OUTPUT]:\n{code}\n")
            
            try:
                compiler_res = requests.post(COMPILER_URL, json={"scad_code": code}, timeout=30)
                if compiler_res.status_code == 200:
                    writer.writerow([user_prompt, code])
                    f.flush()
                    print("[SUCCESS] Compiled flawlessly. Saved to dataset.csv")
                else:
                    print(f"[FAILED] Compiler threw a {compiler_res.status_code} error. Discarding garbage code.")
            except Exception as e:
                print(f"[ERROR] FastAPI server is unreachable ({e}). Is uvicorn running?")
            
            time.sleep(1)

if __name__ == "__main__":
    run_factory()