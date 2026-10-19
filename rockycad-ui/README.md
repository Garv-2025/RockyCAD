# RockyCAD

An AI-driven, browser-based 3D CAD application that bridges natural language with deterministic Constructive Solid Geometry (CSG) for manufacturing-ready parts. 

Unlike standard text-to-3D models that generate unpredictable point clouds or surface meshes, RockyCAD translates text prompts into precise spatial coordinates and boolean operations, outputting watertight, manifold geometry ready for immediate 3D printing.

## Key Features
* **AI-to-CSG Generation:** Type plain-language prompts (e.g., "NEMA 17 stepper motor faceplate") to instantly generate dimensionally accurate 3D primitives and coordinate arrays.
* **Deterministic Boolean Operations:** Perform exact subtractions and unions directly in the browser to cut complex holes with automated Z-fighting prevention.
* **Precision Control:** Features native grid snapping, single-click mesh selection, and right-click context menus (Clone, Mirror X/Y, Delete) for granular alignment.
* **Browser Persistence:** Zero-latency local storage history stack with full keyboard-mapped Undo/Redo capabilities.
* **Manufacturing Ready:** One-click STL exports perfectly compatible with modern slicers (tested directly with Bambu Studio) for uninterrupted print workflows.

## Tech Stack
* **Frontend:** Next.js, React, `@react-three/fiber`, `@react-three/drei`
* **Backend:** Python (Serverless compatible)
* **Geometry Engine:** OpenSCAD

## Getting Started
1. Clone the repository.
2. Set `OPENROUTER_API_KEY` in `.env.local` (and as a Vercel environment variable when deployed).
3. Run `npm install` followed by `npm run dev`.
4. Open `http://localhost:3000`, type a component prompt, and start modeling.