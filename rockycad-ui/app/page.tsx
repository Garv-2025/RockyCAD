'use client';

import { useState, useRef, useEffect, useCallback, useMemo, type PointerEvent as ReactPointerEvent } from 'react';
import Image from 'next/image';
import ReactMarkdown from 'react-markdown';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import { Send, Square, Copy, Edit2, Play, Code2, Check, Loader2, MessageSquare, Plus, Trash2, SlidersHorizontal, Wand2, Download, Box, User, Settings, X, Ruler, RotateCcw, ChevronDown, Paperclip, Maximize2, Minimize2, PanelRightClose, PanelRightOpen, Move, Scale } from 'lucide-react';
import { createClient } from '@supabase/supabase-js';
import JSZip from 'jszip';
import * as THREE from 'three';
import STLViewer, { type ManufacturingSpecs, type SceneObject } from '../components/STLViewer';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

function createSupabaseClient() {
  if (!supabaseUrl || !supabaseAnonKey) return null;
  try {
    return createClient(supabaseUrl, supabaseAnonKey);
  } catch {
    return null;
  }
}

const globalForSupabase = globalThis as typeof globalThis & { rockyCADSupabase?: ReturnType<typeof createSupabaseClient> };
const supabase = globalForSupabase.rockyCADSupabase ?? (globalForSupabase.rockyCADSupabase = createSupabaseClient());

interface Message {
  role: 'user' | 'assistant';
  content: string;
  isAborted?: boolean;
  imageUrl?: string;
}

interface ProjectSession {
  id: string;
  title: string;
  messages: Message[];
  code: string;
}

function getSceneObjectVerticalHalfExtent(object: SceneObject): number {
  if (object.type === 'group') {
    return (object.children ?? []).reduce(
      (extent, child) => Math.max(extent, Math.abs(child.position[2]) + getSceneObjectVerticalHalfExtent(child)),
      0,
    ) * Math.abs(object.scale[2]);
  }

  const halfDimensions: [number, number, number] = object.type === 'box' || object.type === 'wedge'
    ? [object.params.x / 2, object.params.y / 2, object.params.z / 2]
    : object.type === 'sphere'
      ? [object.params.d / 2, object.params.d / 2, object.params.d / 2]
      : object.type === 'torus'
        ? [object.params.d / 2, object.params.d / 2, object.params.tube / 2]
        : [object.params.d / 2, object.params.d / 2, object.params.h / 2];
  const scaledHalfDimensions = halfDimensions.map((dimension, axis) => dimension * Math.abs(object.scale[axis]));
  const rotation = new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(...object.rotation));
  return Math.abs(rotation.elements[2]) * scaledHalfDimensions[0] +
    Math.abs(rotation.elements[6]) * scaledHalfDimensions[1] +
    Math.abs(rotation.elements[10]) * scaledHalfDimensions[2];
}

function parseGeneratedSceneObjects(jsonPayload: string): SceneObject[] {
  const parsed: unknown = JSON.parse(jsonPayload);
  if (!Array.isArray(parsed)) {
    throw new Error('The generated shape payload must be a JSON array.');
  }

  const readVector = (value: unknown, label: string): [number, number, number] => {
    if (!Array.isArray(value) || value.length !== 3 ||
        !value.every(coordinate => typeof coordinate === 'number' && Number.isFinite(coordinate))) {
      throw new Error(`Each generated shape must include a three-number ${label} array.`);
    }
    return value as [number, number, number];
  };
  const readDimension = (params: Record<string, unknown>, fallback: number, ...keys: string[]): number => {
    for (const key of keys) {
      const value = params[key];
      if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
    }
    return fallback;
  };
  const readRadius = (params: Record<string, unknown>): number => {
    const radius = params.radius;
    if (typeof radius === 'number' && Number.isFinite(radius) && radius > 0) return radius;
    const diameter = params.diameter ?? params.d;
    return typeof diameter === 'number' && Number.isFinite(diameter) && diameter > 0
      ? diameter / 2
      : 10;
  };

  return parsed.map((item, index): SceneObject => {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      throw new Error(`Generated shape ${index + 1} must be an object.`);
    }
    const shape = item as Record<string, unknown>;
    const type = shape.type;
    if (type !== 'box' && type !== 'cylinder' && type !== 'sphere' && type !== 'cone') {
      throw new Error(`Generated shape ${index + 1} has an unsupported type.`);
    }
    if (typeof shape.params !== 'object' || shape.params === null || Array.isArray(shape.params)) {
      throw new Error(`Generated shape ${index + 1} must include params.`);
    }
    const rawParams = shape.params as Record<string, unknown>;
    shape.rotation = shape.rotation || [0, 0, 0];
    shape.scale = shape.scale || [1, 1, 1];
    if (!shape.position) {
      const objectHeight = type === 'box'
        ? readDimension(rawParams, 20, 'height', 'thickness', 'z')
        : type === 'sphere'
          ? readDimension(rawParams, 20, 'diameter', 'd', 'radius') * (rawParams.radius ? 2 : 1)
          : readDimension(rawParams, 20, 'height', 'h');
      shape.position = [0, 0, objectHeight / 2];
    }
    const params: Record<string, number> = {};
    if (type === 'box') {
      params.x = readDimension(rawParams, 20, 'width', 'x');
      params.y = readDimension(rawParams, 20, 'length', 'y');
      params.z = readDimension(rawParams, 20, 'height', 'thickness', 'z');
    } else if (type === 'sphere') {
      params.d = readRadius(rawParams) * 2;
    } else {
      params.d = readRadius(rawParams) * 2;
      params.h = readDimension(rawParams, 20, 'height', 'h');
      if (type === 'cylinder') {
        params.segments = Math.max(3, Math.floor(readDimension(rawParams, 32, 'segments')));
      }
    }

    return {
      id: crypto.randomUUID(),
      type,
      operation: shape.isHole === true ? 'hole' : 'solid',
      position: readVector(shape.position, 'position'),
      scale: readVector(shape.scale, 'scale'),
      rotation: readVector(shape.rotation, 'rotation'),
      params,
      name: typeof shape.name === 'string' && shape.name.trim()
        ? shape.name
        : `${type[0].toUpperCase()}${type.slice(1)} ${index + 1}`,
    };
  });
}

function toProjectSession(row: Record<string, unknown>): ProjectSession {
  return {
    id: typeof row.id === 'string' || typeof row.id === 'number' ? String(row.id) : '',
    title: typeof row.title === 'string' ? row.title : 'New Project',
    messages: Array.isArray(row.messages) ? row.messages as Message[] : [],
    code: typeof row.scad_code === 'string' ? row.scad_code : typeof row.code === 'string' ? row.code : '',
  };
}

interface ParametricVariable {
  name: string;
  value: number;
  label: string;
  min: number;
  max: number;
  step: number;
}

