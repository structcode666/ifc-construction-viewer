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

  selection = initSelection({
    components,
    world,
    fragments,
    ui,
  });

  await initClipping({
    components,
    world,
    container: ui.viewerArea,
  });

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

ui.stageSlider.addEventListener("input", async () => {
  await showCurrentSliderStage();
});

ui.renameStageButton.addEventListener("click", () => {
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
  showContext = !showContext;

  ui.toggleContextButton.textContent = showContext
    ? "Hide Context"
    : "Show Context";

  await showCurrentSliderStage();
});

ui.resetVisibilityButton.addEventListener("click", async () => {
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

  ui.toggleModeButton.textContent = "Switch to Sequencing";
  ui.stagingTimeline.classList.add("is-hidden");
  ui.toggleContextButton.textContent = "Show Context";
}

function enterSequencingMode() {
  mode = "sequencing";

  ui.toggleModeButton.textContent = "Switch to Staging";
  ui.stagingTimeline.classList.remove("is-hidden");
}

async function resetViewerVisualState() {
  const hider = components.get(OBC.Hider);

  await hider.set(true);
  await resetAllOpacity();
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

// -----------------------------------------------------------------------------
// Visibility / opacity helpers
// -----------------------------------------------------------------------------

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

    await model.setOpacity([...localIds], opacity);
  }

  await fragments.core.update(true);
}

async function showCurrentSliderStage() {
  const stages = staging.getStages();

  if (stages.length === 0) {
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

      console.log("Finished isolating items.");
      setStatus(`Showing cumulative view up to ${stage.name}.`);
      return;
    }

    await hider.set(true);

    const allItems = await getAllGeometryItems();
    const contextItems = subtractModelIdMap(allItems, itemsToShow);

    await setOpacityForItems(contextItems, 0.15);

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
                    ${lift.name} (${lift.itemCount} items)
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


ui.saveStageViewButton.addEventListener("click", async () => {
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