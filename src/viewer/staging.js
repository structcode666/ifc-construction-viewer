export function createStagingManager() {
  const state = {
    stages: [],
    activeStageId: null,
    viewMode: "single", // "single" or "cumulative"
  };

  function generateStageId() {
    return `stage-${crypto.randomUUID()}`;
  }

  function generateLiftId() {
    return `lift-${crypto.randomUUID()}`;
  }

  function cloneIdSet(ids) {
    return new Set(ids ?? []);
  }

  function idSetToSerializable(ids) {
    return [...(ids ?? [])];
  }

  function serializableToIdSet(ids) {
    return new Set(Array.isArray(ids) ? ids : []);
  }

  function isIdSetEmpty(ids) {
    return !ids || ids.size === 0;
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

  function removeSelectionFromAllLifts(selection) {
    if (isSelectionEmpty(selection)) return;

    for (const stage of state.stages) {
      for (const lift of stage.lifts ?? []) {
        removeModelIdMapFromStageItems(lift.items, selection);
      }
    }
  }

  function removeSelectionFromAllStages(selection) {
    if (isSelectionEmpty(selection)) return;

    for (const stage of state.stages) {
      removeModelIdMapFromStageItems(stage.items, selection);
    }
  }

  function removeManualIdsFromSet(targetIds, idsToRemove) {
    if (!targetIds || isIdSetEmpty(idsToRemove)) return;

    for (const id of idsToRemove) {
      targetIds.delete(id);
    }
  }

  function removeManualIdsFromAllLifts(ids) {
    if (isIdSetEmpty(ids)) return;

    for (const stage of state.stages) {
      for (const lift of stage.lifts ?? []) {
        removeManualIdsFromSet(lift.manualItems, ids);
      }
    }
  }

  function removeManualIdsFromAllStages(ids) {
    if (isIdSetEmpty(ids)) return;

    for (const stage of state.stages) {
      removeManualIdsFromSet(stage.manualItems, ids);
    }
  }

  function createStage(name) {
    const trimmedName = name?.trim();

    const stage = {
      id: generateStageId(),
      name: trimmedName || `Stage ${state.stages.length + 1}`,
      items: {},
      manualItems: new Set(),
      view: null,
      lifts: [],
    };

    state.stages.push(stage);
    return stage;
  }

  function getStageById(stageId) {
    return state.stages.find((stage) => stage.id === stageId) ?? null;
  }

  function getLiftById(stageId, liftId) {
    const stage = getStageById(stageId);

    if (!stage) {
      return null;
    }

    return stage.lifts.find((lift) => lift.id === liftId) ?? null;
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

  function renameLift(stageId, liftId, newName) {
    const stage = getStageById(stageId);

    if (!stage) {
      return {
        ok: false,
        reason: "Stage not found.",
      };
    }

    const lift = getLiftById(stageId, liftId);

    if (!lift) {
      return {
        ok: false,
        reason: "Lift not found.",
      };
    }

    const trimmedName = newName?.trim();

    if (!trimmedName) {
      return {
        ok: false,
        reason: "Lift name cannot be empty.",
      };
    }

    lift.name = trimmedName;

    return {
      ok: true,
      stage,
      lift,
    };
  }

  function setLiftLabelPosition(stageId, liftId, position) {
    const lift = getLiftById(stageId, liftId);

    if (!lift) {
      return {
        ok: false,
        reason: "Lift not found.",
      };
    }

    lift.label = {
      ...(lift.label ?? {}),
      position: position
        ? {
            x: position.x,
            y: position.y,
            z: position.z,
          }
        : null,
    };

    return {
      ok: true,
      lift,
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

  function deleteLift(stageId, liftId) {
    const stage = getStageById(stageId);

    if (!stage) {
      return {
        ok: false,
        reason: "Stage not found.",
      };
    }

    const liftIndex = stage.lifts.findIndex((lift) => lift.id === liftId);

    if (liftIndex === -1) {
      return {
        ok: false,
        reason: "Lift not found.",
      };
    }

    const [deletedLift] = stage.lifts.splice(liftIndex, 1);

    renumberDefaultLiftNames(stage);

    return {
      ok: true,
      stage,
      deletedLift,
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

  function assignManualSelectionToStage(stageId, manualIds) {
    const ids = cloneIdSet(manualIds);

    if (isIdSetEmpty(ids)) {
      return { ok: false, reason: "Manual selection is empty." };
    }

    const stage = getStageById(stageId);

    if (!stage) {
      return { ok: false, reason: "Stage not found." };
    }

    if (!stage.manualItems) {
      stage.manualItems = new Set();
    }

    removeManualIdsFromAllStages(ids);

    for (const id of ids) {
      stage.manualItems.add(id);
    }

    return { ok: true, stage };
  }

  function removeManualElements(manualIds) {
    const ids = cloneIdSet(manualIds);

    if (isIdSetEmpty(ids)) {
      return;
    }

    removeManualIdsFromAllStages(ids);
    removeManualIdsFromAllLifts(ids);
  }

  function createLiftFromSelection(stageId, selection, manualIds = []) {
    const manualSelection = cloneIdSet(manualIds);

    if (isSelectionEmpty(selection) && isIdSetEmpty(manualSelection)) {
      return {
        ok: false,
        reason: "Selection is empty.",
      };
    }

    const stage = getStageById(stageId);

    if (!stage) {
      return {
        ok: false,
        reason: "Stage not found.",
      };
    }

    // Defensive safety:
    // older data or unexpected state should still work.
    if (!Array.isArray(stage.lifts)) {
      stage.lifts = [];
    }

    if (!stage.manualItems) {
      stage.manualItems = new Set();
    }

    // Creating a lift also means these elements belong to this stage.
    // This reuses your existing stage assignment rule:
    // an element can belong to only one stage at a time.
    if (!isSelectionEmpty(selection)) {
      assignSelectionToStage(stageId, selection);
    }

    if (!isIdSetEmpty(manualSelection)) {
      assignManualSelectionToStage(stageId, manualSelection);
    }

    // A selected element should only belong to one lift at a time.
    // Remove it from any previous lift before adding it to the new one.
    if (!isSelectionEmpty(selection)) {
      removeSelectionFromAllLifts(selection);
    }
    removeManualIdsFromAllLifts(manualSelection);

    const lift = {
      id: generateLiftId(),
      name: getNextLiftName(stage),
      items: cloneModelIdMap(selection),
      manualItems: cloneIdSet(manualSelection),
      label: {
        position: null,
      },
    };

    stage.lifts.push(lift);

    return {
      ok: true,
      stage,
      lift,
    };
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
    stage.manualItems = new Set();
    stage.lifts = [];

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

  function getStageManualSelection(stageId) {
    const stage = getStageById(stageId);
    if (!stage) return null;

    return cloneIdSet(stage.manualItems);
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

  function getCumulativeManualSelection(stageId) {
    const cumulative = new Set();
    const targetIndex = state.stages.findIndex((stage) => stage.id === stageId);

    if (targetIndex === -1) return null;

    for (let i = 0; i <= targetIndex; i++) {
      const stage = state.stages[i];

      for (const id of stage.manualItems ?? []) {
        cumulative.add(id);
      }
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

  function getActiveStageManualSelection() {
    if (!state.activeStageId) return null;

    if (state.viewMode === "single") {
      return getStageManualSelection(state.activeStageId);
    }

    if (state.viewMode === "cumulative") {
      return getCumulativeManualSelection(state.activeStageId);
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
      itemCount:
        countItemsInModelIdMap(stage.items) + (stage.manualItems?.size ?? 0),

      lifts: (stage.lifts ?? []).map((lift) => ({
        id: lift.id,
        name: lift.name,
        itemCount:
          countItemsInModelIdMap(lift.items) + (lift.manualItems?.size ?? 0),
      })),
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
      snapshotVersion: 2,
      activeStageId: state.activeStageId,
      viewMode: state.viewMode,
      stages: state.stages.map((stage) => ({
        id: stage.id,
        name: stage.name,
        items: modelIdMapToSerializable(stage.items),
        manualItems: idSetToSerializable(stage.manualItems),
        view: stage.view ?? null,

        lifts: (stage.lifts ?? []).map((lift) => ({
          id: lift.id,
          name: lift.name,
          items: modelIdMapToSerializable(lift.items),
          manualItems: idSetToSerializable(lift.manualItems),
          label: lift.label ?? {
            position: null,
          },
        })),
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
      manualItems: serializableToIdSet(stage.manualItems),
      view: stage.view ?? null,

      lifts: Array.isArray(stage.lifts)
        ? stage.lifts.map((lift, liftIndex) => ({
            id: lift.id || generateLiftId(),
            name: lift.name || `LIFT ${liftIndex + 1}`,
            items: serializableToModelIdMap(lift.items),
            manualItems: serializableToIdSet(lift.manualItems),
            label: lift.label ?? {
              position: null,
            },
          }))
        : [],
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
        manualItems: cloneIdSet(stage.manualItems),
        view: stage.view ?? null,
        lifts: stage.lifts ?? [],
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

  function getNextLiftName(stage) {
    const liftNumbers = stage.lifts
      .map((lift) => {
        const match = lift.name?.match(/^LIFT\s+(\d+)$/i);
        return match ? Number(match[1]) : null;
      })
      .filter((number) => number !== null);

    const highestLiftNumber =
      liftNumbers.length > 0 ? Math.max(...liftNumbers) : 0;

    return `LIFT ${highestLiftNumber + 1}`;
  }

  function renumberDefaultLiftNames(stage) {
    let nextLiftNumber = 1;

    for (const lift of stage.lifts) {
      const isDefaultLiftName = /^LIFT\s+\d+$/i.test(lift.name);

      if (!isDefaultLiftName) {
        continue;
      }

      lift.name = `LIFT ${nextLiftNumber}`;
      nextLiftNumber++;
    }
  }

  return {
    createStage,
    getStageById,
    getLiftById,
    getStages,

    renameStage,
    renameLift,
    setLiftLabelPosition,

    deleteStage,
    deleteLift,

    moveStage,
    assignSelectionToStage,
    assignManualSelectionToStage,
    removeManualElements,
    createLiftFromSelection,
    clearStage,

    getStageSelection,
    getStageManualSelection,
    getCumulativeSelection,
    getCumulativeManualSelection,
    setActiveStage,
    clearActiveStage,
    setViewMode,
    getActiveStageSelection,
    getActiveStageManualSelection,

    createSnapshot,
    restoreFromSnapshot,
    debugState,

    getActiveStageId,
    setStageView,
    getStageView,
  };
}
