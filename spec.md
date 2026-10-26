# Technical Specifications: RockyCAD

## 1. Tech Stack
* **Frontend Framework:** Next.js (React), Tailwind CSS
* **3D Rendering Engine:** React Three Fiber, Three.js
* **CAD Compilation:** OpenSCAD (browser-native implementation)
* **Deployment:** Vercel

## 2. System Architecture
* **Flipped Interaction Model:** The LLM operates as a background engine rather than a chat interface. User prompts are sent via a System Prompt Engineering pipeline heavily constrained by topological and spatial rules.
* **State Management:** The application relies on a unified state tree that tracks the position, scale, and rotation of every CSG node. This state is fed simultaneously into the React Three Fiber canvas (for visual rendering) and the Developer Terminal (for text rendering).
* **Two-Way Binding:** Event listeners on the Three.js transform controls update the global state upon release, triggering a re-render of both the 3D mesh and the raw OpenSCAD string.

## 3. Data Flow
1. User submits prompt -> LLM returns OpenSCAD code.
2. Parser extracts geometry parameters -> Updates Global State.
3. Global State triggers React Three Fiber to render meshes.
4. User transforms mesh via UI -> Updates Global State.
5. Global State triggers code terminal to update raw text coordinates.
6. User clicks Export -> Client bundles current state into .stl and .scad files.