const PARAM_LINE_REGEX = /^\s*([a-zA-Z_]\w*)\s*=\s*([-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?)\s*;\s*(?:\/\/\s*(.*))?$/;
const SCENE_OBJECTS_START = '// ROCKYCAD_SCENE_OBJECTS_START';
const SCENE_OBJECTS_END = '// ROCKYCAD_SCENE_OBJECTS_END';

function sceneObjectsToOpenSCAD(objects: SceneObject[]): string {
  if (objects.length === 0) return '';

  const shapeToSCAD = (object: SceneObject): string => {
    const [x, y, z] = object.position;
    const [rotateX, rotateY, rotateZ] = object.rotation;
    const [scaleX, scaleY, scaleZ] = object.scale;
    const degrees = (radians: number) => Number((radians * 180 / Math.PI).toFixed(6));
    const transform = `translate([${x}, ${y}, ${z}]) rotate([${degrees(rotateX)}, ${degrees(rotateY)}, ${degrees(rotateZ)}])`;
    const { params, type } = object;
    if (type === 'group') {
      const children = object.children ?? [];
      const solids = children.filter(child => child.operation === 'solid').map(shapeToSCAD);
      const holes = children.filter(child => child.operation === 'hole').map(shapeToSCAD);
      const groupedGeometry = solids.length === 0
        ? `union() {\n    ${holes.join('\n    ')}\n  }`
        : holes.length > 0
          ? `difference() {\n    union() {\n      ${solids.join('\n      ')}\n    }\n    union() {\n      ${holes.join('\n      ')}\n    }\n  }`
          : `union() {\n    ${solids.join('\n    ')}\n  }`;
      return `${transform} scale([${scaleX}, ${scaleY}, ${scaleZ}]) {\n  ${groupedGeometry}\n}`;
    }
    let geometry: string;
    switch (type) {
      case 'box':
        geometry = `cube([${params.x}, ${params.y}, ${params.z}], center=true);`;
        break;
      case 'cylinder':
        geometry = `cylinder(d=${params.d}, h=${params.h}, center=true, $fn=${params.segments ?? 32});`;
        break;
      case 'cone':
        geometry = `cylinder(d1=${params.d}, d2=0, h=${params.h}, center=true, $fn=100);`;
        break;
      case 'pyramid':
        geometry = `cylinder(h=${params.h}, r1=${params.d / 2}, r2=0, center=true, $fn=4);`;
        break;
      case 'hexagon':
        geometry = `cylinder(h=${params.h}, r=${params.d / 2}, center=true, $fn=6);`;
        break;
      case 'sphere':
        geometry = `sphere(d=${params.d}, $fn=100);`;
        break;
      case 'torus':
        geometry = `rotate_extrude($fn=100) translate([${Math.max(0.1, (params.d - params.tube) / 2)}, 0, 0]) circle(d=${params.tube}, $fn=100);`;
        break;
      case 'wedge':
        geometry = `linear_extrude(height=${params.z}, center=true) polygon(points=[[-${params.x / 2}, -${params.y / 2}], [${params.x / 2}, -${params.y / 2}], [-${params.x / 2}, ${params.y / 2}]]);`;
        break;
    }
    return `${transform} scale([${scaleX}, ${scaleY}, ${scaleZ}]) {\n  ${geometry}\n}`;
  };

  const solids = objects.filter(object => object.operation === 'solid');
  const holes = objects.filter(object => object.operation === 'hole');
  const solidCode = solids.map(shapeToSCAD).join('\n  ');
  const holeCode = holes.map(shapeToSCAD).join('\n  ');
  const geometry = holes.length > 0
    ? `difference() {\n  union() {\n    ${solidCode}\n  }\n  union() {\n    ${holeCode}\n  }\n}`
    : `union() {\n  ${solidCode}\n}`;

  return `${SCENE_OBJECTS_START}\n$fn = 100;\n${geometry}\n${SCENE_OBJECTS_END}`;
}

function syncSceneObjectsToCode(code: string, objects: SceneObject[], discardRawCode = false): string {
  const generatedCode = sceneObjectsToOpenSCAD(objects);
  if (discardRawCode) return generatedCode;

  const generatedBlock = new RegExp(`${SCENE_OBJECTS_START}[\\s\\S]*?${SCENE_OBJECTS_END}`, 'm');
  if (generatedBlock.test(code)) {
    return generatedCode ? code.replace(generatedBlock, generatedCode) : code.replace(generatedBlock, '').trimEnd();
  }
  return generatedCode ? `${code.trimEnd()}${code.trim() ? '\n\n' : ''}${generatedCode}\n` : code;
}

function parseTopLevelNumericVariables(code: string): Array<{ name: string; value: number; label: string }> {
  const variables: Array<{ name: string; value: number; label: string }> = [];
  let braceDepth = 0;
  let inBlockComment = false;

  for (const line of code.split('\n')) {
    let visibleLine = '';
    for (let index = 0; index < line.length; index += 1) {
      if (inBlockComment) {
        if (line[index] === '*' && line[index + 1] === '/') {
          inBlockComment = false;
          index += 1;
        }
        continue;
      }
      if (line[index] === '/' && line[index + 1] === '*') {
        inBlockComment = true;
        index += 1;
        continue;
      }
      if (line[index] === '/' && line[index + 1] === '/') break;
      visibleLine += line[index];
    }

    if (braceDepth === 0) {
      const match = line.match(PARAM_LINE_REGEX);
      if (match) {
        const value = Number(match[2]);
        if (Number.isFinite(value)) variables.push({ name: match[1], value, label: match[3]?.trim() || '' });
      }
    }

    for (const character of visibleLine) {
      if (character === '{') braceDepth += 1;
      if (character === '}') braceDepth = Math.max(0, braceDepth - 1);
    }
  }

  return variables;
}

async function readApiError(response: Response): Promise<string> {
  const responseText = await response.text();
  if (!responseText) return `${response.status} ${response.statusText}`;

  try {
    const responseData = JSON.parse(responseText);
    if (typeof responseData.detail === 'string') return responseData.detail;
  } catch {
    return responseText;
  }

  return responseText;
}

const COMPONENT_TEMPLATES: Record<string, string> = {
  'NEMA 17 Stepper Mount': `$fn = 64;

difference() {
  union() {
    translate([-35, -30, 0]) cube([70, 60, 8]);
    translate([-35, 20, 8]) cube([70, 10, 56]);
  }

  translate([0, 25, 36]) rotate([90, 0, 0]) cylinder(d=22, h=12, center=true);

  for (x = [-15.5, 15.5]) {
    for (z = [-15.5, 15.5]) {
      translate([x, 25, 36 + z]) rotate([90, 0, 0]) cylinder(d=3.2, h=12, center=true);
    }
  }
}`,
  'Flanged Bearing Block': `$fn = 64;

difference() {
  union() {
    cylinder(d=58, h=6);
    translate([0, 0, 6]) cylinder(d=36, h=24);
  }

  translate([0, 0, -1]) cylinder(d=20, h=32);

  for (angle = [0 : 90 : 270]) {
    rotate([0, 0, angle]) translate([23, 0, -1]) cylinder(d=5.5, h=8);
  }
}`,
  'Bushing Bracket': `$fn = 64;

difference() {
  union() {
    translate([-50, -18, 0]) cube([100, 36, 8]);

    for (x = [-30, 0, 30]) {
      translate([x, 0, 8]) cylinder(d=26, h=30);
    }
  }

  for (x = [-30, 0, 30]) {
    translate([x, 0, -1]) cylinder(d=12, h=40);
  }

  for (x = [-42, 42]) {
    translate([x, 0, -1]) cylinder(d=5.5, h=10);
  }
}`,
};

function computeSliderBounds(initialValue: number): { min: number; max: number; step: number } {
  const isDecimal = !Number.isInteger(initialValue);
  const step = isDecimal ? (Math.abs(initialValue) < 1 ? 0.01 : 0.1) : 1;

  if (initialValue === 0) {
    return { min: 0, max: isDecimal ? 10 : 100, step };
  }
  if (initialValue > 0) {
    return { min: 0, max: initialValue * 3, step };
  }
  return { min: initialValue * 3, max: 0, step };
}

function formatParamValue(value: number, step: number): number {
  return step < 1 ? parseFloat(value.toFixed(2)) : Math.round(value);
}

function updateVariableInCode(code: string, name: string, newValue: number, step: number): string {
  const formatted = formatParamValue(newValue, step);
  const regex = new RegExp(`^(\\s*)(${name})\\s*=\\s*[-+]?\\d+(?:\\.\\d+)?\\s*;`, 'm');
  return code.replace(regex, `$1$2 = ${formatted};`);
}

export default function RockyCADStudio() {
  // Session State
  const [sessions, setSessions] = useState<ProjectSession[]>([]);
  const [activeId, setActiveId] = useState<string>('');
  
  // Active Chat State
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [selectedImage, setSelectedImage] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [currentCode, setCurrentCode] = useState('');
  
  // UI State
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [editText, setEditText] = useState('');
  const [copiedIndex, setCopiedIndex] = useState<number | null>(null);
  const [compiling, setCompiling] = useState(false);
  const [compileStatus, setCompileStatus] = useState('');
  const [stlUrl, setStlUrl] = useState<string | null>(null);
  const [modelSpecs, setModelSpecs] = useState<{ url: string; specs: ManufacturingSpecs } | null>(null);
  const autoOrientToken = 0;
  const [isExportMenuOpen, setIsExportMenuOpen] = useState(false);
  const [isExportingPack, setIsExportingPack] = useState(false);
  const [isMeasuring, setIsMeasuring] = useState(false);
  const [measurePoints, setMeasurePoints] = useState<THREE.Vector3[]>([]);
  const [hoverPoint, setHoverPoint] = useState<THREE.Vector3 | null>(null);
  const isWireframe = false;
  const showOverhangs = false;
  const [cameraResetToken, setCameraResetToken] = useState(0);
  const [params, setParams] = useState<ParametricVariable[]>([]);
  const [compiledParamValues, setCompiledParamValues] = useState<Record<string, number>>({});
  const [sceneObjects, setSceneObjects] = useState<SceneObject[]>([]);
  const [selectedObjectIds, setSelectedObjectIds] = useState<string[]>([]);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; objectId: string } | null>(null);
  const [isShapeMenuOpen, setIsShapeMenuOpen] = useState(false);
  const [inspectorTab, setInspectorTab] = useState<'position' | 'dimensions'>('position');
  const [gizmoMode, setGizmoMode] = useState<'translate' | 'scale'>('translate');
  const [snapDistance, setSnapDistance] = useState<number | null>(1);
  const [clipboardObject, setClipboardObject] = useState<SceneObject | null>(null);
  const [pendingPasteObject, setPendingPasteObject] = useState<SceneObject | null>(null);
  const [cadCommand, setCadCommand] = useState('');
  const [cadCommandStatus, setCadCommandStatus] = useState('');
  const [devView, setDevView] = useState<'code' | 'parametric'>('code');
  const [isFixing, setIsFixing] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [defaultFnResolution, setDefaultFnResolution] = useState(64);
  const [autoCompileOnChange, setAutoCompileOnChange] = useState(true);
  const [isStudioExpanded, setIsStudioExpanded] = useState(false);
  const [isStudioMinimized, setIsStudioMinimized] = useState(false);
  const [isViewerToolbarMinimized, setIsViewerToolbarMinimized] = useState(false);
  const [chatWidth, setChatWidth] = useState(50);
  const [viewerHeight, setViewerHeight] = useState(60);
  const [activeResize, setActiveResize] = useState<'columns' | 'rows' | null>(null);
  
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const currentCodeRef = useRef(currentCode);
  const sceneObjectsRef = useRef(sceneObjects);
  const sceneWorkspaceProjectIdRef = useRef<string | null>(null);
  const sceneActionsRef = useRef<{
    deleteSelectedSceneObject: () => void;
    dropSelectedToWorkplane: () => void;
    duplicateSelectedSceneObject: () => void;
    groupSelectedObjects: () => void;
    mirrorSelectedObject: (axis: 'x' | 'y') => void;
    pasteSceneObject: () => void;
    redoSceneChange: () => void;
    setSelectedObjectOperation: (operation: SceneObject['operation']) => void;
    undoSceneChange: () => void;
  } | null>(null);
  const isSyncingFromSceneRef = useRef(false);
  const dragStartObjectsRef = useRef<SceneObject[] | null>(null);
  const scenePreviewChangedRef = useRef(false);
  const undoHistoryRef = useRef<SceneObject[][]>([]);
  const redoHistoryRef = useRef<SceneObject[][]>([]);
  const compileTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const compileRequestIdRef = useRef(0);
  const compileResetTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const resizeStartRef = useRef<{ axis: 'columns' | 'rows'; position: number; ratio: number; size: number } | null>(null);
  const splitContainerRef = useRef<HTMLDivElement>(null);
  const studioPanelRef = useRef<HTMLElement>(null);
  const projectsLoadedRef = useRef(false);
  const currentModelSpecs = modelSpecs?.url === stlUrl ? modelSpecs.specs : null;

  useEffect(() => {
    const closeContextMenu = () => setContextMenu(null);
    window.addEventListener('click', closeContextMenu);
    return () => window.removeEventListener('click', closeContextMenu);
  }, []);
  const parametricValues = useMemo(
    () => Object.fromEntries(params.map(param => [param.name, param.value])),
    [params],
  );
  const selectedObjectId = selectedObjectIds[selectedObjectIds.length - 1] ?? null;
  const selectedSceneObject = selectedObjectIds.length === 1
    ? sceneObjects.find(object => object.id === selectedObjectId) ?? null
    : null;
  const selectedDimensionFields: Array<{ label: string; key: string; factor?: number; min: number }> = selectedSceneObject?.type === 'box'
    ? [{ label: 'Width', key: 'x', min: 0.1 }, { label: 'Length', key: 'y', min: 0.1 }, { label: 'Height', key: 'z', min: 0.1 }]
    : selectedSceneObject?.type === 'wedge'
      ? [{ label: 'Width', key: 'x', min: 0.1 }, { label: 'Length', key: 'y', min: 0.1 }, { label: 'Height', key: 'z', min: 0.1 }]
    : selectedSceneObject?.type === 'sphere'
      ? [{ label: 'Radius', key: 'd', factor: 2, min: 0.05 }]
      : selectedSceneObject?.type === 'torus'
        ? [{ label: 'Outer diameter', key: 'd', min: 0.1 }, { label: 'Tube diameter', key: 'tube', min: 0.1 }]
        : selectedSceneObject && selectedSceneObject.type !== 'group'
          ? [{ label: 'Diameter', key: 'd', min: 0.1 }, { label: 'Height', key: 'h', min: 0.1 }]
          : [];

  useEffect(() => {
    let isMounted = true;
    sceneWorkspaceProjectIdRef.current = null;
    if (!activeId) return () => { isMounted = false; };

    queueMicrotask(() => {
      if (!isMounted) return;
      let savedSceneObjects: SceneObject[] = [];
      try {
        const savedWorkspace = localStorage.getItem(`rockyCAD_workspace_${activeId || 'default'}`);
        if (savedWorkspace !== null) {
          const parsed: unknown = JSON.parse(savedWorkspace);
          if (!Array.isArray(parsed)) {
            throw new Error('Saved RockyCAD workspace must be an array.');
          }
          savedSceneObjects = parsed as SceneObject[];
        }
      } catch (error: unknown) {
        console.error('Unable to load the saved RockyCAD workspace.', error);
      }
      if (!isMounted) return;
      sceneObjectsRef.current = savedSceneObjects;
      setSceneObjects(savedSceneObjects);
      setSelectedObjectIds([]);
      undoHistoryRef.current = [];
      redoHistoryRef.current = [];
      sceneWorkspaceProjectIdRef.current = activeId;
    });
    return () => { isMounted = false; };
  }, [activeId]);

  useEffect(() => {
    if (!activeId || sceneWorkspaceProjectIdRef.current !== activeId) return;
    try {
      localStorage.setItem(`rockyCAD_workspace_${activeId || 'default'}`, JSON.stringify(sceneObjects));
    } catch (error: unknown) {
      console.error('Unable to save the RockyCAD workspace.', error);
    }
  }, [activeId, sceneObjects]);

  const handleManufacturingSpecs = useCallback((specs: ManufacturingSpecs) => {
    if (stlUrl) setModelSpecs({ url: stlUrl, specs });
  }, [stlUrl]);

  const createNewProject = useCallback(() => {
    const newId = Date.now().toString();
    const initialMsg: Message = { role: 'assistant', content: 'Welcome to RockyCAD Studio. Describe the 3D model you want to generate.' };
    const newProject: ProjectSession = {
      id: newId,
      title: 'New Project',
      messages: [initialMsg],
      code: '// Your active OpenSCAD code will appear here',
    };

    setSessions(prev => [newProject, ...prev]);
    setActiveId(newId);
    setMessages([initialMsg]);
    setCurrentCode(newProject.code);
    setStlUrl(null);
    return newId;
  }, []);

  useEffect(() => {
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setSelectedObjectIds(() => []);
      setIsMeasuring(() => false);
      setMeasurePoints(() => []);
      setHoverPoint(() => null);
      setPendingPasteObject(() => null);
    };

    window.addEventListener('keydown', handleEscape);
    return () => window.removeEventListener('keydown', handleEscape);
  }, []);

  // 1. Initialize sessions from Supabase, falling back to local storage.
  useEffect(() => {
    let cancelled = false;

    const loadProjects = async () => {
      await Promise.resolve();
      let loadedProjects: ProjectSession[] = [];
      if (supabase) {
        let timeoutId: ReturnType<typeof setTimeout> | undefined;
        try {
          const result = await Promise.race([
            supabase.from('projects').select('id, title, scad_code, messages'),
            new Promise<null>(resolve => { timeoutId = setTimeout(() => resolve(null), 3000); }),
          ]);
          if (result && !result.error && result.data) {
            loadedProjects = result.data
              .map(row => toProjectSession(row as unknown as Record<string, unknown>))
              .filter(project => project.id.length > 0);
          }
        } catch {
          loadedProjects = [];
        } finally {
          if (timeoutId) clearTimeout(timeoutId);
        }
      }

      if (loadedProjects.length === 0) {
        try {
          const saved = localStorage.getItem('rockycad_projects');
          if (saved) {
            const parsed: unknown = JSON.parse(saved);
            if (Array.isArray(parsed)) {
              loadedProjects = parsed
                .filter((row): row is Record<string, unknown> => typeof row === 'object' && row !== null)
                .map(toProjectSession)
                .filter(project => project.id.length > 0);
            }
          }
        } catch {
          loadedProjects = [];
        }
      }

      if (cancelled) return;
      projectsLoadedRef.current = true;
      if (loadedProjects.length > 0) {
        setSessions(loadedProjects);
        setActiveId(loadedProjects[0].id);
        setMessages(loadedProjects[0].messages);
        setCurrentCode(loadedProjects[0].code);
      } else {
        createNewProject();
      }
    };

    void loadProjects();
    return () => { cancelled = true; };
  }, [createNewProject]);

  // 2. Auto-Save Active Session Changes
  useEffect(() => {
    if (!activeId) return;
    
    setSessions(prev => {
      const updated = prev.map(session => {
        if (session.id === activeId) {
          // Auto-generate title from the first user message
          let title = session.title;
          if (title === 'New Project' && messages.length > 1) {
             title = messages[1].content.slice(0, 24) + '...';
          }
          return { ...session, messages, code: currentCode, title };
        }
        return session;
      });
      return updated;
    });
  }, [messages, currentCode, activeId]);

  useEffect(() => {
    if (!projectsLoadedRef.current) return;

    try {
      localStorage.setItem('rockycad_projects', JSON.stringify(sessions));
    } catch {
      // Continue cloud sync if browser storage is unavailable.
    }
    if (!supabase || sessions.length === 0) return;

    const syncTimeout = setTimeout(() => {
      const rows = sessions.map(session => ({
        id: session.id,
        title: session.title,
        scad_code: session.code,
        messages: session.messages,
      }));
      void supabase.from('projects').upsert(rows, { onConflict: 'id' });
    }, 500);

    return () => clearTimeout(syncTimeout);
  }, [sessions]);

  // Scroll to bottom of chat
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // Keep code ref in sync for debounced compile
  useEffect(() => {
    currentCodeRef.current = currentCode;
  }, [currentCode]);

  // Parse parametric variables from OpenSCAD code (preserve bounds from initial extraction)
  useEffect(() => {
    if (isSyncingFromSceneRef.current) {
      isSyncingFromSceneRef.current = false;
      return;
    }
    setParams(prev => {
      const prevMap = new Map(prev.map(p => [p.name, p]));
      return parseTopLevelNumericVariables(currentCode).map(({ name, value, label }) => {
        const existing = prevMap.get(name);
        return existing
          ? { ...existing, value, label }
          : { name, value, label, ...computeSliderBounds(value) };
      });
    });
  }, [currentCode]);

  useEffect(() => {
    if (!activeResize) return;

    const handlePointerMove = (event: PointerEvent) => {
      const start = resizeStartRef.current;
      if (!start) return;
      const position = start.axis === 'columns' ? event.clientX : event.clientY;
      const delta = ((position - start.position) / start.size) * 100;
      const nextRatio = Math.min(80, Math.max(20, start.ratio + delta));
      if (start.axis === 'columns') setChatWidth(nextRatio);
      else setViewerHeight(nextRatio);
    };
    const handlePointerEnd = () => {
      resizeStartRef.current = null;
      setActiveResize(null);
    };

    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerEnd);
    window.addEventListener('pointercancel', handlePointerEnd);
    return () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerEnd);
      window.removeEventListener('pointercancel', handlePointerEnd);
    };
  }, [activeResize]);

  // Cleanup debounced compile on unmount
  useEffect(() => {
    return () => {
      if (compileTimeoutRef.current) clearTimeout(compileTimeoutRef.current);
      if (compileResetTimeoutRef.current) clearTimeout(compileResetTimeoutRef.current);
    };
  }, []);

  useEffect(() => {
    if (compileResetTimeoutRef.current) clearTimeout(compileResetTimeoutRef.current);
    compileResetTimeoutRef.current = setTimeout(() => setCompiling(false), 300);
    return () => {
      if (compileResetTimeoutRef.current) clearTimeout(compileResetTimeoutRef.current);
    };
  }, [currentCode]);

  const switchProject = (id: string) => {
    const target = sessions.find(s => s.id === id);
    if (target) {
      setActiveId(id);
      setMessages(target.messages);
      setCurrentCode(target.code);
      setStlUrl(null); // Clear viewer for the new project
    }
  };

  const deleteProject = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    const updated = sessions.filter(s => s.id !== id);
    setSessions(updated);
    try {
      localStorage.setItem('rockycad_projects', JSON.stringify(updated));
    } catch {
      // Session state and cloud sync remain available without browser storage.
    }
    if (supabase) void supabase.from('projects').delete().eq('id', id);
    
    if (updated.length === 0) {
      createNewProject();
    } else if (id === activeId) {
      switchProject(updated[0].id);
    }
  };

  const handleImageSelection = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];
    if (!file) return;

    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) {
      alert('Choose a PNG, JPEG, or WebP image.');
      event.currentTarget.value = '';
      return;
    }

    const inputElement = event.currentTarget;
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') setSelectedImage(reader.result);
    };
    reader.onerror = () => alert('Unable to read this image.');
    reader.readAsDataURL(file);
    inputElement.value = '';
  };

  const handleGenerate = async (promptText: string, editIndex: number | null = null, imageUrl: string | null = selectedImage) => {
    const submittedPrompt = promptText.trim() || (imageUrl ? 'Create a 3D model based on this sketch.' : '');
    if (!submittedPrompt) return;

    let currentHistory = [...messages];
    if (editIndex !== null) {
      currentHistory = currentHistory.slice(0, editIndex);
    }
    const conversationHistory = currentHistory.slice(-6).map(({ role, content }) => ({ role, content }));
    
    currentHistory.push({ role: 'user', content: submittedPrompt, ...(imageUrl ? { imageUrl } : {}) });
    setMessages(currentHistory);
    setInput('');
    setSelectedImage(null);
    setLoading(true);

    const abortController = new AbortController();
    abortControllerRef.current = abortController;

    try {
      const res = await fetch("/api/chat", {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: submittedPrompt, imageUrl, history: conversationHistory }),
        signal: abortController.signal,
      });

      if (!res.ok) throw new Error(await readApiError(res));

      const data = await res.json();
      const conversationalText = typeof data.message === 'string' ? data.message.trim() : '';
      const jsonPayload = typeof data.json_payload === 'string' ? data.json_payload.trim() : '';

      if (jsonPayload) {
        const newObjects = parseGeneratedSceneObjects(jsonPayload);
        if (newObjects.length > 0) {
          commitSceneObjects([...sceneObjectsRef.current, ...newObjects]);
          setSelectedObjectIds(newObjects.map(object => object.id));
          if (stlUrl) URL.revokeObjectURL(stlUrl);
          setStlUrl(null);
        }
      }
      setMessages([...currentHistory, {
        role: 'assistant',
        content: conversationalText || (jsonPayload
          ? 'Generated shapes have been added to the 3D scene.'
          : 'Could you provide more details so I can create the shape?'),
      }]);
      
    } catch (err: unknown) {
      if (err instanceof Error && err.name !== 'AbortError') {
        setMessages([...currentHistory, {
          role: 'assistant',
          content: `⚠️ ${err.message || 'Error communicating with FastAPI backend.'}`,
        }]);
      }
    } finally {
      if (abortControllerRef.current === abortController) {
        abortControllerRef.current = null;
        setLoading(false);
      }
    }
  };

  const handleStop = () => {
    const abortController = abortControllerRef.current;
    if (!abortController) return;

    abortController.abort();
    setLoading(false);
    setMessages(currentMessages => {
      const lastIndex = currentMessages.length - 1;
      if (lastIndex >= 0 && currentMessages[lastIndex].role === 'assistant') {
        return currentMessages.map((message, index) => index === lastIndex ? { ...message, isAborted: true } : message);
      }
      return [...currentMessages, { role: 'assistant', content: 'Response stopped before completion.', isAborted: true }];
    });
  };

  const handleCompile = async (code: string = currentCodeRef.current, retryCount = 0) => {
    if (!code || code.includes('// Your active')) return;
    const requestId = ++compileRequestIdRef.current;
    if (retryCount === 0) {
      setSelectedObjectIds([]);
      setCompiling(true);
      setCompileStatus('');
    }

    try {
      let res: Response;
      try {
        res = await fetch('/api/compile', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ scad_code: code }),
        });
      } catch {
        return;
      }

      if (requestId !== compileRequestIdRef.current) return;

      if (!res.ok) {
        const errorMessage = await readApiError(res);
        if (requestId !== compileRequestIdRef.current) return;
        if (retryCount >= 2) {
          setCompileStatus('');
          console.error('Compilation Error:', errorMessage);
          return;
        }

        setCompileStatus(`Agent self-correcting topology (Attempt ${retryCount + 1}/3)...`);
        try {
          const correctionResponse = await fetch('/api/fix', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ scad_code: code }),
          });

          if (requestId !== compileRequestIdRef.current) return;
          if (!correctionResponse.ok) {
            throw new Error(await readApiError(correctionResponse));
          }

          const correctionData = await correctionResponse.json();
          if (requestId !== compileRequestIdRef.current) return;
          const responseCode = typeof correctionData.scad_code === 'string' ? correctionData.scad_code.trim() : '';
          const codeBlock = responseCode.match(/```(?:openscad|scad)?\s*([\s\S]*?)```/i);
          const correctedCode = (codeBlock?.[1] ?? responseCode).trim();
          if (!correctedCode) throw new Error('The correction service returned no OpenSCAD code.');

          currentCodeRef.current = correctedCode;
          setCurrentCode(correctedCode);
          await handleCompile(correctedCode, retryCount + 1);
        } catch (correctionError: unknown) {
          if (requestId !== compileRequestIdRef.current) return;
          setCompileStatus('');
          const message = correctionError instanceof Error ? correctionError.message : 'Unknown correction error.';
          console.error('Compilation self-correction failed:', { errorMessage, correctionError: message });
        }
        return;
      }

      const blob = await res.blob();
      if (requestId !== compileRequestIdRef.current) return;
      if (stlUrl) URL.revokeObjectURL(stlUrl);
      
      const url = window.URL.createObjectURL(blob);
      setCompiledParamValues(Object.fromEntries(
        parseTopLevelNumericVariables(code).map(({ name, value }) => [name, value]),
      ));
      setStlUrl(url);
      setCompileStatus('');
    } catch (err: unknown) {
      if (requestId !== compileRequestIdRef.current) return;
      setCompileStatus('');
      const message = err instanceof Error ? err.message : 'Unknown compilation error.';
      console.error('Compilation Error:', message);
    } finally {
      if (retryCount === 0) setCompiling(false);
    }
  };

  const handleLoadComponent = (component: string) => {
    const code = COMPONENT_TEMPLATES[component].replace('$fn = 64;', `$fn = ${defaultFnResolution};`);
    const projectId = createNewProject();

    setSessions(prev => prev.map(session =>
      session.id === projectId ? { ...session, title: component, code } : session
    ));
    setCurrentCode(code);
    currentCodeRef.current = code;
    void handleCompile(code);
  };

  const copyToClipboard = (text: string, index: number) => {
    navigator.clipboard.writeText(text);
    setCopiedIndex(index);
    setTimeout(() => setCopiedIndex(null), 2000);
  };

  const debouncedCompile = (code: string = currentCodeRef.current) => {
    if (compileTimeoutRef.current) clearTimeout(compileTimeoutRef.current);
    compileTimeoutRef.current = setTimeout(() => {
      void handleCompile(code);
    }, 300);
  };

  const handleParamChange = (name: string, newValue: number) => {
    if (Number.isNaN(newValue)) return;
    const param = params.find(p => p.name === name);
    if (!param) return;

    const clamped = Math.min(param.max, Math.max(param.min, newValue));
    const updatedCode = updateVariableInCode(currentCodeRef.current, name, clamped, param.step);
    currentCodeRef.current = updatedCode;
    setCurrentCode(updatedCode);
    debouncedCompile(updatedCode);
  };

  const commitSceneObjects = (updatedObjects: SceneObject[], options: { compile?: boolean; recordHistory?: boolean } = {}) => {
    const { compile = true, recordHistory = true } = options;
    const removesObjects = updatedObjects.length < sceneObjectsRef.current.length;
    if (removesObjects || updatedObjects.length === 0) {
      compileRequestIdRef.current += 1;
      setCompiling(false);
      setCompileStatus('');
    }
    if (recordHistory) {
      undoHistoryRef.current.push(sceneObjectsRef.current);
      redoHistoryRef.current = [];
    }
    sceneObjectsRef.current = updatedObjects;
    const sourceCode = currentCodeRef.current.includes('// Your active') ? '' : currentCodeRef.current;
    const updatedCode = syncSceneObjectsToCode(sourceCode, updatedObjects, removesObjects || updatedObjects.length === 0);
    setSceneObjects(updatedObjects);
    isSyncingFromSceneRef.current = updatedCode !== currentCodeRef.current;
    setCurrentCode(updatedCode);
    currentCodeRef.current = updatedCode;
    if (updatedObjects.length === 0 && stlUrl) {
      URL.revokeObjectURL(stlUrl);
      setStlUrl(null);
    }
    if (compile) debouncedCompile(updatedCode);
  };

  const handleObjectDragStart = () => {
    if (compileTimeoutRef.current) {
      clearTimeout(compileTimeoutRef.current);
      compileTimeoutRef.current = null;
    }
    dragStartObjectsRef.current = sceneObjectsRef.current;
    scenePreviewChangedRef.current = false;
  };

  const handleObjectDragEnd = (id: string, position: [number, number, number]) => {
    const initialObjects = dragStartObjectsRef.current;
    dragStartObjectsRef.current = null;
    if (!initialObjects) return;
    scenePreviewChangedRef.current = false;
    undoHistoryRef.current.push(initialObjects);
    redoHistoryRef.current = [];
    const updatedObjects = sceneObjectsRef.current.map(object => object.id === id ? { ...object, position } : object);
    commitSceneObjects(updatedObjects, { recordHistory: false });
  };

  const handleScenePreviewStart = () => {
    if (dragStartObjectsRef.current) return;
    if (compileTimeoutRef.current) {
      clearTimeout(compileTimeoutRef.current);
      compileTimeoutRef.current = null;
    }
    dragStartObjectsRef.current = sceneObjectsRef.current;
    scenePreviewChangedRef.current = false;
  };

  const previewSelectedSceneObject = (update: (object: SceneObject) => SceneObject) => {
    if (!selectedObjectId) return;
    handleScenePreviewStart();
    const updatedObjects = sceneObjectsRef.current.map(object => object.id === selectedObjectId ? update(object) : object);
    sceneObjectsRef.current = updatedObjects;
    setSceneObjects(updatedObjects);
    scenePreviewChangedRef.current = true;
  };

  const handleScenePreviewEnd = () => {
    const initialObjects = dragStartObjectsRef.current;
    dragStartObjectsRef.current = null;
    if (!initialObjects || !scenePreviewChangedRef.current) return;
    scenePreviewChangedRef.current = false;
    undoHistoryRef.current.push(initialObjects);
    redoHistoryRef.current = [];
    commitSceneObjects(sceneObjectsRef.current, { recordHistory: false });
  };

  const undoSceneChange = () => {
    const previous = undoHistoryRef.current.pop();
    if (!previous) return;
    redoHistoryRef.current.push(sceneObjectsRef.current);
    commitSceneObjects(previous, { recordHistory: false });
  };

  const redoSceneChange = () => {
    const next = redoHistoryRef.current.pop();
    if (!next) return;
    undoHistoryRef.current.push(sceneObjectsRef.current);
    commitSceneObjects(next, { recordHistory: false });
  };

  const createSceneObject = (type: SceneObject['type'], operation: SceneObject['operation'] = 'solid'): SceneObject => {
    const currentObjects = sceneObjectsRef.current;
    const params: Record<string, number> = {
      box: { x: 20, y: 20, z: 20 },
      cylinder: { d: 20, h: 20 },
      sphere: { d: 20 },
      cone: { d: 20, h: 30 },
      torus: { d: 24, tube: 5 },
      pyramid: { d: 20, h: 20 },
      wedge: { x: 20, y: 20, z: 20 },
      hexagon: { d: 20, h: 20 },
      group: {},
    }[type];
    const height = type === 'box' || type === 'wedge'
      ? params.z
      : type === 'sphere'
        ? params.d
        : type === 'torus'
          ? params.tube
          : type === 'group' ? 1 : params.h;
    return {
      id: crypto.randomUUID(),
      type,
      operation,
      position: [type === 'box' || type === 'cylinder' ? 0 : currentObjects.length * 10, 0, height / 2],
      rotation: [0, 0, 0],
      scale: [1, 1, 1],
      params,
      name: `${type[0].toUpperCase()}${type.slice(1)} ${currentObjects.length + 1}`,
    };
  };

  const spawnSceneObject = (type: SceneObject['type'], operation: SceneObject['operation'] = 'solid') => {
    const object = createSceneObject(type, operation);
    setSelectedObjectIds([object.id]);
    commitSceneObjects([...sceneObjectsRef.current, object]);
  };

  const handleSceneTransform = (
    id: string,
    position: [number, number, number],
    rotation: [number, number, number],
    scale: [number, number, number],
  ) => {
    commitSceneObjects(sceneObjectsRef.current.map(object => object.id === id
      ? {
        ...object,
        position,
        rotation,
        scale,
      }
      : object));
  };

  const deleteSelectedSceneObject = () => {
    if (selectedObjectIds.length === 0) return;
    commitSceneObjects(sceneObjects.filter(object => !selectedObjectIds.includes(object.id)));
    setSelectedObjectIds([]);
  };

  const duplicateSelectedSceneObject = () => {
    const selected = sceneObjects.find(object => object.id === selectedObjectId);
    if (!selected || selectedObjectIds.length !== 1) return;
    const duplicate = {
      ...selected,
      id: crypto.randomUUID(),
      name: `${selected.name} Copy`,
      position: [selected.position[0] + 10, selected.position[1], selected.position[2]] as [number, number, number],
      params: { ...selected.params },
    };
    setSelectedObjectIds([duplicate.id]);
    commitSceneObjects([...sceneObjects, duplicate]);
  };

  const handleSceneObjectContextMenu = (objectId: string, x: number, y: number) => {
    setContextMenu({ x, y, objectId });
  };

  const handleContextMenuAction = (action: 'select' | 'clone' | 'mirrorX' | 'mirrorY' | 'delete') => {
    if (!contextMenu) return;
    const object = sceneObjectsRef.current.find(candidate => candidate.id === contextMenu.objectId);
    if (!object) {
      setContextMenu(null);
      return;
    }

    if (action === 'select') {
      setSelectedObjectIds([object.id]);
    } else if (action === 'delete') {
      commitSceneObjects(sceneObjectsRef.current.filter(candidate => candidate.id !== object.id));
      setSelectedObjectIds([]);
    } else if (action === 'clone') {
      const cloneObject = (source: SceneObject, root = false): SceneObject => ({
        ...source,
        id: crypto.randomUUID(),
        name: root ? `${source.name} Copy` : source.name,
        position: root
          ? [source.position[0] + 10, source.position[1], source.position[2]]
          : [...source.position],
        rotation: [...source.rotation],
        scale: [...source.scale],
        params: { ...source.params },
        ...(source.children ? { children: source.children.map(child => cloneObject(child)) } : {}),
      });
      const clone = cloneObject(object, true);
      commitSceneObjects([...sceneObjectsRef.current, clone]);
      setSelectedObjectIds([clone.id]);
    } else if (action === 'mirrorX' || action === 'mirrorY') {
      const cloneObject = (source: SceneObject, isRoot = false): SceneObject => {
        const copy: SceneObject = {
          ...source,
          id: crypto.randomUUID(),
          name: isRoot ? `${source.name} Mirror ${action === 'mirrorX' ? 'X' : 'Y'}` : source.name,
          position: isRoot
            ? action === 'mirrorX'
              ? [-source.position[0], source.position[1], source.position[2]]
              : [source.position[0], -source.position[1], source.position[2]]
            : [...source.position],
          rotation: isRoot
            ? action === 'mirrorX'
              ? [source.rotation[0] + Math.PI, source.rotation[1], source.rotation[2]]
              : [source.rotation[0], source.rotation[1] + Math.PI, source.rotation[2]]
            : [...source.rotation],
          scale: [...source.scale],
          params: { ...source.params },
        };
        if (source.children) {
          copy.children = source.children.map(child => cloneObject(child));
        }
        return copy;
      };
      const mirrored = cloneObject(object, true);
      commitSceneObjects([...sceneObjectsRef.current, mirrored]);
      setSelectedObjectIds([mirrored.id]);
    }

    setContextMenu(null);
  };

  const setSelectedObjectOperation = (operation: SceneObject['operation']) => {
    if (selectedObjectIds.length === 0) return;
    commitSceneObjects(sceneObjectsRef.current.map(object => selectedObjectIds.includes(object.id) ? { ...object, operation } : object));
  };

  const updateSelectedSceneObject = (update: (object: SceneObject) => SceneObject) => {
    if (!selectedObjectId || selectedObjectIds.length !== 1) return;
    commitSceneObjects(sceneObjectsRef.current.map(object => object.id === selectedObjectId ? update(object) : object));
  };

  const pasteSceneObject = () => {
    if (!clipboardObject) return;
    setPendingPasteObject({
      ...clipboardObject,
      id: crypto.randomUUID(),
      name: `${clipboardObject.name} Copy`,
      position: [...clipboardObject.position] as [number, number, number],
      params: { ...clipboardObject.params },
    });
  };

  const placePendingPasteObject = (position: [number, number, number]) => {
    if (!pendingPasteObject) return;
    const placedObject = {
      ...pendingPasteObject,
      position,
      params: { ...pendingPasteObject.params },
    };
    setSelectedObjectIds([placedObject.id]);
    commitSceneObjects([...sceneObjectsRef.current, placedObject]);
    setPendingPasteObject(null);
  };

  const dropSelectedToWorkplane = () => {
    const selected = sceneObjectsRef.current.find(object => object.id === selectedObjectId);
    if (!selected) return;
    const verticalHalfExtent = getSceneObjectVerticalHalfExtent(selected);
    commitSceneObjects(sceneObjectsRef.current.map(object => object.id === selected.id
      ? { ...object, position: [object.position[0], object.position[1], verticalHalfExtent] }
      : object));
  };

  const mirrorSelectedObject = (axis: 'x' | 'y') => {
    const selected = sceneObjectsRef.current.find(object => object.id === selectedObjectId);
    if (!selected) return;
    const scale = [...selected.scale] as [number, number, number];
    const scaleAxis = axis === 'x' ? 0 : 1;
    scale[scaleAxis] *= -1;
    const mirrored = {
      ...selected,
      id: crypto.randomUUID(),
      name: `${selected.name} Mirror ${axis.toUpperCase()}`,
      position: axis === 'x'
        ? [-selected.position[0], selected.position[1], selected.position[2]] as [number, number, number]
        : [selected.position[0], -selected.position[1], selected.position[2]] as [number, number, number],
      scale,
      params: { ...selected.params },
    };
    commitSceneObjects([...sceneObjectsRef.current, mirrored]);
    setSelectedObjectIds([mirrored.id]);
  };

  const groupSelectedObjects = () => {
    const selected = sceneObjectsRef.current.filter(object => selectedObjectIds.includes(object.id));
    if (selected.length < 2) return;
    const center: [number, number, number] = [0, 1, 2].map(axis =>
      selected.reduce((sum, object) => sum + object.position[axis], 0) / selected.length,
    ) as [number, number, number];
    const children = selected.map(object => ({
      ...object,
      position: [
        object.position[0] - center[0],
        object.position[1] - center[1],
        object.position[2] - center[2],
      ] as [number, number, number],
      params: { ...object.params },
    }));
    const group: SceneObject = {
      id: crypto.randomUUID(),
      type: 'group',
      operation: children.some(child => child.operation === 'solid') ? 'solid' : 'hole',
      position: center,
      rotation: [0, 0, 0],
      scale: [1, 1, 1],
      params: {},
      children,
      name: `Group (${children.length})`,
    };
    commitSceneObjects([
      ...sceneObjectsRef.current.filter(object => !selectedObjectIds.includes(object.id)),
      group,
    ]);
    setSelectedObjectIds([group.id]);
  };

  const handleSelectSceneObject = (id: string | null, shiftKey = false) => {
    if (!id) {
      setSelectedObjectIds([]);
      return;
    }
    setSelectedObjectIds(current => shiftKey
      ? current.includes(id) ? current.filter(selectedId => selectedId !== id) : [...current, id]
      : [id]);
  };

  const addSelectedSceneObjects = (ids: string[]) => {
    if (ids.length === 0) return;
    setSelectedObjectIds(current => [...new Set([...current, ...ids])]);
  };

  useEffect(() => {
    sceneActionsRef.current = {
      deleteSelectedSceneObject,
      dropSelectedToWorkplane,
      duplicateSelectedSceneObject,
      groupSelectedObjects,
      mirrorSelectedObject,
      pasteSceneObject,
      redoSceneChange,
      setSelectedObjectOperation,
      undoSceneChange,
    };
  });

  const executeCadCommand = (commandText: string) => {
    const parts = commandText.trim().toUpperCase().split(/\s+/);
    if (!parts[0]) return;
    const command = parts[0];
    const values = parts.slice(1).map(Number);
    const validNumbers = values.every(value => Number.isFinite(value) && value > 0);
    const selected = sceneObjects.find(object => object.id === selectedObjectId);
    const spawnFromCommand = (type: SceneObject['type'], params: Record<string, number>, operation: SceneObject['operation'] = 'solid') => {
      const object = createSceneObject(type, operation);
      const height = type === 'box' ? params.z : type === 'sphere' ? params.d : type === 'torus' ? params.tube : params.h;
      const position = operation === 'hole' && selected
        ? selected.position
        : [sceneObjects.length * 10, 0, height / 2] as [number, number, number];
      const rotation = operation === 'hole' && selected ? selected.rotation : object.rotation;
      const configured = { ...object, params, position, rotation };
      setSelectedObjectIds([configured.id]);
      commitSceneObjects([...sceneObjects, configured]);
      setCadCommandStatus(`${configured.name} added.`);
    };

    switch (command) {
      case 'BOX':
        if (values.length !== 3 || !validNumbers) break;
        spawnFromCommand('box', { x: values[0], y: values[1], z: values[2] });
        return;
      case 'CYL':
      case 'HOLE':
        if (values.length !== 2 || !validNumbers) break;
        spawnFromCommand('cylinder', { d: values[0], h: values[1] }, command === 'HOLE' ? 'hole' : 'solid');
        return;
      case 'SPHERE':
        if (values.length !== 1 || !validNumbers) break;
        spawnFromCommand('sphere', { d: values[0] });
        return;
      case 'MOVE':
        if (values.length !== 3 || !values.every(Number.isFinite) || !selected) break;
        commitSceneObjects(sceneObjects.map(object => object.id === selected.id
          ? { ...object, position: [values[0], values[1], values[2]] }
          : object));
        setCadCommandStatus(`Moved ${selected.name}.`);
        return;
      case 'DEL':
        if (parts.length !== 1 || !selected) break;
        deleteSelectedSceneObject();
        setCadCommandStatus(`Deleted ${selected.name}.`);
        return;
      case 'CLEAR':
        if (parts.length !== 1) break;
        commitSceneObjects([]);
        setSelectedObjectIds([]);
        setCadCommandStatus('Build plate cleared.');
        return;
      default:
        setCadCommandStatus('Unknown command. Use BOX, CYL, HOLE, SPHERE, MOVE, DEL, or CLEAR.');
        return;
    }

    setCadCommandStatus(`Invalid ${command} command or arguments.`);
  };

  const beginResize = (axis: 'columns' | 'rows', event: ReactPointerEvent<HTMLDivElement>) => {
    const container = axis === 'columns' ? splitContainerRef.current : studioPanelRef.current;
    if (!container) return;
    const bounds = container.getBoundingClientRect();
    const size = axis === 'columns' ? bounds.width : bounds.height;
    if (!size) return;

    event.preventDefault();
    resizeStartRef.current = {
      axis,
      position: axis === 'columns' ? event.clientX : event.clientY,
      ratio: axis === 'columns' ? chatWidth : viewerHeight,
      size,
    };
    setActiveResize(axis);
  };

  const getExportSlug = () => {
    const activeTitle = sessions.find(s => s.id === activeId)?.title ?? 'model';
    return activeTitle.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'model';
  };

  const downloadBlob = (blob: Blob, filename: string) => {
    const objectUrl = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = objectUrl;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
  };

  const handleExportSTL = () => {
    if (!stlUrl) return;

    const link = document.createElement('a');
    link.href = stlUrl;
    link.download = `rockycad-${getExportSlug()}.stl`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    setIsExportMenuOpen(false);
  };

  const handleExportSCAD = () => {
    downloadBlob(new Blob([currentCode], { type: 'text/plain;charset=utf-8' }), `rockycad-${getExportSlug()}.scad`);
    setIsExportMenuOpen(false);
  };

  const handleExportPack = async () => {
    if (!stlUrl || !currentModelSpecs || isExportingPack) return;
    setIsExportingPack(true);
    try {
      const stlResponse = await fetch(stlUrl);
      if (!stlResponse.ok) throw new Error('Could not read the generated STL.');
      const zip = new JSZip();
      zip.file('model.stl', await stlResponse.blob());
      zip.file('source.scad', currentCode);
      zip.file('specs.json', JSON.stringify({
        projectName: sessions.find(session => session.id === activeId)?.title ?? 'model',
        dimensions_mm: currentModelSpecs.dimensions_mm,
        volume_cm3: currentModelSpecs.volume_cm3,
        weight_pla_grams: currentModelSpecs.weight_pla_grams,
        estimated_cost_usd: currentModelSpecs.estimated_cost_usd,
        exportedAt: new Date().toISOString(),
      }, null, 2));
      const archive = await zip.generateAsync({ type: 'blob' });
      downloadBlob(archive, `rockycad-${getExportSlug()}-manufacturing-pack.zip`);
      setIsExportMenuOpen(false);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Unable to create the manufacturing pack.';
      alert(`Export Error: ${message}`);
    } finally {
      setIsExportingPack(false);
    }
  };

  const handleAutoFix = async () => {
    if (!currentCode || currentCode.includes('// Your active') || isFixing) return;
    setIsFixing(true);

    try {
      const codeToFix = currentCode;
      const res = await fetch('/api/fix', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scad_code: codeToFix }),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(typeof data.detail === 'string' ? data.detail : 'Auto-fix request failed');
      }

      const rawResponse = typeof data.scad_code === 'string' ? data.scad_code.trim() : '';
      if (!rawResponse) throw new Error('No corrected code returned');

      const codeMatch = rawResponse.match(/```(?:openscad)?\n([\s\S]*?)```/i);
      const fixedCode = codeMatch ? codeMatch[1].trim() : rawResponse;

      setCurrentCode(fixedCode);
      currentCodeRef.current = fixedCode;
      await handleCompile();
    } catch (err: unknown) {
      console.error('Auto-Fix Error:', err);
    } finally {
      setIsFixing(false);
    }
  };

  useEffect(() => {
    const handleSceneShortcuts = (event: KeyboardEvent) => {
      const target = event.target;
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement ||
          (target instanceof HTMLElement && target.isContentEditable)) return;

      const selected = sceneObjectsRef.current.find(object => object.id === selectedObjectId);
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'g') {
        if (selectedObjectIds.length > 1) {
          event.preventDefault();
          sceneActionsRef.current?.groupSelectedObjects();
        }
      } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'd') {
        if (selected) {
          event.preventDefault();
          sceneActionsRef.current?.duplicateSelectedSceneObject();
        }
      } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'c') {
        if (selected) {
          event.preventDefault();
          setClipboardObject({ ...selected, params: { ...selected.params } });
        }
      } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'v') {
        if (clipboardObject) {
          event.preventDefault();
          sceneActionsRef.current?.pasteSceneObject();
        }
      } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z' && event.shiftKey) {
        event.preventDefault();
        sceneActionsRef.current?.redoSceneChange();
      } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
        event.preventDefault();
        sceneActionsRef.current?.undoSceneChange();
      } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'y') {
        event.preventDefault();
        sceneActionsRef.current?.redoSceneChange();
      } else if (!event.ctrlKey && !event.metaKey && !event.altKey && selected) {
        switch (event.key.toLowerCase()) {
          case 'd':
            event.preventDefault();
            sceneActionsRef.current?.dropSelectedToWorkplane();
            break;
          case 'h':
            event.preventDefault();
            sceneActionsRef.current?.setSelectedObjectOperation(selected.operation === 'solid' ? 'hole' : 'solid');
            break;
          case 'm':
            event.preventDefault();
            sceneActionsRef.current?.mirrorSelectedObject('x');
            break;
          case 'delete':
          case 'backspace':
            event.preventDefault();
            sceneActionsRef.current?.deleteSelectedSceneObject();
            break;
        }
      }
    };

    window.addEventListener('keydown', handleSceneShortcuts);
    return () => window.removeEventListener('keydown', handleSceneShortcuts);
  }, [
    clipboardObject,
    selectedObjectId,
    selectedObjectIds,
  ]);

  return (
    <main className="flex h-screen w-screen overflow-hidden bg-[#000000] text-[#f8fafc] font-sans">
      
      {/* PANE 1: LEFT SIDEBAR (Library) */}
      <aside className={`shrink-0 flex flex-col h-full overflow-hidden bg-[#050505] transition-all duration-300 ${isStudioMinimized ? 'w-0 border-r-0 p-0 opacity-0' : 'w-[260px] border-r border-[#222222] p-4'}`}>
        <button 
          onClick={createNewProject}
          className="flex items-center gap-2 bg-white text-black font-medium px-4 py-2.5 rounded-lg text-sm hover:bg-gray-200 transition-colors w-full justify-center mb-6"
        >
          <Plus className="w-4 h-4" /> New Project
        </button>
        
        <div className="flex-1 overflow-y-auto space-y-6">
          <section>
            <div className="text-xs font-semibold tracking-widest text-[#666666] mb-3 px-2">RECENT PROJECTS</div>
            <div className="flex flex-col gap-1">
              {sessions.map(session => (
                <div 
                  key={session.id}
                  onClick={() => switchProject(session.id)}
                  className={`flex items-center justify-between px-3 py-2.5 rounded-md cursor-pointer transition-colors group ${
                    activeId === session.id ? 'bg-[#222222] text-white' : 'text-[#888888] hover:bg-[#111111] hover:text-white'
                  }`}
                >
                  <div className="flex items-center gap-2 overflow-hidden">
                    <MessageSquare className="w-4 h-4 shrink-0" />
                    <span className="text-sm truncate">{session.title}</span>
                  </div>
                  <button 
                    onClick={(e) => deleteProject(session.id, e)}
                    className="opacity-0 group-hover:opacity-100 hover:text-red-400 transition-opacity"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              ))}
            </div>
          </section>

          <section>
            <div className="text-xs font-semibold tracking-widest text-[#666666] mb-3 px-2">COMPONENT LIBRARY</div>
            <div className="flex flex-col gap-1">
              {Object.keys(COMPONENT_TEMPLATES).map(component => (
                <button key={component} type="button" onClick={() => handleLoadComponent(component)} className="flex items-center gap-2 px-3 py-2.5 rounded-md text-sm text-[#888888] cursor-pointer transition-colors hover:bg-[#111111] hover:text-white text-left">
                  <Box className="w-4 h-4 shrink-0" />
                  <span className="truncate">{component}</span>
                </button>
              ))}
            </div>
          </section>
        </div>

        <div className="border-t border-[#222222] pt-4 mt-auto">
          <button type="button" onClick={() => setIsSettingsOpen(true)} aria-label="Open Studio Settings" className="w-full flex items-center justify-between p-2 rounded-lg hover:bg-[#151515] cursor-pointer transition-colors text-left">
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-full bg-[#222222] flex items-center justify-center text-[#888888]">
                <User className="w-4 h-4" />
              </div>
              <div>
                <div className="text-sm text-white">Garv</div>
                <div className="text-xs text-[#888888]">Free Tier</div>
              </div>
            </div>
            <Settings className="w-4 h-4 text-[#888888]" />
          </button>
        </div>
      </aside>

      <div ref={splitContainerRef} className="flex min-w-0 flex-1 overflow-hidden">
      {/* PANE 2: CENTER (Chat Assistant) */}
      <section
        className="relative flex min-w-0 flex-col border-r border-[#222222]"
        style={{ flex: isStudioMinimized ? '1 1 0%' : `0 0 ${chatWidth}%` }}
      >
        <header className="h-14 shrink-0 border-b border-[#222222] flex items-center justify-between px-6 bg-[#000000]/80 backdrop-blur z-10">
          <span className="text-sm font-medium tracking-tight text-[#888888]">
            RockyCAD <strong className="text-white">Assistant</strong>
          </span>
          {isStudioMinimized && (
            <button
              type="button"
              onClick={() => setIsStudioMinimized(false)}
              aria-label="Restore Studio panel"
              title="Restore Studio panel"
              className="rounded-md p-2 text-[#aaaaaa] transition-colors hover:bg-[#222222] hover:text-white"
            >
              <PanelRightOpen className="h-4 w-4" />
            </button>
          )}
        </header>

        <div className="flex-grow overflow-y-auto p-6 space-y-6 pb-28">
          {messages.map((msg, index) => (
            <div key={index} className={`flex flex-col ${msg.role === 'user' ? 'items-end' : 'items-start'}`}>
              <div className={`max-w-[90%] rounded-2xl px-5 py-3.5 text-sm leading-relaxed ${
                msg.role === 'user' ? 'bg-[#222222] text-white' : 'bg-transparent text-[#cccccc] border border-[#333333]'
              }`}>
                {editingIndex === index ? (
                  <div className="flex flex-col gap-2 w-[350px]">
                    <textarea
                      value={editText}
                      onChange={(e) => setEditText(e.target.value)}
                      className="w-full bg-[#111111] border border-[#444444] rounded p-2 text-white text-xs resize-none h-24 focus:outline-none focus:border-white"
                    />
                    <div className="flex gap-2 justify-end">
                      <button onClick={() => setEditingIndex(null)} className="px-3 py-1 text-xs text-[#888888] hover:text-white">Cancel</button>
                      <button 
                        onClick={() => { const text = editText; setEditingIndex(null); handleGenerate(text, index, msg.imageUrl ?? null); }} 
                        className="px-3 py-1 text-xs bg-white rounded text-black font-medium hover:bg-gray-200"
                      >
                        Save & Resend
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="font-sans">
                    {msg.imageUrl && (
                      <Image src={msg.imageUrl} alt="Uploaded sketch" width={240} height={240} unoptimized className="mb-2 max-h-48 w-auto rounded-lg object-contain" />
                    )}
                    {msg.role === 'assistant' ? (
                      <div className="break-words [&_a]:text-sky-300 [&_code]:font-mono [&_code]:text-xs [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:bg-[#050505] [&_pre]:p-3 [&_p:first-child]:mt-0 [&_p:last-child]:mb-0">
                        <ReactMarkdown remarkPlugins={[remarkMath]} rehypePlugins={[rehypeKatex]}>
                          {msg.content}
                        </ReactMarkdown>
                      </div>
                    ) : (
                      <div className="whitespace-pre-wrap">{msg.content}</div>
                    )}
                  </div>
                )}
              </div>
              {msg.role === 'user' && !editingIndex && (
                <div className="flex gap-2 mt-1.5 mr-1 text-xs text-[#666666]">
                  <button onClick={() => { setEditingIndex(index); setEditText(msg.content); }} className="flex items-center gap-1 hover:text-white transition-colors">
                    <Edit2 className="w-3.5 h-3.5" /> Edit
                  </button>
                  <button onClick={() => copyToClipboard(msg.content, index)} className="flex items-center gap-1 hover:text-white transition-colors">
                    {copiedIndex === index ? <Check className="w-3.5 h-3.5 text-white" /> : <Copy className="w-3.5 h-3.5" />} {copiedIndex === index ? 'Copied' : 'Copy'}
                  </button>
                </div>
              )}
              {msg.isAborted && (
                <div className="text-xs text-orange-400 bg-orange-950/30 border border-orange-900 rounded-full px-3 py-1 my-2 mx-auto w-fit text-center">
                  You stopped this response
                </div>
              )}
            </div>
          ))}
          {loading && (
            <div className="flex items-start">
              <div className="rounded-2xl px-5 py-3.5 text-sm leading-relaxed text-[#cccccc] border border-[#333333] flex items-center gap-3">
                <Loader2 className="w-4 h-4 animate-spin text-white" /> Working on it...
              </div>
            </div>
          )}
          <div ref={messagesEndRef} />
        </div>

        <div className="absolute bottom-0 left-0 right-0 p-4 bg-gradient-to-t from-[#000000] via-[#000000]/90 to-transparent">
          {selectedImage && (
            <div className="mb-2 flex w-fit items-center gap-2 rounded-lg border border-[#333333] bg-[#111111]/90 p-1.5 pr-2 shadow-lg">
              <Image src={selectedImage} alt="Selected sketch preview" width={40} height={40} unoptimized className="h-10 w-10 rounded object-cover" />
              <span className="text-xs text-[#aaaaaa]">Sketch attached</span>
              <button type="button" onClick={() => setSelectedImage(null)} aria-label="Remove attached image" className="rounded p-1 text-[#888888] hover:bg-[#222222] hover:text-white">
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          )}
          <div className="relative">
            <input
              ref={imageInputRef}
              type="file"
              accept="image/png, image/jpeg, image/webp"
              onChange={handleImageSelection}
              className="hidden"
              aria-label="Upload a sketch image"
            />
            <button
              type="button"
              onClick={() => imageInputRef.current?.click()}
              disabled={loading}
              aria-label="Attach sketch image"
              title="Attach sketch image"
              className="absolute left-2 top-2.5 rounded-lg p-2 text-[#888888] transition-colors hover:bg-[#222222] hover:text-white disabled:opacity-40"
            >
              <Paperclip className="h-4 w-4" />
            </button>
            <input
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && !loading && (input.trim() || selectedImage) && handleGenerate(input)}
              placeholder="Describe a 3D component..."
              disabled={loading}
              className="w-full bg-[#111111] border border-[#333333] rounded-xl py-3.5 pl-12 pr-14 text-sm text-white placeholder-[#666666] focus:outline-none focus:border-white shadow-xl transition-all"
            />
            {loading ? (
              <button onClick={handleStop} className="absolute right-3 top-2.5 bg-[#333333] hover:bg-[#444444] text-white p-2 rounded-lg transition-colors">
                <Square className="w-4 h-4 fill-current" />
              </button>
            ) : (
              <button onClick={() => handleGenerate(input)} disabled={!input.trim() && !selectedImage} aria-label="Send message" className="absolute right-3 top-2.5 bg-white hover:bg-gray-200 disabled:opacity-40 text-black p-2 rounded-lg transition-colors">
                <Send className="w-4 h-4" />
              </button>
            )}
          </div>
        </div>
      </section>

      {!isStudioMinimized && !isStudioExpanded && (
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize chat and studio panels"
          onPointerDown={event => beginResize('columns', event)}
          className="w-1.5 shrink-0 cursor-col-resize bg-neutral-800 transition-colors hover:bg-blue-500"
        />
      )}

      {/* PANE 3: RIGHT SIDEBAR (Studio Environment) */}
      <aside
        ref={studioPanelRef}
        id="studio-panel"
        className={`h-full overflow-hidden flex flex-col bg-[#0a0a0a] gap-4 border-l border-[#222222] transition-all duration-300 ${isStudioExpanded ? 'fixed inset-0 z-40 w-screen border-l-0 p-4' : isStudioMinimized ? 'w-0 flex-none translate-x-full border-l-0 p-0 opacity-0 pointer-events-none max-md:fixed max-md:inset-0 max-md:z-40' : 'relative min-w-0 flex-1 p-4'}`}
      >
        <header className="flex h-8 shrink-0 items-center justify-between px-1 text-xs font-semibold tracking-widest text-[#888888]">
          <span>STUDIO WORKSPACE</span>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => {
                setIsStudioMinimized(false);
                setIsStudioExpanded(expanded => !expanded);
              }}
              aria-label={isStudioExpanded ? 'Collapse Studio panel' : 'Expand Studio panel'}
              title={isStudioExpanded ? 'Collapse Studio panel' : 'Expand Studio panel'}
              className="rounded-md p-1.5 text-[#aaaaaa] transition-colors hover:bg-[#222222] hover:text-white"
            >
              {isStudioExpanded ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
            </button>
            <button
              type="button"
              onClick={() => {
                setIsStudioExpanded(false);
                setIsStudioMinimized(true);
              }}
              aria-label="Minimize Studio panel"
              title="Minimize Studio panel"
              className="rounded-md p-1.5 text-[#aaaaaa] transition-colors hover:bg-[#222222] hover:text-white"
            >
              <PanelRightClose className="h-4 w-4" />
            </button>
          </div>
        </header>
        
        {/* Top Half: 3D Viewer */}
        <div className="flex min-h-0 flex-col gap-2" style={{ flex: `0 0 ${viewerHeight}%` }}>
          <div className="flex justify-between items-center text-xs font-semibold tracking-widest text-[#888888] px-1 shrink-0">
            <span>STUDIO VIEWER</span>
            <div className="flex items-center gap-2">
              {stlUrl && (
                <div className="relative">
                  <button
                    type="button"
                    onClick={() => setIsExportMenuOpen(open => !open)}
                    aria-haspopup="menu"
                    aria-expanded={isExportMenuOpen}
                    className="flex items-center gap-1.5 bg-[#222222] hover:bg-[#333333] text-white px-3 py-1.5 rounded transition-colors"
                  >
                    <Download className="w-3.5 h-3.5" />
                    Export Pack
                    <ChevronDown className="w-3.5 h-3.5" />
                  </button>
                  {isExportMenuOpen && (
                    <div role="menu" className="absolute right-0 top-full z-30 mt-2 w-64 rounded-lg border border-[#333333] bg-[#111111] p-1.5 text-left shadow-xl">
                      <button type="button" role="menuitem" onClick={handleExportSTL} className="w-full rounded px-3 py-2 text-left text-xs text-[#cccccc] hover:bg-[#222222] hover:text-white">Download STL</button>
                      <button type="button" role="menuitem" onClick={handleExportSCAD} className="w-full rounded px-3 py-2 text-left text-xs text-[#cccccc] hover:bg-[#222222] hover:text-white">Download SCAD source</button>
                      <button type="button" role="menuitem" onClick={handleExportPack} disabled={!currentModelSpecs || isExportingPack} className="w-full rounded px-3 py-2 text-left text-xs text-[#cccccc] hover:bg-[#222222] hover:text-white disabled:cursor-not-allowed disabled:opacity-40">
                        {isExportingPack ? 'Building manufacturing pack...' : 'Export Manufacturing Pack (.zip)'}
                      </button>
                    </div>
                  )}
                </div>
              )}
              <button 
                onClick={() => handleCompile()}
                disabled={compiling || !currentCode}
                className="flex items-center gap-1.5 bg-blue-600 hover:bg-blue-500 text-white px-3 py-1.5 rounded disabled:opacity-40 disabled:bg-[#333333] transition-colors"
              >
                {compiling ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />}
                {compiling ? 'Rendering...' : 'Compile & Render'}
              </button>
            </div>
          </div>
          <div className="relative min-h-0 flex-1 overflow-hidden rounded-lg border border-[#333333]">
            <STLViewer
              url={stlUrl}
              sceneObjects={sceneObjects}
              pendingPasteObject={pendingPasteObject}
              selectedObjectIds={selectedObjectIds}
              snapDistance={snapDistance}
              onSelectObject={handleSelectSceneObject}
              onObjectContextMenu={handleSceneObjectContextMenu}
              onSelectObjects={addSelectedSceneObjects}
              onObjectDragStart={handleObjectDragStart}
              onObjectDragEnd={handleObjectDragEnd}
              onPlacePendingObject={placePendingPasteObject}
              onTransformObject={handleSceneTransform}
              gizmoMode={gizmoMode}
              isMeasureMode={isMeasuring}
              measurePoints={measurePoints}
              hoverPoint={hoverPoint}
              setMeasurePoints={setMeasurePoints}
              setHoverPoint={setHoverPoint}
              wireframe={isWireframe}
              showOverhangs={showOverhangs}
              cameraResetToken={cameraResetToken}
              autoOrientToken={autoOrientToken}
              parametricValues={parametricValues}
              compiledParamValues={compiledParamValues}
              onManufacturingSpecs={handleManufacturingSpecs}
            />
            {contextMenu && (
              <div
                role="menu"
                aria-label="Object actions"
                className="fixed z-50 min-w-40 overflow-hidden rounded-lg border border-neutral-700 bg-gray-800 p-1.5 text-sm text-neutral-100 shadow-2xl"
                style={{ left: contextMenu.x, top: contextMenu.y }}
                onClick={event => event.stopPropagation()}
              >
                {([
                  ['select', 'Select', 'text-neutral-100'],
                  ['clone', 'Clone', 'text-neutral-100'],
                  ['mirrorX', 'Mirror X', 'text-neutral-100'],
                  ['mirrorY', 'Mirror Y', 'text-neutral-100'],
                  ['delete', 'Delete', 'text-red-300'],
                ] as const).map(([action, label, color]) => (
                  <button
                    key={action}
                    type="button"
                    role="menuitem"
                    className={`block w-full rounded px-3 py-2 text-left transition-colors hover:bg-neutral-700 ${color}`}
                    onClick={() => handleContextMenuAction(action)}
                  >
                    {label}
                  </button>
                ))}
              </div>
            )}
            <div className="absolute left-3 top-12 z-20 flex max-w-[calc(100%-18rem)] items-center gap-1 overflow-x-auto rounded-xl border border-neutral-700/50 bg-neutral-900/60 p-1 text-[10px] shadow-xl backdrop-blur-md">
              <button type="button" onClick={groupSelectedObjects} disabled={selectedObjectIds.length <= 1} title="Join selected objects (Ctrl+G)" className="rounded px-2 py-1 text-blue-300 hover:bg-blue-500/15 disabled:cursor-not-allowed disabled:opacity-40">Join</button>
              {selectedObjectIds.length > 1 ? <>
                <button type="button" onClick={deleteSelectedSceneObject} title="Delete selected" className="rounded px-2 py-1 text-red-300 hover:bg-red-500/20">Delete</button>
              </> : selectedObjectId && <>
                <button type="button" onClick={duplicateSelectedSceneObject} title="Duplicate (Ctrl+D)" className="rounded px-2 py-1 text-[#cccccc] hover:bg-[#222222]">Duplicate</button>
                <button type="button" onClick={() => {
                  const selected = sceneObjectsRef.current.find(object => object.id === selectedObjectId);
                  if (selected) setClipboardObject({ ...selected, params: { ...selected.params } });
                }} title="Copy (Ctrl+C)" className="rounded px-2 py-1 text-[#cccccc] hover:bg-[#222222]">Copy</button>
                <button type="button" onClick={pasteSceneObject} disabled={!clipboardObject} title="Paste (Ctrl+V)" className="rounded px-2 py-1 text-[#cccccc] hover:bg-[#222222] disabled:opacity-40">Paste</button>
                <button type="button" onClick={dropSelectedToWorkplane} title="Drop to workplane (D)" className="rounded px-2 py-1 text-[#cccccc] hover:bg-[#222222]">Drop</button>
                <button type="button" onClick={() => setSelectedObjectOperation(sceneObjects.find(object => object.id === selectedObjectId)?.operation === 'solid' ? 'hole' : 'solid')} title="Solid / hole (H)" className="rounded px-2 py-1 text-[#cccccc] hover:bg-[#222222]">Solid/Hole</button>
                <button type="button" onClick={() => mirrorSelectedObject('x')} title="Mirror X (M)" className="rounded px-2 py-1 text-[#cccccc] hover:bg-[#222222]">Mirror X</button>
                <button type="button" onClick={() => mirrorSelectedObject('y')} title="Mirror Y" className="rounded px-2 py-1 text-[#cccccc] hover:bg-[#222222]">Mirror Y</button>
                <button type="button" onClick={deleteSelectedSceneObject} title="Delete" className="rounded px-2 py-1 text-red-300 hover:bg-red-500/20">Delete</button>
              </>}
              <button type="button" onClick={undoSceneChange} title="Undo (Ctrl+Z)" className="rounded px-2 py-1 text-[#cccccc] hover:bg-[#222222]">Undo</button>
              <button type="button" onClick={redoSceneChange} title="Redo (Ctrl+Y)" className="rounded px-2 py-1 text-[#cccccc] hover:bg-[#222222]">Redo</button>
              <span className="mx-1 h-4 w-px bg-[#333333]" />
              <span className="px-1 text-[#888888]">Snap</span>
              {([1, 5, null] as const).map(value => (
                <button key={value ?? 'off'} type="button" onClick={() => setSnapDistance(value)} aria-pressed={snapDistance === value} className={`rounded px-2 py-1 ${snapDistance === value ? 'bg-blue-500/20 text-blue-300' : 'text-[#aaaaaa] hover:bg-[#222222]'}`}>
                  {value === null ? 'Off' : `${value}mm`}
                </button>
              ))}
            </div>
            <div className="absolute left-3 top-24 z-10 rounded-xl border border-neutral-700/50 bg-neutral-900/60 p-1.5 text-[10px] shadow-xl backdrop-blur-md">
              <button type="button" aria-haspopup="menu" aria-expanded={isShapeMenuOpen} onClick={() => setIsShapeMenuOpen(open => !open)} className="flex items-center gap-1.5 rounded-lg px-2 py-1.5 font-medium text-white hover:bg-white/10">
                <Plus className="h-3.5 w-3.5" /> Add Shape
              </button>
              {isShapeMenuOpen && <div role="menu" className="absolute left-0 top-full z-30 mt-1 grid w-40 grid-cols-2 gap-1 rounded-xl border border-neutral-700/50 bg-neutral-900/90 p-2 shadow-xl backdrop-blur-md">
              {([
                ['box', 'Box'],
                ['cylinder', 'Cylinder'],
                ['sphere', 'Sphere'],
                ['cone', 'Cone'],
                ['torus', 'Torus'],
                ['pyramid', 'Pyramid'],
                ['wedge', 'Wedge'],
                ['hexagon', 'Hexagon'],
              ] as const).map(([type, label]) => (
                <button key={type} type="button" role="menuitem" onClick={() => { spawnSceneObject(type); setIsShapeMenuOpen(false); }} className="rounded-md border border-neutral-700/60 px-2 py-1.5 text-left text-[#cccccc] transition-colors hover:border-blue-500 hover:bg-blue-500/15 hover:text-white">
                  + {label}
                </button>
              ))}
              </div>}
            </div>
            {selectedSceneObject && (
              <section aria-label="Shape Inspector" className="absolute right-3 top-12 z-20 max-h-[calc(100%-8rem)] w-64 overflow-y-auto rounded-xl border border-neutral-700/50 bg-neutral-900/60 p-3 text-[10px] shadow-xl backdrop-blur-md">
                <div className="mb-2 flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <h3 className="font-semibold uppercase tracking-wide text-white">Shape Inspector</h3>
                    <p className="truncate text-[#888888]">{selectedSceneObject.name}</p>
                  </div>
                  <button type="button" onClick={deleteSelectedSceneObject} title="Delete (Del)" aria-label="Delete selected shape" className="rounded p-1.5 text-red-300 hover:bg-red-500/20"><Trash2 className="h-3.5 w-3.5" /></button>
                </div>
                <div className="mb-3 grid grid-cols-2 gap-1" role="tablist" aria-label="Shape inspector sections">
                  <button type="button" role="tab" aria-selected={inspectorTab === 'position'} onClick={() => setInspectorTab('position')} className={`rounded px-2 py-1.5 ${inspectorTab === 'position' ? 'bg-blue-500/20 text-blue-300' : 'bg-[#222222] text-[#aaaaaa]'}`}>Position</button>
                  <button type="button" role="tab" aria-selected={inspectorTab === 'dimensions'} onClick={() => setInspectorTab('dimensions')} className={`rounded px-2 py-1.5 ${inspectorTab === 'dimensions' ? 'bg-blue-500/20 text-blue-300' : 'bg-[#222222] text-[#aaaaaa]'}`}>Dimensions</button>
                </div>
                <div className="mb-3 grid grid-cols-2 gap-1">
                  <button type="button" onClick={() => setSelectedObjectOperation('solid')} aria-pressed={selectedSceneObject.operation === 'solid'} className={`rounded px-2 py-1.5 ${selectedSceneObject.operation === 'solid' ? 'bg-blue-500/20 text-blue-300' : 'bg-[#222222] text-[#aaaaaa]'}`}>Solid</button>
                  <button type="button" onClick={() => setSelectedObjectOperation('hole')} aria-pressed={selectedSceneObject.operation === 'hole'} className={`rounded px-2 py-1.5 ${selectedSceneObject.operation === 'hole' ? 'bg-red-500/20 text-red-300' : 'bg-[#222222] text-[#aaaaaa]'}`}>Hole</button>
                </div>
                {inspectorTab === 'position' ? <div className="space-y-2">
                  {(['X', 'Y', 'Z'] as const).map((axis, index) => (
                    <label key={axis} className="block text-[#aaaaaa]">
                      <span>{index === 0 ? 'X (Width)' : index === 1 ? 'Y (Depth)' : 'Z (Elevation / Height)'}</span>
                      <div className="flex items-center gap-2">
                        <input
                          type="number"
                          value={selectedSceneObject.position[index]}
                          step="0.1"
                          aria-label={`Position ${axis}`}
                          onChange={event => {
                            const value = Number(event.currentTarget.value);
                            if (!Number.isFinite(value)) return;
                            updateSelectedSceneObject(object => ({
                              ...object,
                              position: object.position.map((coordinate, positionAxis) => positionAxis === index ? value : coordinate) as [number, number, number],
                            }));
                          }}
                          className="w-16 rounded border border-[#333333] bg-[#090909] px-1.5 py-1 text-right text-white"
                        />
                        <input
                          type="range"
                          min={index === 2 ? -150 : -200}
                          max="200"
                          step="1"
                          value={selectedSceneObject.position[index]}
                          aria-label={`Slide position ${axis}`}
                          onPointerDown={handleScenePreviewStart}
                          onPointerUp={handleScenePreviewEnd}
                          onPointerCancel={handleScenePreviewEnd}
                          onKeyDown={handleScenePreviewStart}
                          onKeyUp={handleScenePreviewEnd}
                          onBlur={handleScenePreviewEnd}
                          onChange={event => {
                            const value = Number(event.currentTarget.value);
                            previewSelectedSceneObject(object => ({
                              ...object,
                              position: object.position.map((coordinate, positionAxis) => positionAxis === index ? value : coordinate) as [number, number, number],
                            }));
                          }}
                          className="min-w-0 flex-1 accent-blue-500"
                        />
                      </div>
                    </label>
                  ))}
                </div> : <div className="space-y-3">
                  {selectedDimensionFields.map(field => {
                    const factor = field.factor ?? 1;
                    const value = (selectedSceneObject.params[field.key] ?? 0) / factor;
                    const max = Math.max(100, value * 2);
                    return (
                      <label key={field.key} className="block text-[#aaaaaa]">
                        <span>{field.label}</span>
                        <div className="mt-1 flex items-center gap-2">
                          <input
                            type="number"
                            min={field.min}
                            step="0.1"
                            value={Number(value.toFixed(2))}
                            onChange={event => {
                              const nextValue = Number(event.currentTarget.value);
                              if (!Number.isFinite(nextValue) || nextValue < field.min) return;
                              updateSelectedSceneObject(object => ({
                                ...object,
                                params: { ...object.params, [field.key]: nextValue * factor },
                              }));
                            }}
                            className="w-16 rounded border border-[#333333] bg-[#090909] px-1.5 py-1 text-right text-white"
                          />
                          <input
                            type="range"
                            min={field.min}
                            max={max}
                            step="0.1"
                            value={Math.min(max, Math.max(field.min, value))}
                            aria-label={field.label}
                            onPointerDown={handleScenePreviewStart}
                            onPointerUp={handleScenePreviewEnd}
                            onPointerCancel={handleScenePreviewEnd}
                            onKeyDown={handleScenePreviewStart}
                            onKeyUp={handleScenePreviewEnd}
                            onBlur={handleScenePreviewEnd}
                            onChange={event => {
                              const nextValue = Number(event.currentTarget.value);
                              previewSelectedSceneObject(object => ({
                                ...object,
                                params: { ...object.params, [field.key]: nextValue * factor },
                              }));
                            }}
                            className="min-w-0 flex-1 accent-blue-500"
                          />
                        </div>
                      </label>
                    );
                  })}
                </div>}
                <div className="mt-3 grid grid-cols-2 gap-1">
                  <button type="button" onClick={duplicateSelectedSceneObject} title="Duplicate (Ctrl+D)" className="rounded bg-[#222222] px-2 py-1.5 text-[#cccccc] hover:bg-[#333333]">Duplicate</button>
                  <button type="button" onClick={dropSelectedToWorkplane} title="Drop to grid (D)" className="rounded bg-[#222222] px-2 py-1.5 text-[#cccccc] hover:bg-[#333333]">Drop to Grid</button>
                  <button type="button" onClick={() => updateSelectedSceneObject(object => ({ ...object, position: [0, 0, getSceneObjectVerticalHalfExtent(object)] }))} title="Center on workplane" className="rounded bg-[#222222] px-2 py-1.5 text-[#cccccc] hover:bg-[#333333]">Center</button>
                  <button type="button" onClick={deleteSelectedSceneObject} title="Delete (Del)" className="rounded bg-red-500/10 px-2 py-1.5 text-red-300 hover:bg-red-500/20">Delete</button>
                </div>
              </section>
            )}
            <form
              onSubmit={event => {
                event.preventDefault();
                executeCadCommand(cadCommand);
                setCadCommand('');
              }}
              className="absolute bottom-0 left-3 right-3 z-10 flex items-center gap-2 rounded-xl border border-neutral-700/50 bg-neutral-900/60 px-3 py-2 shadow-xl backdrop-blur-md"
            >
              <span className="font-mono text-blue-400">&gt;</span>
              <input
                value={cadCommand}
                onChange={event => setCadCommand(event.target.value)}
                aria-label="CAD command"
                placeholder="Type a CAD command (e.g., BOX 40 40 10, CYL 15 50, HOLE 5 50, MOVE 10 0 0, DEL, CLEAR)..."
                className="min-w-0 flex-1 bg-transparent font-mono text-[10px] text-green-500 placeholder-green-700/50 focus:outline-none"
              />
              {cadCommandStatus && <span role="status" className="hidden max-w-48 truncate text-[9px] text-[#999999] sm:inline">{cadCommandStatus}</span>}
            </form>
            {compileStatus && (
              <div role="status" className="absolute bottom-14 left-1/2 z-20 -translate-x-1/2 rounded-lg border border-[#333333] bg-[#111111]/90 px-4 py-2 text-xs text-[#cccccc] shadow-lg backdrop-blur">
                {compileStatus}
              </div>
            )}
            <div role="toolbar" aria-label="Viewer inspection tools" className="absolute right-3 top-3 z-10 flex gap-2 rounded-lg border border-[#333333] bg-[#111111]/80 p-1.5 backdrop-blur transition-transform duration-300" style={{ transform: isViewerToolbarMinimized ? 'translateX(calc(100% - 2.75rem))' : undefined }}>
                  <button
                    type="button"
                    onClick={() => setIsViewerToolbarMinimized(minimized => !minimized)}
                    aria-label={isViewerToolbarMinimized ? 'Show viewer tools' : 'Minimize viewer tools'}
                    aria-expanded={!isViewerToolbarMinimized}
                    title={isViewerToolbarMinimized ? 'Show viewer tools' : 'Minimize viewer tools'}
                    className="rounded-md p-1.5 text-[#aaaaaa] transition-colors hover:bg-[#222222] hover:text-white"
                  >
                    {isViewerToolbarMinimized ? <PanelRightOpen className="h-4 w-4" /> : <PanelRightClose className="h-4 w-4" />}
                  </button>
                  {!isViewerToolbarMinimized && <>
                  <button
                    type="button"
                    onClick={() => {
                      const nextMeasuring = !isMeasuring;
                      setIsMeasuring(nextMeasuring);
                      if (!nextMeasuring) {
                        setMeasurePoints([]);
                        setHoverPoint(null);
                      }
                    }}
                    aria-label="Measure tool"
                    aria-pressed={isMeasuring}
                    title="Measure between points"
                    className={`p-1.5 rounded-md transition-colors ${isMeasuring ? 'bg-[#00ffcc]/15 text-[#00ffcc]' : 'text-[#aaaaaa] hover:bg-[#222222] hover:text-white'}`}
                  >
                    <Ruler className="w-4 h-4" />
                  </button>
                  <button
                    type="button"
                    onClick={() => setGizmoMode('translate')}
                    aria-label="Move gizmo"
                    aria-pressed={gizmoMode === 'translate'}
                    title="Move"
                    className={`p-1.5 rounded-md transition-colors ${gizmoMode === 'translate' ? 'bg-blue-500/20 text-blue-300' : 'text-[#aaaaaa] hover:bg-[#222222] hover:text-white'}`}
                  >
                    <Move className="w-4 h-4" />
                  </button>
                  <button
                    type="button"
                    onClick={() => setGizmoMode('scale')}
                    aria-label="Scale gizmo"
                    aria-pressed={gizmoMode === 'scale'}
                    title="Scale"
                    className={`p-1.5 rounded-md transition-colors ${gizmoMode === 'scale' ? 'bg-blue-500/20 text-blue-300' : 'text-[#aaaaaa] hover:bg-[#222222] hover:text-white'}`}
                  >
                    <Scale className="w-4 h-4" />
                  </button>
                  <button
                    type="button"
                    onClick={() => setCameraResetToken(token => token + 1)}
                    aria-label="Reset camera"
                    title="Reset camera"
                    className="p-1.5 rounded-md text-[#aaaaaa] hover:bg-[#222222] hover:text-white transition-colors"
                  >
                    <RotateCcw className="w-4 h-4" />
                  </button>
                  </>}
            </div>
          </div>
        </div>

        <div
          role="separator"
          aria-orientation="horizontal"
          aria-label="Resize studio viewer and developer mode"
          onPointerDown={event => beginResize('rows', event)}
          className="h-1.5 shrink-0 cursor-row-resize bg-neutral-800 transition-colors hover:bg-blue-500"
        />

        {/* Bottom Half: Developer Code Mode */}
        <div className="flex min-h-0 flex-1 flex-col gap-2">
          <div className="flex items-center justify-between px-1 pt-2 border-t border-[#222222] shrink-0 gap-2">
            <div className="flex items-center gap-2 text-xs font-semibold tracking-widest text-[#888888] shrink-0">
              <Code2 className="w-4 h-4" /> DEVELOPER MODE
            </div>
            <div className="flex items-center gap-2 shrink-0">
            <button
              onClick={handleAutoFix}
              disabled={isFixing || !currentCode || currentCode.includes('// Your active')}
              className="flex items-center gap-1 px-2 py-1 rounded-md border border-[#333333] text-[10px] font-medium tracking-wide text-[#888888] hover:text-white hover:border-[#555555] disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              {isFixing ? <Loader2 className="w-3 h-3 animate-spin" /> : <Wand2 className="w-3 h-3" />}
              Auto-Fix
            </button>
            <div className="flex rounded-md border border-[#333333] overflow-hidden text-[10px] font-medium tracking-wide">
              <button
                onClick={() => setDevView('code')}
                className={`flex items-center gap-1 px-2.5 py-1 transition-colors ${
                  devView === 'code' ? 'bg-[#222222] text-white' : 'text-[#666666] hover:text-[#aaaaaa]'
                }`}
              >
                <Code2 className="w-3 h-3" /> Code
              </button>
              <button
                onClick={() => setDevView('parametric')}
                className={`flex items-center gap-1 px-2.5 py-1 border-l border-[#333333] transition-colors ${
                  devView === 'parametric' ? 'bg-[#222222] text-white' : 'text-[#666666] hover:text-[#aaaaaa]'
                }`}
              >
                <SlidersHorizontal className="w-3 h-3" /> Params
                {compiling && (
                  <Loader2 className="w-3 h-3 animate-spin text-blue-400 ml-0.5" />
                )}
              </button>
            </div>
            </div>
          </div>

          {devView === 'code' ? (
            <textarea
              value={currentCode}
              onChange={(e) => {
                setCurrentCode(e.target.value);
                if (autoCompileOnChange) debouncedCompile();
              }}
              spellCheck={false}
              className="w-full flex-grow min-h-0 bg-[#050505] border border-[#222222] rounded-lg p-4 font-mono text-[11px] leading-relaxed text-[#4ade80] resize-none focus:outline-none focus:ring-1 focus:ring-[#4ade80]/30 focus:border-[#4ade80]/40 transition-all selection:bg-[#4ade80]/20"
            />
          ) : (
            <div className="w-full flex-grow min-h-0 bg-[#050505] border border-[#222222] rounded-lg overflow-y-auto">
              {params.length === 0 ? (
                <div className="h-full flex flex-col items-center justify-center text-[#555555] text-[11px] text-center px-6 gap-2">
                  <SlidersHorizontal className="w-5 h-5 text-[#333333]" />
                  <p>No parametric variables detected.</p>
                  <p className="font-mono text-[#666666] text-[10px]">width = 20; // base width</p>
                </div>
              ) : (
                <div className="divide-y divide-[#1a1a1a]">
                  {params.map((param) => (
                    <div key={param.name} className="px-4 py-3.5 flex flex-col gap-2.5 hover:bg-[#0a0a0a] transition-colors">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0 flex-1">
                          <div className="text-[11px] font-mono font-medium text-[#e2e8f0] truncate">
                            {param.name}
                          </div>
                          {param.label && (
                            <div className="text-[10px] text-[#888888] mt-0.5 truncate">
                              {param.label}
                            </div>
                          )}
                        </div>
                        <input
                          type="number"
                          min={param.min}
                          max={param.max}
                          step={param.step}
                          value={param.value}
                          onChange={(e) => handleParamChange(param.name, parseFloat(e.target.value))}
                          className="w-[52px] shrink-0 bg-[#111111] border border-[#333333] rounded px-1.5 py-0.5 text-[11px] font-mono text-white text-right focus:outline-none focus:ring-1 focus:ring-white/20 focus:border-[#555555] transition-all tabular-nums"
                        />
                      </div>
                      <input
                        type="range"
                        min={param.min}
                        max={param.max}
                        step={param.step}
                        value={param.value}
                        onChange={(e) => handleParamChange(param.name, parseFloat(e.target.value))}
                        className="w-full h-[3px] bg-[#222222] rounded-full appearance-none cursor-pointer
                          [&::-webkit-slider-runnable-track]:h-[3px] [&::-webkit-slider-runnable-track]:rounded-full [&::-webkit-slider-runnable-track]:bg-[#222222]
                          [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:h-3 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-white [&::-webkit-slider-thumb]:-mt-[4.5px] [&::-webkit-slider-thumb]:shadow-[0_0_6px_rgba(255,255,255,0.3)]
                          [&::-moz-range-track]:h-[3px] [&::-moz-range-track]:rounded-full [&::-moz-range-track]:bg-[#222222]
                          [&::-moz-range-thumb]:w-3 [&::-moz-range-thumb]:h-3 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:bg-white [&::-moz-range-thumb]:border-0"
                      />
                      <div className="flex justify-between text-[9px] font-mono text-[#444444] tabular-nums">
                        <span>{param.min}</span>
                        <span>{param.max}</span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </aside>
      </div>

      {isSettingsOpen && (
        <div
          className="bg-black/60 backdrop-blur-sm fixed inset-0 z-50 flex items-center justify-center"
          onClick={() => setIsSettingsOpen(false)}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="studio-settings-title"
            onClick={(event) => event.stopPropagation()}
            className="w-full max-w-md mx-4 rounded-lg border border-[#333333] bg-[#101010] p-6 shadow-2xl"
          >
            <div className="flex items-center justify-between mb-6">
              <h2 id="studio-settings-title" className="text-lg font-semibold text-white">Studio Settings</h2>
              <button
                type="button"
                onClick={() => setIsSettingsOpen(false)}
                aria-label="Close settings"
                className="p-1.5 rounded-md text-[#888888] hover:bg-[#222222] hover:text-white transition-colors"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="space-y-5">
              <label className="flex items-center justify-between gap-4 text-sm text-[#cccccc]">
                <span>Default $fn Resolution</span>
                <select
                  value={defaultFnResolution}
                  onChange={(event) => setDefaultFnResolution(Number(event.target.value))}
                  className="bg-[#1a1a1a] border border-[#333333] rounded-md px-3 py-2 text-white focus:outline-none focus:border-[#666666]"
                >
                  <option value={32}>32</option>
                  <option value={64}>64</option>
                  <option value={128}>128</option>
                </select>
              </label>

              <label className="flex items-center justify-between gap-4 text-sm text-[#cccccc]">
                <span>Auto-compile on change</span>
                <input
                  type="checkbox"
                  checked={autoCompileOnChange}
                  onChange={(event) => setAutoCompileOnChange(event.target.checked)}
                  className="h-4 w-4 accent-white"
                />
              </label>
            </div>

            <div className="flex justify-end mt-7">
              <button
                type="button"
                onClick={() => setIsSettingsOpen(false)}
                className="px-4 py-2 rounded-md bg-white text-black text-sm font-medium hover:bg-gray-200 transition-colors"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}