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
    removeSelectedButton: document.getElementById("removeSelectedButton"),
    restoreRemovedButton: document.getElementById("restoreRemovedButton"),
    resetVisibilityButton: document.getElementById("resetVisibilityButton"),
    toggleModeButton: document.getElementById("toggleMode"),

    addStageButton: document.getElementById("add-stage-button"),
    assignStageButton: document.getElementById("assign-stage-button"),
    assignStageZeroButton: document.getElementById("assign-stage-zero-button"),
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

    toggleGridsButton: document.getElementById("toggleGridsButton"),
    gridLevelSelect: document.getElementById("gridLevelSelect"),

    drawConcreteButton: document.getElementById("drawConcreteButton"),
    concreteHeightInput: document.getElementById("concreteHeightInput"),
    concreteTransformModeButtons: document.querySelectorAll(
      "[data-concrete-transform-mode]"
    ),
    deleteConcreteButton: document.getElementById("deleteConcreteButton"),
    snapConcreteButton: document.getElementById("snapConcreteButton"),

    saveProjectButton: document.getElementById("saveProjectButton"),
    projectFileInput: document.getElementById("projectFileInput"),


    renameStageButton: document.getElementById("rename-stage-button"),
    clearStageButton: document.getElementById("clear-stage-button"),
    deleteStageButton: document.getElementById("delete-stage-button"),

    saveStageViewButton: document.getElementById("save-stage-view-button"),
    restoreStageViewButton: document.getElementById("restore-stage-view-button"),

    createLiftButton: document.getElementById("create-lift-button"),

    toggleLiftLabelsButton: document.getElementById("toggleLiftLabelsButton"),

    exportStagePdfButton: document.getElementById("export-stage-pdf-button"),

    exportAllStagesPdfButton: document.getElementById("export-all-stages-pdf-button"),
    
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
