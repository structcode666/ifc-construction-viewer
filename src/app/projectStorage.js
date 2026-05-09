import JSZip from "jszip";

export async function saveProjectFile({
  ifcFile,
  stagingSnapshot,
  projectName = "construction-project",
}) {
  if (!ifcFile) {
    throw new Error("Cannot save project because no IFC file is loaded.");
  }

  const zip = new JSZip();

  const manifest = {
    app: "IFC Construction Viewer",
    projectVersion: 1,
    createdAt: new Date().toISOString(),
    ifcFileName: ifcFile.name,
  };

  zip.file("manifest.json", JSON.stringify(manifest, null, 2));
  zip.file("staging.json", JSON.stringify(stagingSnapshot, null, 2));
  zip.file("model.ifc", ifcFile);

  const projectBlob = await zip.generateAsync({
    type: "blob",
    compression: "DEFLATE",
    compressionOptions: {
      level: 6,
    },
  });

  downloadBlob(projectBlob, `${projectName}.ifcseq`);
}

export async function readProjectFile(projectFile) {
  const zip = await JSZip.loadAsync(projectFile);

  const manifestFile = zip.file("manifest.json");
  const stagingFile = zip.file("staging.json");
  const ifcZipFile = zip.file("model.ifc");

  if (!manifestFile || !stagingFile || !ifcZipFile) {
    throw new Error("Invalid project file. Required files are missing.");
  }

  const manifestText = await manifestFile.async("string");
  const stagingText = await stagingFile.async("string");
  const ifcBlob = await ifcZipFile.async("blob");

  const manifest = JSON.parse(manifestText);
  const stagingSnapshot = JSON.parse(stagingText);

  const ifcFile = new File([ifcBlob], manifest.ifcFileName || "model.ifc", {
    type: "application/octet-stream",
  });

  return {
    manifest,
    stagingSnapshot,
    ifcFile,
  };
}

function downloadBlob(blob, fileName) {
  const url = URL.createObjectURL(blob);

  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;

  document.body.appendChild(anchor);
  anchor.click();

  anchor.remove();
  URL.revokeObjectURL(url);
}