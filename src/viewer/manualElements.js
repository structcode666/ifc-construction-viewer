import * as THREE from "three";

const DEFAULT_CONCRETE_COLOR = "#9ca3af";
const SELECTED_CONCRETE_COLOR = "#d1d5db";
const CONCRETE_OPACITY = 0.36;
const PDF_CONCRETE_OPACITY = 0.68;
const MIN_FOOTPRINT_SIZE = 0.1;
const MIN_POINTER_DRAG_PX = 6;
const HANDLE_SIZE = 0.32;
const MOVE_HANDLE_LENGTH = 1.2;
const ROTATION_RING_RADIUS_PADDING = 0.8;

export function createManualElementManager({
  world,
  container,
  getDefaultHeight = () => 3,
  onSelectionChanged = () => {},
  onBeforeChange = () => {},
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
  const moveHandles = [];
  const rotationHandles = [];
  const snapMarker = createSnapMarker();
  const snapFeedback = createSnapFeedback();
  let drawEnabled = false;
  let snapEnabled = false;
  let pdfAppearanceEnabled = false;
  let drawing = null;
  let pointerDown = null;
  let moving = null;
  let resizing = null;
  let rotating = null;

  group.add(snapMarker);
  createMoveHandles();
  createResizeHandles();
  createRotationHandles();
  container.appendChild(snapFeedback);

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
    onBeforeChange("create concrete");

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
      rotation: quaternionToPlain(mesh.quaternion),
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
    mesh.quaternion.copy(plainToQuaternion(data.rotation));
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
      rotation: quaternionToPlain(mesh.quaternion),
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
      element.rotation = quaternionToPlain(element.mesh.quaternion);
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

  function pickMoveHandle(event) {
    setPointerFromEvent(event);

    const hits = raycaster.intersectObjects(moveHandles, true);
    const handle = hits[0]?.object;

    return handle?.userData?.moveHandle
      ? handle
      : handle?.parent?.userData?.moveHandle
        ? handle.parent
        : null;
  }

  function pickRotationHandle(event) {
    setPointerFromEvent(event);

    const hits = raycaster.intersectObjects(rotationHandles, false);

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

  function createMoveHandles() {
    const configs = [
      {
        axis: "x",
        label: "X",
        direction: new THREE.Vector3(1, 0, 0),
        color: "#ef4444",
      },
      {
        axis: "y",
        label: "Y",
        direction: new THREE.Vector3(0, 1, 0),
        color: "#22c55e",
      },
      {
        axis: "z",
        label: "Z",
        direction: new THREE.Vector3(0, 0, 1),
        color: "#3b82f6",
      },
    ];

    for (const config of configs) {
      const material = new THREE.MeshBasicMaterial({
        color: config.color,
        transparent: true,
        opacity: 0.96,
        depthTest: false,
      });
      const handle = new THREE.Group();
      const shaft = new THREE.Mesh(
        new THREE.CylinderGeometry(0.035, 0.035, MOVE_HANDLE_LENGTH, 12),
        material.clone()
      );
      const cone = new THREE.Mesh(
        new THREE.ConeGeometry(0.13, 0.36, 18),
        material.clone()
      );
      const label = createAxisLabel(config.label, config.color);

      shaft.position.y = MOVE_HANDLE_LENGTH / 2;
      cone.position.y = MOVE_HANDLE_LENGTH + 0.18;
      label.position.y = MOVE_HANDLE_LENGTH + 0.56;

      handle.add(shaft, cone, label);
      handle.quaternion.setFromUnitVectors(
        new THREE.Vector3(0, 1, 0),
        config.direction
      );
      handle.name = `Concrete move ${config.axis.toUpperCase()}`;
      handle.userData.moveHandle = config;
      handle.visible = false;

      moveHandles.push(handle);
      group.add(handle);
    }
  }

  function createAxisLabel(text, color) {
    const canvas = document.createElement("canvas");
    canvas.width = 96;
    canvas.height = 96;
    const context = canvas.getContext("2d");

    context.clearRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = color;
    context.beginPath();
    context.arc(48, 48, 34, 0, Math.PI * 2);
    context.fill();
    context.fillStyle = "#ffffff";
    context.font = "700 42px Arial";
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.fillText(text, 48, 50);

    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;

    const material = new THREE.SpriteMaterial({
      map: texture,
      transparent: true,
      depthTest: false,
    });
    const sprite = new THREE.Sprite(material);
    sprite.scale.set(0.42, 0.42, 0.42);
    sprite.userData.isAxisLabel = true;

    return sprite;
  }

  function createRotationHandles() {
    const configs = [
      {
        axis: "x",
        label: "X",
        direction: new THREE.Vector3(1, 0, 0),
        color: "#f87171",
      },
      {
        axis: "y",
        label: "Y",
        direction: new THREE.Vector3(0, 1, 0),
        color: "#4ade80",
      },
      {
        axis: "z",
        label: "Z",
        direction: new THREE.Vector3(0, 0, 1),
        color: "#60a5fa",
      },
    ];

    for (const config of configs) {
      const geometry = new THREE.TorusGeometry(1, 0.025, 10, 80);
      const material = new THREE.MeshBasicMaterial({
        color: config.color,
        transparent: true,
        opacity: 0.82,
        depthTest: false,
      });
      const mesh = new THREE.Mesh(geometry, material);

      mesh.name = `Concrete rotate ${config.axis.toUpperCase()}`;
      mesh.userData.rotationHandle = config;
      mesh.quaternion.setFromUnitVectors(
        new THREE.Vector3(0, 0, 1),
        config.direction
      );
      mesh.visible = false;
      rotationHandles.push(mesh);
      group.add(mesh);
    }
  }

  function createSnapMarker() {
    const marker = new THREE.Mesh(
      new THREE.SphereGeometry(0.12, 16, 16),
      new THREE.MeshBasicMaterial({
        color: "#facc15",
        transparent: true,
        opacity: 0.9,
        depthTest: false,
      })
    );
    marker.name = "Concrete snap marker";
    marker.visible = false;

    return marker;
  }

  function createSnapFeedback() {
    const element = document.createElement("div");
    element.className = "concrete-snap-feedback";
    element.style.display = "none";
    element.style.position = "absolute";
    element.style.left = "50%";
    element.style.bottom = "1rem";
    element.style.transform = "translateX(-50%)";
    element.style.zIndex = "40";
    element.style.padding = "0.55rem 0.75rem";
    element.style.borderRadius = "999px";
    element.style.background = "rgba(15, 23, 42, 0.84)";
    element.style.color = "#f8fafc";
    element.style.font = "700 0.76rem Inter, Arial, sans-serif";
    element.style.pointerEvents = "none";
    element.style.boxShadow = "0 12px 26px rgba(0, 0, 0, 0.24)";

    return element;
  }

  function hideSnapFeedback() {
    snapFeedback.style.display = "none";
  }

  function showSnapFeedback(message) {
    snapFeedback.textContent = message;
    snapFeedback.style.display = "block";
  }

  function hideAllHandles() {
    for (const handle of resizeHandles) {
      handle.visible = false;
    }

    for (const handle of moveHandles) {
      handle.visible = false;
    }

    for (const handle of rotationHandles) {
      handle.visible = false;
    }
  }

  function updateResizeHandles(element) {
    if (!element || !element.mesh.visible) {
      hideAllHandles();
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

    for (const handle of moveHandles) {
      const { axis, direction } = handle.userData.moveHandle;
      const offset =
        axis === "x"
          ? size.x / 2 + HANDLE_SIZE * 2.5
          : axis === "y"
            ? size.y / 2 + HANDLE_SIZE * 2.5
            : size.z / 2 + HANDLE_SIZE * 2.5;

      handle.position.copy(center).add(direction.clone().multiplyScalar(offset));
      handle.visible = true;
    }

    const ringRadius =
      Math.max(size.x, size.y, size.z) / 2 + ROTATION_RING_RADIUS_PADDING;

    for (const handle of rotationHandles) {
      handle.position.copy(center);
      handle.scale.setScalar(ringRadius);
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
      setElementOpacity(element, getConcreteOpacity());
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
        isForeground ? getConcreteOpacity() : Math.min(contextOpacity, 0.18)
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
      rotation: element.rotation,
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
    rotating = null;

    hideAllHandles();
    snapMarker.visible = false;
    hideSnapFeedback();

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

  function setSnapEnabled(enabled) {
    snapEnabled = Boolean(enabled);

    if (!snapEnabled) {
      snapMarker.visible = false;
      requestRender();
    }
  }

  function setPdfAppearanceEnabled(enabled) {
    pdfAppearanceEnabled = Boolean(enabled);

    for (const element of elements.values()) {
      if (!element.mesh.visible) continue;
      setElementOpacity(element, getConcreteOpacity());
    }

    requestRender();
  }

  function getConcreteOpacity() {
    return pdfAppearanceEnabled ? PDF_CONCRETE_OPACITY : CONCRETE_OPACITY;
  }

  function isPointerInteractionActive() {
    return (
      drawEnabled ||
      Boolean(drawing) ||
      Boolean(moving) ||
      Boolean(resizing) ||
      Boolean(rotating)
    );
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

  function createScreenDragPlane(point) {
    const normal = new THREE.Vector3();
    world.camera.three.getWorldDirection(normal);

    return new THREE.Plane().setFromNormalAndCoplanarPoint(
      normal.normalize(),
      point ?? new THREE.Vector3()
    );
  }

  function startMoving(event, elementId, moveHandle = null) {
    const element = elements.get(elementId);
    const axisConfig = moveHandle?.userData?.moveHandle ?? null;
    const axisVector = axisConfig?.direction?.clone?.() ?? null;
    const plane = axisVector
      ? new THREE.Plane().setFromNormalAndCoplanarPoint(
          createAxisDragPlane(axisVector),
          moveHandle.position
        )
      : createScreenDragPlane(element?.mesh?.position);
    const point = getPointOnPlane(event, plane, new THREE.Vector3());

    if (!element || !point) return false;

    onBeforeChange("move concrete");

    moving = {
      pointerId: event.pointerId,
      element,
      axis: axisConfig?.axis ?? null,
      axisLabel: axisConfig?.label ?? null,
      axisVector,
      plane,
      startPoint: point.clone(),
      startPosition: element.mesh.position.clone(),
    };

    container.setPointerCapture(event.pointerId);
    world.camera.setUserInput(false);
    container.classList.add("is-moving-concrete");
    container.classList.toggle("is-axis-moving-concrete", Boolean(axisVector));

    return true;
  }

  function updateMoving(event) {
    if (!moving || event.pointerId !== moving.pointerId) return;

    const point = getPointOnPlane(event, moving.plane, new THREE.Vector3());
    if (!point) return;

    const delta = point.clone().sub(moving.startPoint);
    const nextPosition = moving.startPosition.clone();

    if (moving.axisVector && moving.axis) {
      nextPosition[moving.axis] =
        moving.startPosition[moving.axis] + delta.dot(moving.axisVector);
    } else {
      nextPosition.x = moving.startPosition.x + delta.x;
      nextPosition.y = moving.startPosition.y + delta.y;
      nextPosition.z = moving.startPosition.z + delta.z;
    }

    applySnapToMovingPosition(event, nextPosition, delta);
    moving.element.mesh.position.copy(nextPosition);
    moving.element.position = vectorToPlain(moving.element.mesh.position);
    updateResizeHandles(moving.element);
    requestRender();

    event.preventDefault();
    event.stopImmediatePropagation();
  }

  function applySnapToMovingPosition(event, nextPosition, delta) {
    if (!snapEnabled) {
      snapMarker.visible = false;
      hideSnapFeedback();
      return;
    }

    const hit = getSnapHit(event);

    if (!hit) {
      snapMarker.visible = false;
      showSnapFeedback("Snap on: move near a steel/model face.");
      return;
    }

    const size = plainToVector(moving.element.size, new THREE.Vector3(1, 1, 1));
    const normal = getHitWorldNormal(hit);
    const dominant = getDominantAxis(normal);
    const snappedPosition = getFaceSnappedPosition({
      hitPoint: hit.point,
      normal,
      size,
      fallbackPosition: nextPosition,
    });
    const beforeSnapDistance = nextPosition.distanceTo(snappedPosition);

    if (moving.axis) {
      nextPosition[moving.axis] = snappedPosition[moving.axis];
    } else {
      nextPosition.copy(snappedPosition);
    }

    snapMarker.position.copy(hit.point);
    snapMarker.visible = true;
    showSnapFeedback(
      `Snap: concrete ${getConcreteFaceLabel(normal)} to ${getTargetFaceLabel(normal)} (${beforeSnapDistance.toFixed(2)}m)`
    );
  }

  function getHitWorldNormal(hit) {
    const normal = hit.face?.normal?.clone?.() ?? new THREE.Vector3(0, 1, 0);

    return normal.transformDirection(hit.object.matrixWorld).normalize();
  }

  function getDominantAxis(vector) {
    const absolute = {
      x: Math.abs(vector.x),
      y: Math.abs(vector.y),
      z: Math.abs(vector.z),
    };

    if (absolute.y >= absolute.x && absolute.y >= absolute.z) return "y";
    if (absolute.x >= absolute.z) return "x";
    return "z";
  }

  function getFaceSnappedPosition({
    hitPoint,
    normal,
    size,
    fallbackPosition,
  }) {
    const dominant = getDominantAxis(normal);
    const snappedPosition = fallbackPosition.clone();
    const sign = Math.sign(normal[dominant]) || 1;

    snappedPosition[dominant] =
      hitPoint[dominant] + sign * (size[dominant] / 2);

    if (!moving.axis) {
      snappedPosition.x = dominant === "x" ? snappedPosition.x : hitPoint.x;
      snappedPosition.y = dominant === "y" ? snappedPosition.y : hitPoint.y;
      snappedPosition.z = dominant === "z" ? snappedPosition.z : hitPoint.z;
    }

    return snappedPosition;
  }

  function getConcreteFaceLabel(normal) {
    const axis = getDominantAxis(normal);
    const sign = Math.sign(normal[axis]) || 1;

    if (axis === "y") return sign > 0 ? "bottom" : "top";
    if (axis === "x") return sign > 0 ? "left side" : "right side";
    return sign > 0 ? "back side" : "front side";
  }

  function getTargetFaceLabel(normal) {
    const axis = getDominantAxis(normal);
    const sign = Math.sign(normal[axis]) || 1;

    if (axis === "y") return sign > 0 ? "top face" : "underside";
    if (axis === "x") return sign > 0 ? "right face" : "left face";
    return sign > 0 ? "front face" : "back face";
  }

  function getSnapHit(event) {
    setPointerFromEvent(event);

    const candidates = [];

    world.scene.three.traverse((object) => {
      if (!object.visible || !object.isMesh) return;
      if (isDescendantOf(object, group)) return;
      candidates.push(object);
    });

    if (candidates.length === 0) return null;

    const hits = raycaster.intersectObjects(candidates, false);

    return hits[0] ?? null;
  }

  function isDescendantOf(object, parent) {
    let current = object;

    while (current) {
      if (current === parent) return true;
      current = current.parent;
    }

    return false;
  }

  function finishMoving(event) {
    if (!moving || event.pointerId !== moving.pointerId) return;

    moving.element.position = vectorToPlain(moving.element.mesh.position);
    moving = null;
    world.camera.setUserInput(true);
    container.classList.remove("is-moving-concrete");
    container.classList.remove("is-axis-moving-concrete");
    snapMarker.visible = false;
    hideSnapFeedback();

    if (container.hasPointerCapture(event.pointerId)) {
      container.releasePointerCapture(event.pointerId);
    }

    onElementChanged();
    requestRender();
    event.preventDefault();
    event.stopImmediatePropagation();
  }

  function startRotating(event, handle) {
    const element = getFirstSelectedElement();

    if (!element) return false;

    const { axis, label, direction } = handle.userData.rotationHandle;
    const axisVector = direction.clone().normalize();
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(
      axisVector,
      element.mesh.position
    );
    const startPoint = getPointOnPlane(event, plane, new THREE.Vector3());

    if (!startPoint) return false;

    const startVector = startPoint.clone().sub(element.mesh.position);

    if (startVector.lengthSq() < 0.0001) return false;

    onBeforeChange("rotate concrete");

    rotating = {
      pointerId: event.pointerId,
      element,
      axis,
      label,
      axisVector,
      plane,
      startVector: startVector.normalize(),
      startQuaternion: element.mesh.quaternion.clone(),
    };

    container.setPointerCapture(event.pointerId);
    world.camera.setUserInput(false);
    container.classList.add("is-rotating-concrete");

    return true;
  }

  function updateRotating(event) {
    if (!rotating || event.pointerId !== rotating.pointerId) return;

    const point = getPointOnPlane(event, rotating.plane, new THREE.Vector3());
    if (!point) return;

    const currentVector = point.clone().sub(rotating.element.mesh.position);
    if (currentVector.lengthSq() < 0.0001) return;

    currentVector.normalize();

    const cross = new THREE.Vector3().crossVectors(
      rotating.startVector,
      currentVector
    );
    const angle = Math.atan2(
      rotating.axisVector.dot(cross),
      rotating.startVector.dot(currentVector)
    );
    const deltaQuaternion = new THREE.Quaternion().setFromAxisAngle(
      rotating.axisVector,
      angle
    );

    rotating.element.mesh.quaternion.copy(
      deltaQuaternion.multiply(rotating.startQuaternion)
    );
    rotating.element.rotation = quaternionToPlain(
      rotating.element.mesh.quaternion
    );
    updateResizeHandles(rotating.element);
    requestRender();

    event.preventDefault();
    event.stopImmediatePropagation();
  }

  function finishRotating(event) {
    if (!rotating || event.pointerId !== rotating.pointerId) return;

    rotating.element.rotation = quaternionToPlain(rotating.element.mesh.quaternion);
    rotating = null;
    world.camera.setUserInput(true);
    container.classList.remove("is-rotating-concrete");

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

    onBeforeChange("resize concrete");

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
      const pickedMoveHandle = pickMoveHandle(event);

      if (pickedMoveHandle) {
        const selectedElement = getFirstSelectedElement();

        if (
          selectedElement &&
          startMoving(event, selectedElement.id, pickedMoveHandle)
        ) {
          const axis = pickedMoveHandle.userData.moveHandle.label;
          onStatus(
            `Moving concrete on ${axis} axis${snapEnabled ? " with snap on" : ""}.`
          );
          event.preventDefault();
          event.stopImmediatePropagation();
        }

        return;
      }

      const pickedRotationHandle = pickRotationHandle(event);

      if (pickedRotationHandle && startRotating(event, pickedRotationHandle)) {
        const axis = pickedRotationHandle.userData.rotationHandle.label;
        onStatus(`Rotating concrete around ${axis} axis.`);
        event.preventDefault();
        event.stopImmediatePropagation();
        return;
      }

      const pickedHandle = pickResizeHandle(event);

      if (pickedHandle && startResizing(event, pickedHandle)) {
        event.preventDefault();
        event.stopImmediatePropagation();
        return;
      }

      const pickedId = pickElement(event);

      if (!pickedId) {
        clearSelection();
        return;
      }

      selectIds([pickedId]);

      if (startMoving(event, pickedId)) {
        onStatus(
          `Concrete element selected. Drag to move on plan, or use X/Y/Z arrows for axis moves${snapEnabled ? " with snap on" : ""}.`
        );
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

    if (rotating) {
      updateRotating(event);
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

    if (rotating) {
      finishRotating(event);
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
      container.classList.remove("is-axis-moving-concrete");
      snapMarker.visible = false;
      hideSnapFeedback();
      pointerDown = null;
      return;
    }

    if (rotating && event.pointerId === rotating.pointerId) {
      rotating = null;
      world.camera.setUserInput(true);
      container.classList.remove("is-rotating-concrete");
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
    setSnapEnabled,
    isSnapEnabled: () => snapEnabled,
    setPdfAppearanceEnabled,
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

function quaternionToPlain(quaternion) {
  return {
    x: quaternion.x,
    y: quaternion.y,
    z: quaternion.z,
    w: quaternion.w,
  };
}

function plainToQuaternion(value) {
  if (!value) return new THREE.Quaternion();

  const quaternion = new THREE.Quaternion(
    Number.isFinite(Number(value.x)) ? Number(value.x) : 0,
    Number.isFinite(Number(value.y)) ? Number(value.y) : 0,
    Number.isFinite(Number(value.z)) ? Number(value.z) : 0,
    Number.isFinite(Number(value.w)) ? Number(value.w) : 1
  );

  return quaternion.normalize();
}
