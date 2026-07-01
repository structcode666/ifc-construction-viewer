import * as THREE from "three";
import {
  IfcAPI,
  IFCGRID,
  IFCPOLYLINE,
  IFCINDEXEDPOLYCURVE,
} from "web-ifc";

const LOG_PREFIX = "[IFC Grids]";

const WASM_PATH = "https://unpkg.com/web-ifc@0.0.77/";

const DEBUG = true;

// Temporary diagnostic appearance.
// We will later change this to subtle grey lines for the production viewer.
const GRID_COLOR = "#0066ff";
const GRID_OPACITY = 0.9;
const GRID_LABEL_WORLD_HEIGHT = 0.65;
const GRID_LABEL_BACKGROUND = "#172033";
const GRID_LABEL_TEXT = "#ffffff";
const GRID_LABEL_RENDER_ORDER = 1000;

// This IFC uses millimetres. The Fragments model uses metres.
const MM_TO_M = 0.001;

/* -------------------------------------------------------------------------- */
/*                              PUBLIC: EXTRACT                               */
/* -------------------------------------------------------------------------- */

/**
 * Reads real IFC grid data:
 *
 * - IfcGrid
 * - IfcGridAxis
 * - AxisTag
 * - AxisCurve
 * - ObjectPlacement
 *
 * It converts the resulting points into the same local coordinates used by
 * the loaded Fragments model.
 */
export async function extractIfcGridMetadataFromBuffer({
  buffer,
  fragmentModel = null,
  wasmPath = WASM_PATH,
} = {}) {
  const modelBounds = getModelBounds(fragmentModel);

  const emptyResult = {
    available: false,
    grids: [],
    modelBounds,
    debug: {
      reason: "No IFC grid metadata extracted.",
    },
  };

  if (!buffer) {
    return emptyResult;
  }

  const api = new IfcAPI();
  let modelID = null;

  try {
    await api.Init((fileName) => `${wasmPath}${fileName}`);

    const ifcBuffer =
      buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);

    modelID = api.OpenModel(ifcBuffer);

    if (modelID < 0) {
      console.warn(`${LOG_PREFIX} Could not open IFC for grid extraction.`);

      return emptyResult;
    }

    const gridIds = vectorToArray(
      api.GetLineIDsWithType(modelID, IFCGRID)
    );

    if (gridIds.length === 0) {
      console.warn(`${LOG_PREFIX} No IfcGrid entities found.`);

      return {
        ...emptyResult,
        debug: {
          reason: "No IfcGrid entities found in the IFC.",
          ifcGridCount: 0,
        },
      };
    }

    const rawGrids = [];

    for (const gridId of gridIds) {
      const rawGrid = readIfcGrid({
        api,
        modelID,
        gridId,
      });

      if (rawGrid) {
        rawGrids.push(rawGrid);
      }
    }

    if (rawGrids.length === 0) {
      console.warn(
        `${LOG_PREFIX} IfcGrid objects were found, but no usable grid axes were extracted.`
      );

      return {
        ...emptyResult,
        debug: {
          reason: "No usable IfcGridAxis geometry was found.",
          ifcGridCount: gridIds.length,
        },
      };
    }

    const coordinationMatrix = await getCoordinationMatrix(fragmentModel);

    const ifcToViewerMatrix = createIfcToViewerMatrix(
      coordinationMatrix
    );

    const grids = rawGrids
      .map((grid) =>
        transformGridToViewerCoordinates({
          grid,
          ifcToViewerMatrix,
        })
      )
      .map((grid) => ({
        ...grid,
        elevation: getGridElevation(grid),
      }));

    const axisCount = grids.reduce(
      (total, grid) => total + grid.axes.length,
      0
    );

    const metadata = {
      available: grids.length > 0,
      grids,
      modelBounds,
      debug: {
        ifcGridCount: gridIds.length,
        extractedGridCount: grids.length,
        extractedAxisCount: axisCount,
        transform:
          "IFC mm -> metres, IFC Z-up -> viewer Y-up, Fragments local origin",
        coordinationMatrix: coordinationMatrix.elements.slice(),
      },
    };

    if (DEBUG) {
      console.log(`${LOG_PREFIX} Grid extraction complete.`, {
        gridCount: metadata.debug.extractedGridCount,
        axisCount: metadata.debug.extractedAxisCount,
        modelBounds,
        firstGrid: metadata.grids[0],
      });
    }

    return metadata;
  } catch (error) {
    console.error(`${LOG_PREFIX} Grid extraction failed.`, error);

    return {
      ...emptyResult,
      debug: {
        reason: "IFC grid extraction threw an error.",
        error: {
          name: error?.name,
          message: error?.message ?? String(error),
        },
      },
    };
  } finally {
    if (modelID !== null && modelID >= 0) {
      api.CloseModel(modelID);
    }

    api.Dispose();
  }
}

