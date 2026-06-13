import "./style.css";
import * as OBC from "@thatopen/components";
import { getUI, setStatus } from "./app/ui.js";
import { setupWorld } from "./viewer/setupWorld.js";
import { loadIfcFromFile } from "./viewer/loadIfc.js";
import { initSelection } from "./viewer/selection.js";
import { createStagingManager } from "./viewer/staging.js";
import {
  initClipping,
  toggleClippingEnabled,
  clearClippingPlanes,
} from "./viewer/clipper.js";
import { saveProjectFile, readProjectFile } from "./app/projectStorage.js";
import { createLiftLabelManager } from "./viewer/liftLabels.js";
import { initMeasurements } from "./viewer/measurements.js";
import { softResetFragmentVisualState } from "./viewer/fragmentVisualReset.js";

import { toPng } from "html-to-image";
import {
  cropWhitespaceFromImage,
  exportStageImageToPdf,
  exportMultipleStageImagesToPdf,
} from "./app/pdfExport.js";
import * as THREE from "three";

const ui = getUI();

const PDF_EXPORT_PIXEL_RATIO = 1.5;
const PDF_EXPORT_SETTLE_FRAMES = 4;
const PDF_CAPTURE_TIMEOUT_MS = 20000;
const PDF_CROP_TIMEOUT_MS = 15000;
const FRAGMENT_STYLE_CHUNK_SIZE = 1000;
const FRAGMENT_STYLE_MIN_CHUNK_SIZE = 25;
const PDF_EXPORT_USE_OPACITY = false;
const PDF_EXPORT_CONTEXT_RENDER_MODE = "override-material-experiment";
const PDF_EXPORT_RENDER_MODES = {
  fragmentColors: "fragment-colors",
  overrideMaterialExperiment: "override-material-experiment",
};
const PDF_EXPORT_GREY_CONTEXT_OPACITY = 0.25;
const PDF_EXPORT_COLORS = {
  context: "#999999",
  previous: "#00b050",
  current: "#ff0000",
};
const PDF_EXPORT_GREY_CONTEXT_MATERIAL = new THREE.MeshBasicMaterial({
  color: PDF_EXPORT_COLORS.context,
  transparent: true,
  opacity: PDF_EXPORT_GREY_CONTEXT_OPACITY,
  depthTest: true,
  depthWrite: false,
});

let components = null;
let world = null;
let orbitControls = null;
let fragments = null;
let currentModel = null;
let currentIfcFile = null;

let selection = null;
let measurements = null;
let activeMeasurementTool = null;
let mode = "staging";
let showContext = false;

let viewpoints = null;
let liftLabels = null;

let showLiftLabels = false;
let isPdfExporting = false;
let pdfExportRunNumber = 0;

const staging = createStagingManager();

// Temporary debug helper so we can inspect staging from DevTools
window.staging = staging;

async function startApp() {
  const setup = await setupWorld(ui.viewerContainer);

  components = setup.components;
  world = setup.world;
  orbitControls = setup.orbitControls;
  fragments = setup.fragments;

  viewpoints = components.get(OBC.Viewpoints);
  viewpoints.world = world;

  // Temporary debug helpers so we can inspect viewer objects from DevTools
  window.components = components;
  window.world = world;
  window.fragments = fragments;

  window.debugFragmentModelMethods = () => {
    const firstModel = [...fragments.list.values()][0];

    if (!firstModel) {
      console.log("No fragment model loaded yet.");
      return null;
    }

    const methodNames = new Set();

    let currentObject = firstModel;

    while (currentObject && currentObject !== Object.prototype) {
      const names = Reflect.ownKeys(currentObject);

      for (const name of names) {
        if (typeof name !== "string") continue;

        const value = firstModel[name];

        if (typeof value === "function") {
          methodNames.add(name);
        }
      }

      currentObject = Object.getPrototypeOf(currentObject);
    }

    const allMethods = [...methodNames].sort();

    const colourRelatedMethods = allMethods.filter((name) => {
      const lowerName = name.toLowerCase();

      return (
        lowerName.includes("color") ||
        lowerName.includes("colour") ||
        lowerName.includes("material") ||
        lowerName.includes("style") ||
        lowerName.includes("opacity") ||
        lowerName.includes("highlight")
      );
    });

    console.log("Fragment model:", firstModel);
    console.log("All fragment model methods:", allMethods);
    console.log("Colour/material/opacity methods:", colourRelatedMethods);

    console.log("Direct checks:", {
      setOpacity: typeof firstModel.setOpacity,
      resetOpacity: typeof firstModel.resetOpacity,
      setColor: typeof firstModel.setColor,
      resetColor: typeof firstModel.resetColor,
      setMaterial: typeof firstModel.setMaterial,
      resetMaterial: typeof firstModel.resetMaterial,
    });

    return {
      allMethods,
      colourRelatedMethods,
    };
  };

  liftLabels = createLiftLabelManager({
    components,
    world,
    fragments,
    onLabelPositionChanged: ({ stageId, liftId, position }) => {
      const result = staging.setLiftLabelPosition(stageId, liftId, position);

      if (!result.ok) {
        console.warn("Failed to save lift label position:", result.reason);
        return;
      }

      setStatus("Lift label position updated.");
    },
  });

  measurements = initMeasurements({
    components,
    world,
    ui,
    onActiveToolChanged: (toolName) => {
      activeMeasurementTool = toolName;
    },
  });

  selection = initSelection({
    components,
    world,
    fragments,
    ui,

    // Prevent selection/highlight changes while the model is temporarily dressed
    // for PDF export or while a measurement tool is taking pointer input.
    canSelect: () => !isPdfExporting && !activeMeasurementTool,
  });

  await initClipping({
    components,
    world,
    container: ui.viewerArea,
  });

  window.debugLiftLabelState = () => {
    const labelStages = getLabelStagesForCurrentSlider();
    const domLabels = [...document.querySelectorAll(".lift-marker")].map(
      (element) => element.textContent
    );

    console.log({
      mode,
      showLiftLabels,
      currentSliderValue: ui.stageSlider.value,
      labelStages,
      domLabels,
    });

    return {
      mode,
      showLiftLabels,
      currentSliderValue: ui.stageSlider.value,
      labelStages,
      domLabels,
    };
  };

  window.clearLiftLabels = () => {
    console.log("Clearing lift labels...");

    liftLabels.clear();

    return "clearLiftLabels ran";
  };

  renderStagingUI();
}

await startApp();

// -----------------------------------------------------------------------------
// Main IFC loading
// -----------------------------------------------------------------------------

ui.loadButton.addEventListener("click", async () => {
  const file = ui.fileInput.files[0];

  if (!file) {
    setStatus("Please choose an IFC file first.");
    return;
  }

  enterStagingMode();

  const loadedModel = await loadIfcFileIntoViewer(file);

  if (!loadedModel) {
    return;
  }

  await resetViewerVisualState();

  setStatus(`Loaded new IFC: ${file.name}`);
});

async function loadIfcFileIntoViewer(file) {
  if (!file) {
    setStatus("No IFC file provided.");
    return null;
  }

  currentIfcFile = file;

  showLoadingOverlay();

  try {
    setStatus("Loading IFC...");

    currentModel = await loadIfcFromFile(
      components,
      file,
      updateLoadingProgress
    );

    await waitForFragmentsReady();
    await resetViewerVisualState();
    await waitForFragmentsReady();

    ui.saveProjectButton.disabled = false;

    try {
      await world.camera.fitToItems();
      await fragments.core.update(true);
    } catch (cameraError) {
      console.warn("Model loaded, but camera fit failed:", cameraError);
    }

    setStatus(`Loaded: ${file.name}`);
    console.log("Loaded model:", currentModel);

    return currentModel;
  } catch (error) {
    console.error("Failed inside loadIfcFileIntoViewer:", error);
    setStatus("Failed to load IFC file.");
    return null;
  } finally {
    hideLoadingOverlay();
  }
}

// -----------------------------------------------------------------------------
// Stage controls
// -----------------------------------------------------------------------------

ui.addStageButton.addEventListener("click", async () => {
  const stageNumber = staging.getStages().length + 1;
  const stage = staging.createStage(`Stage ${stageNumber}`);

  staging.setActiveStage(stage.id);

  renderStagingUI();
  setSliderToStageIndex(staging.getStages().length - 1);

  setStatus(`Created ${stage.name}.`);
  console.log("Created stage:", stage);
  console.log("Staging state:", staging.debugState());
});

ui.assignStageButton.addEventListener("click", async () => {
  if (isPdfExporting) {
    setStatus("Wait for PDF export to finish before assigning stages.");
    return;
  }

  const stages = staging.getStages();

  if (stages.length === 0) {
    setStatus("Create a stage first.");
    return;
  }

  const currentSelection = selection.getSelectedItem();

  if (!currentSelection) {
    setStatus("Select some elements first.");
    return;
  }

  const currentStageIndex = Number(ui.stageSlider.value);
  const currentStage = stages[currentStageIndex];

  if (!currentStage) {
    setStatus("No current stage selected.");
    return;
  }

  const result = staging.assignSelectionToStage(
    currentStage.id,
    currentSelection
  );

  if (!result.ok) {
    setStatus(`Stage assignment failed: ${result.reason}`);
    return;
  }

  renderStagingUI();
  setSliderToStageIndex(currentStageIndex);

  await showCurrentSliderStage();
  await selection.clearSelection();

  setStatus(`Assigned selection to ${currentStage.name}.`);
  console.log("Assigned selection:", currentStage.name);
  console.log("Staging state:", staging.debugState());
});

ui.createLiftButton.addEventListener("click", async () => {
  if (isPdfExporting) {
    setStatus("Wait for PDF export to finish before creating lifts.");
    return;
  }

  const activeStageId = staging.getActiveStageId();

  if (!activeStageId) {
    setStatus("Create a stage or select an active stage first.");
    return;
  }

  const currentSelection = selection.getSelectedItem();

  const result = staging.createLiftFromSelection(
    activeStageId,
    currentSelection
  );

  if (!result.ok) {
    setStatus(result.reason);
    return;
  }

  setStatus(`${result.lift.name} created.`);

  renderStagingUI();
  renderStageSummary(staging.getStages());

  await showCurrentSliderStage();
  await selection.clearSelection();

  console.log("Lift created:", result.lift);
  console.log("Updated staging state:", staging.debugState());
});

