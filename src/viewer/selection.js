import * as OBC from "@thatopen/components";
import * as OBF from "@thatopen/components-front";
import { setStatus } from "../app/ui.js";

export function initSelection({ components, world, ui }) {
  let selectedItem = null;

  // The docs show creating/getting a raycaster for the world first
  components.get(OBC.Raycasters).get(world);

  // Highlighter comes from components-front, not components
  const highlighter = components.get(OBF.Highlighter);

  highlighter.setup({
    world,
  });

  ui.viewerContainer.addEventListener("click", async () => {
    try {
      const result = await highlighter.highlight("select");

      if (!result) {
        selectedItem = null;
        setStatus("Nothing selected.");
        return;
      }

      selectedItem = result;
      console.log("Selected item:", selectedItem);
      setStatus("Element selected.");
    } catch (error) {
      console.error("Selection error:", error);
      setStatus("Selection failed.");
    }
  });
}