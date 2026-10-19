'use client';

import { Canvas, useLoader, type ThreeEvent } from '@react-three/fiber';
import { OrbitControls, Environment, GizmoHelper, GizmoViewport, Html, Line, TransformControls, Edges, PerspectiveCamera } from '@react-three/drei';
import { Geometry, Base, Subtraction, Addition } from '@react-three/csg';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import { Suspense, useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type PointerEvent as ReactPointerEvent, type ReactNode, type SetStateAction } from 'react';
import * as THREE from 'three';
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib';
import { ChevronDown, ChevronUp, Layers, Scale } from 'lucide-react';

export interface ManufacturingSpecs {
  dimensions_mm: { x: number; y: number; z: number };
  volume_cm3: number;
  weight_pla_grams: number;
  estimated_cost_usd: number;
}

type Orientation = [number, number, number];
type GizmoMode = 'translate' | 'scale';
const OVERHANG_DOT_THRESHOLD = 0.707;

export interface SceneObject {
  id: string;
  type: 'box' | 'cylinder' | 'sphere' | 'cone' | 'torus' | 'pyramid' | 'wedge' | 'hexagon' | 'group';
  operation: 'solid' | 'hole';
  position: [number, number, number];
  rotation: [number, number, number];
  scale: [number, number, number];
  params: Record<string, number>;
  children?: SceneObject[];
  name: string;
}

function getMeasurementPoint(hit: THREE.Intersection): THREE.Vector3 {
  if (!hit.face || !(hit.object instanceof THREE.Mesh)) return hit.point.clone();
  const position = hit.object.geometry.getAttribute('position');
  if (!position) return hit.point.clone();

  const vertices = [hit.face.a, hit.face.b, hit.face.c].map(index =>
    new THREE.Vector3().fromBufferAttribute(position, index).applyMatrix4(hit.object.matrixWorld),
  );
  const distances = vertices.map(vertex => hit.point.distanceTo(vertex));
  const closestDistance = Math.min(...distances);
  if (closestDistance >= 2) return hit.point.clone();
  return vertices[distances.indexOf(closestDistance)];
}

const ORIENTATION_CANDIDATES: Orientation[] = [
  [0, 0, 0],
  [Math.PI, 0, 0],
  [Math.PI / 2, 0, 0],
  [-Math.PI / 2, 0, 0],
  [0, Math.PI / 2, 0],
  [0, -Math.PI / 2, 0],
];

function evaluateOrientation(geometry: THREE.BufferGeometry, orientation: Orientation) {
  const position = geometry.getAttribute('position');
  const indices = geometry.index;
  const triangleCount = indices ? indices.count / 3 : position.count / 3;
  const rotation = new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(...orientation));
  const vertices = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
  const edgeA = new THREE.Vector3();
  const edgeB = new THREE.Vector3();
  const normal = new THREE.Vector3();
  const down = new THREE.Vector3(0, 0, -1);
  const triangleIndices = [0, 0, 0];
  let minZ = Infinity;
  let maxZ = -Infinity;
  let overhangArea = 0;

  for (let vertexIndex = 0; vertexIndex < position.count; vertexIndex += 1) {
    vertices[0].fromBufferAttribute(position, vertexIndex).applyMatrix4(rotation);
    minZ = Math.min(minZ, vertices[0].z);
    maxZ = Math.max(maxZ, vertices[0].z);
  }

  const bedTolerance = Math.max(1e-5, (maxZ - minZ) * 1e-6);
  let bedContactArea = 0;
  const readTriangle = (triangle: number) => {
    for (let corner = 0; corner < 3; corner += 1) {
      triangleIndices[corner] = indices ? indices.getX(triangle * 3 + corner) : triangle * 3 + corner;
      vertices[corner].fromBufferAttribute(position, triangleIndices[corner]).applyMatrix4(rotation);
    }
    edgeA.subVectors(vertices[1], vertices[0]);
    edgeB.subVectors(vertices[2], vertices[0]);
    normal.crossVectors(edgeA, edgeB);
    const area = normal.length() / 2;
    normal.normalize();
    return { area, downwardDot: normal.dot(down) };
  };

  for (let triangle = 0; triangle < triangleCount; triangle += 1) {
    const { area, downwardDot } = readTriangle(triangle);
    if (downwardDot <= OVERHANG_DOT_THRESHOLD) continue;
    if (vertices.every(vertex => vertex.z <= minZ + bedTolerance)) {
      bedContactArea += Math.abs(edgeA.x * edgeB.y - edgeA.y * edgeB.x) / 2;
    } else {
      overhangArea += area;
    }
  }

  return { overhangArea, bedContactArea };
}

function computeMeshVolume(geometry: THREE.BufferGeometry): number {
  const position = geometry.getAttribute('position') as THREE.BufferAttribute | undefined;
  if (!position) return 0;

  const positions = position.array;
  const p1 = new THREE.Vector3();
  const p2 = new THREE.Vector3();
  const p3 = new THREE.Vector3();
  const crossProduct = new THREE.Vector3();
  let signedVolume = 0;

  for (let index = 0; index + 8 < positions.length; index += 9) {
    p1.set(positions[index], positions[index + 1], positions[index + 2]);
    p2.set(positions[index + 3], positions[index + 4], positions[index + 5]);
    p3.set(positions[index + 6], positions[index + 7], positions[index + 8]);
    crossProduct.crossVectors(p2, p3);
    signedVolume += p1.dot(crossProduct) / 6;
  }

  return Math.abs(signedVolume);
}

interface STLViewerProps {
  url: string | null;
  sceneObjects: SceneObject[];
  pendingPasteObject: SceneObject | null;
  selectedObjectIds: string[];
  snapDistance: number | null;
  onSelectObject: (id: string | null, shiftKey?: boolean) => void;
  onObjectContextMenu: (id: string, x: number, y: number) => void;
  onSelectObjects: (ids: string[]) => void;
  onObjectDragStart: (id: string) => void;
  onObjectDragEnd: (id: string, position: [number, number, number]) => void;
  onPlacePendingObject: (position: [number, number, number]) => void;
  onTransformObject: (id: string, position: [number, number, number], rotation: [number, number, number], scale: [number, number, number]) => void;
  gizmoMode: GizmoMode;
  isMeasureMode: boolean;
  measurePoints: THREE.Vector3[];
  hoverPoint: THREE.Vector3 | null;
  setMeasurePoints: Dispatch<SetStateAction<THREE.Vector3[]>>;
  setHoverPoint: Dispatch<SetStateAction<THREE.Vector3 | null>>;
  wireframe: boolean;
  showOverhangs: boolean;
  cameraResetToken: number;
  autoOrientToken: number;
  parametricValues: Record<string, number>;
  compiledParamValues: Record<string, number>;
  onManufacturingSpecs: (specs: ManufacturingSpecs) => void;
}

