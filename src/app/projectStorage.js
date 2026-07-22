import JSZip from "jszip";

export async function saveProjectFile({
  ifcFile,
  stagingSnapshot,
  commentsSnapshot = [],
  projectName = "construction-project",
}) {
  if (!ifcFile) {
    throw new Error("Cannot save project because no IFC file is loaded.");
  }

  const zip = new JSZip();

  const manifest = {
    app: "IFC Construction Viewer",
    projectVersion: 2,
    createdAt: new Date().toISOString(),
    ifcFileName: ifcFile.name,
  };

  zip.file("manifest.json", JSON.stringify(manifest, null, 2));
  zip.file("staging.json", JSON.stringify(stagingSnapshot, null, 2));
  zip.file("model.ifc", ifcFile);

  const storedComments = commentsSnapshot.map((comment) => ({ ...comment }));

  for (const comment of storedComments) {
    const document = new DOMParser().parseFromString(
      `<div>${comment.html ?? ""}</div>`,
      "text/html"
    );
    const images = [...document.querySelectorAll("img")];

    images.forEach((image, index) => {
      const match = image.src.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
      if (!match) return;
      const extension = match[1].includes("jpeg") ? "jpg" :
        match[1].includes("webp") ? "webp" : "png";
      const path = `comments/${comment.id}/image-${index + 1}.${extension}`;
      zip.file(path, match[2], { base64: true });
      image.setAttribute("src", path);
    });

    comment.html = document.body.firstElementChild?.innerHTML ?? "";
  }

  zip.file("comments.json", JSON.stringify(storedComments, null, 2));

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
  const commentsFile = zip.file("comments.json");

  if (!manifestFile || !stagingFile || !ifcZipFile) {
    throw new Error("Invalid project file. Required files are missing.");
  }

  const manifestText = await manifestFile.async("string");
  const stagingText = await stagingFile.async("string");
  const ifcBlob = await ifcZipFile.async("blob");

  const manifest = JSON.parse(manifestText);
  const stagingSnapshot = JSON.parse(stagingText);
  const commentsSnapshot = commentsFile
    ? JSON.parse(await commentsFile.async("string"))
    : [];

  for (const comment of commentsSnapshot) {
    const document = new DOMParser().parseFromString(
      `<div>${comment.html ?? ""}</div>`,
      "text/html"
    );

    for (const image of document.querySelectorAll("img")) {
      const path = image.getAttribute("src");
      const imageFile = path ? zip.file(path) : null;
      if (!imageFile) continue;
      const bytes = await imageFile.async("uint8array");
      const mimeType = path.endsWith(".jpg") ? "image/jpeg" :
        path.endsWith(".webp") ? "image/webp" : "image/png";
      const blob = new Blob([bytes], { type: mimeType });
      image.setAttribute("src", await blobToDataUrl(blob));
    }

    comment.html = document.body.firstElementChild?.innerHTML ?? "";
  }

  const ifcFile = new File([ifcBlob], manifest.ifcFileName || "model.ifc", {
    type: "application/octet-stream",
  });

  return {
    manifest,
    stagingSnapshot,
    commentsSnapshot,
    ifcFile,
  };
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
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