/* -------------------------------------------------------------------------- */
/*                          PUBLIC: VIEWER OVERLAY                            */
/* -------------------------------------------------------------------------- */

/**
 * Creates a simple Three.js overlay for debugging grid alignment.
 *
 * It starts visible intentionally.
 *
 * Browser-console helpers:
 *
 * window.ifcGridLayer.show()
 * window.ifcGridLayer.hide()
 * window.ifcGridLayer.toggle()
 * window.ifcGridLayer.getDebugInfo()
 */
export function createIfcGridLayer({
  world,
  color = GRID_COLOR,
  opacity = GRID_OPACITY,
} = {}) {
  if (!world?.scene?.three) {
    throw new Error(
      "createIfcGridLayer requires a valid That Open world."
    );
  }

  const root = new THREE.Group();

  root.name = "ifc-grid-overlay-root";
  root.visible = true;

  world.scene.three.add(root);

  const material = new THREE.LineBasicMaterial({
    color,
    transparent: opacity < 1,
    opacity,
    depthTest: false,
    depthWrite: false,
  });

  const gridGroups = new Map();

  let metadata = null;

  function clear() {
    for (const gridGroup of gridGroups.values()) {
      disposeGridGroup(gridGroup);
      root.remove(gridGroup);
    }

    gridGroups.clear();
    metadata = null;

    renderWorld(world);
  }

  function setMetadata(nextMetadata) {
    clear();

    metadata = nextMetadata;

    if (!metadata?.available || !Array.isArray(metadata.grids)) {
      console.warn(`${LOG_PREFIX} No grid metadata available for overlay.`);

      return;
    }

    for (const grid of metadata.grids) {
      const gridGroup = createGridGroup({
        grid,
        material,
      });

      if (!gridGroup) {
        continue;
      }

      root.add(gridGroup);
      gridGroups.set(grid.gridId, gridGroup);
    }

    root.visible = true;

    if (DEBUG) {
      console.log(`${LOG_PREFIX} Viewer overlay built.`, getDebugInfo());
    }

    renderWorld(world);
  }

  function show() {
    root.visible = true;

    for (const gridGroup of gridGroups.values()) {
      gridGroup.visible = true;
    }

    renderWorld(world);

    return true;
  }

  function hide() {
    root.visible = false;

    renderWorld(world);

    return false;
  }

  function toggle() {
    root.visible = !root.visible;

    renderWorld(world);

    return root.visible;
  }

  function showOnly(gridNames = []) {
    const allowedNames = new Set(
      gridNames.map((name) => String(name).trim().toUpperCase())
    );

    root.visible = true;

    for (const gridGroup of gridGroups.values()) {
      const name = String(
        gridGroup.userData.gridName ?? ""
      ).toUpperCase();

      gridGroup.visible =
        allowedNames.size === 0 || allowedNames.has(name);
    }

    renderWorld(world);

    return getDebugInfo();
  }

  function setColor(nextColor) {
    material.color.set(nextColor);
    renderWorld(world);
  }

  function setOpacity(nextOpacity) {
    material.opacity = THREE.MathUtils.clamp(nextOpacity, 0, 1);
    material.transparent = material.opacity < 1;
    material.needsUpdate = true;

    renderWorld(world);
  }

  function getMetadata() {
    return metadata;
  }

  function getDebugInfo() {
    return {
      rootVisible: root.visible,
      gridGroupCount: gridGroups.size,
      grids: [...gridGroups.values()].map((group) => ({
        gridId: group.userData.gridId,
        gridName: group.userData.gridName,
        elevation: group.userData.elevation,
        axisCount: group.userData.axisCount,
        visible: group.visible,
      })),
    };
  }

  function dispose() {
    clear();

    material.dispose();
    root.removeFromParent();
  }

  return {
    clear,
    setMetadata,
    show,
    hide,
    toggle,
    showOnly,
    setColor,
    setOpacity,
    getMetadata,
    getDebugInfo,
    dispose,
  };
}

