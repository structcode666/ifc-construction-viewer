import * as THREE from "three";

const KEY_PLAN_LOG_PREFIX = "[Key Plan]";

// Step 1 deliberately does not extract or draw IFC grids.
// Its only job is to prove the top-down model capture works reliably.
const KEY_PLAN_DEBUG = true;

const MODEL_PADDING_RATIO = 0.12;
const MIN_PLAN_SIZE = 1;

/**
 * loadIfc.js calls this once when the IFC is loaded.
 *
 * For Step 1, we only retain model bounds. Grid parsing is deliberately
 * disabled until the camera/capture pipeline has been proven separately.
 */
export async function extractKeyPlanMetadataFromIfcBuffer({
  fragmentModel = null,
} = {}) {
  const modelBounds = getBoundsFromFragmentModel(fragmentModel);

  const metadata = {
    available: false,
    grids: [],
    modelBounds,
    step: "model-only-diagnostic",
  };

  if (KEY_PLAN_DEBUG) {
    console.log(`${KEY_PLAN_LOG_PREFIX} Step 1 metadata created.`, metadata);
  }

  return metadata;
}

/**
 * Generates a model-only key plan using the export styling that already works:
 *
 * - grey context image layer
 * - red current-stage items
 * - green previous-stage items, where applicable
 *
 * No IFC grids are drawn in this Step 1 version.
 */
export async function generateStageKeyPlanImage({
  stage,
  buckets,
  currentModel,
  fragments,
  world,
  hider,
  capturePng,
  makeGreyContextImage,
  makeWhiteTransparent,
  compositeImages,
  captureElement,
  foregroundItems,
  waitForStableFrame,
  applyRemovedVisibility = async () => {},
} = {}) {
  const rawMetadata = currentModel?.userData?.keyPlanMetadata ?? {};
  const selectedGridLevelId = currentModel?.userData?.selectedGridLevelId;

  const modelBounds =
    rawMetadata.modelBounds ?? getBoundsFromFragmentModel(currentModel);

  const modelBox = boxFromPlain(modelBounds);

  const stageBox = await getStageBounds({
    buckets,
    fragments,
  });

  // The key plan always frames the full model.
  // Do not use stage bounds or IFC grid extents to drive the camera fit.
  const keyPlanExtent =
    modelBox && !modelBox.isEmpty()
      ? extentFromBox(modelBox)
      : stageBox && !stageBox.isEmpty()
        ? extentFromBox(stageBox)
        : createFallbackExtent();

  if (KEY_PLAN_DEBUG) {
    console.log(`${KEY_PLAN_LOG_PREFIX} Step 1 diagnostics`, {
      stageName: stage?.name,
      modelBounds,
      modelBox: serialiseBox(modelBox),
      stageBox: serialiseBox(stageBox),
      keyPlanExtent,
      foregroundItemCount: countItemsInModelIdMap(foregroundItems),
      currentItemCount: countItemsInModelIdMap(
        buckets?.currentGeometryItems
      ),
      previousItemCount: countItemsInModelIdMap(
        buckets?.previousOnlyItems
      ),
    });
  }

  const cameraState = captureCameraState(world);

  const hadCaptureClass = captureElement?.classList?.contains(
    "is-key-plan-capturing"
  );

  try {
    captureElement?.classList?.add("is-key-plan-capturing");

    const planCamera = await setTopDownCameraForExtent({
      world,
      extent: keyPlanExtent,
      bounds: modelBounds,
    });

    // First capture: the full IFC model becomes the pale grey context layer.
    await hider.set(true);
    await applyRemovedVisibility();
    await waitForStableFrame();

    const contextCapture = await capturePng(captureElement);

    const greyContextImage = await makeGreyContextImage(contextCapture, {
      alpha: 0.28,
      filter: "grayscale(1) brightness(1.24) contrast(0.54)",
      whiteThreshold: 240,
    });

    // Second capture: only the styled foreground items remain.
    // Current stage is red; previous stages are green.
    if (isModelIdMapEmpty(foregroundItems)) {
      await hider.set(false);
    } else {
      await hider.isolate(foregroundItems);
    }
    await applyRemovedVisibility();

    await waitForStableFrame();

    const foregroundCapture = await capturePng(captureElement);

    const transparentForeground = await makeWhiteTransparent(
      foregroundCapture,
      248
    );

    const modelOnlyImage = await compositeImages(
      greyContextImage,
      transparentForeground
    );

    const keyPlanImage = await decorateModelOnlyKeyPlan({
      baseImageDataUrl: modelOnlyImage,
      stageName: stage?.name,
      gridMetadata: rawMetadata,
      selectedGridLevelId,
      planCamera,
    });

    if (KEY_PLAN_DEBUG) {
      window.__lastKeyPlanImage = keyPlanImage;

      console.log(
        `${KEY_PLAN_LOG_PREFIX} Raw Step 1 key-plan image ready. Open it with: window.open(window.__lastKeyPlanImage)`
      );
    }

    return keyPlanImage;
  } catch (error) {
    console.warn(`${KEY_PLAN_LOG_PREFIX} Step 1 key-plan generation failed.`, {
      stageName: stage?.name,
      error,
    });

    return createFallbackKeyPlanImage({
      message: "KEY PLAN CAPTURE FAILED",
      stageName: stage?.name,
    });
  } finally {
    if (!hadCaptureClass) {
      captureElement?.classList?.remove("is-key-plan-capturing");
    }

    await restoreCameraState(world, cameraState);
  }
}

