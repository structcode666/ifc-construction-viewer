import * as OBC from "@thatopen/components";
import * as THREE from "three";
import { setStatus, setSelectionInfo } from "../app/ui.js";

export function initSelection({
  components,
  world,
  fragments,
  ui,
  onSelectionChanged,
  canSelect = () => true,
}) {
  let selectedItem = null;

  const hider = components.get(OBC.Hider);
  const caster = components.get(OBC.Raycasters).get(world);

  const selectionMaterial = {
    color: new THREE.Color("#bcf124"),
    opacity: 1,
    transparent: false,
    renderedFaces: 0,
  };

  let pointerDownPosition = null;
  let areaSelection = null;
  const clickThreshold = 5;

  function getSelectionStats(modelIdMap) {
    const modelIds = Object.keys(modelIdMap);
    let totalSelectedIds = 0;

    for (const modelId of modelIds) {
      totalSelectedIds += modelIdMap[modelId].size;
    }

    return {
      modelCount: modelIds.length,
      selectedIdCount: totalSelectedIds,
    };
  }

  function isSelectionEmpty(modelIdMap) {
    if (!modelIdMap) return true;

    const modelIds = Object.keys(modelIdMap);
    if (modelIds.length === 0) return true;

    for (const modelId of modelIds) {
      if (modelIdMap[modelId].size > 0) {
        return false;
      }
    }

    return true;
  }

  function cloneModelIdMap(modelIdMap) {
    if (!modelIdMap) return {};

    const clone = {};

    for (const modelId of Object.keys(modelIdMap)) {
      clone[modelId] = new Set(modelIdMap[modelId]);
    }

    return clone;
  }

  function getFirstSelectedEntry(modelIdMap) {
    if (!modelIdMap) return null;

    const modelIds = Object.keys(modelIdMap);
    if (modelIds.length === 0) return null;

    const modelId = modelIds[0];
    const ids = [...modelIdMap[modelId]];
    if (ids.length === 0) return null;

    return {
      modelId,
      localId: ids[0],
    };
  }

  function modelIdMapContainsAll(currentSelection, clickedSelection) {
    if (!currentSelection || !clickedSelection) return false;

    for (const modelId of Object.keys(clickedSelection)) {
      const clickedIds = clickedSelection[modelId];
      const currentIds = currentSelection[modelId];

      if (!currentIds) return false;

      for (const id of clickedIds) {
        if (!currentIds.has(id)) {
          return false;
        }
      }
    }

    return true;
  }

  function toggleModelIdMapInSelection(currentSelection, clickedSelection) {
    const nextSelection = cloneModelIdMap(currentSelection);
    const shouldRemove = modelIdMapContainsAll(nextSelection, clickedSelection);

    for (const modelId of Object.keys(clickedSelection)) {
      const clickedIds = clickedSelection[modelId];

      if (!nextSelection[modelId]) {
        nextSelection[modelId] = new Set();
      }

      if (shouldRemove) {
        for (const id of clickedIds) {
          nextSelection[modelId].delete(id);
        }

        if (nextSelection[modelId].size === 0) {
          delete nextSelection[modelId];
        }
      } else {
        for (const id of clickedIds) {
          nextSelection[modelId].add(id);
        }
      }
    }

    return nextSelection;
  }

  function getContainerPoint(event) {
    const rect = ui.viewerContainer.getBoundingClientRect();

    return {
      x: event.clientX - rect.left,
      y: event.clientY - rect.top,
    };
  }

  function getRectangleFromPoints(start, end) {
    return {
      left: Math.min(start.x, end.x),
      right: Math.max(start.x, end.x),
      top: Math.min(start.y, end.y),
      bottom: Math.max(start.y, end.y),
    };
  }

  function rectanglesIntersect(a, b) {
    return (
      a.left <= b.right &&
      a.right >= b.left &&
      a.top <= b.bottom &&
      a.bottom >= b.top
    );
  }

  function createAreaSelectionBox() {
    const box = document.createElement("div");
    box.className = "area-selection-box";
    ui.viewerContainer.appendChild(box);
    return box;
  }

  function updateAreaSelectionBox() {
    if (!areaSelection) return;

    const rectangle = getRectangleFromPoints(
      areaSelection.start,
      areaSelection.current
    );

    areaSelection.box.style.left = `${rectangle.left}px`;
    areaSelection.box.style.top = `${rectangle.top}px`;
    areaSelection.box.style.width = `${rectangle.right - rectangle.left}px`;
    areaSelection.box.style.height = `${rectangle.bottom - rectangle.top}px`;
  }

  function removeAreaSelectionBox() {
    if (!areaSelection) return;

    areaSelection.box.remove();
  }

  function cancelAreaSelection(event) {
    if (!areaSelection || event.pointerId !== areaSelection.pointerId) return;

    removeAreaSelectionBox();
    areaSelection = null;
    world.camera.setUserInput(true);

    if (ui.viewerContainer.hasPointerCapture(event.pointerId)) {
      ui.viewerContainer.releasePointerCapture(event.pointerId);
    }
  }

  function getBoxScreenRectangle(box) {
    const camera = world.camera.three;
    const containerRect = ui.viewerContainer.getBoundingClientRect();
    const points = [
      new THREE.Vector3(box.min.x, box.min.y, box.min.z),
      new THREE.Vector3(box.min.x, box.min.y, box.max.z),
      new THREE.Vector3(box.min.x, box.max.y, box.min.z),
      new THREE.Vector3(box.min.x, box.max.y, box.max.z),
      new THREE.Vector3(box.max.x, box.min.y, box.min.z),
      new THREE.Vector3(box.max.x, box.min.y, box.max.z),
      new THREE.Vector3(box.max.x, box.max.y, box.min.z),
      new THREE.Vector3(box.max.x, box.max.y, box.max.z),
    ];

    let left = Infinity;
    let right = -Infinity;
    let top = Infinity;
    let bottom = -Infinity;
    let hasPointInFront = false;

    for (const point of points) {
      point.project(camera);

      if (point.z < -1 || point.z > 1) continue;

      hasPointInFront = true;

      const x = ((point.x + 1) / 2) * containerRect.width;
      const y = ((1 - point.y) / 2) * containerRect.height;

      left = Math.min(left, x);
      right = Math.max(right, x);
      top = Math.min(top, y);
      bottom = Math.max(bottom, y);
    }

    if (!hasPointInFront) return null;

    return { left, right, top, bottom };
  }

  async function getVisibleIds(model, localIds) {
    if (typeof model.getVisible !== "function") {
      return localIds;
    }

    const visibility = await model.getVisible(localIds);

    return localIds.filter((_, index) => visibility[index]);
  }

  async function getAreaSelection(rectangle) {
    const selectedModelIdMap = {};

    for (const [modelId, model] of fragments.list) {
      if (typeof model.getItemsIdsWithGeometry !== "function") continue;
      if (typeof model.getBoxes !== "function") continue;

      const geometryIds = Array.from(await model.getItemsIdsWithGeometry());
      const visibleIds = await getVisibleIds(model, geometryIds);
      const boxes = await model.getBoxes(visibleIds);

      for (let index = 0; index < visibleIds.length; index++) {
        const screenRectangle = getBoxScreenRectangle(boxes[index]);

        if (!screenRectangle) continue;
        if (!rectanglesIntersect(rectangle, screenRectangle)) continue;

        if (!selectedModelIdMap[modelId]) {
          selectedModelIdMap[modelId] = new Set();
        }

        selectedModelIdMap[modelId].add(visibleIds[index]);
      }
    }

    return selectedModelIdMap;
  }

  async function applyAreaSelection({ rectangle, isMultiSelect }) {
    const areaModelIdMap = await getAreaSelection(rectangle);
    const stats = getSelectionStats(areaModelIdMap);

    if (isMultiSelect) {
      const toggledSelection = toggleModelIdMapInSelection(
        selectedItem,
        areaModelIdMap
      );

      await applySelection(toggledSelection);
    } else {
      await applySelection(areaModelIdMap);
    }

    if (stats.selectedIdCount > 0) {
      setStatus(`Area selected ${stats.selectedIdCount} item(s).`);
    }
  }

  async function clearSelection() {
    selectedItem = null;

    await fragments.resetHighlight();
    await fragments.core.update(true);

    // if (onSelectionChanged) {
    //   await onSelectionChanged();
    // }

    setStatus("Selection cleared.");
    setSelectionInfo("No element selected.");
  }

  async function applySelection(modelIdMap) {
    if (isSelectionEmpty(modelIdMap)) {
      await clearSelection();
      return;
    }

    selectedItem = modelIdMap;

    await fragments.resetHighlight();
    await fragments.highlight(selectionMaterial, modelIdMap);
    await fragments.core.update(true);

    // if (onSelectionChanged) {
    //   await onSelectionChanged();
    // }

    const stats = getSelectionStats(modelIdMap);

    console.log("Selected item:", selectedItem);

    setStatus("Element selected.");
    setSelectionInfo(
      `Selected models: ${stats.modelCount} | Selected IDs: ${stats.selectedIdCount}`
    );
  }

  function getRawSelectionFromRaycast(result) {
    return {
      [result.fragments.modelId]: new Set([result.localId]),
    };
  }

  function extractRelatedIds(value, bucket = new Set()) {
    if (value == null) return bucket;

    if (typeof value === "number") {
      bucket.add(value);
      return bucket;
    }

    if (Array.isArray(value)) {
      for (const item of value) {
        extractRelatedIds(item, bucket);
      }
      return bucket;
    }

    if (typeof value === "object") {
      if (typeof value.localId === "number") bucket.add(value.localId);
      if (typeof value.LocalId === "number") bucket.add(value.LocalId);
      if (typeof value.id === "number") bucket.add(value.id);
      if (typeof value.ID === "number") bucket.add(value.ID);
      if (typeof value.value === "number") bucket.add(value.value);

      for (const nestedValue of Object.values(value)) {
        extractRelatedIds(nestedValue, bucket);
      }
    }

    return bucket;
  }

  async function getAssemblySelectionForItem(modelId, localId) {
    const model = fragments.list.get(modelId);

    if (!model) {
      return {
        [modelId]: new Set([localId]),
      };
    }

    const [itemData] = await model.getItemsData([localId], {
      attributesDefault: true,
      relations: {
        Decomposes: { attributes: true, relations: false },
        IsDecomposedBy: { attributes: true, relations: false },
        Nests: { attributes: true, relations: false },
        IsNestedBy: { attributes: true, relations: false },
      },
    });

    console.log("Clicked item data:", itemData);

    if (!itemData) {
      return {
        [modelId]: new Set([localId]),
      };
    }

    const parentCandidates = new Set([
      ...extractRelatedIds(itemData.Decomposes),
      ...extractRelatedIds(itemData.Nests),
    ]);

    if (parentCandidates.size === 0) {
      const childCandidates = new Set([
        ...extractRelatedIds(itemData.IsDecomposedBy),
        ...extractRelatedIds(itemData.IsNestedBy),
      ]);

      if (childCandidates.size > 0) {
        childCandidates.add(localId);

        return {
          [modelId]: childCandidates,
        };
      }

      return {
        [modelId]: new Set([localId]),
      };
    }

    const parentId = [...parentCandidates][0];

    const [parentData] = await model.getItemsData([parentId], {
      attributesDefault: true,
      relations: {
        IsDecomposedBy: { attributes: true, relations: false },
        IsNestedBy: { attributes: true, relations: false },
      },
    });

    console.log("Parent assembly data:", parentData);

    if (!parentData) {
      return {
        [modelId]: new Set([localId]),
      };
    }

    const siblingIds = new Set([
      ...extractRelatedIds(parentData.IsDecomposedBy),
      ...extractRelatedIds(parentData.IsNestedBy),
    ]);

    if (siblingIds.size === 0) {
      return {
        [modelId]: new Set([localId]),
      };
    }

    siblingIds.add(localId);

    return {
      [modelId]: siblingIds,
    };
  }

  async function expandSelectionToAssembly(rawSelection) {
    const entry = getFirstSelectedEntry(rawSelection);

    if (!entry) return rawSelection;

    const { modelId, localId } = entry;

    try {
      return await getAssemblySelectionForItem(modelId, localId);
    } catch (error) {
      console.warn("Assembly expansion failed, using raw selection instead.", error);
      return rawSelection;
    }
  }

  async function pickSelection({ isMultiSelect }) {
    const result = await caster.castRay();

    if (!result) {
      if (!isMultiSelect) {
        await clearSelection();
      }
      return;
    }

    const rawSelection = getRawSelectionFromRaycast(result);
    const expandedSelection = await expandSelectionToAssembly(rawSelection);

    if (isMultiSelect) {
      const mergedSelection = toggleModelIdMapInSelection(
        selectedItem,
        expandedSelection
      );

      await applySelection(mergedSelection);
      return;
    }

    await applySelection(expandedSelection);
  }

  function getSelectedItem() {
    return selectedItem;
  }

  ui.viewerContainer.addEventListener("pointerdown", (event) => {
    if (event.shiftKey) {
      const start = getContainerPoint(event);

      areaSelection = {
        pointerId: event.pointerId,
        start,
        current: start,
        box: createAreaSelectionBox(),
      };

      pointerDownPosition = null;
      ui.viewerContainer.setPointerCapture(event.pointerId);
      world.camera.setUserInput(false);
      updateAreaSelectionBox();
      event.preventDefault();
      return;
    }

    pointerDownPosition = {
      x: event.clientX,
      y: event.clientY,
    };
  });

  ui.viewerContainer.addEventListener("pointermove", (event) => {
    if (!areaSelection || event.pointerId !== areaSelection.pointerId) return;

    areaSelection.current = getContainerPoint(event);
    updateAreaSelectionBox();
  });

  ui.viewerContainer.addEventListener("pointerup", async (event) => {
    if (areaSelection && event.pointerId === areaSelection.pointerId) {
      const finishedAreaSelection = areaSelection;
      const rectangle = getRectangleFromPoints(
        finishedAreaSelection.start,
        finishedAreaSelection.current
      );
      const width = rectangle.right - rectangle.left;
      const height = rectangle.bottom - rectangle.top;

      removeAreaSelectionBox();
      areaSelection = null;
      world.camera.setUserInput(true);

      if (ui.viewerContainer.hasPointerCapture(event.pointerId)) {
        ui.viewerContainer.releasePointerCapture(event.pointerId);
      }

      if (!canSelect()) return;
      if (width <= clickThreshold || height <= clickThreshold) return;

      try {
        await applyAreaSelection({
          rectangle,
          isMultiSelect: event.ctrlKey,
        });
      } catch (error) {
        console.error("Area selection error:", error);
        setStatus("Area selection failed.");
      }

      return;
    }

    if (!canSelect()) {
      pointerDownPosition = null;
      return;
    }

    if (!pointerDownPosition) return;

    const deltaX = event.clientX - pointerDownPosition.x;
    const deltaY = event.clientY - pointerDownPosition.y;
    const movement = Math.sqrt(deltaX * deltaX + deltaY * deltaY);

    pointerDownPosition = null;

    if (movement > clickThreshold) return;

    try {
      await pickSelection({
        isMultiSelect: event.ctrlKey,
      });
    } catch (error) {
      console.error("Selection error:", error);
      setStatus("Selection failed.");
    }
  });

  ui.viewerContainer.addEventListener("pointercancel", cancelAreaSelection);

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

  return {
    getSelectedItem,
    clearSelection,
  };
}