/* -------------------------------------------------------------------------- */
/*                         IFC GRID ENTITY EXTRACTION                         */
/* -------------------------------------------------------------------------- */

function readIfcGrid({ api, modelID, gridId }) {
  const grid = api.GetLine(modelID, gridId);

  if (!grid) {
    return null;
  }

  const placementMatrix = getIfcLocalPlacementMatrix({
    api,
    modelID,
    placementReference: grid.ObjectPlacement,
  });

  const axes = [];

  const axisFamilies = [
    ["U", grid.UAxes],
    ["V", grid.VAxes],
    ["W", grid.WAxes],
  ];

  for (const [family, axisReferences] of axisFamilies) {
    const axisIds = getReferenceIds(axisReferences);

    for (const axisId of axisIds) {
      const axis = api.GetLine(modelID, axisId);

      if (!axis) {
        continue;
      }

      const localPoints = getGridAxisPoints({
        api,
        modelID,
        axis,
      });

      if (localPoints.length < 2) {
        continue;
      }

      axes.push({
        axisId,
        family,
        tag: String(
          getIfcValue(axis.AxisTag) || `${family}${axes.length + 1}`
        ),
        localPoints,
      });
    }
  }

  if (axes.length === 0) {
    return null;
  }

  return {
    gridId,
    name: String(getIfcValue(grid.Name) || `GRID ${gridId}`),
    placementMatrix,
    axes,
  };
}

function getGridAxisPoints({ api, modelID, axis }) {
  const curveId = getReferenceId(axis?.AxisCurve);

  if (!curveId) {
    return [];
  }

  const curve = api.GetLine(modelID, curveId);

  if (!curve) {
    return [];
  }

  const typeName = getIfcTypeName(api, curve);

  let points = [];

  if (curve.type === IFCPOLYLINE || typeName === "IFCPOLYLINE") {
    points = getPolylinePoints({
      api,
      modelID,
      curve,
    });
  }

  if (
    curve.type === IFCINDEXEDPOLYCURVE ||
    typeName === "IFCINDEXEDPOLYCURVE"
  ) {
    points = getIndexedPolycurvePoints({
      api,
      modelID,
      curve,
    });
  }

  const sameSense = getIfcValue(axis.SameSense);

  return sameSense === false ? [...points].reverse() : points;
}

function getPolylinePoints({ api, modelID, curve }) {
  return getReferenceIds(curve.Points)
    .map((pointId) => api.GetLine(modelID, pointId))
    .map(getCartesianPoint)
    .filter(Boolean);
}

function getIndexedPolycurvePoints({ api, modelID, curve }) {
  const pointListId = getReferenceId(curve.Points);

  const pointList = pointListId
    ? api.GetLine(modelID, pointListId)
    : curve.Points;

  const coordinateList = unwrapIfcValue(
    pointList?.CoordList ?? pointList?.Coordinates
  );

  if (!Array.isArray(coordinateList)) {
    return [];
  }

  return coordinateList
    .map((coordinates) => {
      const values = unwrapIfcValue(coordinates);

      if (!Array.isArray(values) || values.length < 2) {
        return null;
      }

      return {
        x: Number(getIfcValue(values[0])) || 0,
        y: Number(getIfcValue(values[1])) || 0,
        z: Number(getIfcValue(values[2])) || 0,
      };
    })
    .filter(Boolean);
}