// -----------------------------------------------------------------------------
// Stage and model bounds
// -----------------------------------------------------------------------------

async function getStageBounds({ buckets, fragments }) {
  const items = mergeModelIdMaps(
    buckets?.previousOnlyItems,
    buckets?.currentGeometryItems
  );

  if (isModelIdMapEmpty(items)) {
    return null;
  }

  const result = new THREE.Box3();
  let foundBounds = false;

  for (const [modelId, localIdsSet] of Object.entries(items)) {
    const model = fragments?.list?.get(modelId);
    const localIds = [...(localIdsSet ?? [])];

    if (!model || localIds.length === 0) {
      continue;
    }

    try {
      const box = await model.getMergedBox(localIds);

      if (box?.isBox3 && !box.isEmpty()) {
        result.union(box);
        foundBounds = true;
      }
    } catch (error) {
      console.warn(`${KEY_PLAN_LOG_PREFIX} Could not calculate stage bounds.`, {
        modelId,
        error,
      });
    }
  }

  return foundBounds ? result : null;
}

function getBoundsFromFragmentModel(model) {
  const box = model?.box?.isBox3
    ? model.box
    : new THREE.Box3().setFromObject(
        model?.object ?? new THREE.Object3D()
      );

  if (!box || box.isEmpty()) {
    return null;
  }

  return {
    min: vectorToPlainPoint(box.min),
    max: vectorToPlainPoint(box.max),
  };
}

function boxFromPlain(bounds) {
  if (!bounds?.min || !bounds?.max) {
    return null;
  }

  return new THREE.Box3(
    new THREE.Vector3(bounds.min.x, bounds.min.y, bounds.min.z),
    new THREE.Vector3(bounds.max.x, bounds.max.y, bounds.max.z)
  );
}

function extentFromBox(box) {
  return {
    minX: box.min.x,
    maxX: box.max.x,
    minY: box.min.y,
    maxY: box.max.y,
    minZ: box.min.z,
    maxZ: box.max.z,
  };
}

function createFallbackExtent() {
  return {
    minX: -10,
    maxX: 10,
    minY: 0,
    maxY: 10,
    minZ: -10,
    maxZ: 10,
  };
}

// -----------------------------------------------------------------------------
// Temporary plan camera
// -----------------------------------------------------------------------------