ui.stageSummary.addEventListener("click", async (event) => {
  if (isPdfExporting) {
    setStatus("Wait for PDF export to finish before editing lifts.");
    return;
  }

  const liftActionButton = event.target.closest("[data-lift-action]");

  if (!liftActionButton) {
    return;
  }

  const action = liftActionButton.dataset.liftAction;
  const stageId = liftActionButton.dataset.stageId;
  const liftId = liftActionButton.dataset.liftId;

  if (action === "rename") {
    const lift = staging.getLiftById(stageId, liftId);

    if (!lift) {
      setStatus("Lift could not be found.");
      return;
    }

    const newName = prompt("Enter new lift name:", lift.name);

    if (newName === null) {
      return;
    }

    const result = staging.renameLift(stageId, liftId, newName);

    if (!result.ok) {
      setStatus(result.reason);
      return;
    }

    renderStagingUI();

    setStatus(`Renamed lift to "${result.lift.name}".`);
    console.log("Renamed lift:", result.lift);
    console.log("Updated staging state:", staging.debugState());

    return;
  }

  if (action === "delete") {
    const lift = staging.getLiftById(stageId, liftId);

    if (!lift) {
      setStatus("Lift could not be found.");
      return;
    }

    const confirmed = confirm(
      `Delete "${lift.name}"? This removes the lift label/grouping, but keeps its elements in the stage.`
    );

    if (!confirmed) {
      return;
    }

    const result = staging.deleteLift(stageId, liftId);

    if (!result.ok) {
      setStatus(result.reason);
      return;
    }

    renderStagingUI();

    setStatus(`Deleted "${result.deletedLift.name}".`);
    console.log("Deleted lift:", result.deletedLift);
    console.log("Updated staging state:", staging.debugState());
  }
});

ui.stageSlider.addEventListener("input", async () => {
  if (isPdfExporting) {
    return;
  }

  await showCurrentSliderStage();
});

ui.renameStageButton.addEventListener("click", () => {
  if (isPdfExporting) {
    setStatus("Wait for PDF export to finish before renaming stages.");
    return;
  }

  const activeStageId = staging.getActiveStageId();

  if (!activeStageId) {
    setStatus("No active stage selected.");
    return;
  }

  const stage = staging.getStageById(activeStageId);

  if (!stage) {
    setStatus("Active stage could not be found.");
    return;
  }

  const newName = prompt("Enter new stage name:", stage.name);

  if (newName === null) {
    return;
  }

  const result = staging.renameStage(activeStageId, newName);

  if (!result.ok) {
    setStatus(result.reason);
    return;
  }

  renderStagingUI();
  setStatus(`Renamed stage to "${result.stage.name}".`);
});

ui.clearStageButton.addEventListener("click", async () => {
  if (isPdfExporting) {
    setStatus("Wait for PDF export to finish before clearing stages.");
    return;
  }

  const activeStageId = staging.getActiveStageId();

  if (!activeStageId) {
    setStatus("No active stage selected.");
    return;
  }

  const stage = staging.getStageById(activeStageId);

  if (!stage) {
    setStatus("Active stage could not be found.");
    return;
  }

  const confirmed = confirm(
    `Clear all assigned elements from "${stage.name}"?`
  );

  if (!confirmed) {
    return;
  }

  const result = staging.clearStage(activeStageId);

  if (!result.ok) {
    setStatus(result.reason);
    return;
  }

  renderStagingUI();
  await showCurrentSliderStage();

  setStatus(`Cleared all assigned elements from "${result.stage.name}".`);
});

ui.deleteStageButton.addEventListener("click", async () => {
  if (isPdfExporting) {
    setStatus("Wait for PDF export to finish before deleting stages.");
    return;
  }

  const activeStageId = staging.getActiveStageId();

  if (!activeStageId) {
    setStatus("No active stage selected.");
    return;
  }

  const stage = staging.getStageById(activeStageId);

  if (!stage) {
    setStatus("Active stage could not be found.");
    return;
  }

  const confirmed = confirm(
    `Delete "${stage.name}"? This cannot be undone.`
  );

  if (!confirmed) {
    return;
  }

  const result = staging.deleteStage(activeStageId);

  if (!result.ok) {
    setStatus(result.reason);
    return;
  }

  if (result.activeStageId) {
    setSliderToStageId(result.activeStageId);
  }

  renderStagingUI();
  await showCurrentSliderStage();

  setStatus(`Deleted "${result.deletedStage.name}".`);
});

ui.toggleModeButton.addEventListener("click", async () => {
  if (isPdfExporting) {
    setStatus("Wait for PDF export to finish before switching modes.");
    return;
  }

  if (mode === "staging") {
    enterSequencingMode();

    await showCurrentSliderStage();
    setStatus("Sequencing mode enabled.");
    return;
  }

  enterStagingMode();

  await resetViewerVisualState();
  setStatus("Staging mode enabled (full model visible).");
});

ui.toggleContextButton.addEventListener("click", async () => {
  if (isPdfExporting) {
    setStatus("Wait for PDF export to finish before changing context view.");
    return;
  }

  showContext = !showContext;

  ui.toggleContextButton.textContent = showContext
    ? "Hide Context"
    : "Show Context";

  await showCurrentSliderStage();
});

ui.resetVisibilityButton.addEventListener("click", async () => {
  if (isPdfExporting) {
    setStatus("Wait for PDF export to finish before resetting visibility.");
    return;
  }

  try {
    await resetViewerVisualState();
    setStatus("Visibility reset.");
  } catch (error) {
    console.error("Reset visibility failed:", error);
    setStatus("Failed to reset visibility.");
  }
});

// -----------------------------------------------------------------------------
// Project save / open
// -----------------------------------------------------------------------------

ui.saveProjectButton.addEventListener("click", async () => {
  if (isPdfExporting) {
    setStatus("Wait for PDF export to finish before saving.");
    return;
  }

  if (!currentIfcFile) {
    setStatus("Load an IFC file before saving the project.");
    return;
  }

  try {
    const stagingSnapshot = staging.createSnapshot();
    console.log("Staging snapshot:", stagingSnapshot);

    const projectName = currentIfcFile.name.replace(/\.ifc$/i, "");

    await saveProjectFile({
      ifcFile: currentIfcFile,
      stagingSnapshot,
      projectName,
    });

    setStatus("Project saved.");
  } catch (error) {
    console.error("Failed to save project:", error);
    setStatus("Failed to save project.");
  }
});

ui.projectFileInput.addEventListener("change", async () => {
  if (isPdfExporting) {
    setStatus("Wait for PDF export to finish before opening another project.");
    return;
  }

  console.log("1. Project file input changed");

  const projectFile = ui.projectFileInput.files[0];

  console.log("2. Selected project file:", projectFile);

  if (!projectFile) {
    console.log("No project file selected. Stopping.");
    return;
  }

  try {
    setStatus("Opening project file...");
    console.log("3. About to read project file");

    const projectData = await readProjectFile(projectFile);

    console.log("4. Project file read successfully:", projectData);
    console.log(
      "5. Project stage count:",
      projectData.stagingSnapshot?.stages?.length
    );

    console.log("6. About to load extracted IFC file");

    const loadedModel = await loadIfcFileIntoViewer(projectData.ifcFile);

    console.log("7. Extracted IFC load finished:", loadedModel);

    if (!loadedModel) {
      console.log("Loaded model was null. Stopping before restore.");
      setStatus("Project file was read, but the IFC model could not be loaded.");
      return;
    }

    await waitForFragmentsReady();
    await resetViewerVisualState();

    console.log("8. About to restore staging snapshot");

    const restoreResult = staging.restoreFromSnapshot(
      projectData.stagingSnapshot
    );

    console.log("9. RESTORE RESULT:", restoreResult);

    if (!restoreResult.ok) {
      setStatus(
        `Project opened, but staging could not be restored: ${restoreResult.reason}`
      );
      return;
    }

    renderStagingUI();
    enterSequencingMode();

    const didSetSlider = setSliderToStageId(
      projectData.stagingSnapshot.activeStageId
    );

    if (!didSetSlider) {
      setSliderToStageIndex(0);
    }

    await waitForFragmentsReady();

    console.log("17. About to show current slider stage");

    await showCurrentSliderStage();

    console.log("18. Project open workflow complete");

    setStatus(`Opened project: ${projectData.manifest.ifcFileName}`);
  } catch (error) {
    console.error("FAILED SOMEWHERE IN OPEN PROJECT WORKFLOW:", error);
    setStatus("Failed to open project file.");
  }
});

// -----------------------------------------------------------------------------
// Clipping controls
// -----------------------------------------------------------------------------

ui.toggleClippingButton.addEventListener("click", () => {
  if (isPdfExporting) {
    setStatus("Wait for PDF export to finish before changing clipping.");
    return;
  }

  const enabled = toggleClippingEnabled();

  ui.toggleClippingButton.textContent = enabled
    ? "Exit Clipping Mode"
    : "Enter Clipping Mode";

  setStatus(
    enabled
      ? "Clipping mode active. Double-click the model to create a section cut."
      : "Clipping mode off."
  );
});

ui.clearClippingButton.addEventListener("click", () => {
  if (isPdfExporting) {
    setStatus("Wait for PDF export to finish before clearing clipping planes.");
    return;
  }

  clearClippingPlanes();
  setStatus("Clipping planes cleared.");
});

// -----------------------------------------------------------------------------
// File input UI
// -----------------------------------------------------------------------------

ui.fileInput.addEventListener("change", () => {
  const file = ui.fileInput.files[0];
  const nameEl = document.getElementById("fileName");

  nameEl.textContent = file ? file.name : "No file selected";
});

