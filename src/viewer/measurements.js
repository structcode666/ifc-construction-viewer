import * as THREE from "three";
import * as OBCF from "@thatopen/components-front";
import { setStatus } from "../app/ui.js";

export function initMeasurements({
  components,
  world,
  ui,
  onActiveToolChanged,
}) {
  const tools = {
    length: components.get(OBCF.LengthMeasurement),
    area: components.get(OBCF.AreaMeasurement),
    angle: components.get(OBCF.AngleMeasurement),
    volume: components.get(OBCF.VolumeMeasurement),
  };

  const toolButtons = {
    length: ui.measureLengthButton,
    area: ui.measureAreaButton,
    angle: ui.measureAngleButton,
    volume: ui.measureVolumeButton,
  };

  let activeToolName = null;

  const toolLabels = {
    length: "Length",
    area: "Area",
    angle: "Angle",
    volume: "Volume",
  };

  function setupToolDefaults() {
    tools.length.world = world;
    tools.length.units = "m";
    tools.length.mode = "edge";
    tools.length.rounding = 2;

    tools.area.world = world;
    tools.area.units = "m2";
    tools.area.mode = "face";
    tools.area.rounding = 2;

    tools.angle.world = world;
    tools.angle.units = "deg";
    tools.angle.rounding = 1;

    tools.volume.world = world;
    tools.volume.units = "m3";
    tools.volume.rounding = 2;

    for (const tool of Object.values(tools)) {
      tool.enabled = false;
      tool.visible = true;
      tool.color = new THREE.Color("#38bdf8");
    }
  }

  function updateButtons() {
    for (const [toolName, button] of Object.entries(toolButtons)) {
      if (!button) continue;

      button.classList.toggle("is-active", toolName === activeToolName);
    }
  }

  function notifyActiveToolChanged() {
    onActiveToolChanged?.(activeToolName);
  }

  function cancelActiveTool() {
    if (!activeToolName) return;

    const activeTool = tools[activeToolName];
    activeTool.cancelCreation();
    activeTool.enabled = false;
    activeToolName = null;
    updateButtons();
    notifyActiveToolChanged();
  }

  function activateTool(toolName) {
    const tool = tools[toolName];

    if (!tool) return;

    if (activeToolName === toolName) {
      cancelActiveTool();
      setStatus("Measurement mode off.");
      return;
    }

    cancelActiveTool();

    activeToolName = toolName;
    tool.enabled = true;
    updateButtons();
    notifyActiveToolChanged();
    setStatus(`${toolLabels[toolName]} measurement active.`);

    try {
      const creation = tool.create();

      if (creation instanceof Promise) {
        creation.catch((error) => {
          console.error(`${toolLabels[toolName]} measurement failed:`, error);
          cancelActiveTool();
          setStatus("Measurement tool failed.");
        });
      }
    } catch (error) {
      console.error(`${toolLabels[toolName]} measurement failed:`, error);
      cancelActiveTool();
      setStatus("Measurement tool failed.");
    }
  }

  function clearToolMeasurements(tool) {
    tool.cancelCreation();
    tool.list.clear();
    tool.lines.clear();
    tool.fills.clear();
    tool.labels.clear();
    tool.volumes.clear();
  }

  function clearMeasurements() {
    cancelActiveTool();

    for (const tool of Object.values(tools)) {
      clearToolMeasurements(tool);
    }

    setStatus("Measurements cleared.");
  }

  async function deleteMeasurementUnderCursor() {
    const toolsToTry = activeToolName ? [tools[activeToolName]] : Object.values(tools);

    try {
      for (const tool of toolsToTry) {
        await tool.delete();
      }

      setStatus("Measurement delete attempted.");
    } catch (error) {
      console.error("Measurement delete failed:", error);
      setStatus("Measurement delete failed.");
    }
  }

  setupToolDefaults();

  toolButtons.length?.addEventListener("click", () => activateTool("length"));
  toolButtons.area?.addEventListener("click", () => activateTool("area"));
  toolButtons.angle?.addEventListener("click", () => activateTool("angle"));
  toolButtons.volume?.addEventListener("click", () => activateTool("volume"));
  ui.deleteMeasurementButton?.addEventListener(
    "click",
    deleteMeasurementUnderCursor
  );
  ui.clearMeasurementsButton?.addEventListener("click", clearMeasurements);

  window.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    cancelActiveTool();
  });

  return {
    getActiveToolName: () => activeToolName,
    cancelActiveTool,
    clearMeasurements,
  };
}
