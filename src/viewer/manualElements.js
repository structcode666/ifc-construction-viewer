import * as THREE from "three";
import { TransformControls } from "three/examples/jsm/controls/TransformControls.js";

const DEFAULT_CONCRETE_COLOR = "#9ca3af";
const SELECTED_CONCRETE_COLOR = "#d1d5db";
const MIN_FOOTPRINT_SIZE = 0.1;
const MIN_POINTER_DRAG_PX = 6;

export function createManualElementManager({
  world,
  container,
  getDefaultHeight = () => 3,
  onSelectionChanged = () => {},
  onElementChanged = () => {},
  onStatus = () => {},
}) {
  const group = new THREE.Group();
  group.name = "Manual concrete elements";
  world.scene.three.add(group);

  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  const groundPoint = new THREE.Vector3();
  const drawMaterial = new THREE.MeshBasicMaterial({
    color: "#60a5fa",
    transparent: true,
    opacity: 0.24,
    depthWrite: false,
  });
  const previewEdgesMaterial = new THREE.LineBasicMaterial({
    color: "#bfdbfe",
    transparent: true,
    opacity: 0.95,
  });
  const concreteTexture = createConcreteTexture();
  const concreteBumpTexture = concreteTexture.clone();
  concreteBumpTexture.needsUpdate = true;

  const concreteMaterial = new THREE.MeshStandardMaterial({
    color: DEFAULT_CONCRETE_COLOR,
    map: concreteTexture,
    bumpMap: concreteBumpTexture,
    bumpScale: 0.045,
    roughness: 0.92,
    metalness: 0,
  });
  const selectedMaterial = concreteMaterial.clone();
  selectedMaterial.color = new THREE.Color(SELECTED_CONCRETE_COLOR);
  selectedMaterial.emissive = new THREE.Color("#111827");
  selectedMaterial.emissiveIntensity = 0.08;

  const elements = new Map();
  const selectedIds = new Set();
  let drawEnabled = false;
  let drawing = null;
  let pointerDown = null;

  const transformControls = new TransformControls(
    world.camera.three,
    world.renderer.three.domElement
  );
  transformControls.name = "Manual concrete move controls";
  transformControls.setMode("translate");
  transformControls.setSpace("world");
  transformControls.size = 0.85;
  transformControls.visible = false;
  world.scene.three.add(transformControls);

  transformControls.addEventListener("dragging-changed", (event) => {
    world.camera.setUserInput(!event.value);

    if (!event.value) {
      syncSelectedElementFromMesh();
      onElementChanged();
      requestRender();
    }
  });

  transformControls.addEventListener("objectChange", () => {
    syncSelectedElementFromMesh();
    requestRender();
  });

  function requestRender() {
    world.renderer.three.render(world.scene.three, world.camera.three);
  }

  function createConcreteTexture(size = 256) {
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const context = canvas.getContext("2d");
    const image = context.createImageData(size, size);

    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const index = (y * size + x) * 4;
        const grain =
          146 +
          Math.random() * 34 +
          Math.sin(x * 0.18) * 5 +
          Math.cos(y * 0.12) * 5;
        const speckle = Math.random() > 0.985 ? -46 : 0;
        const value = Math.max(95, Math.min(190, grain + speckle));

        image.data[index] = value;
        image.data[index + 1] = value;
        image.data[index + 2] = value;
        image.data[index + 3] = 255;
      }
    }

    context.putImageData(image, 0, 0);

    const texture = new THREE.CanvasTexture(canvas);
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    texture.repeat.set(1.8, 1.8);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.needsUpdate = true;

    return texture;
  }

  function getGroundPoint(event, target = groundPoint) {
    const rect = container.getBoundingClientRect();
    pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(pointer, world.camera.three);

    return raycaster.ray.intersectPlane(groundPlane, target);
  }

  function getPointerDistance(event) {
    if (!pointerDown) return 0;

    const dx = event.clientX - pointerDown.clientX;
    const dy = event.clientY - pointerDown.clientY;

    return Math.sqrt(dx * dx + dy * dy);
  }

  function createPreviewMesh(start, end, height) {
    const { center, size } = getBoxFromFootprint(start, end, height);
    const geometry = new THREE.BoxGeometry(size.x, size.y, size.z);
    const mesh = new THREE.Mesh(geometry, drawMaterial);
    const edges = new THREE.LineSegments(
      new THREE.EdgesGeometry(geometry),
      previewEdgesMaterial
    );

    mesh.name = "Concrete footprint preview";
    mesh.position.copy(center);
    mesh.add(edges);

    return mesh;
  }

  function updatePreviewMesh() {
    if (!drawing?.preview) return;

    const height = getElementHeight();
    const { center, size } = getBoxFromFootprint(
      drawing.start,
      drawing.current,
      height
    );

    drawing.preview.geometry.dispose();
    drawing.preview.geometry = new THREE.BoxGeometry(size.x, size.y, size.z);
    drawing.preview.position.copy(center);

    const edges = drawing.preview.children[0];
    if (edges) {
      edges.geometry.dispose();
      edges.geometry = new THREE.EdgesGeometry(drawing.preview.geometry);
    }

    requestRender();
  }

  function getElementHeight() {
    const value = Number(getDefaultHeight());
    return Number.isFinite(value) && value > 0 ? value : 3;
  }

  function getBoxFromFootprint(start, end, height) {
    const width = Math.max(Math.abs(end.x - start.x), MIN_FOOTPRINT_SIZE);
    const depth = Math.max(Math.abs(end.z - start.z), MIN_FOOTPRINT_SIZE);
    const center = new THREE.Vector3(
      (start.x + end.x) / 2,
      height / 2,
      (start.z + end.z) / 2
    );

    return {
      center,
      size: new THREE.Vector3(width, height, depth),
    };
  }

  function createElementFromFootprint(start, end, height = getElementHeight()) {
    const { center, size } = getBoxFromFootprint(start, end, height);
    const id = `manual-${crypto.randomUUID()}`;
    const geometry = new THREE.BoxGeometry(size.x, size.y, size.z);
    const mesh = new THREE.Mesh(geometry, concreteMaterial.clone());

    mesh.name = `Concrete element ${elements.size + 1}`;
    mesh.position.copy(center);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.userData.manualElementId = id;

    const edges = new THREE.LineSegments(
      new THREE.EdgesGeometry(geometry),
      new THREE.LineBasicMaterial({
        color: "#6b7280",
        transparent: true,
        opacity: 0.28,
      })
    );
    mesh.add(edges);

    group.add(mesh);

    const element = {
      id,
      type: "box",
      name: mesh.name,
      position: vectorToPlain(center),
      size: vectorToPlain(size),
      color: DEFAULT_CONCRETE_COLOR,
      mesh,
    };

    elements.set(id, element);
    selectIds([id]);
    onElementChanged();
    requestRender();

    return element;
  }

  function restoreElement(data) {
    if (!data?.id || data.type !== "box") return null;

    const size = plainToVector(data.size, new THREE.Vector3(1, 1, 1));
    const position = plainToVector(
      data.position,
      new THREE.Vector3(0, size.y / 2, 0)
    );
    const geometry = new THREE.BoxGeometry(
      Math.max(size.x, MIN_FOOTPRINT_SIZE),
      Math.max(size.y, MIN_FOOTPRINT_SIZE),
      Math.max(size.z, MIN_FOOTPRINT_SIZE)
    );
    const mesh = new THREE.Mesh(geometry, concreteMaterial.clone());

    mesh.name = data.name || `Concrete element ${elements.size + 1}`;
    mesh.position.copy(position);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.userData.manualElementId = data.id;

    const edges = new THREE.LineSegments(
      new THREE.EdgesGeometry(geometry),
      new THREE.LineBasicMaterial({
        color: "#6b7280",
        transparent: true,
        opacity: 0.28,
      })
    );
    mesh.add(edges);
    group.add(mesh);

    const element = {
      id: data.id,
      type: "box",
      name: mesh.name,
      position: vectorToPlain(position),
      size: vectorToPlain(size),
      color: data.color || DEFAULT_CONCRETE_COLOR,
      mesh,
    };

    elements.set(element.id, element);
    return element;
  }

  function syncSelectedElementFromMesh() {
    for (const id of selectedIds) {
      const element = elements.get(id);
      if (!element) continue;

      element.position = vectorToPlain(element.mesh.position);
    }
  }

  function selectIds(ids) {
    clearMaterialSelection();
    selectedIds.clear();

    for (const id of ids) {
      const element = elements.get(id);
      if (!element) continue;

      selectedIds.add(id);
      element.mesh.material = selectedMaterial.clone();
    }

    const [firstSelectedId] = selectedIds;
    const firstSelected = firstSelectedId ? elements.get(firstSelectedId) : null;

    if (firstSelected) {
      transformControls.attach(firstSelected.mesh);
      transformControls.visible = true;
    } else {
      transformControls.detach();
      transformControls.visible = false;
    }

    onSelectionChanged(getSelectedIds());
    requestRender();
  }

  function clearMaterialSelection() {
    for (const id of selectedIds) {
      const element = elements.get(id);
      if (!element) continue;
      element.mesh.material = concreteMaterial.clone();
    }
  }

  function clearSelection() {
    selectIds([]);
  }

  function pickElement(event) {
    const rect = container.getBoundingClientRect();
    pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(pointer, world.camera.three);

    const hits = raycaster.intersectObjects(
      [...elements.values()].map((element) => element.mesh),
      false
    );

    return hits[0]?.object?.userData?.manualElementId ?? null;
  }

  function removePreview() {
    if (!drawing?.preview) return;

    group.remove(drawing.preview);
    drawing.preview.traverse((object) => {
      object.geometry?.dispose?.();
    });
  }

  function deleteSelected() {
    const ids = getSelectedIds();

    for (const id of ids) {
      const element = elements.get(id);
      if (!element) continue;

      group.remove(element.mesh);
      element.mesh.traverse((object) => {
        object.geometry?.dispose?.();
        object.material?.dispose?.();
      });
      elements.delete(id);
    }

    clearSelection();
    onElementChanged();
    requestRender();

    return ids.length;
  }

  function setVisibleIds(ids) {
    const visibleIds = new Set(ids ?? []);

    for (const element of elements.values()) {
      element.mesh.visible = visibleIds.has(element.id);
    }

    transformControls.visible =
      selectedIds.size > 0 &&
      [...selectedIds].some((id) => elements.get(id)?.mesh.visible);
    requestRender();
  }

  function showAll() {
    for (const element of elements.values()) {
      element.mesh.visible = true;
      setElementOpacity(element, 1);
    }

    transformControls.visible = selectedIds.size > 0;
    requestRender();
  }

  function setElementOpacity(element, opacity) {
    element.mesh.material.transparent = opacity < 1;
    element.mesh.material.opacity = opacity;
    element.mesh.material.depthWrite = opacity >= 1;
  }

  function showWithContext(foregroundIds, contextIds, contextOpacity = 0.18) {
    const foreground = new Set(foregroundIds ?? []);
    const context = new Set(contextIds ?? []);

    for (const element of elements.values()) {
      const isForeground = foreground.has(element.id);
      const isContext = context.has(element.id);
      element.mesh.visible = isForeground || isContext;
      setElementOpacity(element, isForeground ? 1 : contextOpacity);
    }

    transformControls.visible =
      selectedIds.size > 0 &&
      [...selectedIds].some((id) => elements.get(id)?.mesh.visible);
    requestRender();
  }

  function serialize() {
    return [...elements.values()].map((element) => ({
      id: element.id,
      type: element.type,
      name: element.name,
      position: element.position,
      size: element.size,
      color: element.color,
    }));
  }

  function restore(serializedElements) {
    clear();

    for (const data of serializedElements ?? []) {
      restoreElement(data);
    }

    onElementChanged();
    requestRender();
  }

  function clear() {
    transformControls.detach();
    transformControls.visible = false;
    selectedIds.clear();

    for (const element of elements.values()) {
      group.remove(element.mesh);
      element.mesh.traverse((object) => {
        object.geometry?.dispose?.();
        object.material?.dispose?.();
      });
    }

    elements.clear();
    onSelectionChanged([]);
    onElementChanged();
    requestRender();
  }

  function getAllIds() {
    return [...elements.keys()];
  }

  function getSelectedIds() {
    return [...selectedIds];
  }

  function hasSelection() {
    return selectedIds.size > 0;
  }

  function setDrawEnabled(enabled) {
    drawEnabled = Boolean(enabled);

    if (!drawEnabled && drawing) {
      removePreview();
      drawing = null;
      world.camera.setUserInput(true);
    }

    container.classList.toggle("is-drawing-concrete", drawEnabled);
  }

  function isPointerInteractionActive() {
    return drawEnabled || Boolean(drawing) || transformControls.dragging;
  }

  function onPointerDown(event) {
    if (event.button !== 0) return;

    pointerDown = {
      clientX: event.clientX,
      clientY: event.clientY,
    };

    if (!drawEnabled) return;

    const start = getGroundPoint(event, new THREE.Vector3());
    if (!start) return;

    drawing = {
      pointerId: event.pointerId,
      start: start.clone(),
      current: start.clone(),
      preview: createPreviewMesh(start, start, getElementHeight()),
    };

    group.add(drawing.preview);
    container.setPointerCapture(event.pointerId);
    world.camera.setUserInput(false);
    event.preventDefault();
    event.stopImmediatePropagation();
  }

  function onPointerMove(event) {
    if (!drawing || event.pointerId !== drawing.pointerId) return;

    const current = getGroundPoint(event, new THREE.Vector3());
    if (!current) return;

    drawing.current.copy(current);
    updatePreviewMesh();
    event.preventDefault();
    event.stopImmediatePropagation();
  }

  function finishDrawing(event) {
    const finishedDrawing = drawing;

    removePreview();
    drawing = null;
    world.camera.setUserInput(true);

    if (container.hasPointerCapture(event.pointerId)) {
      container.releasePointerCapture(event.pointerId);
    }

    if (getPointerDistance(event) >= MIN_POINTER_DRAG_PX) {
      createElementFromFootprint(
        finishedDrawing.start,
        finishedDrawing.current,
        getElementHeight()
      );
      onStatus("Concrete element created. Use the arrows to move it.");
    } else {
      onStatus("Drag a footprint to create a concrete element.");
    }

    event.preventDefault();
    event.stopImmediatePropagation();
  }

  function onPointerUp(event) {
    if (drawing && event.pointerId === drawing.pointerId) {
      finishDrawing(event);
      pointerDown = null;
      return;
    }

    if (drawEnabled) {
      pointerDown = null;
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }

    if (getPointerDistance(event) > MIN_POINTER_DRAG_PX) {
      pointerDown = null;
      return;
    }

    const pickedId = pickElement(event);
    pointerDown = null;

    if (!pickedId) return;

    selectIds([pickedId]);
    onStatus("Concrete element selected. Use the arrows to move it.");
    event.preventDefault();
    event.stopImmediatePropagation();
  }

  function onPointerCancel(event) {
    if (!drawing || event.pointerId !== drawing.pointerId) return;

    removePreview();
    drawing = null;
    world.camera.setUserInput(true);
    pointerDown = null;
  }

  container.addEventListener("pointerdown", onPointerDown, true);
  container.addEventListener("pointermove", onPointerMove, true);
  container.addEventListener("pointerup", onPointerUp, true);
  container.addEventListener("pointercancel", onPointerCancel, true);

  return {
    setDrawEnabled,
    isDrawEnabled: () => drawEnabled,
    isPointerInteractionActive,
    clearSelection,
    deleteSelected,
    getSelectedIds,
    hasSelection,
    getAllIds,
    showAll,
    setVisibleIds,
    showWithContext,
    serialize,
    restore,
    clear,
  };
}

function vectorToPlain(vector) {
  return {
    x: vector.x,
    y: vector.y,
    z: vector.z,
  };
}

function plainToVector(value, fallback) {
  if (!value) return fallback.clone();

  return new THREE.Vector3(
    Number.isFinite(Number(value.x)) ? Number(value.x) : fallback.x,
    Number.isFinite(Number(value.y)) ? Number(value.y) : fallback.y,
    Number.isFinite(Number(value.z)) ? Number(value.z) : fallback.z
  );
}