// -----------------------------------------------------------------------------
// Viewer state helpers
// -----------------------------------------------------------------------------

function enterStagingMode() {
  mode = "staging";
  showContext = false;
  showLiftLabels = false;
  liftLabels?.clear();

  ui.toggleModeButton.textContent = "Switch to Sequencing";
  ui.stagingTimeline.classList.add("is-hidden");
  ui.toggleContextButton.textContent = "Show Context";

  if (ui.toggleLiftLabelsButton) {
    ui.toggleLiftLabelsButton.textContent = "Show Lift Labels";
  }
}

function enterSequencingMode() {
  mode = "sequencing";
  showLiftLabels = false;

  liftLabels?.clear();

  ui.toggleModeButton.textContent = "Switch to Staging";
  ui.stagingTimeline.classList.remove("is-hidden");

  if (ui.toggleLiftLabelsButton) {
    ui.toggleLiftLabelsButton.textContent = "Show Lift Labels";
  }
}

async function resetViewerVisualState() {
  const hider = components.get(OBC.Hider);

  await hider.set(true);

  await fragments.resetHighlight();

  for (const [, model] of fragments.list) {
    await model.resetColor();
    await model.resetOpacity();
  }

  await fragments.core.update(true);
}

async function resetAllOpacity() {
  for (const [, model] of fragments.list) {
    await model.resetOpacity();
  }

  await fragments.core.update(true);
}

async function resetPdfExportFragmentStyles(
  context = null,
  reason = "unknown",
  {
    componentsManager = components,
    fragmentsManager = fragments,
    worldOverride = world,
    hider: hiderOverride = null,
  } = {}
) {
  let hider = hiderOverride;

  if (!hider) {
    try {
      hider = componentsManager?.get?.(OBC.Hider) ?? null;
    } catch (error) {
      logPdfExportBreadcrumb(
        context,
        "Could not get Hider for soft fragment reset. Continuing without visibility reset.",
        { reason, error: getErrorDetails(error) },
        "warn"
      );
    }
  }

  const result = await softResetFragmentVisualState({
    fragments: fragmentsManager,
    hider,
    highlighter: null,
    world: worldOverride,
    renderer: worldOverride?.renderer,
    reason,
  });

  logPdfExportBreadcrumb(
    context,
    result.ok
      ? "Soft reset fragment visual state completed."
      : "Soft reset fragment visual state completed with warnings.",
    result,
    result.ok ? "log" : "warn"
  );

  return result;
}

async function waitForFragmentsReady(fragmentsManager = fragments) {
  await fragmentsManager.core.update(true);

  await new Promise((resolve) => requestAnimationFrame(resolve));
  await new Promise((resolve) => requestAnimationFrame(resolve));

  await fragmentsManager.core.update(true);
}

async function waitForAnimationFrames(count = 1) {
  for (let i = 0; i < count; i++) {
    await new Promise((resolve) => requestAnimationFrame(resolve));
  }
}

/**
 * This helper is used immediately before screenshot capture.
 *
 * Why it exists:
 * PDF export changes several independent systems:
 * - fragment colours
 * - camera/viewpoint
 * - lift-label DOM markers
 * - CSS export class
 * - renderer background
 *
 * A normal await after each operation is not always enough for the browser to
 * visually settle. This helper gives the renderer and DOM a final stable frame
 * before html-to-image captures the viewer.
 */
async function waitForStableExportFrame({
  frames = 6,
  fragmentsManager = fragments,
  worldOverride = world,
} = {}) {
  await fragmentsManager.core.update(true);

  for (let i = 0; i < frames; i++) {
    await new Promise((resolve) => requestAnimationFrame(resolve));
    await fragmentsManager.core.update(true);
  }

  try {
    worldOverride.renderer.three.render(
      worldOverride.scene.three,
      worldOverride.camera.three
    );
  } catch (error) {
    console.warn("Manual export render failed. Continuing anyway.", error);
  }

  await new Promise((resolve) => requestAnimationFrame(resolve));
}

function withTimeout(promise, timeoutMs, label) {
  let timeoutId = null;

  const timeout = new Promise((_, reject) => {
    timeoutId = window.setTimeout(() => {
      reject(new Error(`${label} timed out after ${timeoutMs}ms.`));
    }, timeoutMs);
  });

  return Promise.race([promise, timeout]).finally(() => {
    window.clearTimeout(timeoutId);
  });
}

// -----------------------------------------------------------------------------
// Visibility / opacity helpers
// -----------------------------------------------------------------------------

function countItemsInModelIdMap(modelIdMap) {
  if (!modelIdMap) return 0;

  let total = 0;

  for (const localIds of Object.values(modelIdMap)) {
    total += localIds?.size ?? 0;
  }

  return total;
}

function isModelIdMapEmpty(modelIdMap) {
  if (!modelIdMap) return true;

  const modelIds = Object.keys(modelIdMap);

  if (modelIds.length === 0) return true;

  for (const modelId of modelIds) {
    const localIds = modelIdMap[modelId];

    if (localIds && localIds.size > 0) {
      return false;
    }
  }

  return true;
}

function isFragmentsMemoryOverflow(error) {
  return getErrorMessage(error).includes("Fragments: Memory overflow");
}

function getErrorMessage(error) {
  if (!error) return "";

  if (typeof error === "string") return error;

  return error.message || String(error);
}

function createPdfExportContext(label, stages = []) {
  pdfExportRunNumber += 1;

  return {
    id: `pdf-export-${pdfExportRunNumber}`,
    label,
    startedAt: new Date().toISOString(),
    stages: stages.map((stage) => ({
      id: stage.id,
      name: stage.name,
      itemCount: countItemsInModelIdMap(stage.items),
      liftCount: stage.lifts?.length ?? 0,
    })),
  };
}

function summarizeModelIdMap(modelIdMap) {
  const byModel = {};
  let total = 0;

  for (const [modelId, localIds] of Object.entries(modelIdMap ?? {})) {
    const ids = [...(localIds ?? [])];
    total += ids.length;
    byModel[modelId] = {
      count: ids.length,
      sampleIds: ids.slice(0, 8),
    };
  }

  return {
    total,
    modelCount: Object.keys(byModel).length,
    byModel,
  };
}

function getErrorDetails(error) {
  return {
    name: error?.name,
    message: getErrorMessage(error),
    stack: error?.stack,
  };
}

function logPdfExportBreadcrumb(context, message, details = {}, level = "log") {
  if (!context) return;

  const logger = console[level] ?? console.log;

  logger(`[PDF Export][${context.id}] ${message}`, {
    trace: context,
    ...details,
  });
}

async function getAllGeometryItems(fragmentsManager = fragments) {
  const allItems = {};

  for (const [modelId, model] of fragmentsManager.list) {
    const ids = await model.getItemsIdsWithGeometry();
    allItems[modelId] = new Set(ids);
  }

  return allItems;
}

function extractRelatedIds(value, bucket = new Set()) {
  if (value == null) return bucket;

  if (typeof value === "number") {
    bucket.add(value);
    return bucket;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      extractRelatedIds(item, bucket);
    }

    return bucket;
  }

  if (typeof value === "object") {
    if (typeof value.localId === "number") bucket.add(value.localId);
    if (typeof value.LocalId === "number") bucket.add(value.LocalId);
    if (typeof value.id === "number") bucket.add(value.id);
    if (typeof value.ID === "number") bucket.add(value.ID);
    if (typeof value.value === "number") bucket.add(value.value);

    for (const nestedValue of Object.values(value)) {
      extractRelatedIds(nestedValue, bucket);
    }
  }

  return bucket;
}

async function getGeometryIdsForItem({
  model,
  localId,
  geometryIds,
  visited = new Set(),
  depth = 0,
  maxDepth = 8,
}) {
  const result = new Set();

  if (visited.has(localId)) {
    return result;
  }

  visited.add(localId);

  // Important:
  // Some IFC items are both:
  // 1. directly renderable geometry IDs, and
  // 2. parent/container IDs with child geometry.
  //
  // So do NOT return immediately just because this ID has geometry.
  // Add it, then still inspect its children.
  if (geometryIds.has(localId)) {
    result.add(localId);
  }

  if (depth >= maxDepth) {
    return result;
  }

  try {
    const [itemData] = await model.getItemsData([localId], {
      attributesDefault: true,
      relations: {
        IsDecomposedBy: { attributes: true, relations: false },
        IsNestedBy: { attributes: true, relations: false },
      },
    });

    if (!itemData) {
      return result;
    }

    const childIds = new Set([
      ...extractRelatedIds(itemData.IsDecomposedBy),
      ...extractRelatedIds(itemData.IsNestedBy),
    ]);

    for (const childId of childIds) {
      const childGeometryIds = await getGeometryIdsForItem({
        model,
        localId: childId,
        geometryIds,
        visited,
        depth: depth + 1,
        maxDepth,
      });

      for (const geometryId of childGeometryIds) {
        result.add(geometryId);
      }
    }
  } catch (error) {
    console.warn(
      `Could not resolve geometry descendants for localId ${localId}.`,
      error
    );
  }

  return result;
}

async function resolveSelectionToGeometryItems(
  selection,
  allGeometryItems,
  fragmentsManager = fragments
) {
  const resolved = {};
  const unresolved = {};
  const fallbackModelId =
    Object.keys(allGeometryItems ?? {}).length === 1
      ? Object.keys(allGeometryItems)[0]
      : null;

  for (const [modelId, localIds] of Object.entries(selection ?? {})) {
    const targetModelId =
      fragmentsManager.list.has(modelId) || !fallbackModelId
        ? modelId
        : fallbackModelId;
    const model = fragmentsManager.list.get(targetModelId);
    const geometryIds = allGeometryItems[targetModelId];

    if (!model || !geometryIds) {
      unresolved[targetModelId] = [...localIds];
      continue;
    }

    for (const localId of localIds) {
      const resolvedIds = await getGeometryIdsForItem({
        model,
        localId,
        geometryIds,
      });

      if (resolvedIds.size === 0) {
        if (!unresolved[targetModelId]) {
          unresolved[targetModelId] = [];
        }

        unresolved[targetModelId].push(localId);
        continue;
      }

      if (!resolved[targetModelId]) {
        resolved[targetModelId] = new Set();
      }

      for (const resolvedId of resolvedIds) {
        resolved[targetModelId].add(resolvedId);
      }
    }
  }

  return {
    resolved,
    unresolved,
  };
}