/* -------------------------------------------------------------------------- */
/*                         IFC PLACEMENT TRANSFORMS                           */
/* -------------------------------------------------------------------------- */

function getIfcLocalPlacementMatrix({
  api,
  modelID,
  placementReference,
  visited = new Set(),
}) {
  const placementId = getReferenceId(placementReference);

  if (!placementId || visited.has(placementId)) {
    return new THREE.Matrix4();
  }

  visited.add(placementId);

  const placement = api.GetLine(modelID, placementId);

  if (!placement) {
    return new THREE.Matrix4();
  }

  const parentMatrix = getIfcLocalPlacementMatrix({
    api,
    modelID,
    placementReference: placement.PlacementRelTo,
    visited,
  });

  const localMatrix = getIfcAxisPlacementMatrix({
    api,
    modelID,
    placementReference: placement.RelativePlacement,
  });

  return parentMatrix.multiply(localMatrix);
}

function getIfcAxisPlacementMatrix({
  api,
  modelID,
  placementReference,
}) {
  const placementId = getReferenceId(placementReference);

  if (!placementId) {
    return new THREE.Matrix4();
  }

  const placement = api.GetLine(modelID, placementId);

  if (!placement) {
    return new THREE.Matrix4();
  }

  const locationId = getReferenceId(placement.Location);

  const location = locationId
    ? getCartesianPoint(api.GetLine(modelID, locationId))
    : null;

  const origin = new THREE.Vector3(
    location?.x ?? 0,
    location?.y ?? 0,
    location?.z ?? 0
  );

  if (location?.dimension === 2) {
    return getIfc2DPlacementMatrix({
      api,
      modelID,
      placement,
      origin,
    });
  }

  return getIfc3DPlacementMatrix({
    api,
    modelID,
    placement,
    origin,
  });
}

function getIfc2DPlacementMatrix({
  api,
  modelID,
  placement,
  origin,
}) {
  const refDirectionId = getReferenceId(placement.RefDirection);

  const xAxis = refDirectionId
    ? getDirection(api.GetLine(modelID, refDirectionId))
    : new THREE.Vector3(1, 0, 0);

  xAxis.z = 0;

  if (xAxis.lengthSq() < 1e-12) {
    xAxis.set(1, 0, 0);
  }

  xAxis.normalize();

  const yAxis = new THREE.Vector3(-xAxis.y, xAxis.x, 0);
  const zAxis = new THREE.Vector3(0, 0, 1);

  const matrix = new THREE.Matrix4();

  matrix.makeBasis(xAxis, yAxis, zAxis);
  matrix.setPosition(origin);

  return matrix;
}

function getIfc3DPlacementMatrix({
  api,
  modelID,
  placement,
  origin,
}) {
  const axisId = getReferenceId(placement.Axis);
  const refDirectionId = getReferenceId(placement.RefDirection);

  const zAxis = axisId
    ? getDirection(api.GetLine(modelID, axisId))
    : new THREE.Vector3(0, 0, 1);

  const rawXAxis = refDirectionId
    ? getDirection(api.GetLine(modelID, refDirectionId))
    : new THREE.Vector3(1, 0, 0);

  const xAxis = rawXAxis
    .clone()
    .sub(zAxis.clone().multiplyScalar(rawXAxis.dot(zAxis)));

  if (xAxis.lengthSq() < 1e-12) {
    xAxis.set(1, 0, 0);

    if (Math.abs(xAxis.dot(zAxis)) > 0.95) {
      xAxis.set(0, 1, 0);
    }

    xAxis.sub(zAxis.clone().multiplyScalar(xAxis.dot(zAxis)));
  }

  xAxis.normalize();

  const yAxis = new THREE.Vector3()
    .crossVectors(zAxis, xAxis)
    .normalize();

  const matrix = new THREE.Matrix4();

  matrix.makeBasis(xAxis, yAxis, zAxis);
  matrix.setPosition(origin);

  return matrix;
}

