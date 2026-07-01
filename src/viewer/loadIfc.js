import * as OBC from "@thatopen/components";
import { extractIfcGridMetadataFromBuffer } from "./ifcGridLayer.js";

const setupLoaders = new WeakSet();

export async function loadIfcFromFile(components, file, onProgress) {
  const ifcLoader = components.get(OBC.IfcLoader);

  if (!setupLoaders.has(ifcLoader)) {
    await ifcLoader.setup({
      autoSetWasm: false,
      wasm: {
        path: "https://unpkg.com/web-ifc@0.0.77/",
        absolute: true,
      },
    });

    setupLoaders.add(ifcLoader);
  }

  const arrayBuffer = await file.arrayBuffer();
  const buffer = new Uint8Array(arrayBuffer);

  const model = await ifcLoader.load(buffer, false, file.name, {
    processData: {
      progressCallback: (progress) => {
        console.log("IFC conversion progress:", progress);

        if (onProgress) {
          onProgress(progress);
        }
      },
    },
  });

  model.userData ??= {};
  model.userData.keyPlanMetadata =
    await extractIfcGridMetadataFromBuffer({
      buffer,
      fragmentModel: model,
    });

  window.__keyPlanMetadata = model.userData.keyPlanMetadata;

  console.log("[Key Plan] Metadata after IFC load:", {
  available: model.userData.keyPlanMetadata?.available,
  gridCount: model.userData.keyPlanMetadata?.grids?.length ?? 0,
  modelBounds: model.userData.keyPlanMetadata?.modelBounds,
});

  return model;
}
