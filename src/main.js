import "./style.css";
import { getUI, setStatus } from "./app/ui.js";
import { setupWorld } from "./viewer/setupWorld.js";
import { loadIfcFromFile } from "./viewer/loadIfc.js";
import { initSelection } from "./viewer/selection.js";

const ui = getUI();

let components = null;
let world = null;
let orbitControls = null;
let fragments = null;
let currentModel = null;

async function startApp() {
  const setup = await setupWorld(ui.viewerContainer);
  components = setup.components;
  world = setup.world;
  orbitControls = setup.orbitControls;
  fragments = setup.fragments;
  initSelection({ components, world, fragments, ui });
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