async function setTopDownCameraForExtent({
  world,
  extent,
  bounds,
}) {
  const cameraComponent = world.camera;

  await cameraComponent.projection?.set?.("Orthographic");

  const camera = cameraComponent.threeOrtho ?? cameraComponent.three;

  if (!camera?.isOrthographicCamera) {
    throw new Error("The viewer did not provide an orthographic camera.");
  }

  const rendererAspect = getRendererAspect(world);

  const width = Math.max(extent.maxX - extent.minX, MIN_PLAN_SIZE);
  const depth = Math.max(extent.maxZ - extent.minZ, MIN_PLAN_SIZE);

  const paddedWidth = width * (1 + MODEL_PADDING_RATIO * 2);
  const paddedDepth = depth * (1 + MODEL_PADDING_RATIO * 2);

  const viewWidth = Math.max(
    paddedWidth,
    paddedDepth * rendererAspect
  );

  const viewHeight = viewWidth / rendererAspect;

  const centerX = (extent.minX + extent.maxX) / 2;
  const centerZ = (extent.minZ + extent.maxZ) / 2;

  const modelBox = boxFromPlain(bounds);

  const minimumY = modelBox?.min.y ?? extent.minY ?? 0;
  const maximumY = modelBox?.max.y ?? extent.maxY ?? 0;

  const modelHeight = Math.max(maximumY - minimumY, MIN_PLAN_SIZE);

  const targetY = (minimumY + maximumY) / 2;
  const cameraY = maximumY + modelHeight * 4 + 10;

  camera.left = -viewWidth / 2;
  camera.right = viewWidth / 2;
  camera.top = viewHeight / 2;
  camera.bottom = -viewHeight / 2;
  camera.near = 0.01;
  camera.far = Math.max(cameraY - minimumY + modelHeight * 4, 1000);
  camera.zoom = 1;

  // Your model uses Y as vertical.
  // Looking down from +Y, use -Z as the screen-up direction.
  camera.up.set(0, 0, -1);
  camera.updateProjectionMatrix();

  await cameraComponent.controls.setLookAt(
    centerX,
    cameraY,
    centerZ,
    centerX,
    targetY,
    centerZ,
    false
  );

  camera.updateMatrixWorld(true);

  return camera;
}

function captureCameraState(world) {
  const cameraComponent = world.camera;
  const activeCamera = cameraComponent.three;

  const position = new THREE.Vector3();
  const target = new THREE.Vector3();

  cameraComponent.controls.getPosition(position);
  cameraComponent.controls.getTarget(target);

  const ortho = cameraComponent.threeOrtho;

  return {
    projection: cameraComponent.projection?.current,
    position,
    target,
    activeCameraUp:
      activeCamera?.up?.clone?.() ?? new THREE.Vector3(0, 1, 0),
    ortho: ortho?.isOrthographicCamera
      ? {
          left: ortho.left,
          right: ortho.right,
          top: ortho.top,
          bottom: ortho.bottom,
          near: ortho.near,
          far: ortho.far,
          zoom: ortho.zoom,
          up: ortho.up.clone(),
        }
      : null,
  };
}

async function restoreCameraState(world, state) {
  if (!state) {
    return;
  }

  const cameraComponent = world.camera;

  if (state.projection) {
    await cameraComponent.projection?.set?.(state.projection);
  }

  const ortho = cameraComponent.threeOrtho;

  if (state.ortho && ortho?.isOrthographicCamera) {
    ortho.left = state.ortho.left;
    ortho.right = state.ortho.right;
    ortho.top = state.ortho.top;
    ortho.bottom = state.ortho.bottom;
    ortho.near = state.ortho.near;
    ortho.far = state.ortho.far;
    ortho.zoom = state.ortho.zoom;
    ortho.up.copy(state.ortho.up);
    ortho.updateProjectionMatrix();
  }

  if (cameraComponent.three?.up && state.activeCameraUp) {
    cameraComponent.three.up.copy(state.activeCameraUp);
  }

  await cameraComponent.controls.setLookAt(
    state.position.x,
    state.position.y,
    state.position.z,
    state.target.x,
    state.target.y,
    state.target.z,
    false
  );
}

// -----------------------------------------------------------------------------
// Key-plan image decoration
// -----------------------------------------------------------------------------

async function decorateModelOnlyKeyPlan({
  baseImageDataUrl,
  stageName,
  gridMetadata,
  selectedGridLevelId,
  planCamera,
}) {
  const image = await loadImage(baseImageDataUrl);

  const canvas = document.createElement("canvas");

  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;

  const context = canvas.getContext("2d");

  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(image, 0, 0, canvas.width, canvas.height);

  forceNearWhitePixelsToWhite(canvas, 220);

  drawGridOverlayOnCanvas({
    context,
    canvas,
    gridMetadata,
    selectedGridLevelId,
    planCamera,
    stageName,
  });

  context.save();

  context.strokeStyle = "rgba(15, 23, 42, 0.35)";
  context.lineWidth = Math.max(2, Math.round(canvas.width / 900));
  context.strokeRect(1, 1, canvas.width - 2, canvas.height - 2);

  context.restore();

  return canvas.toDataURL("image/png");
}