/* -------------------------------------------------------------------------- */
/*                     IFC COORDINATES -> VIEWER COORDINATES                 */
/* -------------------------------------------------------------------------- */

function createIfcToViewerMatrix(coordinationMatrix) {
  /*
   * IFC:
   *   X = horizontal
   *   Y = horizontal
   *   Z = elevation
   *
   * Your rendered model:
   *   X = IFC X
   *   Y = IFC Z
   *   Z = -IFC Y
   *
   * (x, y, z) -> (x, z, -y)
   */

  const scaleMatrix = new THREE.Matrix4().makeScale(
    MM_TO_M,
    MM_TO_M,
    MM_TO_M
  );

  const zUpToYUpMatrix = new THREE.Matrix4().set(
    1, 0, 0, 0,
    0, 0, 1, 0,
    0, -1, 0, 0,
    0, 0, 0, 1
  );

  const localOriginMatrix = coordinationMatrix?.isMatrix4
    ? coordinationMatrix.clone()
    : new THREE.Matrix4();

  /*
   * The right-most transform runs first:
   *
   * local grid point
   * -> IFC grid placement
   * -> mm to metres
   * -> IFC Z-up to viewer Y-up
   * -> Fragments local origin
   */
  return localOriginMatrix
    .multiply(zUpToYUpMatrix)
    .multiply(scaleMatrix);
}

function transformGridToViewerCoordinates({
  grid,
  ifcToViewerMatrix,
}) {
  const gridTransform = ifcToViewerMatrix
    .clone()
    .multiply(grid.placementMatrix);

  return {
    gridId: grid.gridId,
    name: grid.name,
    axes: grid.axes.map((axis) => ({
      axisId: axis.axisId,
      family: axis.family,
      tag: axis.tag,
      points: axis.localPoints.map((point) => {
        const vector = new THREE.Vector3(
          point.x,
          point.y,
          point.z
        );

        vector.applyMatrix4(gridTransform);

        return {
          x: vector.x,
          y: vector.y,
          z: vector.z,
        };
      }),
    })),
  };
}

/* -------------------------------------------------------------------------- */
/*                          THREE.JS GRID OVERLAY                             */
/* -------------------------------------------------------------------------- */

function createGridGroup({ grid, material }) {
  const positions = [];
  const labelKeys = new Set();

  for (const axis of grid.axes) {
    for (let index = 0; index < axis.points.length - 1; index += 1) {
      const start = axis.points[index];
      const end = axis.points[index + 1];

      positions.push(
        start.x,
        start.y,
        start.z,
        end.x,
        end.y,
        end.z
      );
    }
  }

  if (positions.length === 0) {
    return null;
  }

  const geometry = new THREE.BufferGeometry();

  geometry.setAttribute(
    "position",
    new THREE.Float32BufferAttribute(positions, 3)
  );

  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();

  const lines = new THREE.LineSegments(geometry, material);

  lines.name = `ifc-grid-lines-${grid.gridId}`;
  lines.frustumCulled = false;
  lines.renderOrder = 999;

  const group = new THREE.Group();

  group.name = `ifc-grid-${grid.name}`;

  group.userData = {
    gridId: grid.gridId,
    gridName: grid.name,
    elevation: grid.elevation,
    axisCount: grid.axes.length,
  };

  group.add(lines);

  for (const axis of grid.axes) {
    const labels = createAxisEndpointLabels(axis, labelKeys);

    for (const label of labels) {
      group.add(label);
    }
  }

  return group;
}