function subtractModelIdMap(allItems, itemsToRemove) {
  const result = {};

  for (const modelId of Object.keys(allItems)) {
    result[modelId] = new Set(allItems[modelId]);

    const removeIds = itemsToRemove?.[modelId];

    if (!removeIds) continue;

    for (const id of removeIds) {
      result[modelId].delete(id);
    }

    if (result[modelId].size === 0) {
      delete result[modelId];
    }
  }

  return result;
}

async function applyFragmentStyleInChunks({
  items,
  operationName,
  applyChunk,
  fragmentsManager = fragments,
  context = null,
  stage = null,
  bucketName = "unknown",
  update = true,
  recoverMemoryOverflow = true,
}) {
  let applied = true;

  logPdfExportBreadcrumb(context, `Starting ${operationName}.`, {
    stageId: stage?.id,
    stageName: stage?.name,
    bucketName,
    itemSummary: summarizeModelIdMap(items),
  });

  for (const [modelId, localIds] of Object.entries(items ?? {})) {
    const model = fragmentsManager.list.get(modelId);

    if (!model) {
      logPdfExportBreadcrumb(
        context,
        `Skipped ${operationName}; model was not loaded.`,
        { stageId: stage?.id, stageName: stage?.name, bucketName, modelId },
        "warn"
      );
      continue;
    }

    if (!localIds || localIds.size === 0) continue;

    const ids = [...localIds];

    for (
      let index = 0;
      index < ids.length;
      index += FRAGMENT_STYLE_CHUNK_SIZE
    ) {
      const chunk = ids.slice(index, index + FRAGMENT_STYLE_CHUNK_SIZE);
      const chunkDetails = {
        stageId: stage?.id,
        stageName: stage?.name,
        bucketName,
        modelId,
        operationName,
        chunkStart: index,
        chunkEnd: index + chunk.length - 1,
        chunkSize: chunk.length,
        totalModelItems: ids.length,
        sampleIds: chunk.slice(0, 8),
      };

      logPdfExportBreadcrumb(context, `Applying ${operationName} chunk.`, {
        chunk: chunkDetails,
      });

      const chunkApplied = await applyFragmentStyleChunkWithRecovery({
        operationName,
        applyChunk,
        model,
        modelId,
        chunk,
        index,
        ids,
        chunkDetails,
        context,
        recoverMemoryOverflow,
      });

      if (!chunkApplied) {
        applied = false;
      }
    }
  }

  if (update) {
    await fragmentsManager.core.update(true);
  }

  return applied;
}

async function applyFragmentStyleChunkWithRecovery({
  operationName,
  applyChunk,
  model,
  modelId,
  chunk,
  index,
  ids,
  chunkDetails,
  context = null,
  recoverMemoryOverflow = true,
}) {
  try {
    await applyChunk({ model, modelId, chunk, index, ids });
    return true;
  } catch (error) {
    if (!recoverMemoryOverflow || !isFragmentsMemoryOverflow(error)) {
      logPdfExportBreadcrumb(
        context,
        `${operationName} failed.`,
        {
          chunk: chunkDetails,
          error: getErrorDetails(error),
        },
        "error"
      );
      throw error;
    }

    if (chunk.length > FRAGMENT_STYLE_MIN_CHUNK_SIZE) {
      const splitIndex = Math.ceil(chunk.length / 2);
      const firstChunk = chunk.slice(0, splitIndex);
      const secondChunk = chunk.slice(splitIndex);

      logPdfExportBreadcrumb(
        context,
        `${operationName} chunk hit the fragments memory budget. Retrying with smaller chunks.`,
        {
          chunk: chunkDetails,
          retryChunkSizes: [firstChunk.length, secondChunk.length],
          error: getErrorDetails(error),
        },
        "warn"
      );

      const firstApplied = await applyFragmentStyleChunkWithRecovery({
        operationName,
        applyChunk,
        model,
        modelId,
        chunk: firstChunk,
        index,
        ids,
        chunkDetails: {
          ...chunkDetails,
          chunkEnd: chunkDetails.chunkStart + firstChunk.length - 1,
          chunkSize: firstChunk.length,
          sampleIds: firstChunk.slice(0, 8),
        },
        context,
        recoverMemoryOverflow,
      });

      const secondApplied = await applyFragmentStyleChunkWithRecovery({
        operationName,
        applyChunk,
        model,
        modelId,
        chunk: secondChunk,
        index: index + splitIndex,
        ids,
        chunkDetails: {
          ...chunkDetails,
          chunkStart: chunkDetails.chunkStart + splitIndex,
          chunkEnd: chunkDetails.chunkEnd,
          chunkSize: secondChunk.length,
          sampleIds: secondChunk.slice(0, 8),
        },
        context,
        recoverMemoryOverflow,
      });

      return firstApplied && secondApplied;
    }

    if (context && operationName.startsWith("setOpacity")) {
      context.opacityDisabled = true;
    }

    logPdfExportBreadcrumb(
      context,
      `${operationName} chunk hit the fragments memory budget and will be skipped.`,
      {
        chunk: chunkDetails,
        error: getErrorDetails(error),
      },
      "warn"
    );

    return false;
  }
}

async function setOpacityForItems(
  items,
  opacity,
  {
    update = true,
    context = null,
    stage = null,
    bucketName = "unknown",
    fragmentsManager = fragments,
  } = {}
) {
  if (context?.opacityDisabled) {
    logPdfExportBreadcrumb(
      context,
      "Skipped opacity because this export run already exceeded the fragments opacity memory budget.",
      {
        stageId: stage?.id,
        stageName: stage?.name,
        bucketName,
        opacity,
        itemSummary: summarizeModelIdMap(items),
      },
      "warn"
    );

    return false;
  }

  return applyFragmentStyleInChunks({
    items,
    operationName: `setOpacity(${opacity})`,
    applyChunk: async ({ model, chunk }) => {
      await model.setOpacity(chunk, opacity);
    },
    fragmentsManager,
    context,
    stage,
    bucketName,
    update,
    recoverMemoryOverflow: true,
  });
}

function mergeModelIdMaps(...maps) {
  const merged = {};

  for (const map of maps) {
    if (!map) continue;

    for (const [modelId, localIds] of Object.entries(map)) {
      if (!merged[modelId]) {
        merged[modelId] = new Set();
      }

      for (const localId of localIds) {
        merged[modelId].add(localId);
      }
    }
  }

  return merged;
}

function subtractManyModelIdMaps(allItems, mapsToRemove) {
  const result = {};

  for (const [modelId, allLocalIds] of Object.entries(allItems)) {
    result[modelId] = new Set(allLocalIds);

    for (const mapToRemove of mapsToRemove) {
      const removeLocalIds = mapToRemove?.[modelId];

      if (!removeLocalIds) continue;

      for (const localId of removeLocalIds) {
        result[modelId].delete(localId);
      }
    }

    if (result[modelId].size === 0) {
      delete result[modelId];
    }
  }

  return result;
}

function assertExportBucketsCoverAllGeometry({
  allGeometryItems,
  currentGeometryItems,
  previousOnlyItems,
  remainderItems,
}) {
  const combinedExportItems = mergeModelIdMaps(
    currentGeometryItems,
    previousOnlyItems,
    remainderItems
  );

  const missingItems = subtractModelIdMap(
    allGeometryItems,
    combinedExportItems
  );

  const missingCount = countItemsInModelIdMap(missingItems);

  if (missingCount > 0) {
    console.warn("PDF export bucket coverage warning:", {
      missingCount,
      missingItems,
    });

    return false;
  }

  return true;
}

function getPreviousStageItems(stageId) {
  const debugState = staging.debugState();
  const targetIndex = debugState.stages.findIndex(
    (stage) => stage.id === stageId
  );

  if (targetIndex === -1) {
    return {};
  }

  const previousStageMaps = debugState.stages
    .slice(0, targetIndex)
    .map((stage) => stage.items);

  return mergeModelIdMaps(...previousStageMaps);
}

function createPdfExportBuckets({
  stageId,
  allGeometryItems,
  currentGeometryItems,
  previousGeometryItems,
  unresolvedCurrentItems = {},
  unresolvedPreviousItems = {},
  rawCurrentItems = {},
  rawPreviousItems = {},
}) {
  // Current stage should visually win over previous stages.
  const previousOnlyItems = subtractModelIdMap(
    previousGeometryItems,
    currentGeometryItems
  );

  const remainderItems = subtractManyModelIdMaps(allGeometryItems, [
    previousOnlyItems,
    currentGeometryItems,
  ]);

  const exportBucketsCoverAllGeometry = assertExportBucketsCoverAllGeometry({
    allGeometryItems,
    currentGeometryItems,
    previousOnlyItems,
    remainderItems,
  });

  const bucketCounts = {
    allGeometry: countItemsInModelIdMap(allGeometryItems),
    current: countItemsInModelIdMap(currentGeometryItems),
    previous: countItemsInModelIdMap(previousOnlyItems),
    remainder: countItemsInModelIdMap(remainderItems),
    unresolvedCurrent: countItemsInModelIdMap(
      objectOfArraysToObjectOfSets(unresolvedCurrentItems)
    ),
    unresolvedPrevious: countItemsInModelIdMap(
      objectOfArraysToObjectOfSets(unresolvedPreviousItems)
    ),
    exportBucketsCoverAllGeometry,
  };

  console.log("PDF export buckets built:", {
    stageId,
    bucketCounts,
    rawCurrentItems,
    rawPreviousItems,
    currentGeometryItems,
    previousGeometryItems,
    previousOnlyItems,
    remainderItems,
    unresolvedCurrentItems,
    unresolvedPreviousItems,
  });

  if (bucketCounts.current === 0) {
    console.warn(
      "PDF export warning: current stage resolved to zero visible geometry items.",
      {
        stageId,
        rawCurrentItems,
        unresolvedCurrentItems,
      }
    );
  }

  return {
    allGeometryItems,
    currentGeometryItems,
    previousOnlyItems,
    remainderItems,
    unresolvedCurrentItems,
    unresolvedPreviousItems,
    bucketCounts,
  };
}