function getSelectedGridAxes({
  gridMetadata,
  selectedGridLevelId,
  stageName,
}) {
  if (!gridMetadata?.available || !Array.isArray(gridMetadata.grids)) {
    console.warn(
      `${KEY_PLAN_LOG_PREFIX} Grid metadata is missing or invalid; generating model-only key plan.`,
      {
        stageName,
        metadataAvailable: gridMetadata?.available,
      }
    );

    return {
      axes: [],
      selectedGrids: [],
    };
  }

  const selectedLevel = getGridLevelForSelection({
    gridMetadata,
    selectedGridLevelId,
  });
  const selectedGridIds = new Set(
    (selectedLevel?.gridIds ?? []).map(normaliseGridId)
  );
  const selectedGrids = gridMetadata.grids.filter((grid) =>
    selectedGridIds.has(normaliseGridId(grid.gridId))
  );
  const usableSelectedGrids = selectedGrids.filter(
    (grid) => Array.isArray(grid?.axes) && grid.axes.length > 0
  );

  if (usableSelectedGrids.length === 0) {
    console.warn(
      `${KEY_PLAN_LOG_PREFIX} Primary grid level contains no usable grids; generating model-only key plan.`,
      {
        stageName,
        selectedGridLevelId,
        selectedLevel,
      }
    );

    return {
      axes: [],
      selectedGrids: [],
    };
  }

  return {
    axes: usableSelectedGrids.flatMap((grid) => grid.axes),
    selectedGrids: usableSelectedGrids,
    selectedLevel,
  };
}

function getGridLevelForSelection({
  gridMetadata,
  selectedGridLevelId,
}) {
  const levels = Array.isArray(gridMetadata?.gridLevels)
    ? gridMetadata.gridLevels
    : [];
  const normalisedLevelId = String(selectedGridLevelId ?? "").trim();

  return levels.find((level) => level.levelId === normalisedLevelId)
    ?? gridMetadata?.primaryGridLevel
    ?? levels[0]
    ?? null;
}

function drawGridOverlayOnCanvas({
  context,
  canvas,
  gridMetadata,
  selectedGridLevelId,
  planCamera,
  stageName,
}) {
  if (!planCamera) {
    return;
  }

  const {
    axes,
    selectedGrids,
    selectedLevel,
  } = getSelectedGridAxes({
    gridMetadata,
    selectedGridLevelId,
    stageName,
  });

  if (axes.length === 0) {
    return;
  }

  console.log(`${KEY_PLAN_LOG_PREFIX} Grid overlay diagnostics`, {
    stageName,
    selectedGridNames: selectedGrids.map((grid) => grid.name),
    selectedGridLevelId: selectedLevel?.levelId ?? null,
    selectedGridElevation: selectedLevel?.elevation ?? null,
    axisCount: axes.length,
  });

  window.__lastKeyPlanGridDebug = {
    stageName,
    selectedGridNames: selectedGrids.map((grid) => grid.name),
    selectedGridLevelId: selectedLevel?.levelId ?? null,
    selectedGridElevation: selectedLevel?.elevation ?? null,
    axes,
  };

  planCamera.updateMatrixWorld(true);

  context.save();
  context.beginPath();
  context.rect(0, 0, canvas.width, canvas.height);
  context.clip();

  context.strokeStyle = "rgba(0, 115, 255, 0.95)";
  context.lineWidth = 2;
  context.lineCap = "round";
  context.lineJoin = "round";

  const labelCandidates = [];

  for (const axis of axes) {
    const points = axis?.points ?? [];

    if (points.length < 2) {
      continue;
    }

    let hasDrawablePoint = false;

    context.beginPath();

    for (const point of points) {
      const canvasPoint = projectWorldPointToCanvas({
        point,
        planCamera,
        canvas,
      });

      if (!canvasPoint) {
        hasDrawablePoint = false;
        continue;
      }

      if (!hasDrawablePoint) {
        context.moveTo(canvasPoint.x, canvasPoint.y);
        hasDrawablePoint = true;
      } else {
        context.lineTo(canvasPoint.x, canvasPoint.y);
      }
    }

    if (hasDrawablePoint) {
      context.stroke();
      labelCandidates.push(...getAxisLabelCandidates({
        axis,
        planCamera,
        canvas,
      }));
    }
  }

  drawGridLabelsOnCanvas({
    context,
    canvas,
    labelCandidates,
  });

  context.restore();
}

