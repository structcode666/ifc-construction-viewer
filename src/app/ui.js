export function getUI() {
  return {
    fileInput: document.getElementById("ifcFileInput"),
    loadButton: document.getElementById("loadButton"),
    statusText: document.getElementById("statusText"),
    viewerContainer: document.getElementById("viewer-container"),
  };
}

export function setStatus(text) {
  const statusText = document.getElementById("statusText");
  statusText.textContent = text;
}