async function buildPdfExportBuckets(stageId, fragmentsManager = fragments) {
  const allGeometryItems = await getAllGeometryItems(fragmentsManager);

  const rawCurrentItems = staging.getStageSelection(stageId);
  const rawPreviousItems = getPreviousStageItems(stageId);

  const {
    resolved: currentGeometryItems,
    unresolved: unresolvedCurrentItems,
  } = await resolveSelectionToGeometryItems(
    rawCurrentItems,
    allGeometryItems,
    fragmentsManager
  );

  const {
    resolved: previousGeometryItems,
    unresolved: unresolvedPreviousItems,
  } = await resolveSelectionToGeometryItems(
    rawPreviousItems,
    allGeometryItems,
    fragmentsManager
  );

  return createPdfExportBuckets({
    stageId,
    allGeometryItems,
    currentGeometryItems,
    previousGeometryItems,
    unresolvedCurrentItems,
    unresolvedPreviousItems,
    rawCurrentItems,
    rawPreviousItems,
  });
}

async function buildPdfExportPlan(stages, fragmentsManager = fragments) {
  const allGeometryItems = await getAllGeometryItems(fragmentsManager);
  const resolvedStageItems = new Map();
  const unresolvedStageItems = new Map();

  for (const stage of stages) {
    const { resolved, unresolved } = await resolveSelectionToGeometryItems(
      stage.items,
      allGeometryItems,
      fragmentsManager
    );

    resolvedStageItems.set(stage.id, resolved);
    unresolvedStageItems.set(stage.id, unresolved);
  }

  const bucketsByStageId = new Map();
  let previousGeometryItems = {};
  let rawPreviousItems = {};

  for (const stage of stages) {
    const currentGeometryItems = resolvedStageItems.get(stage.id) ?? {};

    const buckets = createPdfExportBuckets({
      stageId: stage.id,
      allGeometryItems,
      currentGeometryItems,
      previousGeometryItems,
      unresolvedCurrentItems: unresolvedStageItems.get(stage.id) ?? {},
      unresolvedPreviousItems: {},
      rawCurrentItems: stage.items,
      rawPreviousItems,
    });

    bucketsByStageId.set(stage.id, buckets);
    previousGeometryItems = mergeModelIdMaps(
      previousGeometryItems,
      currentGeometryItems
    );
    rawPreviousItems = mergeModelIdMaps(rawPreviousItems, stage.items);
  }

  return bucketsByStageId;
}

function objectOfArraysToObjectOfSets(objectOfArrays) {
  const result = {};

  for (const [key, value] of Object.entries(objectOfArrays ?? {})) {
    result[key] = new Set(value);
  }

  return result;
}

async function setColorForItems(
  items,
  colorHex,
  {
    update = true,
    context = null,
    stage = null,
    bucketName = "unknown",
    fragmentsManager = fragments,
  } = {}
) {
  const color = new THREE.Color(colorHex);

  return applyFragmentStyleInChunks({
    items,
    operationName: `setColor(${colorHex})`,
    applyChunk: async ({ model, chunk }) => {
      await model.setColor(chunk, color);
    },
    fragmentsManager,
    context,
    stage,
    bucketName,
    update,
    recoverMemoryOverflow: true,
  });
}

async function applyPdfExportHighlightStyles({
  context,
  stage,
  currentGeometryItems,
  previousOnlyItems,
  fragmentsManager = fragments,
}) {
  await fragmentsManager.resetHighlight?.();

  const previousApplied = await setColorForItems(
    previousOnlyItems,
    PDF_EXPORT_COLORS.previous,
    {
      update: false,
      context,
      stage,
      bucketName: "previous-fragment-highlight",
      fragmentsManager,
    }
  );

  const currentApplied = await setColorForItems(
    currentGeometryItems,
    PDF_EXPORT_COLORS.current,
    {
      update: false,
      context,
      stage,
      bucketName: "current-fragment-highlight",
      fragmentsManager,
    }
  );

  await fragmentsManager.core.update(true);

  logPdfExportBreadcrumb(context, "Applied PDF export fragment highlights.", {
    stageId: stage?.id,
    stageName: stage?.name,
    applied: {
      previous: previousApplied,
      current: currentApplied,
    },
    itemCounts: {
      previous: countItemsInModelIdMap(previousOnlyItems),
      current: countItemsInModelIdMap(currentGeometryItems),
    },
  });

  return {
    previousApplied,
    currentApplied,
  };
}

function logFailedPdfColorBuckets({
  context,
  stage,
  bucketResults,
  bucketCounts,
}) {
  const failedBuckets = Object.entries(bucketResults)
    .filter(([, applied]) => !applied)
    .map(([bucketName]) => bucketName);

  if (failedBuckets.length === 0) {
    return;
  }

  logPdfExportBreadcrumb(
    context,
    "One or more PDF export colour buckets hit the fragments memory budget. Continuing with the colours that were applied.",
    {
      stageId: stage?.id,
      stageName: stage?.name,
      failedBuckets,
      bucketCounts,
    },
    "warn"
  );
}

async function applyPdfExportBucketStyles({
  context,
  stage,
  currentGeometryItems,
  previousOnlyItems,
  remainderItems,
  bucketCounts,
  fragmentsManager = fragments,
}) {
  let contextApplied = true;
  let previousApplied = true;
  let currentApplied = true;

  const applyContext = async () => {
    contextApplied = await setColorForItems(
      remainderItems,
      PDF_EXPORT_COLORS.context,
      {
        update: false,
        context,
        stage,
        bucketName: "context/remainder/full",
        fragmentsManager,
      }
    );
  };

  const applyPrevious = async () => {
    previousApplied = await setColorForItems(
      previousOnlyItems,
      PDF_EXPORT_COLORS.previous,
      {
        update: false,
        context,
        stage,
        bucketName: "previous",
        fragmentsManager,
      }
    );
  };

  const applyCurrent = async () => {
    currentApplied = await setColorForItems(
      currentGeometryItems,
      PDF_EXPORT_COLORS.current,
      {
        update: false,
        context,
        stage,
        bucketName: "current",
        fragmentsManager,
      }
    );
  };

  await applyContext();
  await applyPrevious();
  await applyCurrent();

  logFailedPdfColorBuckets({
    context,
    stage,
    bucketResults: {
      context: contextApplied,
      previous: previousApplied,
      current: currentApplied,
    },
    bucketCounts,
  });

  logPdfExportBreadcrumb(context, "PDF export colour bucket results.", {
    stageId: stage?.id,
    stageName: stage?.name,
    contextMode: "light-grey",
    bucketCounts,
    applied: {
      context: contextApplied,
      previous: previousApplied,
      current: currentApplied,
    },
  });

  await fragmentsManager.core.update(true);
}

function isOverrideMaterialPdfExportEnabled() {
  return (
    PDF_EXPORT_CONTEXT_RENDER_MODE ===
    PDF_EXPORT_RENDER_MODES.overrideMaterialExperiment
  );
}

function disposePdfExportOverlayScene(overlayScene) {
  if (!overlayScene) return;

  overlayScene.traverse((object) => {
    if (!object.isMesh) return;

    object.geometry?.dispose?.();

    if (Array.isArray(object.material)) {
      object.material.forEach((material) => material?.dispose?.());
    } else {
      object.material?.dispose?.();
    }
  });

  overlayScene.clear();
}

async function addPdfExportBoxOverlaysForItems({
  overlayScene,
  items,
  colorHex,
  bucketName,
  fragmentsManager = fragments,
  context = null,
  stage = null,
}) {
  const material = new THREE.MeshBasicMaterial({
    color: colorHex,
    depthTest: true,
    depthWrite: false,
  });
  let meshCount = 0;
  const skipped = [];

  for (const [modelId, localIds] of Object.entries(items ?? {})) {
    const model = fragmentsManager.list.get(modelId);

    if (!model) {
      skipped.push({ modelId, reason: "model-not-loaded" });
      continue;
    }

    for (const localId of localIds ?? []) {
      try {
        const box = await model.getMergedBox([localId]);

        if (!box?.isBox3 || box.isEmpty()) {
          skipped.push({ modelId, localId, reason: "empty-box" });
          continue;
        }

        const expandedBox = box.clone().expandByScalar(0.015);
        const size = expandedBox.getSize(new THREE.Vector3());

        if (size.lengthSq() === 0) {
          skipped.push({ modelId, localId, reason: "zero-size-box" });
          continue;
        }

        const center = expandedBox.getCenter(new THREE.Vector3());
        const geometry = new THREE.BoxGeometry(size.x, size.y, size.z);
        const mesh = new THREE.Mesh(geometry, material);

        mesh.position.copy(center);
        mesh.name = `pdf-export-${bucketName}-${modelId}-${localId}`;
        overlayScene.add(mesh);
        meshCount += 1;
      } catch (error) {
        skipped.push({
          modelId,
          localId,
          reason: "box-error",
          message: getErrorMessage(error),
        });
      }
    }
  }

  logPdfExportBreadcrumb(context, "Built PDF export overlay bucket.", {
    stageId: stage?.id,
    stageName: stage?.name,
    bucketName,
    meshCount,
    skipped: skipped.slice(0, 20),
    skippedCount: skipped.length,
  });

  return meshCount;
}