function disposeGridGroup(group) {
  group.traverse((object) => {
    object.geometry?.dispose?.();

    if (object.isSprite) {
      object.material?.map?.dispose?.();
      object.material?.dispose?.();
    }
  });
}

function createAxisEndpointLabels(axis, labelKeys) {
  const tag = String(axis?.tag ?? "").trim();

  if (!tag || !Array.isArray(axis.points) || axis.points.length < 2) {
    return [];
  }

  const firstPoint = axis.points[0];
  const lastPoint = axis.points[axis.points.length - 1];
  const direction = pointToVector(lastPoint)
    .sub(pointToVector(firstPoint))
    .normalize();

  return [
    createGridLabelSprite({
      text: tag,
      point: firstPoint,
      offsetDirection: direction.clone().multiplyScalar(-1),
      labelKeys,
    }),
    createGridLabelSprite({
      text: tag,
      point: lastPoint,
      offsetDirection: direction,
      labelKeys,
    }),
  ].filter(Boolean);
}

function createGridLabelSprite({
  text,
  point,
  offsetDirection,
  labelKeys,
}) {
  const key = createGridLabelKey(text, point);

  if (labelKeys.has(key)) {
    return null;
  }

  labelKeys.add(key);

  const { texture, aspectRatio } = createGridLabelTexture(text);
  const material = new THREE.SpriteMaterial({
    map: texture,
    transparent: true,
    depthTest: false,
    depthWrite: false,
  });
  const sprite = new THREE.Sprite(material);
  const offset = offsetDirection.lengthSq() > 0
    ? offsetDirection.clone().multiplyScalar(GRID_LABEL_WORLD_HEIGHT * 0.85)
    : new THREE.Vector3();

  sprite.name = `ifc-grid-label-${text}`;
  sprite.position
    .set(point.x, point.y, point.z)
    .add(offset);
  sprite.scale.set(
    GRID_LABEL_WORLD_HEIGHT * aspectRatio,
    GRID_LABEL_WORLD_HEIGHT,
    1
  );
  sprite.frustumCulled = false;
  sprite.renderOrder = GRID_LABEL_RENDER_ORDER;

  return sprite;
}

function createGridLabelTexture(text) {
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d");
  const fontSize = 44;
  const horizontalPadding = 22;
  const verticalPadding = 14;
  const borderRadius = 16;

  context.font = `700 ${fontSize}px Inter, Arial, sans-serif`;

  const textMetrics = context.measureText(text);
  const width = Math.ceil(textMetrics.width + horizontalPadding * 2);
  const height = fontSize + verticalPadding * 2;
  const pixelRatio = Math.max(1, window.devicePixelRatio || 1);

  canvas.width = width * pixelRatio;
  canvas.height = height * pixelRatio;
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;

  context.scale(pixelRatio, pixelRatio);
  context.clearRect(0, 0, width, height);
  context.fillStyle = GRID_LABEL_BACKGROUND;
  drawRoundedRectangle(context, 0, 0, width, height, borderRadius);
  context.fill();
  context.font = `700 ${fontSize}px Inter, Arial, sans-serif`;
  context.fillStyle = GRID_LABEL_TEXT;
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.fillText(text, width / 2, height / 2 + 1);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;

  return {
    texture,
    aspectRatio: width / height,
  };
}

