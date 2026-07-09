import * as OBC from "@thatopen/components";
import * as OBCF from "@thatopen/components-front";

const NORMAL_DOLLY_SPEED = 0.3;
const PRECISION_DOLLY_SPEED = 0.06;

function isTypingTarget(target) {
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement ||
    target?.isContentEditable
  );
}

function setupPrecisionZoom(container, controls) {
  let isPrecisionZooming = false;

  const setNormalSpeed = () => {
    controls.dollySpeed = NORMAL_DOLLY_SPEED;
  };

  const handleKeyDown = (event) => {
    if (isTypingTarget(event.target)) return;
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.key.toLowerCase() !== "z") return;

    isPrecisionZooming = true;
  };

  const handleKeyUp = (event) => {
    if (event.key.toLowerCase() !== "z") return;

    isPrecisionZooming = false;
    setNormalSpeed();
  };

  const handleBlur = () => {
    isPrecisionZooming = false;
    setNormalSpeed();
  };

  const handleWheel = () => {
    controls.dollySpeed = isPrecisionZooming
      ? PRECISION_DOLLY_SPEED
      : NORMAL_DOLLY_SPEED;
  };

  window.addEventListener("keydown", handleKeyDown);
  window.addEventListener("keyup", handleKeyUp);
  window.addEventListener("blur", handleBlur);
  container.addEventListener("wheel", handleWheel, { capture: true });

  setNormalSpeed();
}

export async function setupWorld(container) {
  const components = new OBC.Components();

  const worlds = components.get(OBC.Worlds);
  const world = worlds.create();

  world.scene = new OBC.SimpleScene(components);
  world.renderer = new OBCF.PostproductionRenderer(components, container);
  world.camera = new OBC.OrthoPerspectiveCamera(components);

  container.addEventListener("contextmenu", (event) => {
    event.preventDefault();
  });

  world.scene.setup();
  components.init();

  await world.camera.controls.setLookAt(12, 10, 8, 0, 0, 0);

  setupPrecisionZoom(container, world.camera.controls);

  world.camera.set("Orbit");
  world.camera.setUserInput(true);

  const githubUrl =
    "https://thatopen.github.io/engine_fragment/resources/worker.mjs";

  const fetchedWorker = await fetch(githubUrl);
  const workerBlob = await fetchedWorker.blob();
  const workerFile = new File([workerBlob], "worker.mjs", {
    type: "text/javascript",
  });
  const workerUrl = URL.createObjectURL(workerFile);

  const fragments = components.get(OBC.FragmentsManager);
  fragments.init(workerUrl);

  world.camera.controls.addEventListener("update", () => {
    fragments.core.update();
  });

  world.onCameraChanged.add((camera) => {
    for (const [, model] of fragments.list) {
      model.useCamera(camera.three);
    }
    fragments.core.update(true);
  });

  fragments.list.onItemSet.add(({ value: model }) => {
    model.useCamera(world.camera.three);
    world.scene.three.add(model.object);
    fragments.core.update(true);
  });

  return {
    components,
    world,
    fragments,
    orbitControls: world.camera.controls,
    workerUrl,
  };
}