async function createPdfExportOverlayScene({
  context,
  stage,
  currentGeometryItems,
  previousOnlyItems,
  fragmentsManager = fragments,
}) {
  const overlayScene = new THREE.Scene();

  const previousMeshCount = await addPdfExportBoxOverlaysForItems({
    overlayScene,
    items: previousOnlyItems,
    colorHex: PDF_EXPORT_COLORS.previous,
    bucketName: "previous",
    fragmentsManager,
    context,
    stage,
  });

  const currentMeshCount = await addPdfExportBoxOverlaysForItems({
    overlayScene,
    items: currentGeometryItems,
    colorHex: PDF_EXPORT_COLORS.current,
    bucketName: "current",
    fragmentsManager,
    context,
    stage,
  });

  return {
    overlayScene,
    previousMeshCount,
    currentMeshCount,
  };
}

async function renderPdfExportOverrideMaterialFrame({
  visualState = null,
  fragmentsManager = fragments,
  worldOverride = world,
  frames = PDF_EXPORT_SETTLE_FRAMES,
  context = null,
  hider = components.get(OBC.Hider),
} = {}) {
  await fragmentsManager.core.update(true);
  await waitForAnimationFrames(frames);

  const threeScene = worldOverride.scene.three;
  const renderer = worldOverride.renderer.three;
  const camera = worldOverride.camera.three;
  const previousOverrideMaterial = threeScene.overrideMaterial;
  const previousAutoClear = renderer.autoClear;

  try {
    await hider.set(true);
    await fragmentsManager.core.update(true);
    await waitForAnimationFrames(1);

    threeScene.overrideMaterial = PDF_EXPORT_GREY_CONTEXT_MATERIAL;
    renderer.autoClear = true;
    renderer.render(threeScene, camera);

    threeScene.overrideMaterial = null;
    renderer.autoClear = false;

    if (
      visualState?.highlightItems &&
      !isModelIdMapEmpty(visualState.highlightItems)
    ) {
      await hider.isolate(visualState.highlightItems);
      await fragmentsManager.core.update(true);
      await waitForAnimationFrames(1);

      renderer.render(threeScene, camera);
    }

    logPdfExportBreadcrumb(
      context,
      "Rendered grey override + fragment highlight PDF frame.",
      {
        hasHighlightItems: Boolean(visualState?.highlightItems),
        highlightItemCount: countItemsInModelIdMap(
          visualState?.highlightItems
        ),
        greyMaterialColor: PDF_EXPORT_COLORS.context,
        greyOpacity: PDF_EXPORT_GREY_CONTEXT_OPACITY,
      }
    );
  } finally {
    renderer.autoClear = previousAutoClear;
    threeScene.overrideMaterial = previousOverrideMaterial;
  }
}

async function applyPdfExportVisualState(
  stage,
  preparedBuckets = null,
  context = null,
  {
    componentsManager = components,
    fragmentsManager = fragments,
    worldOverride = world,
    hider = components.get(OBC.Hider),
  } = {}
) {
  const stageId = stage.id;

  const {
    currentGeometryItems,
    previousOnlyItems,
    remainderItems,
    bucketCounts,
  } = preparedBuckets ?? (await buildPdfExportBuckets(stageId, fragmentsManager));

  logPdfExportBreadcrumb(context, "Applying PDF export visual state.", {
    stageId,
    stageName: stage.name,
    bucketCounts,
    useOpacity: PDF_EXPORT_USE_OPACITY,
  });

  await hider.set(true);
  await resetPdfExportFragmentStyles(context, "before PDF export styling", {
    componentsManager,
    fragmentsManager,
    worldOverride,
    hider,
  });

  if (isOverrideMaterialPdfExportEnabled()) {
    const highlightItems = mergeModelIdMaps(
      previousOnlyItems,
      currentGeometryItems
    );

    const highlightResults = await applyPdfExportHighlightStyles({
      context,
      stage,
      currentGeometryItems,
      previousOnlyItems,
      fragmentsManager,
    });

    await fragmentsManager.core.update(true);

    logPdfExportBreadcrumb(
      context,
      "Applied experimental override-material PDF export visual state.",
      {
        stageId,
        stageName: stage.name,
        contextMode: PDF_EXPORT_CONTEXT_RENDER_MODE,
        bucketCounts,
        highlightItemCount: countItemsInModelIdMap(highlightItems),
        highlightResults,
      }
    );

    return {
      renderMode: PDF_EXPORT_RENDER_MODES.overrideMaterialExperiment,
      highlightItems,
      dispose: async () => {
        for (const [, model] of fragmentsManager.list) {
          await model.resetColor?.();
        }

        await fragmentsManager.resetHighlight?.();
        await fragmentsManager.core.update(true);
      },
    };
  }

  await applyPdfExportBucketStyles({
    context,
    stage,
    currentGeometryItems,
    previousOnlyItems,
    remainderItems,
    bucketCounts,
    fragmentsManager,
    hider,
  });

  await waitForStableExportFrame({
    frames: PDF_EXPORT_SETTLE_FRAMES,
    fragmentsManager,
    worldOverride,
  });

  logPdfExportBreadcrumb(context, "Applied PDF export visual state.", {
    stageId,
    stageName: stage.name,
    bucketCounts,
  });

  return {
    renderMode: PDF_EXPORT_RENDER_MODES.fragmentColors,
    dispose: () => {},
  };
}

async function showCurrentSliderStage() {
  const stages = staging.getStages();

  if (stages.length === 0) {
    liftLabels?.clear();
    updateStageLabel(null, 0, 0);

    try {
      await resetViewerVisualState();
    } catch (error) {
      console.error("Failed to reset visibility with no stages:", error);
    }

    return;
  }

  const stageIndex = Number(ui.stageSlider.value);
  const stage = stages[stageIndex];

  if (!stage) {
    setStatus("Invalid stage index.");
    return;
  }

  updateStageLabel(stage, stageIndex, stages.length);
  staging.setActiveStage(stage.id);

  if (mode === "staging") {
    liftLabels?.clear();

    try {
      await resetViewerVisualState();

      if (showContext) {
        const assignedItems = mergeAllStageItems();

        if (!isModelIdMapEmpty(assignedItems)) {
          const opacityApplied = await setOpacityForItems(assignedItems, 0.15);
          if (!opacityApplied) {
            await resetAllOpacity();
          }

          setStatus(
            opacityApplied
              ? "Staging mode: assigned elements shown as transparent context."
              : "Staging mode: assigned elements shown. Transparent context was skipped for this large model."
          );
          return;
        }

        setStatus("Staging mode: no assigned elements yet.");
        return;
      }

      setStatus("Staging mode enabled. Full model visible.");
    } catch (error) {
      console.error("Failed to update staging mode view:", error);
      setStatus("Failed to update stage view.");
    }

    return;
  }

  staging.setViewMode("cumulative");

  const itemsToShow = staging.getActiveStageSelection();

  console.log("showCurrentSliderStage mode:", mode);
  console.log("showCurrentSliderStage stage:", stage);
  console.log("itemsToShow:", itemsToShow);
  console.log("itemsToShow model IDs:", Object.keys(itemsToShow ?? {}));
  console.log("loaded fragment model IDs:", [...fragments.list.keys()]);
  console.log("itemsToShow empty?", isModelIdMapEmpty(itemsToShow));

  if (isModelIdMapEmpty(itemsToShow)) {
    try {
      await resetViewerVisualState();
      await updateLiftLabelsForCurrentView();
      setStatus(`${stage.name} is empty. Showing full model.`);
    } catch (error) {
      console.error("Failed to show full model for empty stage:", error);
      setStatus("Failed to update stage view.");
    }

    return;
  }

  try {
    const hider = components.get(OBC.Hider);

    await resetAllOpacity();

    if (!showContext) {
      console.log("About to isolate items:", itemsToShow);

      await hider.isolate(itemsToShow);
      await fragments.core.update(true);
      await updateLiftLabelsForCurrentView();

      console.log("Finished isolating items.");
      setStatus(`Showing cumulative view up to ${stage.name}.`);
      return;
    }

    await hider.set(true);

    const allItems = await getAllGeometryItems();
    const contextItems = subtractModelIdMap(allItems, itemsToShow);

    const opacityApplied = await setOpacityForItems(contextItems, 0.15);
    if (!opacityApplied) {
      await resetAllOpacity();
    }

    await updateLiftLabelsForCurrentView();

    setStatus(
      opacityApplied
        ? `Showing ${stage.name} with transparent context.`
        : `Showing ${stage.name}. Transparent context was skipped for this large model.`
    );
  } catch (error) {
    console.error("Failed to show stage:", error);
    setStatus("Failed to update stage view.");
  }
}

// -----------------------------------------------------------------------------
// Staging UI helpers
// -----------------------------------------------------------------------------

function setSliderToStageIndex(index) {
  ui.stageSlider.value = String(index);
}

function setSliderToStageId(stageId) {
  const stages = staging.getStages();

  const index = stages.findIndex((stage) => stage.id === stageId);

  if (index === -1) return false;

  setSliderToStageIndex(index);
  return true;
}

function renderStagingUI() {
  const stages = staging.getStages();

  if (stages.length === 0) {
    ui.stageSlider.disabled = true;
    ui.stageSlider.min = "0";
    ui.stageSlider.max = "0";
    ui.stageSlider.value = "0";

    updateStageLabel(null, 0, 0);
    renderStageSummary(stages);
    return;
  }

  ui.stageSlider.disabled = false;
  ui.stageSlider.min = "0";
  ui.stageSlider.max = String(stages.length - 1);

  const currentValue = Number(ui.stageSlider.value);
  const clampedValue = Math.min(currentValue, stages.length - 1);

  ui.stageSlider.value = String(clampedValue);

  const activeStage = stages[clampedValue];

  updateStageLabel(activeStage, clampedValue, stages.length);
  renderStageSummary(stages);
}

function updateStageLabel(stage, index, total) {
  if (!stage) {
    ui.stageLabel.textContent = "No stages yet.";
    return;
  }

  ui.stageLabel.textContent = `Current: ${stage.name} (${index + 1} / ${total})`;
}

