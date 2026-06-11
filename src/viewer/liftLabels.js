import * as THREE from "three";
import * as OBCF from "@thatopen/components-front";

export function createLiftLabelManager({
  components,
  world,
  fragments,
  onLabelPositionChanged,
}) {
  const markers = components.get(OBCF.Marker);
  markers.autoCluster = false;

  let dragState = null;

  function createLabelElement({ stageId, liftId, text }) {
    const element = document.createElement("div");
    element.className = "lift-marker";
    element.dataset.markerType = "lift-label";
    element.dataset.stageId = stageId;
    element.dataset.liftId = liftId;
    element.textContent = text;
    return element;
  }

  function getSavedLabelPosition(lift) {
    const position = lift.label?.position;

    if (
      typeof position?.x !== "number" ||
      typeof position?.y !== "number" ||
      typeof position?.z !== "number"
    ) {
      return null;
    }

    return new THREE.Vector3(position.x, position.y, position.z);
  }

  function getPointerNdc(event) {
    const rect = world.renderer.three.domElement.getBoundingClientRect();

    return {
      x: ((event.clientX - rect.left) / rect.width) * 2 - 1,
      y: -(((event.clientY - rect.top) / rect.height) * 2 - 1),
    };
  }

  function getWorldPositionAtDragDepth(event) {
    const ndc = getPointerNdc(event);

    return new THREE.Vector3(ndc.x, ndc.y, dragState.depth).unproject(
      world.camera.three
    );
  }

  function requestViewerUpdate() {
    fragments.core.update(true);
    world.renderer.three.render(world.scene.three, world.camera.three);
  }

  function finishDrag(event, shouldSave) {
    if (!dragState || event.pointerId !== dragState.pointerId) return;

    const { element, stageId, liftId, marker } = dragState;
    const position = marker.label.three.position.clone();

    element.classList.remove("is-dragging");
    world.camera.setUserInput(true);

    if (element.hasPointerCapture(event.pointerId)) {
      element.releasePointerCapture(event.pointerId);
    }

    dragState = null;

    if (shouldSave && onLabelPositionChanged) {
      onLabelPositionChanged({
        stageId,
        liftId,
        position,
      });
    }
  }

  function enableLabelDragging(element, markerId) {
    element.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;

      const marker = markers.getWorldMarkerList(world).get(markerId);

      if (!marker) return;

      const stageId = element.dataset.stageId;
      const liftId = element.dataset.liftId;
      const projectedPosition = marker.label.three.position
        .clone()
        .project(world.camera.three);

      dragState = {
        pointerId: event.pointerId,
        element,
        marker,
        stageId,
        liftId,
        depth: projectedPosition.z,
      };

      element.classList.add("is-dragging");
      element.setPointerCapture(event.pointerId);
      world.camera.setUserInput(false);

      event.preventDefault();
      event.stopPropagation();
    });

    element.addEventListener("pointermove", (event) => {
      if (!dragState || event.pointerId !== dragState.pointerId) return;

      const position = getWorldPositionAtDragDepth(event);
      dragState.marker.label.three.position.copy(position);
      requestViewerUpdate();

      event.preventDefault();
      event.stopPropagation();
    });

    element.addEventListener("pointerup", (event) => {
      finishDrag(event, true);
      event.preventDefault();
      event.stopPropagation();
    });

    element.addEventListener("pointercancel", (event) => {
      finishDrag(event, false);
      event.preventDefault();
      event.stopPropagation();
    });

    element.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
    });
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
        const element = createLabelElement({
          stageId: stage.id,
          liftId: lift.id,
          text: lift.name,
        });

        const calculatedPosition = await calculateLiftLabelPosition(lift);
        const savedPosition = getSavedLabelPosition(lift);

        const fallbackPosition = new THREE.Vector3(
          0,
          5 + labelIndex * 0.5,
          labelIndex * 0.5
        );

        const position = savedPosition ?? calculatedPosition ?? fallbackPosition;

        const markerId = markers.create(world, element, position);

        if (markerId) {
          enableLabelDragging(element, markerId);
        }

        console.log("Created lift marker:", {
          markerId,
          stageName: stage.name,
          liftName: lift.name,
          position,
          usedSavedPosition: savedPosition !== null,
          usedFallbackPosition: !savedPosition && calculatedPosition === null,
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
