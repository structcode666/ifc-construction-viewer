import * as OBC from "@thatopen/components";

export async function setupWorld(container) {
  const components = new OBC.Components();

  const worlds = components.get(OBC.Worlds);
  const world = worlds.create();

  world.scene = new OBC.SimpleScene(components);
  world.renderer = new OBC.SimpleRenderer(components, container);
  world.camera = new OBC.OrthoPerspectiveCamera(components);

  container.addEventListener("contextmenu", (event) => {
    event.preventDefault();
  });

  world.scene.setup();
  components.init();

  await world.camera.controls.setLookAt(12, 10, 8, 0, 0, 0);

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

  return { components, world, fragments, orbitControls: world.camera.controls };
}