function getParametricPreviewScale(values: Record<string, number>, baseValues: Record<string, number>): [number, number, number] {
  const scale: [number, number, number] = [1, 1, 1];
  for (const [name, value] of Object.entries(values)) {
    const baseValue = baseValues[name];
    if (!Number.isFinite(baseValue) || baseValue === 0 || !Number.isFinite(value)) continue;
    const ratio = Math.abs(value / baseValue);
    if (!Number.isFinite(ratio) || ratio <= 0) continue;

    const variable = name.toLowerCase();
    let axes: number[];
    if (/diameter|radius|(^|_)(d|r)(_|$)/.test(variable)) axes = [0, 1];
    else if (/width|(^|_)x($|_)/.test(variable)) axes = [0];
    else if (/depth|(^|_)y($|_)/.test(variable)) axes = [1];
    else if (/height|length|(^|_)z($|_)/.test(variable)) axes = [2];
    else axes = [0, 1, 2];

    for (const axis of axes) scale[axis] *= ratio;
  }
  return scale;
}

function getSceneObjectGeometry(type: SceneObject['type'], params: Record<string, number>, isHole: boolean): THREE.BufferGeometry | null {
  const extraHeight = isHole ? 2 : 0;
  switch (type) {
    case 'box':
      return new THREE.BoxGeometry(params.x, params.y, params.z + extraHeight);
    case 'cylinder':
      return new THREE.CylinderGeometry(params.d / 2, params.d / 2, params.h + extraHeight, params.segments || 32).rotateX(Math.PI / 2);
    case 'cone':
      return new THREE.CylinderGeometry(0, params.d / 2, params.h + extraHeight, 32).rotateX(Math.PI / 2);
    case 'pyramid':
      return new THREE.CylinderGeometry(0, params.d / 2, params.h, 4).rotateX(Math.PI / 2);
    case 'hexagon':
      return new THREE.CylinderGeometry(params.d / 2, params.d / 2, params.h, 6).rotateX(Math.PI / 2);
    case 'sphere':
      return new THREE.SphereGeometry(params.d / 2, 32, 32);
    case 'torus':
      return new THREE.TorusGeometry(Math.max(0.1, (params.d - params.tube) / 2), params.tube / 2, 16, 64);
    case 'wedge':
    case 'group':
      return null;
  }
}

function clampMeshAboveWorkplane(mesh: THREE.Mesh): number {
  const geometry = mesh.geometry;
  if (!geometry.boundingBox) geometry.computeBoundingBox();
  if (!geometry.boundingBox || geometry.boundingBox.isEmpty()) return Math.max(0, mesh.position.z);

  const localTransform = new THREE.Matrix4().compose(
    new THREE.Vector3(),
    mesh.quaternion,
    mesh.scale,
  );
  const bounds = geometry.boundingBox.clone().applyMatrix4(localTransform);
  const minZ = Math.max(0, -bounds.min.z);
  mesh.position.z = Math.max(mesh.position.z, minZ);
  return mesh.position.z;
}

function SceneGeometry({ object }: { object: SceneObject }) {
  const { params, type, operation } = object;
  const geometry = useMemo(() => {
    if (type !== 'wedge') return getSceneObjectGeometry(type, params, operation === 'hole');
    const shape = new THREE.Shape();
    shape.moveTo(-params.x / 2, -params.y / 2);
    shape.lineTo(params.x / 2, -params.y / 2);
    shape.lineTo(-params.x / 2, params.y / 2);
    shape.closePath();
    const height = params.z + (operation === 'hole' ? 2 : 0);
    const extruded = new THREE.ExtrudeGeometry(shape, { depth: height, bevelEnabled: false });
    extruded.translate(0, 0, -height / 2);
    return extruded;
  }, [operation, params, type]);
  useEffect(() => () => geometry?.dispose(), [geometry]);

  return geometry ? <primitive object={geometry} attach="geometry" /> : null;
}

