import * as THREE from "three";

const DEFAULT_WIDTH = 280;
const DEFAULT_HEIGHT = 150;
const MIN_WIDTH = 190;
const MIN_HEIGHT = 100;

function makeId() {
  return globalThis.crypto?.randomUUID?.() ??
    `comment-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function isTypingTarget(target) {
  return target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement ||
    target?.isContentEditable;
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

export function createCommentCalloutManager({
  world,
  fragments,
  container,
  modelRaycaster,
  onBeforeChange = () => {},
  onChanged = () => {},
  onStatus = () => {},
  canPlace = () => true,
}) {
  const comments = new Map();
  let placementActive = false;
  let visible = true;
  let pointerDown = null;

  const overlay = document.createElement("div");
  overlay.className = "comment-overlay";
  container.appendChild(overlay);

  function restoreCameraInput() {
    world.camera.setUserInput(true);
  }

  function finishEditing() {
    const activeEditor = document.activeElement?.closest?.(".comment-editor");
    activeEditor?.blur();
    restoreCameraInput();
  }

  function updateControls() {
    const button = document.getElementById("addCommentButton");
    button?.classList.toggle("is-active", placementActive);
    button?.setAttribute("aria-pressed", String(placementActive));
    container.classList.toggle("is-placing-comment", placementActive);
  }

  function setPlacementActive(next) {
    placementActive = Boolean(next);
    updateControls();
    onStatus(placementActive
      ? "Comment placement active. Click a point on the IFC model."
      : "Comment placement cancelled.");
  }

  function togglePlacement() {
    if (!placementActive && !canPlace()) return;
    setPlacementActive(!placementActive);
  }

  function isPlacementActive() {
    return placementActive;
  }

  function projectAnchor(anchor) {
    const rect = container.getBoundingClientRect();
    const projected = new THREE.Vector3(anchor.x, anchor.y, anchor.z)
      .project(world.camera.three);

    return {
      x: ((projected.x + 1) / 2) * rect.width,
      y: ((1 - projected.y) / 2) * rect.height,
      behind: projected.z < -1 || projected.z > 1,
    };
  }

  function updateComment(comment) {
    if (!comment.element) return;
    const anchor = projectAnchor(comment.anchor);
    const left = anchor.x + comment.offset.x;
    const top = anchor.y + comment.offset.y;

    comment.element.style.left = `${left}px`;
    comment.element.style.top = `${top}px`;
    comment.element.style.width = `${comment.size.width}px`;
    comment.element.style.height = `${comment.size.height}px`;
    comment.anchorElement.style.left = `${anchor.x}px`;
    comment.anchorElement.style.top = `${anchor.y}px`;

    const boxX = left + Math.max(0, Math.min(comment.size.width, anchor.x - left));
    const boxY = top + Math.max(0, Math.min(comment.size.height, anchor.y - top));
    const dx = boxX - anchor.x;
    const dy = boxY - anchor.y;
    const length = Math.hypot(dx, dy);

    comment.leader.style.left = `${anchor.x}px`;
    comment.leader.style.top = `${anchor.y}px`;
    comment.leader.style.width = `${length}px`;
    comment.leader.style.transform = `rotate(${Math.atan2(dy, dx)}rad)`;
    comment.wrapper.classList.toggle("is-behind-camera", anchor.behind);
  }

  function updateAll() {
    for (const comment of comments.values()) updateComment(comment);
  }

  function insertTextAtSelection(text) {
    const selection = window.getSelection();
    if (!selection?.rangeCount) return;
    selection.deleteFromDocument();
    const node = document.createTextNode(text);
    const range = selection.getRangeAt(0);
    range.insertNode(node);
    range.setStartAfter(node);
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);
  }

  function createDom(comment) {
    const wrapper = document.createElement("div");
    wrapper.className = "comment-callout-wrapper";
    wrapper.dataset.commentId = comment.id;

    const leader = document.createElement("div");
    leader.className = "comment-leader";
    const anchorElement = document.createElement("div");
    anchorElement.className = "comment-anchor";

    const element = document.createElement("article");
    element.className = "comment-callout";

    const header = document.createElement("div");
    header.className = "comment-callout-header";
    header.innerHTML = '<span>Comment</span>';

    const deleteButton = document.createElement("button");
    deleteButton.type = "button";
    deleteButton.className = "comment-delete-button";
    deleteButton.title = "Delete comment";
    deleteButton.setAttribute("aria-label", "Delete comment");
    deleteButton.textContent = "×";
    header.appendChild(deleteButton);

    const editor = document.createElement("div");
    editor.className = "comment-editor";
    editor.contentEditable = "true";
    editor.dataset.placeholder = "Type a comment or paste a screenshot…";
    editor.setAttribute("role", "textbox");
    editor.setAttribute("aria-multiline", "true");
    editor.innerHTML = comment.html ?? "";

    element.append(header, editor);
    wrapper.append(leader, anchorElement, element);
    overlay.appendChild(wrapper);

    Object.assign(comment, { wrapper, leader, anchorElement, element, editor });

    let drag = null;
    header.addEventListener("pointerdown", (event) => {
      if (event.button !== 0 || event.target === deleteButton) return;
      onBeforeChange("move comment");
      drag = {
        pointerId: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        offset: { ...comment.offset },
      };
      header.setPointerCapture(event.pointerId);
      world.camera.setUserInput(false);
      element.classList.add("is-dragging");
      event.preventDefault();
      event.stopPropagation();
    });

    header.addEventListener("pointermove", (event) => {
      if (!drag || drag.pointerId !== event.pointerId) return;
      comment.offset.x = drag.offset.x + event.clientX - drag.x;
      comment.offset.y = drag.offset.y + event.clientY - drag.y;
      updateComment(comment);
      event.preventDefault();
      event.stopPropagation();
    });

    const finishDrag = (event) => {
      if (!drag || drag.pointerId !== event.pointerId) return;
      drag = null;
      restoreCameraInput();
      element.classList.remove("is-dragging");
      onChanged();
      event.stopPropagation();
    };
    header.addEventListener("pointerup", finishDrag);
    header.addEventListener("pointercancel", finishDrag);

    let resizeStart = null;
    const resizeObserver = new ResizeObserver(() => {
      const width = Math.max(MIN_WIDTH, Math.round(element.offsetWidth));
      const height = Math.max(MIN_HEIGHT, Math.round(element.offsetHeight));
      if (width === comment.size.width && height === comment.size.height) return;
      if (!resizeStart) onBeforeChange("resize comment");
      resizeStart = true;
      comment.size = { width, height };
      updateComment(comment);
      onChanged();
      clearTimeout(comment.resizeTimer);
      comment.resizeTimer = setTimeout(() => { resizeStart = null; }, 300);
    });
    resizeObserver.observe(element);
    comment.resizeObserver = resizeObserver;

    editor.addEventListener("blur", () => {
      comment.html = editor.innerHTML;
      onChanged();
    });
    editor.addEventListener("keydown", (event) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      editor.blur();
      restoreCameraInput();
    });
    editor.addEventListener("input", () => {
      comment.html = editor.innerHTML;
    });
    editor.addEventListener("paste", async (event) => {
      const imageItems = [...(event.clipboardData?.items ?? [])]
        .filter((item) => item.kind === "file" && item.type.startsWith("image/"));
      if (imageItems.length === 0) return;

      event.preventDefault();
      onBeforeChange("paste image into comment");
      for (const item of imageItems) {
        const file = item.getAsFile();
        if (!file) continue;
        const image = document.createElement("img");
        image.src = await readFileAsDataUrl(file);
        image.alt = "Pasted comment image";
        editor.appendChild(image);
      }
      const text = event.clipboardData?.getData("text/plain");
      if (text) insertTextAtSelection(text);
      comment.html = editor.innerHTML;
      comment.size.width = Math.max(comment.size.width, 320);
      comment.size.height = Math.max(comment.size.height, 220);
      updateComment(comment);
      onChanged();
    });

    deleteButton.addEventListener("click", (event) => {
      event.stopPropagation();
      onBeforeChange("delete comment");
      remove(comment.id);
      onStatus("Comment deleted.");
    });

    element.addEventListener("pointerdown", (event) => event.stopPropagation());
    element.addEventListener("click", (event) => event.stopPropagation());
    element.addEventListener("wheel", (event) => event.stopPropagation());
    updateComment(comment);
  }

  function add(data, { focus = false } = {}) {
    const comment = {
      id: data.id ?? makeId(),
      modelId: data.modelId ?? null,
      localId: Number.isFinite(data.localId) ? data.localId : null,
      anchor: {
        x: Number(data.anchor?.x) || 0,
        y: Number(data.anchor?.y) || 0,
        z: Number(data.anchor?.z) || 0,
      },
      offset: {
        x: Number.isFinite(data.offset?.x) ? data.offset.x : 36,
        y: Number.isFinite(data.offset?.y) ? data.offset.y : -70,
      },
      size: {
        width: Math.max(MIN_WIDTH, Number(data.size?.width) || DEFAULT_WIDTH),
        height: Math.max(MIN_HEIGHT, Number(data.size?.height) || DEFAULT_HEIGHT),
      },
      html: typeof data.html === "string" ? data.html : "",
    };
    comments.set(comment.id, comment);
    createDom(comment);
    if (focus) requestAnimationFrame(() => comment.editor.focus());
    return comment;
  }

  function remove(id) {
    const comment = comments.get(id);
    if (!comment) return;
    comment.resizeObserver?.disconnect();
    clearTimeout(comment.resizeTimer);
    if (comment.element?.contains(document.activeElement)) finishEditing();
    comment.wrapper?.remove();
    comments.delete(id);
    onChanged();
  }

  function clear() {
    finishEditing();
    for (const comment of comments.values()) {
      comment.resizeObserver?.disconnect();
      clearTimeout(comment.resizeTimer);
      comment.wrapper?.remove();
    }
    comments.clear();
    setPlacementActive(false);
  }

  function serialize() {
    return [...comments.values()].map((comment) => ({
      id: comment.id,
      modelId: comment.modelId,
      localId: comment.localId,
      anchor: { ...comment.anchor },
      offset: { ...comment.offset },
      size: { ...comment.size },
      html: comment.editor?.innerHTML ?? comment.html,
    }));
  }

  function restore(snapshot) {
    clear();
    for (const data of Array.isArray(snapshot) ? snapshot : []) add(data);
    setVisible(visible);
    updateAll();
  }

  function setVisible(next) {
    visible = Boolean(next);
    if (!visible) finishEditing();
    overlay.classList.toggle("is-hidden", !visible);
  }

  function toggleVisible() {
    setVisible(!visible);
    return visible;
  }

  container.addEventListener("pointerdown", (event) => {
    if (!placementActive || event.button !== 0) return;
    pointerDown = { x: event.clientX, y: event.clientY };
  });

  container.addEventListener("pointerup", async (event) => {
    if (!placementActive || !pointerDown || event.button !== 0) return;
    const movement = Math.hypot(event.clientX - pointerDown.x, event.clientY - pointerDown.y);
    pointerDown = null;
    if (movement > 5) return;

    try {
      const result = await modelRaycaster.castRay();
      if (!result?.point) {
        onStatus("Click directly on an IFC element to place the comment.");
        return;
      }
      onBeforeChange("add comment");
      const point = result.point;
      add({
        modelId: result.fragments?.modelId ?? null,
        localId: result.localId,
        anchor: { x: point.x, y: point.y, z: point.z },
      }, { focus: true });
      setPlacementActive(false);
      onChanged();
      onStatus("Comment added. Type text or paste a screenshot with Ctrl+V.");
    } catch (error) {
      console.error("Comment placement failed:", error);
      onStatus("Failed to place comment.");
    }
  });

  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && placementActive) {
      event.preventDefault();
      setPlacementActive(false);
      return;
    }
    if (isTypingTarget(event.target)) return;
    if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
    if (event.key.toLowerCase() !== "q") return;
    event.preventDefault();
    togglePlacement();
  });

  document.addEventListener("pointerdown", (event) => {
    if (event.target.closest?.(".comment-callout")) return;
    finishEditing();
  }, true);

  window.addEventListener("blur", restoreCameraInput);

  world.camera.controls.addEventListener("update", updateAll);
  window.addEventListener("resize", updateAll);

  return {
    add,
    clear,
    restore,
    serialize,
    updateAll,
    setVisible,
    toggleVisible,
    isVisible: () => visible,
    isPlacementActive,
    setPlacementActive,
    togglePlacement,
  };
}