function drawRoundedRectangle(context, x, y, width, height, radius) {
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

function createGridLabelKey(text, point) {
  return [
    text.trim().toUpperCase(),
    roundCoordinate(point.x),
    roundCoordinate(point.y),
    roundCoordinate(point.z),
  ].join("|");
}

function roundCoordinate(value) {
  return Math.round(Number(value) * 1000) / 1000;
}

function pointToVector(point) {
  return new THREE.Vector3(point.x, point.y, point.z);
}

/* -------------------------------------------------------------------------- */
/*                                 HELPERS                                    */
/* -------------------------------------------------------------------------- */

async function getCoordinationMatrix(fragmentModel) {
  try {
    const matrix = await fragmentModel?.getCoordinationMatrix?.();

    if (matrix?.isMatrix4) {
      return matrix.clone();
    }

    if (
      Array.isArray(matrix) ||
      matrix instanceof Float32Array ||
      matrix instanceof Float64Array
    ) {
      return new THREE.Matrix4().fromArray(matrix);
    }
  } catch (error) {
    console.warn(
      `${LOG_PREFIX} Could not read Fragments coordination matrix.`,
      error
    );
  }

  return new THREE.Matrix4();
}

function getGridElevation(grid) {
  const elevations = [];

  for (const axis of grid.axes) {
    for (const point of axis.points) {
      elevations.push(point.y);
    }
  }

  if (elevations.length === 0) {
    return 0;
  }

  return (
    elevations.reduce((total, elevation) => total + elevation, 0) /
    elevations.length
  );
}

function getModelBounds(model) {
  const box = model?.box?.isBox3
    ? model.box
    : new THREE.Box3().setFromObject(
        model?.object ?? new THREE.Object3D()
      );

  if (box.isEmpty()) {
    return null;
  }

  return {
    min: {
      x: box.min.x,
      y: box.min.y,
      z: box.min.z,
    },
    max: {
      x: box.max.x,
      y: box.max.y,
      z: box.max.z,
    },
  };
}

function getCartesianPoint(point) {
  const coordinates = unwrapIfcValue(point?.Coordinates);

  if (!Array.isArray(coordinates) || coordinates.length < 2) {
    return null;
  }

  return {
    x: Number(getIfcValue(coordinates[0])) || 0,
    y: Number(getIfcValue(coordinates[1])) || 0,
    z: Number(getIfcValue(coordinates[2])) || 0,
    dimension: coordinates.length,
  };
}

function getDirection(direction) {
  const ratios = unwrapIfcValue(direction?.DirectionRatios);

  if (!Array.isArray(ratios) || ratios.length < 2) {
    return new THREE.Vector3(1, 0, 0);
  }

  const vector = new THREE.Vector3(
    Number(getIfcValue(ratios[0])) || 0,
    Number(getIfcValue(ratios[1])) || 0,
    Number(getIfcValue(ratios[2])) || 0
  );

  return vector.lengthSq() > 1e-12
    ? vector.normalize()
    : new THREE.Vector3(1, 0, 0);
}

function getIfcTypeName(api, entity) {
  try {
    return api.GetNameFromTypeCode?.(entity?.type) ?? String(entity?.type);
  } catch {
    return String(entity?.type);
  }
}

function getReferenceIds(value) {
  const unwrapped = unwrapIfcValue(value);

  if (!Array.isArray(unwrapped)) {
    const id = getReferenceId(unwrapped);

    return id ? [id] : [];
  }

  return unwrapped
    .map(getReferenceId)
    .filter(Boolean);
}

function getReferenceId(value) {
  const unwrapped = unwrapIfcValue(value);

  if (typeof unwrapped === "number") {
    return unwrapped;
  }

  if (!unwrapped || typeof unwrapped !== "object") {
    return null;
  }

  return (
    unwrapped.expressID ??
    unwrapped.ExpressID ??
    unwrapped.id ??
    unwrapped.ID ??
    unwrapped.value ??
    null
  );
}

function getIfcValue(value) {
  return unwrapIfcValue(value);
}

function unwrapIfcValue(value) {
  if (
    value &&
    typeof value === "object" &&
    "value" in value
  ) {
    return value.value;
  }

  return value;
}

function vectorToArray(vector) {
  const size =
    typeof vector?.size === "function"
      ? vector.size()
      : vector?.size;

  if (typeof size !== "number") {
    return Array.from(vector ?? []);
  }

  return Array.from(
    { length: size },
    (_, index) => vector.get(index)
  );
}

function renderWorld(world) {
  try {
    world.renderer.three.render(
      world.scene.three,
      world.camera.three
    );
  } catch {
    // The normal renderer update loop will render on the next frame.
  }
}