function renderStageSummary(stages) {
  if (stages.length === 0) {
    ui.stageSummary.innerHTML = "<p>No stages created yet.</p>";
    return;
  }

  ui.stageSummary.innerHTML = stages
    .map((stage, index) => {
      const liftsHtml =
        stage.lifts.length > 0
          ? stage.lifts
              .map((lift) => {
                return `
                  <div class="lift-summary-row">
                    <div class="lift-summary-main">
                      <span class="lift-summary-name">
                        ${lift.name} (${lift.itemCount} items)
                      </span>
                    </div>

                    <div class="lift-summary-actions">
                      <button
                        type="button"
                        class="lift-action-button"
                        data-lift-action="rename"
                        data-stage-id="${stage.id}"
                        data-lift-id="${lift.id}"
                      >
                        Rename
                      </button>

                      <button
                        type="button"
                        class="lift-action-button danger"
                        data-lift-action="delete"
                        data-stage-id="${stage.id}"
                        data-lift-id="${lift.id}"
                      >
                        Delete
                      </button>
                    </div>
                  </div>
                `;
              })
              .join("")
          : `<div class="lift-summary-empty">No lifts yet</div>`;

      return `
        <div class="stage-summary-block">
          <div class="stage-summary-row">
            Stage ${index + 1}: ${stage.name} (${stage.itemCount} items)
          </div>

          <div class="lift-summary-list">
            ${liftsHtml}
          </div>
        </div>
      `;
    })
    .join("");
}

function mergeAllStageItems() {
  const merged = {};
  const debugState = staging.debugState();

  for (const stage of debugState.stages) {
    for (const [modelId, localIds] of Object.entries(stage.items)) {
      if (!merged[modelId]) {
        merged[modelId] = new Set();
      }

      for (const id of localIds) {
        merged[modelId].add(id);
      }
    }
  }

  return merged;
}

// -----------------------------------------------------------------------------
// Loading overlay helpers
// -----------------------------------------------------------------------------

function showLoadingOverlay() {
  ui.loadingOverlay.classList.remove("is-hidden");
  ui.loadingBar.style.width = "0%";
  ui.loadingText.textContent = "Preparing file...";
}

function updateLoadingProgress(progress) {
  console.log("Loading progress value:", progress);

  let percent = 0;

  if (typeof progress === "number") {
    percent = progress <= 1 ? progress * 100 : progress;
  }

  if (typeof progress === "object" && progress !== null) {
    if ("percentage" in progress) {
      percent = progress.percentage;
    } else if ("progress" in progress) {
      percent =
        progress.progress <= 1 ? progress.progress * 100 : progress.progress;
    } else if (
      "loaded" in progress &&
      "total" in progress &&
      progress.total > 0
    ) {
      percent = (progress.loaded / progress.total) * 100;
    }
  }

  percent = Math.max(0, Math.min(100, Math.round(percent)));

  ui.loadingBar.style.width = `${percent}%`;
  ui.loadingText.textContent = `Converting IFC... ${percent}%`;
}

function hideLoadingOverlay() {
  console.log("Hiding loading overlay");

  ui.loadingOverlay.classList.add("is-hidden");
  ui.loadingBar.style.width = "0%";
  ui.loadingText.textContent = "Preparing file...";
}

// -----------------------------------------------------------------------------
// Saved stage views
// -----------------------------------------------------------------------------

ui.saveStageViewButton.addEventListener("click", async () => {
  if (isPdfExporting) {
    setStatus("Wait for PDF export to finish before saving a view.");
    return;
  }

  const activeStageId = staging.getActiveStageId();

  if (!activeStageId) {
    setStatus("No active stage selected.");
    return;
  }

  const stage = staging.getStageById(activeStageId);

  if (!stage) {
    setStatus("Active stage could not be found.");
    return;
  }

  const viewpoint = viewpoints.create();
  viewpoint.title = `${stage.name} Saved View`;

  await viewpoint.updateCamera(false);

  const viewpointData = viewpoint.toJSON();

  const result = staging.setStageView(activeStageId, viewpointData);

  if (!result.ok) {
    setStatus(result.reason);
    return;
  }

  setStatus(`Saved current view for "${result.stage.name}".`);

  console.log("Saved viewpoint data:", viewpointData);
  console.log("Staging state:", staging.debugState());
});

ui.restoreStageViewButton.addEventListener("click", async () => {
  if (isPdfExporting) {
    setStatus("Wait for PDF export to finish before restoring a view.");
    return;
  }

  const activeStageId = staging.getActiveStageId();

  if (!activeStageId) {
    setStatus("No active stage selected.");
    return;
  }

  const stage = staging.getStageById(activeStageId);

  if (!stage) {
    setStatus("Active stage could not be found.");
    return;
  }

  const savedViewData = staging.getStageView(activeStageId);

  if (!savedViewData) {
    setStatus(`No saved view found for "${stage.name}".`);
    return;
  }

  const viewpoint = viewpoints.create();
  viewpoint.title = `${stage.name} Restored View`;

  viewpoint.set(savedViewData);

  await viewpoint.go({
    transition: true,
    applyVisibility: false,
    applyClippings: false,
  });

  setStatus(`Restored saved view for "${stage.name}".`);

  console.log("Restored viewpoint data:", savedViewData);
});

// -----------------------------------------------------------------------------
// Lift label visibility
// -----------------------------------------------------------------------------

ui.toggleLiftLabelsButton.addEventListener("click", async () => {
  if (isPdfExporting) {
    setStatus("Wait for PDF export to finish before toggling lift labels.");
    return;
  }

  if (mode !== "sequencing") {
    setStatus("Lift labels are only available in sequencing mode.");
    return;
  }

  showLiftLabels = !showLiftLabels;

  ui.toggleLiftLabelsButton.textContent = showLiftLabels
    ? "Hide Lift Labels"
    : "Show Lift Labels";

  await updateLiftLabelsForCurrentView();

  setStatus(showLiftLabels ? "Lift labels shown." : "Lift labels hidden.");
});

async function updateLiftLabelsForCurrentView() {
  if (!liftLabels) {
    return;
  }

  if (mode !== "sequencing") {
    liftLabels.clear();
    return;
  }

  if (!showLiftLabels) {
    liftLabels.clear();
    return;
  }

  const labelStages = getLabelStagesForCurrentSlider();

  await liftLabels.showLiftLabelsForStages(labelStages);
}

function getLabelStagesForCurrentSlider() {
  const stages = staging.getStages();

  if (stages.length === 0) {
    return [];
  }

  const stageIndex = Number(ui.stageSlider.value);
  const summaryStage = stages[stageIndex];

  if (!summaryStage) {
    return [];
  }

  const fullStage = staging.getStageById(summaryStage.id);

  if (!fullStage) {
    return [];
  }

  return [fullStage];
}

// -----------------------------------------------------------------------------
// PDF export
// -----------------------------------------------------------------------------

ui.exportStagePdfButton.addEventListener("click", async () => {
  const stages = staging.getStages();

  if (stages.length === 0) {
    setStatus("Create a stage before exporting.");
    return;
  }

  const stageIndex = Number(ui.stageSlider.value);
  const summaryStage = stages[stageIndex];

  if (!summaryStage) {
    setStatus("No current stage selected for export.");
    return;
  }

  const fullStage = staging.getStageById(summaryStage.id);

  if (!fullStage) {
    setStatus("Could not find full stage data for export.");
    return;
  }

  await exportCurrentStagePdf(fullStage);
});

function captureCurrentViewerStateForExportRestore() {
  return {
    mode,
    showLiftLabels,
    showContext,
    sliderValue: ui.stageSlider.value,
    activeStageId: staging.getActiveStageId(),
    sceneBackground: world.scene.three.background,
    sceneOverrideMaterial: world.scene.three.overrideMaterial,
    rendererClearColor: world.renderer.three.getClearColor(new THREE.Color()),
    rendererClearAlpha: world.renderer.three.getClearAlpha(),
  };
}

async function restoreViewerAfterPdfExport(previousState, context = null) {
  logPdfExportBreadcrumb(context, "Restoring viewer after PDF export.", {
    previousMode: previousState.mode,
    previousActiveStageId: previousState.activeStageId,
  });

  ui.viewerArea.classList.remove("is-exporting");

  world.scene.three.background = previousState.sceneBackground;
  world.scene.three.overrideMaterial = previousState.sceneOverrideMaterial;
  world.renderer.three.setClearColor(
    previousState.rendererClearColor,
    previousState.rendererClearAlpha
  );

  await resetPdfExportFragmentStyles(context, "after PDF export");

  mode = previousState.mode;
  showLiftLabels = previousState.showLiftLabels;
  showContext = previousState.showContext;

  ui.stageSlider.value = previousState.sliderValue;

  if (previousState.activeStageId) {
    staging.setActiveStage(previousState.activeStageId);
  }

  if (mode === "staging") {
    ui.toggleModeButton.textContent = "Switch to Sequencing";
    ui.stagingTimeline.classList.add("is-hidden");

    ui.toggleContextButton.textContent = showContext
      ? "Hide Context"
      : "Show Context";

    if (ui.toggleLiftLabelsButton) {
      ui.toggleLiftLabelsButton.textContent = "Show Lift Labels";
    }

    liftLabels?.clear();

    await showCurrentSliderStage();
    return;
  }

  ui.toggleModeButton.textContent = "Switch to Staging";
  ui.stagingTimeline.classList.remove("is-hidden");

  ui.toggleContextButton.textContent = showContext
    ? "Hide Context"
    : "Show Context";

  if (ui.toggleLiftLabelsButton) {
    ui.toggleLiftLabelsButton.textContent = showLiftLabels
      ? "Hide Lift Labels"
      : "Show Lift Labels";
  }

  await showCurrentSliderStage();
}

