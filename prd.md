# Product Requirements Document (PRD): RockyCAD

## 1. Problem Statement
Traditional CAD software has a massive learning curve, while current AI 3D generators produce messy, uneditable meshes unfit for engineering. Engineers and hobbyists need a rapid prototyping tool that generates precise, manufacturable geometry from natural language without sacrificing editability.

## 2. Target Audience
* Mechanical engineering students and hobbyists.
* 3D printing enthusiasts.
* Rapid prototyping developers.

## 3. Core Features
* **Prompt-to-Part:** LLM pipeline that accepts mechanical descriptions and returns compile-ready OpenSCAD syntax.
* **Sub-Studio UI:** A 3D interactive viewer featuring right-click context menus, cloning, and deletion.
* **Visual-to-Code Sync:** Any drag, scale, or rotation applied to a 3D object via UI gizmos instantly rewrites the corresponding coordinates in the code terminal.
* **One-Click Export:** Client-side generation of a ZIP file containing both the 3D mesh (.stl) and the source code (.scad).

## 4. Success Metrics
* Successful rendering of a valid mechanical part from a text prompt.
* Sub-100ms latency on visual-to-code syncing.
* Successful slicing of the exported .stl file in standard 3D printing software.