function ScenePrimitive({ object, selected, transformTarget, gizmoMode, snapDistance, isMeasureMode, setMeasurePoints, setHoverPoint, onSelect, onObjectContextMenu, onHover, dragPlane, onObjectDragStart, onTransformDragging, onTransformObject, onMeshRef }: {
  object: SceneObject;
  selected: boolean;
  transformTarget: boolean;
  gizmoMode: GizmoMode;
  snapDistance: number | null;
  isMeasureMode: boolean;
  setMeasurePoints: Dispatch<SetStateAction<THREE.Vector3[]>>;
  setHoverPoint: Dispatch<SetStateAction<THREE.Vector3 | null>>;
  onSelect: (id: string, shiftKey: boolean) => void;
  onObjectContextMenu: (id: string, x: number, y: number) => void;
  onHover: (id: string | null) => void;
  dragPlane: THREE.Plane;
  onObjectDragStart: (id: string, offset: [number, number, number]) => void;
  onTransformDragging: (dragging: boolean) => void;
  onTransformObject: (id: string, position: [number, number, number], rotation: [number, number, number], scale: [number, number, number]) => void;
  onMeshRef: (id: string, mesh: THREE.Object3D | null) => void;
}) {
  const meshRef = useRef<THREE.Mesh>(null);
  const [meshObject, setMeshObject] = useState<THREE.Mesh | null>(null);
  const attachMeshRef = useCallback((mesh: THREE.Mesh | null) => {
    meshRef.current = mesh;
    onMeshRef(object.id, mesh);
    setMeshObject(current => current === mesh ? current : mesh);
  }, [object.id, onMeshRef]);
  const meshScale = object.scale;
  const isHole = object.operation === 'hole';

  const handleMeasurePointerMove = (event: ThreeEvent<PointerEvent>) => {
    if (!isMeasureMode) return;
    event.stopPropagation();
    const hit = event.intersections[0];
    if (hit) setHoverPoint(getMeasurementPoint(hit));
  };

  const handlePointerDown = (event: ThreeEvent<PointerEvent>) => {
    if (event.button !== 0) return;
    event.stopPropagation();
    if (isMeasureMode) {
      const hit = event.intersections[0];
      if (hit) {
        const point = getMeasurementPoint(hit);
        setMeasurePoints(points => points.length === 2 ? [point] : [...points, point]);
      }
      return;
    }
    onSelect(object.id, event.shiftKey);
    if (event.shiftKey) return;
    const startHitPoint = new THREE.Vector3();
    if (!event.ray.intersectPlane(dragPlane, startHitPoint)) return;
    const dragOffset = new THREE.Vector3(...object.position).sub(startHitPoint);
    onObjectDragStart(object.id, [dragOffset.x, dragOffset.y, dragOffset.z]);
  };

  const handleTransformEnd = () => {
    const mesh = meshRef.current;
    if (!mesh) return;
    const clampedZ = clampMeshAboveWorkplane(mesh);
    onTransformObject(
      object.id,
      [mesh.position.x, mesh.position.y, clampedZ],
      [mesh.rotation.x, mesh.rotation.y, mesh.rotation.z],
      [mesh.scale.x, mesh.scale.y, mesh.scale.z],
    );
    onTransformDragging(false);
  };

  return (
    <>
      <mesh
        ref={attachMeshRef}
        position={object.position}
        rotation={object.rotation}
        scale={meshScale}
        onPointerMove={isMeasureMode ? handleMeasurePointerMove : undefined}
        onPointerDown={handlePointerDown}
        onContextMenu={event => {
          event.stopPropagation();
          event.nativeEvent.preventDefault();
          onObjectContextMenu(object.id, event.clientX, event.clientY);
        }}
        onPointerOut={() => {
          onHover(null);
          if (isMeasureMode) setHoverPoint(null);
        }}
        onClick={event => {
          event.stopPropagation();
        }}
        onPointerOver={event => {
          event.stopPropagation();
          onHover(object.id);
        }}
      >
        <SceneGeometry object={object} />
        <meshStandardMaterial
          color={isHole ? '#ff3344' : selected ? '#4f9cff' : '#b8c4d4'}
          emissive={selected && !isHole ? '#164b87' : '#000000'}
          transparent={isHole}
          opacity={isHole ? 0.38 : 1}
          wireframe={isHole}
          roughness={0.48}
          metalness={0.18}
          depthWrite={!isHole}
        />
        {selected && <Edges linewidth={2} threshold={15} color="cyan" />}
      </mesh>
      {transformTarget && meshObject && !isMeasureMode && (
        <TransformControls
          object={meshObject}
          mode={gizmoMode}
          translationSnap={snapDistance}
          onMouseDown={() => onTransformDragging(true)}
          onMouseUp={handleTransformEnd}
        />
      )}
    </>
  );
}

type CSGOperationComponent = typeof Base | typeof Addition | typeof Subtraction;

function renderGroupOperand(
  object: SceneObject,
  Operation: CSGOperationComponent,
  renderGeometry: (object: SceneObject) => ReactNode,
): ReactNode {
  return (
    <Operation
      key={object.id}
      position={object.position}
      rotation={object.rotation}
      scale={object.scale}
    >
      {renderGeometry(object)}
    </Operation>
  );
}

function SceneGroup({ object, selected, transformTarget, gizmoMode, snapDistance, isMeasureMode, setMeasurePoints, setHoverPoint, onSelect, onObjectContextMenu, onHover, dragPlane, onObjectDragStart, onTransformDragging, onTransformObject, onMeshRef }: {
  object: SceneObject;
  selected: boolean;
  transformTarget: boolean;
  gizmoMode: GizmoMode;
  snapDistance: number | null;
  isMeasureMode: boolean;
  setMeasurePoints: Dispatch<SetStateAction<THREE.Vector3[]>>;
  setHoverPoint: Dispatch<SetStateAction<THREE.Vector3 | null>>;
  onSelect: (id: string, shiftKey: boolean) => void;
  onObjectContextMenu: (id: string, x: number, y: number) => void;
  onHover: (id: string | null) => void;
  dragPlane: THREE.Plane;
  onObjectDragStart: (id: string, offset: [number, number, number]) => void;
  onTransformDragging: (dragging: boolean) => void;
  onTransformObject: (id: string, position: [number, number, number], rotation: [number, number, number], scale: [number, number, number]) => void;
  onMeshRef: (id: string, mesh: THREE.Object3D | null) => void;
}) {
  const groupRef = useRef<THREE.Mesh>(null);
  const [groupObject, setGroupObject] = useState<THREE.Mesh | null>(null);
  const attachGroupRef = useCallback((mesh: THREE.Mesh | null) => {
    groupRef.current = mesh;
    onMeshRef(object.id, mesh);
    setGroupObject(current => current === mesh ? current : mesh);
  }, [object.id, onMeshRef]);
  const children = object.children ?? [];

  const renderObjectGeometry = (child: SceneObject): ReactNode => {
    if (child.type !== 'group') return <SceneGeometry object={child} />;
    const nestedChildren = child.children ?? [];
    const nestedSolids = nestedChildren.filter(part => part.operation === 'solid');
    const nestedHoles = nestedChildren.filter(part => part.operation === 'hole');
    const nestedOperations = [
      ...nestedSolids.map((part, index) => renderGroupOperand(part, index === 0 ? Base : Addition, renderObjectGeometry)),
      ...nestedHoles.map(part => renderGroupOperand(part, Subtraction, renderObjectGeometry)),
    ];
    return <Geometry>{nestedOperations}</Geometry>;
  };

  const startInteraction = (event: ThreeEvent<PointerEvent>) => {
    event.stopPropagation();
    if (isMeasureMode) {
      const hit = event.intersections[0];
      if (hit) {
        const point = getMeasurementPoint(hit);
        setMeasurePoints(points => points.length === 2 ? [point] : [...points, point]);
      }
      return;
    }
    onSelect(object.id, event.shiftKey);
    if (event.shiftKey) return;
    const hitPoint = new THREE.Vector3();
    if (!event.ray.intersectPlane(dragPlane, hitPoint)) return;
    const group = groupRef.current;
    const position = group?.position.clone() ?? new THREE.Vector3(...object.position);
    const offset = position.sub(hitPoint);
    onObjectDragStart(object.id, [offset.x, offset.y, offset.z]);
  };

  return (
    <>
      <mesh
        ref={attachGroupRef}
        position={object.position}
        rotation={object.rotation}
        scale={object.scale}
        onPointerMove={event => {
          if (!isMeasureMode) return;
          event.stopPropagation();
          const hit = event.intersections[0];
          if (hit) setHoverPoint(getMeasurementPoint(hit));
        }}
        onPointerDown={startInteraction}
        onContextMenu={event => {
          event.stopPropagation();
          event.nativeEvent.preventDefault();
          onObjectContextMenu(object.id, event.clientX, event.clientY);
        }}
        onPointerOut={() => {
          onHover(null);
          if (isMeasureMode) setHoverPoint(null);
        }}
        onPointerOver={event => {
          event.stopPropagation();
          onHover(object.id);
        }}
      >
        <Geometry>
          {children.filter(child => child.operation === 'solid').map((child, index) =>
            renderGroupOperand(child, index === 0 ? Base : Addition, renderObjectGeometry),
          )}
          {children.filter(child => child.operation === 'hole').map(child =>
            renderGroupOperand(child, Subtraction, renderObjectGeometry),
          )}
        </Geometry>
        <meshStandardMaterial
          color={selected ? '#4f9cff' : '#888888'}
          emissive={selected ? '#164b87' : '#000000'}
          roughness={0.48}
          metalness={0.18}
        />
        {selected && <Edges linewidth={2} threshold={15} color="cyan" />}
      </mesh>
      {transformTarget && groupObject && !isMeasureMode && (
        <TransformControls
          object={groupObject}
          mode={gizmoMode}
          translationSnap={snapDistance}
          onMouseDown={() => onTransformDragging(true)}
          onMouseUp={() => {
            const group = groupRef.current;
            if (!group) return;
            const clampedZ = clampMeshAboveWorkplane(group);
            onTransformObject(
              object.id,
              [group.position.x, group.position.y, clampedZ],
              [group.rotation.x, group.rotation.y, group.rotation.z],
              [group.scale.x, group.scale.y, group.scale.z],
            );
            onTransformDragging(false);
          }}
        />
      )}
    </>
  );
}

