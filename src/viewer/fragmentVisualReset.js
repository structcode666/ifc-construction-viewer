const RESET_LOG_PREFIX = "[PDF Export Reset]";

export function waitFrame() {
  return new Promise((resolve) => requestAnimationFrame(resolve));
}

export async function waitFrames(count = 1) {
  for (let index = 0; index < count; index++) {
    await waitFrame();
  }
}

export async function safeCall(label, fn, failures = []) {
  try {
    const value = await fn();
    return { ok: true, value };
  } catch (error) {
    const failure = {
      label,
      name: error?.name,
      message: error?.message ?? String(error),
      stack: error?.stack,
    };

    failures.push(failure);
    console.warn(`${RESET_LOG_PREFIX} ${label} failed.`, failure);
    return { ok: false, error };
  }
}

export function getFragmentModelEntries(fragments) {
  const list = fragments?.list;

  if (!list) return [];

  if (typeof list.entries === "function") {
    return [...list.entries()];
  }

  if (Array.isArray(list)) {
    return list;
  }

  return Object.entries(list);
}

function getOptionalMethod(target, methodNames) {
  if (!target) return null;

  for (const methodName of methodNames) {
    if (typeof target[methodName] === "function") {
      return target[methodName].bind(target);
    }
  }

  return null;
}

function temporarilyDisableHighlighter(highlighter) {
  if (!highlighter) {
    return () => {};
  }

  const previousEnabled =
    typeof highlighter.enabled === "boolean" ? highlighter.enabled : null;
  const previousSelectEnabled =
    typeof highlighter.config?.selectEnabled === "boolean"
      ? highlighter.config.selectEnabled
      : null;
  const previousAutoHighlightOnClick =
    typeof highlighter.config?.autoHighlightOnClick === "boolean"
      ? highlighter.config.autoHighlightOnClick
      : null;

  if (previousEnabled !== null) {
    highlighter.enabled = false;
  }

  if (previousSelectEnabled !== null) {
    highlighter.config.selectEnabled = false;
  }

  if (previousAutoHighlightOnClick !== null) {
    highlighter.config.autoHighlightOnClick = false;
  }

  return () => {
    if (previousEnabled !== null) {
      highlighter.enabled = previousEnabled;
    }

    if (previousSelectEnabled !== null) {
      highlighter.config.selectEnabled = previousSelectEnabled;
    }

    if (previousAutoHighlightOnClick !== null) {
      highlighter.config.autoHighlightOnClick = previousAutoHighlightOnClick;
    }
  };
}

function renderWorld(world, renderer) {
  const threeRenderer = renderer?.three ?? world?.renderer?.three;
  const scene = world?.scene?.three;
  const camera = world?.camera?.three;

  if (!threeRenderer || !scene || !camera) {
    return;
  }

  if (typeof threeRenderer.render === "function") {
    threeRenderer.render(scene, camera);
  }
}

export async function softResetFragmentVisualState({
  fragments,
  hider = null,
  highlighter = null,
  world = null,
  renderer = null,
  reason = "unknown",
} = {}) {
  const startedAt = performance.now();
  const failures = [];
  const modelEntries = getFragmentModelEntries(fragments);
  const modelIds = modelEntries.map(([modelId]) => modelId);
  const restoreHighlighter = temporarilyDisableHighlighter(highlighter);

  console.log(`${RESET_LOG_PREFIX} Starting soft reset.`, {
    reason,
    modelIds,
  });

  try {
    const clearHighlighter = getOptionalMethod(highlighter, [
      "clear",
      "reset",
      "resetHighlight",
    ]);

    if (clearHighlighter) {
      await safeCall("highlighter clear", clearHighlighter, failures);
    }

    if (typeof fragments?.resetHighlight === "function") {
      await safeCall(
        "fragments resetHighlight",
        () => fragments.resetHighlight(),
        failures
      );
    }

    if (typeof hider?.set === "function") {
      await safeCall("hider show all", () => hider.set(true), failures);
    }

    for (const [modelId, model] of modelEntries) {
      if (typeof model?.resetColor === "function") {
        await safeCall(
          `model ${modelId} resetColor`,
          () => model.resetColor(),
          failures
        );
      }

      if (typeof model?.resetOpacity === "function") {
        await safeCall(
          `model ${modelId} resetOpacity`,
          () => model.resetOpacity(),
          failures
        );
      }
    }

    if (typeof fragments?.core?.update === "function") {
      await safeCall(
        "fragments core update",
        () => fragments.core.update(true),
        failures
      );
    }

    await waitFrames(3);
    await safeCall(
      "renderer render",
      () => renderWorld(world, renderer),
      failures
    );
    await waitFrames(2);
  } finally {
    restoreHighlighter();
  }

  const durationMs = Math.round(performance.now() - startedAt);
  const result = {
    ok: failures.length === 0,
    reason,
    modelCount: modelEntries.length,
    failures,
    durationMs,
  };

  const logMethod = result.ok ? "log" : "warn";
  console[logMethod](`${RESET_LOG_PREFIX} Finished soft reset.`, result);

  return result;
}
