# Project Scope: RockyCAD

## 1. Project Objective
To build a browser-based, AI-driven CAD co-pilot that translates natural language directly into precise, parametric OpenSCAD code and renders it in a live 3D WebGL environment.

## 2. In-Scope
* Natural language text-to-CAD generation using an LLM.
* Strict output constraints forcing mathematical Constructive Solid Geometry (CSG) in OpenSCAD format.
* Live WebGL rendering using React Three Fiber.
* Interactive 3D workspace with transform gizmos and measurement sliders.
* Real-time, two-way state synchronization between the visual 3D canvas and raw OpenSCAD code.
* Export functionality for a "Manufacturing Pack" (.stl and .scad files).

## 3. Out of Scope (V1)
* Cloud-based multiplayer collaboration.
* Complex organic mesh generation (focusing strictly on mechanical, parametric geometry).
* Server-side database for saving user accounts (app operates entirely locally in the browser).
