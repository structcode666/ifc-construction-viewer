export function getUI() {
  return {
    fileInput: document.getElementById("ifcFileInput"),
    loadButton: document.getElementById("loadButton"),
    statusText: document.getElementById("statusText"),
    selectionInfo: document.getElementById("selectionInfo"),

    viewerContainer: document.getElementById("viewer-container"),
    viewerArea: document.querySelector(".viewer-area"),

    hideSelectedButton: document.getElementById("hideSelectedButton"),
    isolateSelectedButton: document.getElementById("isolateSelectedButton"),
    resetVisibilityButton: document.getElementById("resetVisibilityButton"),
    toggleModeButton: document.getElementById("toggleMode"),

    addStageButton: document.getElementById("add-stage-button"),
    assignStageButton: document.getElementById("assign-stage-button"),
    stageSlider: document.getElementById("stage-slider"),
    stageLabel: document.getElementById("stage-label"),
    stageSummary: document.getElementById("stage-summary"),
    stagingTimeline: document.getElementById("staging-timeline"),

    // Your HTML uses id="showContextButton"
    toggleContextButton: document.getElementById("showContextButton"),

    loadingOverlay: document.getElementById("loadingOverlay"),
    loadingBar: document.getElementById("loadingBar"),
    loadingText: document.getElementById("loadingText"),

    toggleClippingButton: document.getElementById("toggleClippingButton"),
    clearClippingButton: document.getElementById("clearClippingButton"),
  };
}

export function setStatus(text) {
  const statusText = document.getElementById("statusText");

  if (!statusText) return;

  statusText.textContent = text;
}

export function setSelectionInfo(text) {
  const selectionInfo = document.getElementById("selectionInfo");

  if (!selectionInfo) return;

  selectionInfo.textContent = text;
}