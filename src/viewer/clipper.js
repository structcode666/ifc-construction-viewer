import * as OBC from "@thatopen/components";

let clipper = null;
let clippingEnabled = false;

export async function initClipping({ components, world, container }) {
  clipper = components.get(OBC.Clipper);

  await clipper.setup({
    world,
  });

  clipper.enabled = true;
  clipper.visible = false;

  container.addEventListener("dblclick", async (event) => {
    if (!clippingEnabled) return;

    const clickedToolbar = event.target.closest(".viewer-top-right-controls");

    if (clickedToolbar) return;

    await clipper.create(world);
  });

  return clipper;
}

export function setClippingEnabled(enabled) {
  clippingEnabled = enabled;

  if (!clipper) return;

  clipper.visible = enabled;
}

export function toggleClippingEnabled() {
  clippingEnabled = !clippingEnabled;

  if (clipper) {
    clipper.visible = clippingEnabled;
  }

  return clippingEnabled;
}

export function clearClippingPlanes() {
  if (!clipper) return;

  clipper.deleteAll();
}

export function isClippingEnabled() {
  return clippingEnabled;
}