function STLModel({ url, isMeasureMode, setMeasurePoints, setHoverPoint, wireframe, showOverhangs, clipPlane, orientation, autoOrientToken, parametricValues, compiledParamValues, gizmoMode, snapDistance, onSelectObject, onMeshRef, onTransformDragging, onManufacturingSpecs, onOrientationOptimized }: Omit<STLViewerProps, 'url' | 'sceneObjects' | 'pendingPasteObject' | 'selectedObjectIds' | 'onObjectContextMenu' | 'onSelectObjects' | 'onObjectDragStart' | 'onObjectDragEnd' | 'onPlacePendingObject' | 'onTransformObject' | 'measurePoints' | 'hoverPoint' | 'cameraResetToken' | 'autoOrientToken' | 'onManufacturingSpecs'> & {
  url: string;
  clipPlane: THREE.Plane;
  orientation: Orientation;
  autoOrientToken: number;
  gizmoMode: GizmoMode;
  snapDistance: number | null;
  onMeshRef: (id: string, mesh: THREE.Object3D | null) => void;
  onTransformDragging: (dragging: boolean) => void;
  onManufacturingSpecs: (specs: ManufacturingSpecs) => void;
  onOrientationOptimized: (orientation: Orientation, supportReduction: number) => void;
}) {
  const geom = useLoader(STLLoader, url);
  if (!geom.boundingBox) geom.computeBoundingBox();
  const parametricScale = useMemo(
    () => getParametricPreviewScale(parametricValues, compiledParamValues),
    [compiledParamValues, parametricValues],
  );
  const specs = useMemo<ManufacturingSpecs>(() => {
    const position = geom.getAttribute('position');
    const bounds = new THREE.Box3().setFromBufferAttribute(position as THREE.BufferAttribute);
    const dimensions = bounds.getSize(new THREE.Vector3());
    const volumeCm3 = computeMeshVolume(geom) / 1000;
    const weightGrams = volumeCm3 * 1.24;
    return {
      dimensions_mm: { x: dimensions.x, y: dimensions.y, z: dimensions.z },
      volume_cm3: volumeCm3,
      weight_pla_grams: weightGrams,
      estimated_cost_usd: weightGrams * 0.02,
    };
  }, [geom]);
  const orientationMatrix = useMemo(() => new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(...orientation)), [orientation]);
  const overhangGeometry = useMemo(() => {
    if (!showOverhangs) return null;

    const geometry = geom.index ? geom.toNonIndexed() : geom.clone();
    const position = geometry.getAttribute('position');
    const colors = new Float32Array(position.count * 3);
    const safeColor = new THREE.Color('#444a54');
    const warningColor = new THREE.Color('#ff2a2a');
    const downAxis = new THREE.Vector3(0, 0, -1);
    const vertexA = new THREE.Vector3();
    const vertexB = new THREE.Vector3();
    const vertexC = new THREE.Vector3();
    const edgeA = new THREE.Vector3();
    const edgeB = new THREE.Vector3();
    const faceNormal = new THREE.Vector3();

    for (let index = 0; index + 2 < position.count; index += 3) {
      vertexA.fromBufferAttribute(position, index).applyMatrix4(orientationMatrix);
      vertexB.fromBufferAttribute(position, index + 1).applyMatrix4(orientationMatrix);
      vertexC.fromBufferAttribute(position, index + 2).applyMatrix4(orientationMatrix);
      edgeA.subVectors(vertexB, vertexA);
      edgeB.subVectors(vertexC, vertexA);
      faceNormal.crossVectors(edgeA, edgeB).normalize();
      const color = faceNormal.dot(downAxis) > OVERHANG_DOT_THRESHOLD ? warningColor : safeColor;

      color.toArray(colors, index * 3);
      color.toArray(colors, (index + 1) * 3);
      color.toArray(colors, (index + 2) * 3);
    }

    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geometry.computeBoundingBox();
    return geometry;
  }, [geom, orientationMatrix, showOverhangs]);
  const meshRef = useRef<THREE.Mesh>(null);
  const [meshObject, setMeshObject] = useState<THREE.Mesh | null>(null);
  const attachMeshRef = useCallback((mesh: THREE.Mesh | null) => {
    meshRef.current = mesh;
    setMeshObject(mesh);
    onMeshRef('compiled-model', mesh);
  }, [onMeshRef]);
  const processedAutoOrientToken = useRef(autoOrientToken);

  useEffect(() => () => overhangGeometry?.dispose(), [overhangGeometry]);

  useEffect(() => {
    onManufacturingSpecs(specs);
  }, [onManufacturingSpecs, specs]);

  useEffect(() => {
    if (autoOrientToken === processedAutoOrientToken.current) return;
    processedAutoOrientToken.current = autoOrientToken;

    const currentSupportArea = evaluateOrientation(geom, orientation).overhangArea;
    let bestOrientation = ORIENTATION_CANDIDATES[0];
    let bestMetrics = evaluateOrientation(geom, bestOrientation);
    for (const candidate of ORIENTATION_CANDIDATES.slice(1)) {
      const metrics = evaluateOrientation(geom, candidate);
      const tolerance = Math.max(1e-6, bestMetrics.overhangArea * 1e-6);
      if (metrics.overhangArea < bestMetrics.overhangArea - tolerance ||
        (Math.abs(metrics.overhangArea - bestMetrics.overhangArea) <= tolerance && metrics.bedContactArea > bestMetrics.bedContactArea)) {
        bestOrientation = candidate;
        bestMetrics = metrics;
      }
    }

    const supportReduction = currentSupportArea > 0
      ? Math.max(0, Math.round((currentSupportArea - bestMetrics.overhangArea) / currentSupportArea * 100))
      : 0;
    onOrientationOptimized(bestOrientation, supportReduction);
  }, [autoOrientToken, geom, onOrientationOptimized, orientation]);

  const handlePointerMove = (event: ThreeEvent<PointerEvent>) => {
    if (!isMeasureMode) return;
    event.stopPropagation();
    const hit = event.intersections[0];
    if (hit) setHoverPoint(getMeasurementPoint(hit));
  };

  const handlePointClick = (event: ThreeEvent<MouseEvent>) => {
    if (!isMeasureMode || event.button !== 0) return;
    event.stopPropagation();
    const hit = event.intersections[0];
    if (hit) {
      const point = getMeasurementPoint(hit);
      setMeasurePoints(points => points.length === 2 ? [point] : [...points, point]);
    }
  };

  return (
    <group scale={parametricScale}>
      <mesh
        ref={attachMeshRef}
        geometry={overhangGeometry ?? geom}
        castShadow
        receiveShadow
        onPointerMove={isMeasureMode ? handlePointerMove : undefined}
        onPointerDown={event => {
          event.stopPropagation();
          if (!isMeasureMode && event.button === 0) onSelectObject('compiled-model');
        }}
        onClick={event => {
          event.stopPropagation();
          if (isMeasureMode) handlePointClick(event);
        }}
      >
          {/* Lightened the material to a bright aluminum so it pops against the dark grid */}
          <meshStandardMaterial color={showOverhangs ? '#ffffff' : wireframe ? '#00ffcc' : '#cccccc'} vertexColors={showOverhangs} wireframe={wireframe} roughness={0.4} metalness={0.3} side={THREE.DoubleSide} clippingPlanes={[clipPlane]} />
      </mesh>
      {meshObject && !isMeasureMode && (
        <TransformControls
          object={meshObject}
          mode={gizmoMode}
          translationSnap={snapDistance}
          onMouseDown={() => onTransformDragging(true)}
          onMouseUp={() => onTransformDragging(false)}
        />
      )}
    </group>
  );
}

