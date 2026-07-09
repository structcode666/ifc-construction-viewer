import * as THREE from "three";

const DEFAULT_CONCRETE_COLOR = "#9ca3af";
const SELECTED_CONCRETE_COLOR = "#d1d5db";
const CONCRETE_OPACITY = 0.36;
const MIN_FOOTPRINT_SIZE = 0.1;
const MIN_POINTER_DRAG_PX = 6;
const HANDLE_SIZE = 0.32;

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
  selectedMaterial.transparent = true;
  selectedMaterial.opacity = Math.min(CONCRETE_OPACITY + 0.16, 0.72);
  selectedMaterial.depthWrite = false;

  const elements = new Map();
  const selectedIds = new Set();
  const resizeHandles = [];
  let drawEnabled = false;
  let drawing = null;
  let pointerDown = null;
  let moving = null;
  let resizing = null;

  createResizeHandles();

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
    const mesh = new THREE.Mesh(geometry, createConcreteMaterial());

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
    const mesh = new THREE.Mesh(geometry, createConcreteMaterial());

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

  function createConcreteMaterial() {
    const material = concreteMaterial.clone();
    material.transparent = true;
    material.opacity = CONCRETE_OPACITY;
    material.depthWrite = false;

    return material;
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
      setElementOpacity(element, Math.min(CONCRETE_OPACITY + 0.16, 0.72));
    }

    const [firstSelectedId] = selectedIds;
    const firstSelected = firstSelectedId ? elements.get(firstSelectedId) : null;

    updateResizeHandles(firstSelected);

    onSelectionChanged(getSelectedIds());
    requestRender();
  }

  function clearMaterialSelection() {
    for (const id of selectedIds) {
      const element = elements.get(id);
      if (!element) continue;
      element.mesh.material = createConcreteMaterial();
    }
  }

  function clearSelection() {
    selectIds([]);
  }

  function setPointerFromEvent(event) {
    const rect = container.getBoundingClientRect();
    pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(pointer, world.camera.three);
  }

  function pickResizeHandle(event) {
    setPointerFromEvent(event);

    const hits = raycaster.intersectObjects(resizeHandles, false);

    return hits[0]?.object ?? null;
  }

  function pickElement(event) {
    setPointerFromEvent(event);

    const hits = raycaster.intersectObjects(
      [...elements.values()].map((element) => element.mesh),
      false
    );

    return hits[0]?.object?.userData?.manualElementId ?? null;
  }

  function createResizeHandles() {
    const directions = [
      { axis: "x", sign: 1, direction: new THREE.Vector3(1, 0, 0) },
      { axis: "x", sign: -1, direction: new THREE.Vector3(-1, 0, 0) },
      { axis: "y", sign: 1, direction: new THREE.Vector3(0, 1, 0) },
      { axis: "y", sign: -1, direction: new THREE.Vector3(0, -1, 0) },
      { axis: "z", sign: 1, direction: new THREE.Vector3(0, 0, 1) },
      { axis: "z", sign: -1, direction: new THREE.Vector3(0, 0, -1) },
    ];
    const handleMaterial = new THREE.MeshBasicMaterial({
      color: "#38bdf8",
      transparent: true,
      opacity: 0.95,
      depthTest: false,
    });

    for (const config of directions) {
      const geometry = new THREE.ConeGeometry(
        HANDLE_SIZE * 0.42,
        HANDLE_SIZE,
        16
      );
      const mesh = new THREE.Mesh(geometry, handleMaterial.clone());
      mesh.name = `Concrete resize ${config.axis}${config.sign > 0 ? "+" : "-"}`;
      mesh.userData.resizeHandle = config;
      mesh.quaternion.setFromUnitVectors(
        new THREE.Vector3(0, 1, 0),
        config.direction
      );
      mesh.visible = false;
      resizeHandles.push(mesh);
      group.add(mesh);
    }
  }

  function updateResizeHandles(element) {
    if (!element || !element.mesh.visible) {
      for (const handle of resizeHandles) {
        handle.visible = false;
      }
      return;
    }

    const size = plainToVector(element.size, new THREE.Vector3(1, 1, 1));
    const center = element.mesh.position;
    const positions = {
      "x:1": new THREE.Vector3(
        center.x + size.x / 2 + HANDLE_SIZE * 0.9,
        center.y,
        center.z
      ),
      "x:-1": new THREE.Vector3(
        center.x - size.x / 2 - HANDLE_SIZE * 0.9,
        center.y,
        center.z
      ),
      "y:1": new THREE.Vector3(
        center.x,
        center.y + size.y / 2 + HANDLE_SIZE * 0.9,
        center.z
      ),
      "y:-1": new THREE.Vector3(
        center.x,
        center.y - size.y / 2 - HANDLE_SIZE * 0.9,
        center.z
      ),
      "z:1": new THREE.Vector3(
        center.x,
        center.y,
        center.z + size.z / 2 + HANDLE_SIZE * 0.9
      ),
      "z:-1": new THREE.Vector3(
        center.x,
        center.y,
        center.z - size.z / 2 - HANDLE_SIZE * 0.9
      ),
    };

    for (const handle of resizeHandles) {
      const { axis, sign } = handle.userData.resizeHandle;
      handle.position.copy(positions[`${axis}:${sign}`]);
      handle.visible = true;
    }
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

    updateResizeHandles(getFirstSelectedElement());
    requestRender();
  }

  function showAll() {
    for (const element of elements.values()) {
      element.mesh.visible = true;
      setElementOpacity(element, CONCRETE_OPACITY);
    }

    updateResizeHandles(getFirstSelectedElement());
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
      setElementOpacity(
        element,
        isForeground ? CONCRETE_OPACITY : Math.min(contextOpacity, 0.18)
      );
    }

    updateResizeHandles(getFirstSelectedElement());
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
    selectedIds.clear();
    moving = null;
    resizing = null;

    for (const handle of resizeHandles) {
      handle.visible = false;
    }

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

  function getFirstSelectedElement() {
    const [firstSelectedId] = selectedIds;

    return firstSelectedId ? elements.get(firstSelectedId) ?? null : null;
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
    return drawEnabled || Boolean(drawing) || Boolean(moving) || Boolean(resizing);
  }

  function createAxisDragPlane(axisVector) {
    const cameraDirection = new THREE.Vector3();
    world.camera.three.getWorldDirection(cameraDirection);

    let normal = new THREE.Vector3().crossVectors(axisVector, cameraDirection);

    if (normal.lengthSq() < 0.0001) {
      normal = new THREE.Vector3().crossVectors(
        axisVector,
        world.camera.three.up
      );
    }

    normal.normalize();

    return normal;
  }

  function getPointOnPlane(event, plane, target = new THREE.Vector3()) {
    setPointerFromEvent(event);

    return raycaster.ray.intersectPlane(plane, target);
  }

  function startMoving(event, elementId) {
    const element = elements.get(elementId);
    const point = getGroundPoint(event, new THREE.Vector3());

    if (!element || !point) return false;

    moving = {
      pointerId: event.pointerId,
      element,
      startPoint: point.clone(),
      startPosition: element.mesh.position.clone(),
    };

    container.setPointerCapture(event.pointerId);
    world.camera.setUserInput(false);
    container.classList.add("is-moving-concrete");

    return true;
  }

  function updateMoving(event) {
    if (!moving || event.pointerId !== moving.pointerId) return;

    const point = getGroundPoint(event, new THREE.Vector3());
    if (!point) return;

    const delta = point.clone().sub(moving.startPoint);
    moving.element.mesh.position.set(
      moving.startPosition.x + delta.x,
      moving.startPosition.y,
      moving.startPosition.z + delta.z
    );
    moving.element.position = vectorToPlain(moving.element.mesh.position);
    updateResizeHandles(moving.element);
    requestRender();

    event.preventDefault();
    event.stopImmediatePropagation();
  }

  function finishMoving(event) {
    if (!moving || event.pointerId !== moving.pointerId) return;

    moving.element.position = vectorToPlain(moving.element.mesh.position);
    moving = null;
    world.camera.setUserInput(true);
    container.classList.remove("is-moving-concrete");

    if (container.hasPointerCapture(event.pointerId)) {
      container.releasePointerCapture(event.pointerId);
    }

    onElementChanged();
    requestRender();
    event.preventDefault();
    event.stopImmediatePropagation();
  }

  function startResizing(event, handle) {
    const element = getFirstSelectedElement();

    if (!element) return false;

    const { axis, sign } = handle.userData.resizeHandle;
    const axisVector = new THREE.Vector3(
      axis === "x" ? 1 : 0,
      axis === "y" ? 1 : 0,
      axis === "z" ? 1 : 0
    );
    const planeNormal = createAxisDragPlane(axisVector);
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(
      planeNormal,
      handle.position
    );
    const startPoint = getPointOnPlane(event, plane, new THREE.Vector3());

    if (!startPoint) return false;

    resizing = {
      pointerId: event.pointerId,
      element,
      axis,
      sign,
      axisVector,
      plane,
      startPoint: startPoint.clone(),
      startSize: plainToVector(element.size, new THREE.Vector3(1, 1, 1)),
      startPosition: element.mesh.position.clone(),
    };

    container.setPointerCapture(event.pointerId);
    world.camera.setUserInput(false);
    container.classList.add("is-resizing-concrete");

    return true;
  }

  function updateElementGeometry(element, size) {
    const mesh = element.mesh;
    const nextGeometry = new THREE.BoxGeometry(size.x, size.y, size.z);
    const edges = mesh.children[0];

    mesh.geometry.dispose();
    mesh.geometry = nextGeometry;

    if (edges) {
      edges.geometry.dispose();
      edges.geometry = new THREE.EdgesGeometry(nextGeometry);
    }

    element.size = vectorToPlain(size);
    element.position = vectorToPlain(mesh.position);
  }

  function updateResizing(event) {
    if (!resizing || event.pointerId !== resizing.pointerId) return;

    const point = getPointOnPlane(event, resizing.plane, new THREE.Vector3());
    if (!point) return;

    const delta = point.clone().sub(resizing.startPoint).dot(resizing.axisVector);
    const sizeChange = resizing.sign * delta;
    const nextSize = resizing.startSize.clone();
    nextSize[resizing.axis] = Math.max(
      MIN_FOOTPRINT_SIZE,
      resizing.startSize[resizing.axis] + sizeChange
    );

    const actualChange = nextSize[resizing.axis] - resizing.startSize[resizing.axis];
    const nextPosition = resizing.startPosition.clone();
    nextPosition.add(
      resizing.axisVector
        .clone()
        .multiplyScalar((resizing.sign * actualChange) / 2)
    );

    resizing.element.mesh.position.copy(nextPosition);
    updateElementGeometry(resizing.element, nextSize);
    updateResizeHandles(resizing.element);
    requestRender();

    event.preventDefault();
    event.stopImmediatePropagation();
  }

  function finishResizing(event) {
    if (!resizing || event.pointerId !== resizing.pointerId) return;

    resizing.element.position = vectorToPlain(resizing.element.mesh.position);
    resizing = null;
    world.camera.setUserInput(true);
    container.classList.remove("is-resizing-concrete");

    if (container.hasPointerCapture(event.pointerId)) {
      container.releasePointerCapture(event.pointerId);
    }

    onElementChanged();
    requestRender();
    event.preventDefault();
    event.stopImmediatePropagation();
  }

  function onPointerDown(event) {
    if (event.button !== 0) return;

    pointerDown = {
      clientX: event.clientX,
      clientY: event.clientY,
    };

    if (!drawEnabled) {
      const pickedHandle = pickResizeHandle(event);

      if (pickedHandle && startResizing(event, pickedHandle)) {
        event.preventDefault();
        event.stopImmediatePropagation();
        return;
      }

      const pickedId = pickElement(event);

      if (!pickedId) return;

      selectIds([pickedId]);

      if (startMoving(event, pickedId)) {
        onStatus("Concrete element selected. Drag to move or use arrows to resize.");
        event.preventDefault();
        event.stopImmediatePropagation();
      }

      return;
    }

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
    if (moving) {
      updateMoving(event);
      return;
    }

    if (resizing) {
      updateResizing(event);
      return;
    }

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
      onStatus("Concrete element created. Drag it to move or drag arrows to resize.");
    } else {
      onStatus("Drag a footprint to create a concrete element.");
    }

    event.preventDefault();
    event.stopImmediatePropagation();
  }

  function onPointerUp(event) {
    if (moving) {
      finishMoving(event);
      pointerDown = null;
      return;
    }

    if (resizing) {
      finishResizing(event);
      pointerDown = null;
      return;
    }

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

    pointerDown = null;
  }

  function onPointerCancel(event) {
    if (moving && event.pointerId === moving.pointerId) {
      moving = null;
      world.camera.setUserInput(true);
      container.classList.remove("is-moving-concrete");
      pointerDown = null;
      return;
    }

    if (resizing && event.pointerId === resizing.pointerId) {
      resizing = null;
      world.camera.setUserInput(true);
      container.classList.remove("is-resizing-concrete");
      pointerDown = null;
      return;
    }

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
