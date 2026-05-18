export function createStagingManager() {
  const state = {
    stages: [],
    activeStageId: null,
    viewMode: "single", // "single" or "cumulative"
  };

  function generateStageId() {
    return `stage-${crypto.randomUUID()}`;
  }

  function getActiveStageId() {
    return state.activeStageId;
  } 

  function cloneModelIdMap(modelIdMap) {
    if (!modelIdMap) return {};

    const clone = {};

    for (const modelId of Object.keys(modelIdMap)) {
      clone[modelId] = new Set(modelIdMap[modelId]);
    }

    return clone;
  }

  function modelIdMapToSerializable(modelIdMap) {
    if (!modelIdMap) return {};

    const serializable = {};

    for (const modelId of Object.keys(modelIdMap)) {
      serializable[modelId] = [...modelIdMap[modelId]];
    }

    return serializable;
  } 

  function serializableToModelIdMap(serializableMap) {
    if (!serializableMap) return {};

    const modelIdMap = {};

    for (const modelId of Object.keys(serializableMap)) {
      modelIdMap[modelId] = new Set(serializableMap[modelId]);
    }

    return modelIdMap;
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

  function mergeModelIdMaps(baseMap, extraMap) {
    const merged = cloneModelIdMap(baseMap);

    if (!extraMap) return merged;

    for (const modelId of Object.keys(extraMap)) {
      if (!merged[modelId]) {
        merged[modelId] = new Set();
      }

      for (const localId of extraMap[modelId]) {
        merged[modelId].add(localId);
      }
    }

    return merged;
  }

  function removeModelIdMapFromStageItems(stageItems, itemsToRemove) {
    if (!stageItems || !itemsToRemove) return;

    for (const modelId of Object.keys(itemsToRemove)) {
      if (!stageItems[modelId]) continue;

      for (const localId of itemsToRemove[modelId]) {
        stageItems[modelId].delete(localId);
      }

      if (stageItems[modelId].size === 0) {
        delete stageItems[modelId];
      }
    }
  }

  function removeSelectionFromAllStages(selection) {
    if (isSelectionEmpty(selection)) return;

    for (const stage of state.stages) {
      removeModelIdMapFromStageItems(stage.items, selection);
    }
  }

  function createStage(name) {
    const trimmedName = name?.trim();

    const stage = {
      id: generateStageId(),
      name: trimmedName || `Stage ${state.stages.length + 1}`,
      items: {},
      view: null,
    };

    state.stages.push(stage);
    return stage;
  }

  function getStageById(stageId) {
    return state.stages.find((stage) => stage.id === stageId) ?? null;
  }

  function renameStage(stageId, newName) {
    const stage = getStageById(stageId);

    if (!stage) {
      return {
        ok: false,
        reason: "Stage not found.",
      };
    }

    const trimmedName = newName?.trim();

    if (!trimmedName) {
      return {
        ok: false,
        reason: "Stage name cannot be empty.",
      };
    }

    stage.name = trimmedName;

    return {
      ok: true,
      stage,
    };
  }

  function deleteStage(stageId) {
    const index = state.stages.findIndex((stage) => stage.id === stageId);

    if (index === -1) {
      return {
        ok: false,
        reason: "Stage not found.",
      };
    }

    const [deletedStage] = state.stages.splice(index, 1);

    if (state.activeStageId === stageId) {
      const nextStage = state.stages[index] ?? state.stages[index - 1] ?? null;
      state.activeStageId = nextStage ? nextStage.id : null;
    }

    return {
      ok: true,
      deletedStage,
      activeStageId: state.activeStageId,
    };
  }

  function assignSelectionToStage(stageId, selection) {
    if (isSelectionEmpty(selection)) {
      return { ok: false, reason: "Selection is empty." };
    }

    const stage = getStageById(stageId);

    if (!stage) {
      return { ok: false, reason: "Stage not found." };
    }

    // Important rule:
    // an element can belong to only ONE stage at a time.
    // So before adding selection to this stage,
    // remove it from every other stage.
    removeSelectionFromAllStages(selection);

    stage.items = mergeModelIdMaps(stage.items, selection);

    return { ok: true, stage };
  }

  function clearStage(stageId) {
    const stage = getStageById(stageId);

    if (!stage) {
      return {
        ok: false,
        reason: "Stage not found.",
      };
    }

    stage.items = {};

    return {
      ok: true,
      stage,
    };
  }

  function getStageSelection(stageId) {
    const stage = getStageById(stageId);
    if (!stage) return null;

    return cloneModelIdMap(stage.items);
  }

  function getCumulativeSelection(stageId) {
    const cumulative = {};
    const targetIndex = state.stages.findIndex((stage) => stage.id === stageId);

    if (targetIndex === -1) return null;

    for (let i = 0; i <= targetIndex; i++) {
      const stage = state.stages[i];
      Object.assign(cumulative, mergeModelIdMaps(cumulative, stage.items));
    }

    return cumulative;
  }

  function setActiveStage(stageId) {
    const stage = getStageById(stageId);
    if (!stage) return false;

    state.activeStageId = stageId;
    return true;
  }

  function clearActiveStage() {
    state.activeStageId = null;
  }

  function setViewMode(mode) {
    if (mode !== "single" && mode !== "cumulative") {
      return false;
    }

    state.viewMode = mode;
    return true;
  }

  function getActiveStageSelection() {
    if (!state.activeStageId) return null;

    if (state.viewMode === "single") {
      return getStageSelection(state.activeStageId);
    }

    if (state.viewMode === "cumulative") {
      return getCumulativeSelection(state.activeStageId);
    }

    return null;
  }

  function moveStage(stageId, newIndex) {
    const currentIndex = state.stages.findIndex((stage) => stage.id === stageId);
    if (currentIndex === -1) return false;

    if (newIndex < 0 || newIndex >= state.stages.length) return false;

    const [stage] = state.stages.splice(currentIndex, 1);
    state.stages.splice(newIndex, 0, stage);

    return true;
  }

  function getStages() {
    return state.stages.map((stage) => ({
      id: stage.id,
      name: stage.name,
      itemCount: countItemsInModelIdMap(stage.items),
    }));
  }

  function countItemsInModelIdMap(modelIdMap) {
    if (!modelIdMap) return 0;

    let total = 0;

    for (const modelId of Object.keys(modelIdMap)) {
      total += modelIdMap[modelId].size;
    }

    return total;
  }

  function createSnapshot() {
    return {
      snapshotVersion: 1,
      activeStageId: state.activeStageId,
      viewMode: state.viewMode,
      stages: state.stages.map((stage) => ({
        id: stage.id,
        name: stage.name,
        items: modelIdMapToSerializable(stage.items),
        view: stage.view ?? null,
      })),
    };
  }

  function restoreFromSnapshot(snapshot) {
    if (!snapshot || !Array.isArray(snapshot.stages)) {
      return {
        ok: false,
        reason: "Invalid staging snapshot.",
      };
    }

    state.stages = snapshot.stages.map((stage, index) => ({
      id: stage.id || generateStageId(),
      name: stage.name || `Stage ${index + 1}`,
      items: serializableToModelIdMap(stage.items),
      view: stage.view ?? null,
    }));

    const activeStageExists = state.stages.some(
      (stage) => stage.id === snapshot.activeStageId
    );

    state.activeStageId = activeStageExists ? snapshot.activeStageId : null;

    state.viewMode =
      snapshot.viewMode === "single" || snapshot.viewMode === "cumulative"
        ? snapshot.viewMode
        : "single";

    return {
      ok: true,
    };
}

  function debugState() {
    return {
      activeStageId: state.activeStageId,
      viewMode: state.viewMode,
      stages: state.stages.map((stage) => ({
        id: stage.id,
        name: stage.name,
        items: cloneModelIdMap(stage.items),
        view: stage.view ?? null,
      })),
    };
  }

  function setStageView(stageId, view) {
    const stage = getStageById(stageId);

    if (!stage) {
      return {
        ok: false,
        reason: "Stage not found.",
      };
    }

    if (!view) {
      return {
        ok: false,
        reason: "No view data provided.",
      };
    }

    stage.view = view;

    return {
      ok: true,
      stage,
    };
  }

  function getStageView(stageId) {
    const stage = getStageById(stageId);

    if (!stage) {
      return null;
    }

    return stage.view ?? null;
  }


  return {
    createStage,
    getStageById,
    getStages,
    renameStage,
    deleteStage,
    moveStage,
    assignSelectionToStage,
    clearStage,
    getStageSelection,
    getCumulativeSelection,
    setActiveStage,
    clearActiveStage,
    setViewMode,
    getActiveStageSelection,
    createSnapshot,
    restoreFromSnapshot,
    debugState,
    getActiveStageId,
    setStageView,
    getStageView,
  };
}