async function prepareViewerForPdfExport(
  stage,
  preparedBuckets = null,
  context = null
) {
  setStatus(`Preparing PDF export for ${stage.name}...`);
  logPdfExportBreadcrumb(context, "Preparing viewer for PDF export.", {
    stageId: stage.id,
    stageName: stage.name,
    bucketCounts: preparedBuckets?.bucketCounts,
  });

  // Force the app state into export mode.
  mode = "sequencing";
  showContext = false;
  showLiftLabels = true;

  ui.toggleModeButton.textContent = "Switch to Staging";
  ui.stagingTimeline.classList.remove("is-hidden");
  ui.toggleContextButton.textContent = "Show Context";

  if (ui.toggleLiftLabelsButton) {
    ui.toggleLiftLabelsButton.textContent = "Hide Lift Labels";
  }

  setSliderToStageId(stage.id);
  staging.setActiveStage(stage.id);

  // Restore the saved stage camera first.
  // Important:
  // Camera movement can trigger fragment updates, so we do this before applying
  // the export colours.
  const usedSavedView = await restoreSavedViewForStage(stage.id, {
    transition: false,
  });

  if (!usedSavedView) {
    console.warn(
      `No saved view found for ${stage.name}. Exporting current camera view.`
    );
  }

  // Make the export background white before capture.
  world.scene.three.background = new THREE.Color("#ffffff");
  world.renderer.three.setClearColor("#ffffff", 1);

  // Hide viewer UI controls during export capture.
  ui.viewerArea.classList.add("is-exporting");

  // Update lift labels after camera is in the export position.
  await updateLiftLabelsForCurrentView();

  // Apply export visuals after camera/background/labels are ready.
  const pdfExportVisualState = await applyPdfExportVisualState(
    stage,
    preparedBuckets,
    context
  );

  if (
    pdfExportVisualState?.renderMode === PDF_EXPORT_RENDER_MODES.fragmentColors
  ) {
    await waitForStableExportFrame({ frames: PDF_EXPORT_SETTLE_FRAMES });
  }

  return pdfExportVisualState;
}

async function captureStageSheetData(
  stage,
  drawingNumber = "DRAFT-001",
  captureElement = ui.viewerArea,
  {
    fragmentsManager = fragments,
    worldOverride = world,
    visualState = null,
    context = null,
  } = {}
) {
  if (
    visualState?.renderMode ===
    PDF_EXPORT_RENDER_MODES.overrideMaterialExperiment
  ) {
    await renderPdfExportOverrideMaterialFrame({
      visualState,
      fragmentsManager,
      worldOverride,
      context,
    });
  } else {
    await waitForStableExportFrame({
      frames: PDF_EXPORT_SETTLE_FRAMES,
      fragmentsManager,
      worldOverride,
    });
  }

  const rawImageDataUrl = await withTimeout(
    toPng(captureElement, {
      cacheBust: true,
      fontEmbedCSS: "",
      pixelRatio: PDF_EXPORT_PIXEL_RATIO,
      backgroundColor: "#ffffff",
    }),
    PDF_CAPTURE_TIMEOUT_MS,
    `PDF image capture for ${stage.name}`
  );

  const croppedCapture = await withTimeout(
    cropWhitespaceFromImage(rawImageDataUrl, {
      threshold: 248,
      paddingRatio: 0.06,
    }),
    PDF_CROP_TIMEOUT_MS,
    `PDF image crop for ${stage.name}`
  );

  return {
    imageDataUrl: croppedCapture.imageDataUrl,
    imagePixelWidth: croppedCapture.width,
    imagePixelHeight: croppedCapture.height,
    stageName: stage.name,
    projectTitle: currentIfcFile?.name ?? "IFC Construction Viewer",
    sheetTitle: "CONSTRUCTION SEQUENCING",
    clientName: "CLIENT NAME",
    drawingNumber,
  };
}

async function exportCurrentStagePdf(stage) {
  if (isPdfExporting) {
    setStatus("PDF export already in progress.");
    return;
  }

  isPdfExporting = true;

  const previousState = captureCurrentViewerStateForExportRestore();
  const exportContext = createPdfExportContext("single-stage", [stage]);

  try {
    logPdfExportBreadcrumb(exportContext, "Started single-stage PDF export.");

    const preparedBuckets = await buildPdfExportBuckets(stage.id);

    logPdfExportBreadcrumb(exportContext, "Prepared single-stage export data.", {
      stageId: stage.id,
      stageName: stage.name,
      bucketCounts: preparedBuckets.bucketCounts,
    });

    let stageSheetData = null;
    let visualState = null;

    try {
      visualState = await prepareViewerForPdfExport(
        stage,
        preparedBuckets,
        exportContext
      );
      stageSheetData = await captureStageSheetData(
        stage,
        "DRAFT-001",
        ui.viewerArea,
        {
          visualState,
          context: exportContext,
        }
      );
    } finally {
      await visualState?.dispose?.();
      await resetPdfExportFragmentStyles(
        exportContext,
        "after single-stage PDF capture"
      );
    }

    exportStageImageToPdf(stageSheetData);

    logPdfExportBreadcrumb(exportContext, "Completed single-stage PDF export.");
    setStatus(`Exported PDF for ${stage.name}.`);
  } catch (error) {
    logPdfExportBreadcrumb(
      exportContext,
      "PDF export failed.",
      { error: getErrorDetails(error) },
      "error"
    );
    setStatus("PDF export failed.");
  } finally {
    try {
      await restoreViewerAfterPdfExport(previousState, exportContext);
    } catch (restoreError) {
      logPdfExportBreadcrumb(
        exportContext,
        "Failed to restore viewer after PDF export.",
        { error: getErrorDetails(restoreError) },
        "error"
      );
      setStatus("PDF export finished, but viewer restore failed.");
    } finally {
      isPdfExporting = false;
    }
  }
}

ui.exportAllStagesPdfButton.addEventListener("click", async () => {
  const stages = staging.getStages();

  if (stages.length === 0) {
    setStatus("Create stages before exporting all stages.");
    return;
  }

  await exportAllStagesPdf();
});

async function exportAllStagesPdf() {
  if (isPdfExporting) {
    setStatus("PDF export already in progress.");
    return;
  }

  isPdfExporting = true;

  const previousState = captureCurrentViewerStateForExportRestore();
  const stageSheets = [];
  const failedStages = [];
  let exportContext = null;

  try {
    const stages = staging
      .getStages()
      .map((stage) => staging.getStageById(stage.id))
      .filter(Boolean);
    exportContext = createPdfExportContext("all-stages", stages);

    setStatus(`Preparing export data for ${stages.length} stages...`);
    logPdfExportBreadcrumb(exportContext, "Started all-stages PDF export.", {
      stageCount: stages.length,
    });

    const exportPlan = await buildPdfExportPlan(stages);

    for (let index = 0; index < stages.length; index++) {
      const fullStage = stages[index];
      const preparedBuckets = exportPlan.get(fullStage.id);
      let visualState = null;

      setStatus(
        `Exporting ${fullStage.name} (${index + 1} / ${stages.length})...`
      );

      try {
        logPdfExportBreadcrumb(exportContext, "Starting stage export.", {
          stageIndex: index,
          stageId: fullStage.id,
          stageName: fullStage.name,
          bucketCounts: preparedBuckets?.bucketCounts,
        });

        visualState = await prepareViewerForPdfExport(
          fullStage,
          preparedBuckets,
          exportContext
        );

        const stageSheetData = await captureStageSheetData(
          fullStage,
          `DRAFT-${String(index + 1).padStart(3, "0")}`,
          ui.viewerArea,
          {
            visualState,
            context: exportContext,
          }
        );

        stageSheets.push(stageSheetData);
        logPdfExportBreadcrumb(exportContext, "Captured stage sheet.", {
          stageIndex: index,
          stageId: fullStage.id,
          stageName: fullStage.name,
          imagePixelWidth: stageSheetData.imagePixelWidth,
          imagePixelHeight: stageSheetData.imagePixelHeight,
        });
      } catch (stageError) {
        logPdfExportBreadcrumb(
          exportContext,
          `Failed to export ${fullStage.name}.`,
          {
            stageIndex: index,
            stageId: fullStage.id,
            stageName: fullStage.name,
            bucketCounts: preparedBuckets?.bucketCounts,
            error: getErrorDetails(stageError),
          },
          "error"
        );
        failedStages.push(fullStage.name);
      } finally {
        await visualState?.dispose?.();
        await resetPdfExportFragmentStyles(
          exportContext,
          `after stage PDF capture: ${fullStage.name}`
        );
      }
    }

    if (stageSheets.length === 0) {
      throw new Error("No stages were captured successfully.");
    }

    exportMultipleStageImagesToPdf(stageSheets);
    logPdfExportBreadcrumb(exportContext, "Created combined PDF.", {
      capturedStageCount: stageSheets.length,
      failedStages,
    });

    if (failedStages.length > 0) {
      setStatus(
        `Exported ${stageSheets.length} stages. Failed: ${failedStages.join(
          ", "
        )}.`
      );
    } else {
      setStatus(`Exported ${stageSheets.length} stages to combined PDF.`);
    }
  } catch (error) {
    logPdfExportBreadcrumb(
      exportContext,
      "Export all stages failed.",
      { error: getErrorDetails(error) },
      "error"
    );
    setStatus("Export all stages failed.");
  } finally {
    try {
      await restoreViewerAfterPdfExport(previousState, exportContext);
    } catch (restoreError) {
      logPdfExportBreadcrumb(
        exportContext,
        "Failed to restore viewer after exporting all stages.",
        { error: getErrorDetails(restoreError) },
        "error"
      );
      setStatus("Export finished, but viewer restore failed.");
    } finally {
      isPdfExporting = false;
    }
  }
}

async function restoreSavedViewForStage(stageId, { transition = false } = {}) {
  const savedViewData = staging.getStageView(stageId);

  if (!savedViewData) {
    return false;
  }

  const viewpoint = viewpoints.create();
  viewpoint.title = "Export Viewpoint";

  viewpoint.set(savedViewData);

  await viewpoint.go({
    transition,
    applyVisibility: false,
    applyClippings: false,
  });

  await waitForFragmentsReady();
  await waitForAnimationFrames(2);

  return true;
}