function getAxisLabelCandidates({
  axis,
  planCamera,
  canvas,
}) {
  const tag = String(axis?.tag ?? "").trim();
  const points = axis?.points ?? [];

  if (!tag || points.length < 2) {
    return [];
  }

  const firstPoint = projectWorldPointToCanvas({
    point: points[0],
    planCamera,
    canvas,
  });
  const lastPoint = projectWorldPointToCanvas({
    point: points[points.length - 1],
    planCamera,
    canvas,
  });

  return [
    createGridLabelCandidate(tag, firstPoint, lastPoint, -1),
    createGridLabelCandidate(tag, lastPoint, firstPoint, 1),
  ].filter(Boolean);
}

function createGridLabelCandidate(
  text,
  point,
  oppositePoint,
  directionSign
) {
  if (!point || !oppositePoint) {
    return null;
  }

  const directionX = point.x - oppositePoint.x;
  const directionY = point.y - oppositePoint.y;
  const length = Math.hypot(directionX, directionY);
  const offset = 12;

  if (length < 1e-6) {
    return {
      text,
      x: point.x,
      y: point.y - offset * directionSign,
    };
  }

  return {
    text,
    x: point.x + (directionX / length) * offset,
    y: point.y + (directionY / length) * offset,
  };
}

function drawGridLabelsOnCanvas({
  context,
  canvas,
  labelCandidates,
}) {
  const drawnLabels = new Set();
  const fontSize = Math.max(12, Math.round(canvas.width / 90));
  const horizontalPadding = Math.round(fontSize * 0.55);
  const verticalPadding = Math.round(fontSize * 0.32);
  const radius = Math.round(fontSize * 0.35);

  context.font = `700 ${fontSize}px Arial, sans-serif`;
  context.textAlign = "center";
  context.textBaseline = "middle";

  for (const label of labelCandidates) {
    if (!label || !Number.isFinite(label.x) || !Number.isFinite(label.y)) {
      continue;
    }

    const key = [
      label.text.toUpperCase(),
      Math.round(label.x / 4),
      Math.round(label.y / 4),
    ].join("|");

    if (drawnLabels.has(key)) {
      continue;
    }

    drawnLabels.add(key);

    const metrics = context.measureText(label.text);
    const width = metrics.width + horizontalPadding * 2;
    const height = fontSize + verticalPadding * 2;
    const x = THREE.MathUtils.clamp(
      label.x,
      width / 2 + 2,
      canvas.width - width / 2 - 2
    );
    const y = THREE.MathUtils.clamp(
      label.y,
      height / 2 + 2,
      canvas.height - height / 2 - 2
    );

    context.fillStyle = "rgba(255, 255, 255, 0.92)";
    drawRoundedRectOnCanvas(
      context,
      x - width / 2,
      y - height / 2,
      width,
      height,
      radius
    );
    context.fill();

    context.strokeStyle = "rgba(0, 80, 180, 0.65)";
    context.lineWidth = 1;
    context.stroke();

    context.fillStyle = "rgba(0, 80, 180, 0.95)";
    context.fillText(label.text, x, y + 1);
  }
}

function drawRoundedRectOnCanvas(context, x, y, width, height, radius) {
  const safeRadius = Math.min(radius, width / 2, height / 2);

  context.beginPath();
  context.moveTo(x + safeRadius, y);
  context.lineTo(x + width - safeRadius, y);
  context.quadraticCurveTo(x + width, y, x + width, y + safeRadius);
  context.lineTo(x + width, y + height - safeRadius);
  context.quadraticCurveTo(
    x + width,
    y + height,
    x + width - safeRadius,
    y + height
  );
  context.lineTo(x + safeRadius, y + height);
  context.quadraticCurveTo(x, y + height, x, y + height - safeRadius);
  context.lineTo(x, y + safeRadius);
  context.quadraticCurveTo(x, y, x + safeRadius, y);
  context.closePath();
}

