import * as THREE from "three";

function cloneAssignments(assignments) {
  const clone = {};

  for (const [modelId, colorsById] of Object.entries(assignments ?? {})) {
    clone[modelId] = { ...colorsById };
  }

  return clone;
}

export function createElementColorManager({ fragments }) {
  let assignments = {};

  function hasAssignments() {
    return Object.values(assignments).some(
      (colorsById) => Object.keys(colorsById).length > 0
    );
  }

  function serialize() {
    return cloneAssignments(assignments);
  }

  function restore(serializedAssignments) {
    assignments = {};

    for (const [modelId, colorsById] of Object.entries(
      serializedAssignments ?? {}
    )) {
      if (!colorsById || typeof colorsById !== "object") continue;

      for (const [localId, color] of Object.entries(colorsById)) {
        if (!Number.isFinite(Number(localId))) continue;
        if (typeof color !== "string" || !/^#[0-9a-f]{6}$/i.test(color)) continue;

        assignments[modelId] ??= {};
        assignments[modelId][localId] = color.toLowerCase();
      }
    }
  }

  function assign(modelIdMap, color) {
    const normalizedColor = color.toLowerCase();

    for (const [modelId, localIds] of Object.entries(modelIdMap ?? {})) {
      assignments[modelId] ??= {};

      for (const localId of localIds ?? []) {
        assignments[modelId][localId] = normalizedColor;
      }
    }
  }

  async function apply({ update = true } = {}) {
    const groups = new Map();

    for (const [modelId, colorsById] of Object.entries(assignments)) {
      for (const [localId, color] of Object.entries(colorsById)) {
        const key = `${modelId}\u0000${color}`;
        const group = groups.get(key) ?? { modelId, color, localIds: [] };
        group.localIds.push(Number(localId));
        groups.set(key, group);
      }
    }

    for (const { modelId, color, localIds } of groups.values()) {
      const model = fragments.list.get(modelId);
      if (!model || typeof model.setColor !== "function") continue;
      await model.setColor(localIds, new THREE.Color(color));
    }

    if (update) await fragments.core.update(true);
  }

  async function setColor(modelIdMap, color) {
    assign(modelIdMap, color);
    await apply();
  }

  async function resetAll({ update = true } = {}) {
    assignments = {};

    for (const [, model] of fragments.list) {
      if (typeof model.resetColor === "function") await model.resetColor();
    }

    if (update) await fragments.core.update(true);
  }

  return {
    apply,
    hasAssignments,
    resetAll,
    restore,
    serialize,
    setColor,
  };
}