export default function STLViewer({ url, sceneObjects, pendingPasteObject, selectedObjectIds, snapDistance, onSelectObject, onObjectContextMenu, onSelectObjects, onObjectDragStart, onObjectDragEnd, onPlacePendingObject, onTransformObject, gizmoMode, isMeasureMode, measurePoints, hoverPoint, setMeasurePoints, setHoverPoint, wireframe, showOverhangs, cameraResetToken, autoOrientToken, parametricValues, compiledParamValues, onManufacturingSpecs }: STLViewerProps) {
  const controlsRef = useRef<OrbitControlsImpl>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const canvasElementRef = useRef<HTMLCanvasElement | null>(null);
  const marqueePointerIdRef = useRef<number | null>(null);
  const [orbitEnabled, setOrbitEnabled] = useState(true);
  const [marquee, setMarquee] = useState({ startX: 0, startY: 0, currentX: 0, currentY: 0, active: false });
  const [isTransformDragging, setIsTransformDragging] = useState(false);
  const [isDraggingObject, setIsDraggingObject] = useState(false);
  const [hoveredObjectId, setHoveredObjectId] = useState<string | null>(null);
  const draggingObjectIdRef = useRef<string | null>(null);
  const meshRefs = useRef<Record<string, THREE.Object3D>>({});
  const ghostMeshRef = useRef<THREE.Mesh>(null);
  const dragOffsetRef = useRef(new THREE.Vector3());
  const [clipValue, setClipValue] = useState(100);
  const [isSectionOpen, setIsSectionOpen] = useState(false);
  const [isSpecsOpen, setIsSpecsOpen] = useState(true);
  const [orientation, setOrientation] = useState<Orientation>([0, 0, 0]);
  const [orientationToast, setOrientationToast] = useState<string | null>(null);
  const orientationToastTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clipPlane = useMemo(() => new THREE.Plane(new THREE.Vector3(0, 0, -1), clipValue), [clipValue]);
  const dragPlane = useMemo(() => new THREE.Plane(new THREE.Vector3(0, 0, 1), 0), []);
  const [specs, setSpecs] = useState<{ url: string | null } & ManufacturingSpecs | null>(null);
  const handleTransformDragging = useCallback((dragging: boolean) => {
    setIsTransformDragging(dragging);
    setOrbitEnabled(!dragging);
  }, []);
  const volume = specs?.url === url ? specs.volume_cm3 : null;
  const weight = specs?.url === url ? specs.weight_pla_grams : null;
  const cost = specs?.url === url ? specs.estimated_cost_usd : null;
  const registerMeshRef = useCallback((id: string, mesh: THREE.Object3D | null) => {
    if (mesh) meshRefs.current[id] = mesh;
    else delete meshRefs.current[id];
  }, []);
  const measurementDistance = measurePoints.length === 2 ? measurePoints[0].distanceTo(measurePoints[1]) : null;
  const measurementMidpoint = measurementDistance === null
    ? null
    : measurePoints[0].clone().add(measurePoints[1]).multiplyScalar(0.5);

  const handleManufacturingSpecs = useCallback((modelSpecs: ManufacturingSpecs) => {
    setSpecs({ url, ...modelSpecs });
    onManufacturingSpecs(modelSpecs);
  }, [onManufacturingSpecs, url]);

  const handleOrientationOptimized = useCallback((nextOrientation: Orientation, supportReduction: number) => {
    setOrientation(nextOrientation);
    setOrientationToast(`Oriented for minimum supports (-${supportReduction}% support material)`);
    if (orientationToastTimeout.current) clearTimeout(orientationToastTimeout.current);
    orientationToastTimeout.current = setTimeout(() => setOrientationToast(null), 2800);
  }, []);

  useEffect(() => () => {
    if (orientationToastTimeout.current) clearTimeout(orientationToastTimeout.current);
  }, []);

  const finishObjectDrag = useCallback(() => {
    const draggingId = draggingObjectIdRef.current;
    if (!draggingId) return;
    draggingObjectIdRef.current = null;
    const mesh = meshRefs.current[draggingId];
    const object = sceneObjects.find(candidate => candidate.id === draggingId);
    const position: [number, number, number] = mesh
      ? [mesh.position.x, mesh.position.y, mesh.position.z]
      : object?.position ?? [0, 0, 0];
    setIsDraggingObject(false);
    delete document.body.dataset.rockyCadDragging;
    document.body.style.cursor = 'default';
    onObjectDragEnd(draggingId, position);
  }, [onObjectDragEnd, sceneObjects]);

  useEffect(() => {
    const handlePointerRelease = () => finishObjectDrag();
    window.addEventListener('pointerup', handlePointerRelease);
    window.addEventListener('pointercancel', handlePointerRelease);
    return () => {
      window.removeEventListener('pointerup', handlePointerRelease);
      window.removeEventListener('pointercancel', handlePointerRelease);
    };
  }, [finishObjectDrag]);

  const handleFloorPointerMove = (event: ThreeEvent<PointerEvent>) => {
    const currentHitPoint = new THREE.Vector3();
    if (!event.ray.intersectPlane(dragPlane, currentHitPoint)) return;
    if (pendingPasteObject) {
      const ghostMesh = ghostMeshRef.current;
      if (ghostMesh) {
        ghostMesh.position.set(
          THREE.MathUtils.clamp(currentHitPoint.x, -150, 150),
          THREE.MathUtils.clamp(currentHitPoint.y, -150, 150),
          0,
        );
      }
      return;
    }

    const draggingId = draggingObjectIdRef.current;
    if (!draggingId || event.buttons !== 1) return;
    const object = sceneObjects.find(candidate => candidate.id === draggingId);
    if (!object) return;

    const newPos = currentHitPoint.clone().add(dragOffsetRef.current);
    newPos.z = object.position[2];
    newPos.x = THREE.MathUtils.clamp(newPos.x, -150, 150);
    newPos.y = THREE.MathUtils.clamp(newPos.y, -150, 150);
    if (snapDistance !== null) {
      newPos.x = THREE.MathUtils.clamp(Math.round(newPos.x / snapDistance) * snapDistance, -150, 150);
      newPos.y = THREE.MathUtils.clamp(Math.round(newPos.y / snapDistance) * snapDistance, -150, 150);
    }
    meshRefs.current[draggingId]?.position.copy(newPos);
  };

  const handleFloorPointerDown = (event: ThreeEvent<PointerEvent>) => {
    if (!pendingPasteObject || event.button !== 0) return;
    event.stopPropagation();
    const intersection = new THREE.Vector3();
    if (!event.ray.intersectPlane(dragPlane, intersection)) return;
    onPlacePendingObject([
      THREE.MathUtils.clamp(intersection.x, -150, 150),
      THREE.MathUtils.clamp(intersection.y, -150, 150),
      0,
    ]);
  };

  const getViewportPoint = (event: ReactPointerEvent<HTMLDivElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    return { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
  };

  const handleMarqueePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || pendingPasteObject || isMeasureMode || isDraggingObject || isTransformDragging) return;
    if (event.target !== canvasElementRef.current) return;
    const point = getViewportPoint(event);
    const camera = cameraRef.current;
    const viewport = viewportRef.current;
    if (!camera || !viewport) return;
    const bounds = viewport.getBoundingClientRect();
    const pointer = new THREE.Vector2(
      (point.x / bounds.width) * 2 - 1,
      -(point.y / bounds.height) * 2 + 1,
    );
    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(pointer, camera);
    if (raycaster.intersectObjects(Object.values(meshRefs.current), true).length > 0) return;
    marqueePointerIdRef.current = event.pointerId;
    event.currentTarget.setPointerCapture(event.pointerId);
    setMarquee({ startX: point.x, startY: point.y, currentX: point.x, currentY: point.y, active: true });
  };

  const handleMarqueePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!marquee.active || marqueePointerIdRef.current !== event.pointerId) return;
    const point = getViewportPoint(event);
    setMarquee(current => ({ ...current, currentX: point.x, currentY: point.y }));
  };

  const handleMarqueePointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!marquee.active || marqueePointerIdRef.current !== event.pointerId) return;
    const point = getViewportPoint(event);
    const dragDistance = Math.abs(point.x - marquee.startX) + Math.abs(point.y - marquee.startY);
    const left = Math.min(marquee.startX, point.x);
    const right = Math.max(marquee.startX, point.x);
    const top = Math.min(marquee.startY, point.y);
    const bottom = Math.max(marquee.startY, point.y);
    const camera = cameraRef.current;
    const viewport = viewportRef.current;

    if (camera && viewport && dragDistance >= 5) {
      camera.updateMatrixWorld();
      const bounds = viewport.getBoundingClientRect();
      const selectedIds = sceneObjects.filter(object => {
        const projected = new THREE.Vector3(...object.position).project(camera);
        if (projected.z < -1 || projected.z > 1) return false;
        const screenX = (projected.x + 1) * bounds.width / 2;
        const screenY = (1 - projected.y) * bounds.height / 2;
        return screenX >= left && screenX <= right && screenY >= top && screenY <= bottom;
      }).map(object => object.id);
      if (selectedIds.length > 0) onSelectObjects(selectedIds);
    }

    marqueePointerIdRef.current = null;
    setMarquee(current => ({ ...current, active: false }));
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const handleMarqueePointerCancel = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (marqueePointerIdRef.current !== event.pointerId) return;
    marqueePointerIdRef.current = null;
    setMarquee(current => ({ ...current, active: false }));
  };

  useEffect(() => {
    if (cameraResetToken > 0) controlsRef.current?.reset();
  }, [cameraResetToken]);

  useEffect(() => {
    const handleShortcut = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        const pointerId = marqueePointerIdRef.current;
        if (pointerId !== null && viewportRef.current?.hasPointerCapture(pointerId)) {
          viewportRef.current.releasePointerCapture(pointerId);
        }
        marqueePointerIdRef.current = null;
        setMarquee(current => ({ ...current, active: false }));
        setIsTransformDragging(() => false);
      }
    };

    window.addEventListener('keydown', handleShortcut);
    return () => window.removeEventListener('keydown', handleShortcut);
  }, []);

  return (
    <div
      ref={viewportRef}
      onContextMenu={event => event.preventDefault()}
      className={`w-full h-full overflow-hidden relative ${marquee.active ? 'cursor-crosshair' : isDraggingObject ? 'cursor-grabbing' : hoveredObjectId ? 'cursor-pointer' : 'cursor-default'}`}
    >
      <Canvas
        shadows
        onContextMenu={event => {
          event.stopPropagation();
          event.nativeEvent.preventDefault();
        }}
        onPointerDown={handleMarqueePointerDown}
        onPointerMove={handleMarqueePointerMove}
        onPointerUp={handleMarqueePointerUp}
        onPointerCancel={handleMarqueePointerCancel}
        onPointerMissed={() => { if (!isDraggingObject) onSelectObject(null); }}
        onCreated={({ gl }) => { gl.localClippingEnabled = true; canvasElementRef.current = gl.domElement; }}
      >
        <PerspectiveCamera ref={cameraRef} makeDefault position={[0, -150, 150]} up={[0, 0, 1]} fov={50} />
        
        {/* 1. Dedicated Studio Background Color */}
        <color attach="background" args={['#f0f4f8']} />
        
        {/* 2. Bounded Tinkercad-style workplane */}
        <mesh position={[0, 0, -0.1]} receiveShadow>
          <planeGeometry args={[500, 500]} />
          <meshBasicMaterial color="#e0f2fe" transparent opacity={0.8} />
        </mesh>
        <gridHelper args={[500, 50, '#444444', '#cccccc']} position={[0, 0, 0]} rotation={[Math.PI / 2, 0, 0]} />
        {isMeasureMode && hoverPoint && (
          <mesh position={hoverPoint} renderOrder={5} raycast={() => {}}>
            <sphereGeometry args={[0.5, 16, 16]} />
            <meshBasicMaterial color="red" depthTest={false} toneMapped={false} />
          </mesh>
        )}
        {isMeasureMode && measurePoints.map((point, index) => (
          <mesh key={index} position={point} renderOrder={5} raycast={() => {}}>
            <sphereGeometry args={[0.65, 16, 16]} />
            <meshBasicMaterial color="blue" depthTest={false} toneMapped={false} />
          </mesh>
        ))}
        {isMeasureMode && measurePoints.length === 1 && hoverPoint && (
          <Line points={[measurePoints[0], hoverPoint]} color="yellow" dashed />
        )}
        {isMeasureMode && measurePoints.length === 2 && measurementMidpoint && measurementDistance !== null && (
          <>
            <Line points={[measurePoints[0], measurePoints[1]]} color="cyan" lineWidth={3} />
            <Html center position={measurementMidpoint} style={{ pointerEvents: 'none', background: 'rgba(0,0,0,0.8)', color: '#00ffff', padding: '2px 6px', borderRadius: '4px', fontSize: '12px', whiteSpace: 'nowrap' }}>
              <div className="whitespace-nowrap rounded-md border border-cyan-400/40 bg-[#071014]/95 px-3 py-1.5 font-mono text-xs font-semibold text-cyan-100 shadow-lg backdrop-blur">
                {measurementDistance.toFixed(2)} mm
              </div>
            </Html>
          </>
        )}
        {(isDraggingObject || pendingPasteObject) && (
          <mesh
            position={[0, 0, 0.001]}
            onPointerMove={handleFloorPointerMove}
            onPointerDown={handleFloorPointerDown}
            onPointerUp={finishObjectDrag}
            onPointerCancel={finishObjectDrag}
          >
            <planeGeometry args={[300, 300]} />
            <meshBasicMaterial transparent opacity={0} colorWrite={false} depthWrite={false} side={THREE.DoubleSide} />
          </mesh>
        )}

        {/* 3. Studio Lighting */}
        <ambientLight intensity={0.6} />
        <directionalLight position={[20, 30, 20]} intensity={1.5} castShadow />
        
        <Suspense fallback={null}>
          {url && sceneObjects.length === 0 && (
            <group>
              <group rotation={orientation}>
                  <STLModel
                    key={url}
                    url={url}
                    wireframe={wireframe}
                    showOverhangs={showOverhangs}
                    clipPlane={clipPlane}
                    orientation={orientation}
                    autoOrientToken={autoOrientToken}
                    parametricValues={parametricValues}
                    compiledParamValues={compiledParamValues}
                    gizmoMode={gizmoMode}
                    snapDistance={snapDistance}
                    onSelectObject={onSelectObject}
                    onMeshRef={registerMeshRef}
                    isMeasureMode={isMeasureMode}
                    setMeasurePoints={setMeasurePoints}
                    setHoverPoint={setHoverPoint}
                    onTransformDragging={handleTransformDragging}
                    onManufacturingSpecs={handleManufacturingSpecs}
                    onOrientationOptimized={handleOrientationOptimized}
                  />
              </group>
            </group>
          )}
          {sceneObjects.map(object => {
            const isSelected = selectedObjectIds.length === 1 && selectedObjectIds[0] === object.id;
            const sharedProps = {
              object,
              selected: selectedObjectIds.includes(object.id),
              transformTarget: isSelected,
              gizmoMode,
              snapDistance,
              isMeasureMode,
              setMeasurePoints,
              setHoverPoint,
              onSelect: onSelectObject,
              onObjectContextMenu,
              onHover: setHoveredObjectId,
              dragPlane,
              onMeshRef: registerMeshRef,
              onObjectDragStart: (id: string, offset: [number, number, number]) => {
                dragOffsetRef.current.fromArray(offset);
                draggingObjectIdRef.current = id;
                setIsDraggingObject(true);
                onObjectDragStart(id);
              },
              onTransformDragging: handleTransformDragging,
              onTransformObject,
            };
            return object.type === 'group'
              ? <SceneGroup key={object.id} {...sharedProps} />
              : <ScenePrimitive key={object.id} {...sharedProps} />;
          })}
          {pendingPasteObject && (
            <mesh
              ref={ghostMeshRef}
              position={pendingPasteObject.position}
              rotation={pendingPasteObject.rotation}
              scale={pendingPasteObject.scale}
              raycast={() => {}}
            >
              <SceneGeometry object={pendingPasteObject} />
              <meshStandardMaterial color="#4f9cff" transparent opacity={0.45} depthWrite={false} />
            </mesh>
          )}
          <Environment preset="city" />
        </Suspense>
        
        <OrbitControls
          ref={controlsRef}
          makeDefault
          enableRotate={!isMeasureMode}
          enabled={orbitEnabled && !isTransformDragging && !isDraggingObject}
          minDistance={10}
          maxDistance={400}
          maxPolarAngle={Math.PI / 2 + 0.1}
          mouseButtons={{
            LEFT: undefined,
            MIDDLE: THREE.MOUSE.PAN,
            RIGHT: THREE.MOUSE.ROTATE,
          }}
        />
        <GizmoHelper alignment="bottom-right" margin={[60, 60]}>
          <GizmoViewport />
        </GizmoHelper>
      </Canvas>
      {marquee.active && (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute z-10 bg-blue-500/20 border border-blue-500"
          style={{
            left: Math.min(marquee.startX, marquee.currentX),
            top: Math.min(marquee.startY, marquee.currentY),
            width: Math.abs(marquee.currentX - marquee.startX),
            height: Math.abs(marquee.currentY - marquee.startY),
          }}
        />
      )}

      <div className="absolute top-3 left-3 text-[10px] font-bold tracking-widest text-[#aaaaaa] bg-[#000000]/60 px-2 py-1 rounded backdrop-blur border border-[#333333]">
        STUDIO SPACE (X: Red, Y: Green, Z: Blue)
      </div>
      {orientationToast && (
        <div role="status" className="absolute top-14 left-1/2 z-20 -translate-x-1/2 rounded-lg border border-[#333333] bg-[#111111]/90 px-3 py-2 text-xs text-[#cccccc] shadow-lg backdrop-blur">
          {orientationToast}
        </div>
      )}
      {url && sceneObjects.length === 0 && <>
      <div className="absolute bottom-14 left-4 z-10 w-48 rounded-xl border border-[#333333] bg-[#111111]/80 shadow-xl backdrop-blur-md transition-all duration-200">
        <button type="button" onClick={() => setIsSectionOpen(open => !open)} aria-expanded={isSectionOpen} className="flex w-full cursor-pointer items-center justify-between gap-3 rounded-xl p-2 text-left hover:bg-[#222222]">
          <span className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wide text-[#888888]"><Layers className="h-4 w-4" />Z-Axis Cross Section</span>
          {isSectionOpen ? <ChevronDown className="h-4 w-4 text-[#888888]" /> : <ChevronUp className="h-4 w-4 text-[#888888]" />}
        </button>
        <div className={`grid transition-[grid-template-rows,opacity] duration-200 ${isSectionOpen ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0'}`}>
          <div className="overflow-hidden px-3">
            <div className="pb-3">
              <input
                id="cross-section-slider"
                type="range"
                min={-100}
                max={100}
                value={clipValue}
                onChange={event => setClipValue(Number(event.target.value))}
                aria-label="Z-Axis Cross Section"
                className="w-full cursor-pointer accent-[#00ffcc]"
              />
              <div className="mt-1 text-right text-[10px] text-[#888888]">{clipValue} mm</div>
            </div>
          </div>
        </div>
      </div>
      <div className="absolute bottom-28 right-4 z-10 w-56 rounded-xl border border-[#333333] bg-[#111111]/80 shadow-xl backdrop-blur-md transition-all duration-200">
        <button type="button" onClick={() => setIsSpecsOpen(open => !open)} aria-expanded={isSpecsOpen} className="flex w-full cursor-pointer items-center justify-between gap-3 rounded-xl p-2 text-left hover:bg-[#222222]">
          <span className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wide text-[#888888]"><Scale className="h-4 w-4" />Manufacturing Specs</span>
          {isSpecsOpen ? <ChevronDown className="h-4 w-4 text-[#888888]" /> : <ChevronUp className="h-4 w-4 text-[#888888]" />}
        </button>
        <div className={`grid transition-[grid-template-rows,opacity] duration-200 ${isSpecsOpen ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0'}`}>
          <div className="overflow-hidden px-3">
            <div className="space-y-1 pb-3 text-xs text-[#cccccc]">
              <div>Volume: {volume === null ? '--' : `${volume.toFixed(2)} cm³`}</div>
              <div>Est. Weight (PLA): {weight === null ? '--' : `${weight.toFixed(2)} g`}</div>
              <div>Material Cost: {cost === null ? '--' : `$${cost.toFixed(3)}`}</div>
            </div>
          </div>
        </div>
      </div>
      </>}
    </div>
  );
}