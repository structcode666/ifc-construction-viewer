import * as OBC from "@thatopen/components";

let loaderIsSetup = false;

export async function loadIfcFromFile(components, file, onProgress) {
  const ifcLoader = components.get(OBC.IfcLoader);

  if (!loaderIsSetup) {
    await ifcLoader.setup({
      autoSetWasm: false,
      wasm: {
        path: "https://unpkg.com/web-ifc@0.0.77/",
        absolute: true,
      },
    });

    loaderIsSetup = true;
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

  return model;
}