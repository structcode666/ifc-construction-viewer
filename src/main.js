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

import { toPng } from "html-to-image";
import {
  cropWhitespaceFromImage,
  exportStageImageToPdf,
  exportMultipleStageImagesToPdf,
} from "./app/pdfExport.js";
import * as THREE from "three";

const ui = getUI();

let components = null;
let world = null;
let orbitControls = null;
let fragments = null;
let currentModel = null;
let currentIfcFile = null;

let selection = null;
let mode = "staging";
let showContext = false;

let viewpoints = null;
let liftLabels = null;

let showLiftLabels = false;
let isPdfExporting = false;

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

  selection = initSelection({
    components,
    world,
    fragments,
    ui,

    // Prevent selection/highlight changes while the model is temporarily dressed
    // for PDF export.
    canSelect: () => !isPdfExporting,
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

async function waitForFragmentsReady() {
  await fragments.core.update(true);

  await new Promise((resolve) => requestAnimationFrame(resolve));
  await new Promise((resolve) => requestAnimationFrame(resolve));

  await fragments.core.update(true);
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
 * - fragment opacity
 * - camera/viewpoint
 * - lift-label DOM markers
 * - CSS export class
 * - renderer background
 *
 * A normal await after each operation is not always enough for the browser to
 * visually settle. This helper gives the renderer and DOM a final stable frame
 * before html-to-image captures the viewer.
 */
async function waitForStableExportFrame({ frames = 6 } = {}) {
  await fragments.core.update(true);

  for (let i = 0; i < frames; i++) {
    await new Promise((resolve) => requestAnimationFrame(resolve));
    await fragments.core.update(true);
  }

  try {
    world.renderer.three.render(world.scene.three, world.camera.three);
  } catch (error) {
    console.warn("Manual export render failed. Continuing anyway.", error);
  }

  await new Promise((resolve) => requestAnimationFrame(resolve));
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

async function getAllGeometryItems() {
  const allItems = {};

  for (const [modelId, model] of fragments.list) {
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

async function resolveSelectionToGeometryItems(selection, allGeometryItems) {
  const resolved = {};
  const unresolved = {};

  for (const [modelId, localIds] of Object.entries(selection ?? {})) {
    const model = fragments.list.get(modelId);
    const geometryIds = allGeometryItems[modelId];

    if (!model || !geometryIds) {
      unresolved[modelId] = [...localIds];
      continue;
    }

    for (const localId of localIds) {
      const resolvedIds = await getGeometryIdsForItem({
        model,
        localId,
        geometryIds,
      });

      if (resolvedIds.size === 0) {
        if (!unresolved[modelId]) {
          unresolved[modelId] = [];
        }

        unresolved[modelId].push(localId);
        continue;
      }

      if (!resolved[modelId]) {
        resolved[modelId] = new Set();
      }

      for (const resolvedId of resolvedIds) {
        resolved[modelId].add(resolvedId);
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

async function setOpacityForItems(items, opacity) {
  for (const [modelId, localIds] of Object.entries(items)) {
    const model = fragments.list.get(modelId);

    if (!model) continue;

    if (!localIds || localIds.size === 0) continue;

    await model.setOpacity([...localIds], opacity);
  }

  await fragments.core.update(true);
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

async function buildPdfExportBuckets(stageId) {
  const allGeometryItems = await getAllGeometryItems();

  const rawCurrentItems = staging.getStageSelection(stageId);
  const rawPreviousItems = getPreviousStageItems(stageId);

  const {
    resolved: currentGeometryItems,
    unresolved: unresolvedCurrentItems,
  } = await resolveSelectionToGeometryItems(rawCurrentItems, allGeometryItems);

  const {
    resolved: previousGeometryItems,
    unresolved: unresolvedPreviousItems,
  } = await resolveSelectionToGeometryItems(rawPreviousItems, allGeometryItems);

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

function objectOfArraysToObjectOfSets(objectOfArrays) {
  const result = {};

  for (const [key, value] of Object.entries(objectOfArrays ?? {})) {
    result[key] = new Set(value);
  }

  return result;
}

async function setColorForItems(items, colorHex) {
  const color = new THREE.Color(colorHex);

  for (const [modelId, localIds] of Object.entries(items ?? {})) {
    const model = fragments.list.get(modelId);

    if (!model) continue;

    if (!localIds || localIds.size === 0) continue;

    await model.setColor([...localIds], color);
  }

  await fragments.core.update(true);
}

async function applyPdfExportVisualState(stageId) {
  const hider = components.get(OBC.Hider);

  const {
    currentGeometryItems,
    previousOnlyItems,
    remainderItems,
    bucketCounts,
  } = await buildPdfExportBuckets(stageId);

  // Start from a clean model state.
  await hider.set(true);
  await fragments.resetHighlight();

  for (const [, model] of fragments.list) {
    await model.resetColor();
    await model.resetOpacity();
  }

  await fragments.core.update(true);

  // Apply export-only colours.
  //
  // Order matters:
  // 1. Grey transparent context first
  // 2. Previous erected work second
  // 3. Current stage last, so it visually wins
  await setColorForItems(remainderItems, "#b8b8b8");
  await setOpacityForItems(remainderItems, 0.18);

  await setColorForItems(previousOnlyItems, "#5fa85f");
  await setOpacityForItems(previousOnlyItems, 1.0);

  await setColorForItems(currentGeometryItems, "#d94f4f");
  await setOpacityForItems(currentGeometryItems, 1.0);

  await waitForStableExportFrame();

  console.log("Applied PDF export visual state:", {
    stageId,
    bucketCounts,
  });
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
          await setOpacityForItems(assignedItems, 0.15);
          setStatus(
            "Staging mode: assigned elements shown as transparent context."
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

    await setOpacityForItems(contextItems, 0.15);

    await updateLiftLabelsForCurrentView();

    setStatus(`Showing ${stage.name} with transparent context.`);
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
    rendererClearColor: world.renderer.three.getClearColor(new THREE.Color()),
    rendererClearAlpha: world.renderer.three.getClearAlpha(),
  };
}

async function restoreViewerAfterPdfExport(previousState) {
  ui.viewerArea.classList.remove("is-exporting");

  world.scene.three.background = previousState.sceneBackground;
  world.renderer.three.setClearColor(
    previousState.rendererClearColor,
    previousState.rendererClearAlpha
  );

  await fragments.resetHighlight();

  for (const [, model] of fragments.list) {
    await model.resetColor();
    await model.resetOpacity();
  }

  await fragments.core.update(true);

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

async function prepareViewerForPdfExport(stage) {
  setStatus(`Preparing PDF export for ${stage.name}...`);

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

  // Critical:
  // Apply export colours LAST, after camera/background/labels.
  // This makes the red/green/grey state the final model-changing operation
  // before screenshot capture.
  await applyPdfExportVisualState(stage.id);

  await waitForStableExportFrame({ frames: 6 });
}

async function captureStageSheetData(stage, drawingNumber = "DRAFT-001") {
  await waitForStableExportFrame({ frames: 6 });

  const rawImageDataUrl = await toPng(ui.viewerArea, {
    cacheBust: true,
    pixelRatio: 2,
    backgroundColor: "#ffffff",
  });

  const croppedCapture = await cropWhitespaceFromImage(rawImageDataUrl, {
    threshold: 248,
    paddingRatio: 0.06,
  });

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

  try {
    await prepareViewerForPdfExport(stage);

    const stageSheetData = await captureStageSheetData(stage, "DRAFT-001");

    exportStageImageToPdf(stageSheetData);

    setStatus(`Exported PDF for ${stage.name}.`);
  } catch (error) {
    console.error("PDF export failed:", error);
    setStatus("PDF export failed.");
  } finally {
    await restoreViewerAfterPdfExport(previousState);
    isPdfExporting = false;
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

  try {
    const stages = staging.getStages();

    for (let index = 0; index < stages.length; index++) {
      const summaryStage = stages[index];
      const fullStage = staging.getStageById(summaryStage.id);

      if (!fullStage) {
        continue;
      }

      setStatus(
        `Exporting ${fullStage.name} (${index + 1} / ${stages.length})...`
      );

      await prepareViewerForPdfExport(fullStage);

      const stageSheetData = await captureStageSheetData(
        fullStage,
        `DRAFT-${String(index + 1).padStart(3, "0")}`
      );

      stageSheets.push(stageSheetData);
    }

    exportMultipleStageImagesToPdf(stageSheets);

    setStatus(`Exported ${stageSheets.length} stages to combined PDF.`);
  } catch (error) {
    console.error("Export all stages failed:", error);
    setStatus("Export all stages failed.");
  } finally {
    await restoreViewerAfterPdfExport(previousState);
    isPdfExporting = false;
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
