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
const staging = createStagingManager();

async function startApp() {
  const setup = await setupWorld(ui.viewerContainer);
  components = setup.components;
  world = setup.world;
  orbitControls = setup.orbitControls;
  fragments = setup.fragments;

  selection = initSelection({ components, world, fragments, ui });

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

    await showCurrentSliderStage();
    setStatus("Sequencing mode enabled.");
  } else {
    mode = "staging";
    ui.toggleModeButton.textContent = "Switch to Sequencing";

    await components.get(OBC.Hider).set(true);
    setStatus("Staging mode enabled (full model visible).");
  }
});
function setSliderToStageIndex(index) {
  ui.stageSlider.value = String(index);
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

async function showCurrentSliderStage() {
  const stages = staging.getStages();

  if (mode === "staging") {
    await components.get(OBC.Hider).set(true);
    return;
  }

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

  staging.setActiveStage(stage.id);
  staging.setViewMode("cumulative");

  const itemsToShow = staging.getActiveStageSelection();

  updateStageLabel(stage, stageIndex, stages.length);

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
    await components.get(OBC.Hider).isolate(itemsToShow);
    setStatus(`Showing cumulative view up to ${stage.name}.`);
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