function normaliseGridId(gridId) {
  return String(gridId ?? "").trim();
}

function projectWorldPointToCanvas({
  point,
  planCamera,
  canvas,
}) {
  if (!point) {
    return null;
  }

  const x = Number(point.x);
  const y = Number(point.y);
  const z = Number(point.z);

  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
    return null;
  }

  const projected = new THREE.Vector3(x, y, z).project(planCamera);

  if (
    !Number.isFinite(projected.x) ||
    !Number.isFinite(projected.y) ||
    !Number.isFinite(projected.z)
  ) {
    return null;
  }

  return {
    x: (projected.x * 0.5 + 0.5) * canvas.width,
    y: (-projected.y * 0.5 + 0.5) * canvas.height,
  };
}

function createFallbackKeyPlanImage({
  message,
  stageName,
}) {
  const canvas = document.createElement("canvas");

  canvas.width = 900;
  canvas.height = 620;

  const context = canvas.getContext("2d");

  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, canvas.width, canvas.height);

  context.strokeStyle = "#94a3b8";
  context.lineWidth = 3;
  context.strokeRect(12, 12, canvas.width - 24, canvas.height - 24);

  context.font = "bold 22px Arial, sans-serif";
  context.fillStyle = "#334155";
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.fillText(message, canvas.width / 2, canvas.height / 2 - 12);

  if (stageName) {
    context.font = "bold 16px Arial, sans-serif";
    context.fillText(
      stageName.toUpperCase(),
      canvas.width / 2,
      canvas.height / 2 + 24
    );
  }

  return canvas.toDataURL("image/png");
}

// -----------------------------------------------------------------------------
// General helpers
// -----------------------------------------------------------------------------

function mergeModelIdMaps(...maps) {
  const merged = {};

  for (const map of maps) {
    for (const [modelId, localIds] of Object.entries(map ?? {})) {
      if (!merged[modelId]) {
        merged[modelId] = new Set();
      }

      for (const localId of localIds ?? []) {
        merged[modelId].add(localId);
      }
    }
  }

  return merged;
}

function isModelIdMapEmpty(modelIdMap) {
  return !Object.values(modelIdMap ?? {}).some(
    (localIds) => localIds?.size > 0
  );
}

function countItemsInModelIdMap(modelIdMap) {
  let total = 0;

  for (const localIds of Object.values(modelIdMap ?? {})) {
    total += localIds?.size ?? 0;
  }

  return total;
}

function getRendererAspect(world) {
  const size = new THREE.Vector2();

  world.renderer.three.getSize(size);

  return size.y > 0 ? size.x / size.y : 1;
}

function forceNearWhitePixelsToWhite(canvas, threshold = 246) {
  const context = canvas.getContext("2d");

  const imageData = context.getImageData(
    0,
    0,
    canvas.width,
    canvas.height
  );

  const { data } = imageData;

  for (let index = 0; index < data.length; index += 4) {
    if (
      data[index] >= threshold &&
      data[index + 1] >= threshold &&
      data[index + 2] >= threshold
    ) {
      data[index] = 255;
      data[index + 1] = 255;
      data[index + 2] = 255;
      data[index + 3] = 255;
    }
  }

  context.putImageData(imageData, 0, 0);
}

function serialiseBox(box) {
  if (!box?.isBox3 || box.isEmpty()) {
    return null;
  }

  return {
    min: vectorToPlainPoint(box.min),
    max: vectorToPlainPoint(box.max),
  };
}

function vectorToPlainPoint(vector) {
  return {
    x: vector.x,
    y: vector.y,
    z: vector.z,
  };
}

async function loadImage(imageDataUrl) {
  const image = new Image();

  image.src = imageDataUrl;

  await new Promise((resolve, reject) => {
    image.onload = resolve;
    image.onerror = reject;
  });

  return image;
}
