import "./style.css";
import * as OBC from "@thatopen/components";
import { getUI, setStatus } from "./app/ui.js";
import { setupWorld } from "./viewer/setupWorld.js";
import { loadIfcFromFile } from "./viewer/loadIfc.js";
import { initSelection } from "./viewer/selection.js";
import { createStagingManager } from "./viewer/staging.js";

const ui = getUI();

let components = null;
let world = null;
let orbitControls = null;
let fragments = null;
let currentModel = null;

let selection = null;
let mode = "staging";
let showContext = false;
const staging = createStagingManager();

async function startApp() {
  const setup = await setupWorld(ui.viewerContainer);
  components = setup.components;
  world = setup.world;
  orbitControls = setup.orbitControls;
  fragments = setup.fragments;

  selection = initSelection({ components, world, fragments, ui, });

  renderStagingUI();
}

await startApp();

ui.loadButton.addEventListener("click", async () => {
  const file = ui.fileInput.files[0];

  if (!file) {
    setStatus("Please choose an IFC file first.");
    return;
  }

  try {
    setStatus("Loading IFC...");

    currentModel = await loadIfcFromFile(components, file);

    await world.camera.fitToItems();

    orbitControls.target.set(0, 0, 0);
    orbitControls.update();

    setStatus(`Loaded: ${file.name}`);
    console.log("Loaded model:", currentModel);
  } catch (error) {
    console.error(error);
    setStatus("Failed to load IFC file.");
  }
});

ui.addStageButton.addEventListener("click", async () => {
  const stageNumber = staging.getStages().length + 1;
  const stage = staging.createStage(`Stage ${stageNumber}`);

  renderStagingUI();
  setSliderToStageIndex(staging.getStages().length - 1);

  await showCurrentSliderStage();

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

  const result = staging.assignSelectionToStage(currentStage.id, currentSelection);

  if (!result.ok) {
    setStatus(`Stage assignment failed: ${result.reason}`);
    return;
  }

  renderStagingUI();
  setSliderToStageIndex(currentStageIndex);

  await showCurrentSliderStage();

  setStatus(`Assigned selection to ${currentStage.name}.`);
  console.log("Assigned selection:", currentStage.name);
  console.log("Staging state:", staging.debugState());
});

ui.stageSlider.addEventListener("input", async () => {
  await showCurrentSliderStage();
});

ui.resetVisibilityButton.addEventListener("click", async () => {
  try {
    await components.get(OBC.Hider).set(true);
    await resetAllOpacity();
    setStatus("Visibility reset.");
  } catch (error) {
    console.error("Reset visibility failed:", error);
    setStatus("Failed to reset visibility.");
  }
});

ui.toggleModeButton.addEventListener("click", async () => {
  if (mode === "staging") {
    mode = "sequencing";
    ui.toggleModeButton.textContent = "Switch to Staging";

    ui.stagingTimeline.classList.remove("is-hidden");

    await showCurrentSliderStage();
    setStatus("Sequencing mode enabled.");
  } else {
    mode = "staging";
    ui.toggleModeButton.textContent = "Switch to Sequencing";

    ui.stagingTimeline.classList.add("is-hidden");

    await components.get(OBC.Hider).set(true);
    setStatus("Staging mode enabled (full model visible).");
  }
});
function setSliderToStageIndex(index) {
  ui.stageSlider.value = String(index);
}

ui.toggleContextButton.addEventListener("click", async () => {
  showContext = !showContext;

  ui.toggleContextButton.textContent = showContext
    ? "Hide Context"
    : "Show Context";

  await showCurrentSliderStage();
});

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

async function resetAllOpacity() {
  for (const [, model] of fragments.list) {
    await model.resetOpacity();
  }

  await fragments.core.update(true);
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
      await components.get(OBC.Hider).set(true);
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

  if (mode === "staging") {
    try {
      const hider = components.get(OBC.Hider);

      await hider.set(true);
      await resetAllOpacity();

      if (showContext) {
        const assignedItems = mergeAllStageItems();

        if (!isModelIdMapEmpty(assignedItems)) {
          await setOpacityForItems(assignedItems, 0.15);
          setStatus("Staging mode: assigned elements shown as transparent context.");
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

  staging.setActiveStage(stage.id);
  staging.setViewMode("cumulative");

  const itemsToShow = staging.getActiveStageSelection();

  if (isModelIdMapEmpty(itemsToShow)) {
    try {
      await components.get(OBC.Hider).set(true);
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
    await hider.isolate(itemsToShow);
    setStatus(`Showing cumulative view up to ${stage.name}.`);
  } else {
    await hider.set(true);

    const allItems = await getAllGeometryItems();
    const contextItems = subtractModelIdMap(allItems, itemsToShow);

    await setOpacityForItems(contextItems, 0.15);

    setStatus(`Showing ${stage.name} with transparent context.`);
  }
} catch (error) {
  console.error("Failed to show stage:", error);
  setStatus("Failed to update stage view.");
}
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
      return `<div>Stage ${index + 1}: ${stage.name} (${stage.itemCount} items)</div>`;
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



