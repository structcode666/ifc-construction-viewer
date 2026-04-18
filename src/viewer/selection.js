import * as OBC from "@thatopen/components";
import * as OBF from "@thatopen/components-front";
import { setStatus } from "../app/ui.js";

export function initSelection({ components, world }) {
  let selectedItem = null;

  components.get(OBC.Raycasters).get(world);

  const highlighter = components.get(OBF.Highlighter);

  highlighter.setup({
    world,
  });

  highlighter.events.select.onHighlight.add((modelIdMap) => {
    selectedItem = modelIdMap;
    console.log("Selected item:", selectedItem);
    setStatus("Element selected.");
  });

  highlighter.events.select.onClear.add(() => {
    selectedItem = null;
    setStatus("Nothing selected.");
  });
}