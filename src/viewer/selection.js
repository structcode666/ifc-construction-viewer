import * as OBC from "@thatopen/components";
import * as OBF from "@thatopen/components-front";
import { setStatus, setSelectionInfo} from "../app/ui.js";

export function initSelection({ components, world, ui}) {
  let selectedItem = null;

  components.get(OBC.Raycasters).get(world);

  const highlighter = components.get(OBF.Highlighter);
  const hider = components.get(OBC.Hider);

  highlighter.setup({
    world,
  });

  highlighter.events.select.onHighlight.add((modelIdMap) => {
    selectedItem = modelIdMap;
    console.log("Selected item:", selectedItem);

    const fragmentIds = Object.keys(modelIdMap);
    const fragmentCount = fragmentIds.length;

    let expressIdCount = 0;

    for(const fragmentId of fragmentIds){
      expressIdCount += modelIdMap[fragmentId].size;
    }
    setStatus("Element selected.");

    setSelectionInfo(
      `Selected fragments: ${fragmentCount} | Selected express IDs: ${expressIdCount}`
    );
  });

  highlighter.events.select.onClear.add(() => {
    selectedItem = null;
    setStatus("Nothing selected.");
  });

  ui.hideSelectedButton.addEventListener("click", async () => {
    if (!selectedItem) {
      setStatus("Nothing selected to hide.");
      return;
    }

    try {
      await hider.set(false, selectedItem);
      setStatus("Selected item hidden.");
    } catch (error) {
      console.error("Hide failed:", error);
      setStatus("Failed to hide selected item.");
    }
  });

  ui.isolateSelectedButton.addEventListener("click", async () => {
    if (!selectedItem) {
      setStatus("Nothing selected to isolate.");
      return;
    }

    try {
      await hider.isolate(selectedItem);
      setStatus("Selected item isolated.");
    } catch (error) {
      console.error("Isolation failed:", error);
      setStatus("Failed to isolate selected item.");
    }
  });

  ui.resetVisibilityButton.addEventListener("click", async () => {
    try {
      await hider.set(true);
      setStatus("Visibility reset.");
    } catch (error) {
      console.error("Reset visibility failed:", error);
      setStatus("Failed to reset visibility.");
    }
  });



}