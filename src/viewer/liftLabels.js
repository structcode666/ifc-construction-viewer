import * as THREE from "three";
import * as OBCF from "@thatopen/components-front";

export function createLiftLabelManager({ components, world, fragments }) {
  const markers = components.get(OBCF.Marker);
   markers.autoCluster = false;

  function createLabelElement(text) {
    const element = document.createElement("div");
    element.className = "lift-marker";
    element.dataset.markerType = "lift-label";
    element.textContent = text;
    return element;
  }

  function clear() {
    for (const [, worldMarkers] of markers.list) {
      worldMarkers.clear();
    }

    document
      .querySelectorAll('.lift-marker[data-marker-type="lift-label"]')
      .forEach((element) => {
        element.remove();
      });
  }

  async function calculateLiftLabelPosition(lift) {
    const combinedBox = new THREE.Box3();

    for (const [modelId, localIdsSet] of Object.entries(lift.items ?? {})) {
      const model = fragments.list.get(modelId);

      if (!model) {
        console.warn("No fragment model found for lift label:", modelId);
        continue;
      }

      const localIds = [...localIdsSet];

      if (localIds.length === 0) {
        continue;
      }

      const box = await model.getMergedBox(localIds);

      if (!box || !box.isBox3) {
        console.warn("Invalid box returned for lift:", lift.name, box);
        continue;
      }

      combinedBox.union(box);
    }

    if (combinedBox.isEmpty()) {
      return null;
    }

    const center = combinedBox.getCenter(new THREE.Vector3());

    // Temporary vertical offset so the label is not buried inside the elements.
    // Your model appears to use Y as vertical, based on the bounding box output.
    center.y += 1.0;

    return center;
  }

  async function showLiftLabelsForStages(stages) {
    clear();

    let labelIndex = 0;

    for (const stage of stages) {
      for (const lift of stage.lifts) {
        const element = createLabelElement(lift.name);

        const calculatedPosition = await calculateLiftLabelPosition(lift);

        const fallbackPosition = new THREE.Vector3(
          0,
          5 + labelIndex * 0.5,
          labelIndex * 0.5
        );

        const position = calculatedPosition ?? fallbackPosition;

        const markerId = markers.create(world, element, position);

        console.log("Created lift marker:", {
          markerId,
          stageName: stage.name,
          liftName: lift.name,
          position,
          usedFallbackPosition: calculatedPosition === null,
        });

        labelIndex += 1;
      }
    }

    console.log(`Rendered ${labelIndex} lift labels.`);

    return labelIndex;
  }

  return {
    showLiftLabelsForStages,
    clear,
  };
}