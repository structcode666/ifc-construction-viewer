import { jsPDF } from "jspdf";





export function createStagePdfDocument() {
  return new jsPDF({
    orientation: "landscape",
    unit: "mm",
    format: "a3",
  });
}

/**
 * Fits an image inside a PDF rectangle without distorting it.
 *
 * This is the "contain" behaviour:
 * - the whole image is visible
 * - the image is not stretched
 * - empty margins may remain if the image and box have different aspect ratios
 */
function fitImageInsideBox({
  imageWidth,
  imageHeight,
  boxX,
  boxY,
  boxWidth,
  boxHeight,
}) {
  const imageRatio = imageWidth / imageHeight;
  const boxRatio = boxWidth / boxHeight;

  let drawWidth = boxWidth;
  let drawHeight = boxHeight;

  if (imageRatio > boxRatio) {
    drawWidth = boxWidth;
    drawHeight = boxWidth / imageRatio;
  } else {
    drawHeight = boxHeight;
    drawWidth = boxHeight * imageRatio;
  }

  const drawX = boxX + (boxWidth - drawWidth) / 2;
  const drawY = boxY + (boxHeight - drawHeight) / 2;

  return {
    x: drawX,
    y: drawY,
    width: drawWidth,
    height: drawHeight,
  };
}

/**
 * Writes wrapped text into a PDF.
 *
 * jsPDF does not automatically wrap long text, so we split the text into lines
 * that fit inside a maximum width.
 */
function addWrappedText(pdf, text, x, y, maxWidth, lineHeight) {
  const lines = pdf.splitTextToSize(text, maxWidth);
  pdf.text(lines, x, y);

  return y + lines.length * lineHeight;
}

/**
 * Crops white empty space from a captured viewer image.
 *
 * Why this exists:
 * html-to-image captures the whole viewer area. Even if the model is small in
 * the middle of the viewer, the PNG still includes all the surrounding white
 * space. If we place that whole PNG into the PDF, the model stays small.
 *
 * This function:
 * - loads the PNG
 * - scans the pixels
 * - finds the rectangle containing all non-white pixels
 * - adds padding around that rectangle
 * - returns a new cropped PNG
 */
export async function cropWhitespaceFromImage(
  imageDataUrl,
  { threshold = 245, paddingRatio = 0.14 } = {}
) {
  const image = new Image();
  image.src = imageDataUrl;

  await new Promise((resolve, reject) => {
    image.onload = resolve;
    image.onerror = reject;
  });

  const sourceCanvas = document.createElement("canvas");
  sourceCanvas.width = image.naturalWidth;
  sourceCanvas.height = image.naturalHeight;

  const sourceContext = sourceCanvas.getContext("2d");
  sourceContext.drawImage(image, 0, 0);

  const sourceWidth = sourceCanvas.width;
  const sourceHeight = sourceCanvas.height;

  const imageData = sourceContext.getImageData(
    0,
    0,
    sourceWidth,
    sourceHeight
  );

  const pixels = imageData.data;

  let minX = sourceWidth;
  let minY = sourceHeight;
  let maxX = -1;
  let maxY = -1;

  for (let y = 0; y < sourceHeight; y++) {
    for (let x = 0; x < sourceWidth; x++) {
      const pixelIndex = (y * sourceWidth + x) * 4;

      const red = pixels[pixelIndex];
      const green = pixels[pixelIndex + 1];
      const blue = pixels[pixelIndex + 2];
      const alpha = pixels[pixelIndex + 3];

      const isTransparent = alpha === 0;

      const isWhiteEnough =
        red >= threshold &&
        green >= threshold &&
        blue >= threshold;

      if (!isTransparent && !isWhiteEnough) {
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
      }
    }
  }

  const foundVisiblePixels = maxX !== -1 && maxY !== -1;

  if (!foundVisiblePixels) {
    return {
      imageDataUrl,
      width: sourceWidth,
      height: sourceHeight,
    };
  }

  const visibleWidth = maxX - minX + 1;
  const visibleHeight = maxY - minY + 1;

  const paddingX = Math.round(visibleWidth * paddingRatio);
  const paddingY = Math.round(visibleHeight * paddingRatio);

  const cropX = Math.max(0, minX - paddingX);
  const cropY = Math.max(0, minY - paddingY);
  const cropRight = Math.min(sourceWidth - 1, maxX + paddingX);
  const cropBottom = Math.min(sourceHeight - 1, maxY + paddingY);

  const cropWidth = cropRight - cropX + 1;
  const cropHeight = cropBottom - cropY + 1;

  const croppedCanvas = document.createElement("canvas");
  croppedCanvas.width = cropWidth;
  croppedCanvas.height = cropHeight;

  const croppedContext = croppedCanvas.getContext("2d");

  croppedContext.drawImage(
    sourceCanvas,
    cropX,
    cropY,
    cropWidth,
    cropHeight,
    0,
    0,
    cropWidth,
    cropHeight
  );

  return {
    imageDataUrl: croppedCanvas.toDataURL("image/png"),
    width: cropWidth,
    height: cropHeight,
  };
}

export function addStageSheetToPdf(pdf, {
  imageDataUrl,
  imagePixelWidth,
  imagePixelHeight,
  stageName,
  projectTitle = "PROJECT TITLE",
  sheetTitle = "CONSTRUCTION SEQUENCING",
  clientName = "CLIENT NAME",
  drawingNumber = "DRAFT-001",
  revision = "1",
  dateText = new Date().toLocaleDateString(),
  notes = [],
}) {
  // const pdf = new jsPDF({
  //   orientation: "landscape",
  //   unit: "mm",
  //   format: "a3",
  // });

  const pageWidth = pdf.internal.pageSize.getWidth();
  const pageHeight = pdf.internal.pageSize.getHeight();

  const margin = 8;
  const titleBlockHeight = 42;

  const contentTop = margin;
  const contentBottom = pageHeight - margin - titleBlockHeight;
  const contentHeight = contentBottom - contentTop;

  const leftPanelWidth = 96;
  const notesPanelWidth = 66;

  const leftX = margin;
  const mainX = leftX + leftPanelWidth;
  const notesX = pageWidth - margin - notesPanelWidth;

  const mainWidth = notesX - mainX;
  const notesWidth = notesPanelWidth;

  // ---------------------------------------------------------------------------
  // Sheet border and main panel layout
  // ---------------------------------------------------------------------------

  pdf.setLineWidth(0.35);
  pdf.setDrawColor(0, 0, 0);
  pdf.setTextColor(0, 0, 0);

  pdf.rect(margin, margin, pageWidth - margin * 2, pageHeight - margin * 2);

  pdf.line(mainX, contentTop, mainX, contentBottom);
  pdf.line(notesX, contentTop, notesX, contentBottom);
  pdf.line(margin, contentBottom, pageWidth - margin, contentBottom);

  // ---------------------------------------------------------------------------
  // Left panel: key plan + sequence table placeholders
  // ---------------------------------------------------------------------------

  pdf.setFont("helvetica", "bold");
  pdf.setFontSize(8);
  pdf.text("KEY PLAN", leftX + 4, contentTop + 7);

  pdf.setFont("helvetica", "normal");
  pdf.setFontSize(7);

  pdf.rect(leftX + 4, contentTop + 11, leftPanelWidth - 8, 75);
  pdf.text("Placeholder key plan / grid diagram", leftX + 8, contentTop + 22);

  const tableY = contentTop + 95;

  pdf.setFont("helvetica", "bold");
  pdf.setFontSize(8);
  pdf.text(`${stageName.toUpperCase()} SEQUENCE INFORMATION`, leftX + 4, tableY);

  pdf.setFont("helvetica", "normal");
  pdf.setFontSize(7);

  const tableX = leftX + 4;
  const tableWidth = leftPanelWidth - 8;
  const rowHeight = 7;

  const col1 = tableX + 18;
  const col2 = tableX + 52;
  const col3 = tableX + 72;

  pdf.rect(tableX, tableY + 4, tableWidth, rowHeight * 6);

  pdf.line(
    tableX,
    tableY + 4 + rowHeight,
    tableX + tableWidth,
    tableY + 4 + rowHeight
  );

  pdf.line(col1, tableY + 4, col1, tableY + 4 + rowHeight * 6);
  pdf.line(col2, tableY + 4, col2, tableY + 4 + rowHeight * 6);
  pdf.line(col3, tableY + 4, col3, tableY + 4 + rowHeight * 6);

  pdf.text("LIFT", tableX + 2, tableY + 9);
  pdf.text("ELEMENT", col1 + 2, tableY + 9);
  pdf.text("WEIGHT", col2 + 2, tableY + 9);
  pdf.text("TOTAL", col3 + 2, tableY + 9);

  for (let i = 1; i <= 5; i++) {
    const y = tableY + 9 + rowHeight * i;

    pdf.text(`LIFT ${i}`, tableX + 2, y);
    pdf.text("TBC", col1 + 2, y);
    pdf.text("-", col2 + 2, y);
    pdf.text("-", col3 + 2, y);

    if (i < 5) {
      pdf.line(
        tableX,
        tableY + 4 + rowHeight * (i + 1),
        tableX + tableWidth,
        tableY + 4 + rowHeight * (i + 1)
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Main 3D view panel
  // ---------------------------------------------------------------------------

  pdf.setFillColor(255, 255, 255);
  pdf.rect(mainX, contentTop, mainWidth, contentHeight, "F");

  const imagePadding = 0;

  const imageBox = {
    boxX: mainX + imagePadding,
    boxY: contentTop + imagePadding,
    boxWidth: mainWidth - imagePadding * 2,
    boxHeight: contentHeight - imagePadding * 2,
  };

  const fittedImage = fitImageInsideBox({
    imageWidth: imagePixelWidth,
    imageHeight: imagePixelHeight,
    ...imageBox,
  });

  pdf.addImage(
    imageDataUrl,
    "PNG",
    fittedImage.x,
    fittedImage.y,
    fittedImage.width,
    fittedImage.height
  );

  // ---------------------------------------------------------------------------
  // Right panel: construction notes
  // ---------------------------------------------------------------------------

  pdf.setFont("helvetica", "bold");
  pdf.setFontSize(8);
  pdf.text("CONSTRUCTION NOTES", notesX + 4, contentTop + 7);

  pdf.setFont("helvetica", "normal");
  pdf.setFontSize(6.8);

  const defaultNotes = [
    "Block assemblies represent a stable point in the structure.",
    "During steelwork installation, wind speed limits are to be confirmed by the project engineer.",
    "All individual lifts outside a block assembly are to be installed in a logical sequence.",
    "Ensure all bolts are snug tight before releasing from the crane hook.",
    "Temporary bracing, propping and packers are to be installed where required.",
    "This drawing is a sequencing diagram only and is not a substitute for approved structural drawings.",
  ];

  const notesToUse = notes.length > 0 ? notes : defaultNotes;

  let noteY = contentTop + 15;

  notesToUse.forEach((note, index) => {
    pdf.setFont("helvetica", "bold");
    pdf.text(`${index + 1}.`, notesX + 4, noteY);

    pdf.setFont("helvetica", "normal");

    noteY = addWrappedText(
      pdf,
      note,
      notesX + 9,
      noteY,
      notesWidth - 14,
      3.4
    );

    noteY += 3;
  });

  pdf.setDrawColor(255, 0, 0);
  pdf.setTextColor(255, 0, 0);

  pdf.rect(notesX + 4, contentBottom - 32, notesWidth - 8, 24);

  pdf.setFont("helvetica", "bold");
  pdf.setFontSize(6.5);

  addWrappedText(
    pdf,
    "ALL POST FIXED ANCHORS MUST BE INSTALLED IN ACCORDANCE WITH MANUFACTURER SPECIFICATIONS AND PROJECT DRAWINGS.",
    notesX + 7,
    contentBottom - 25,
    notesWidth - 14,
    3.2
  );

  pdf.setDrawColor(0, 0, 0);
  pdf.setTextColor(0, 0, 0);

  // ---------------------------------------------------------------------------
  // Bottom title block
  // ---------------------------------------------------------------------------

  const tbY = contentBottom;
  const tbBottom = pageHeight - margin;

  // We are removing the narrow metadata box on the far right.
  // So the title block now has 4 main cells:
  // Client | Project | Sheet | Logo

  const clientW = 110;
  const projectW = 120;
  const sheetW = 115;
  const logoW = pageWidth - margin * 2 - clientW - projectW - sheetW;

  const clientX = margin;
  const projectX = clientX + clientW;
  const sheetX = projectX + projectW;
  const logoX = sheetX + sheetW;
  const titleBlockRight = pageWidth - margin;

  // Vertical divisions
  pdf.line(projectX, tbY, projectX, tbBottom);
  pdf.line(sheetX, tbY, sheetX, tbBottom);
  pdf.line(logoX, tbY, logoX, tbBottom);

  // Main horizontal title-strip line
  // This is the long line you marked in red.
  const topTitleStripY = tbY + 8;
  pdf.line(clientX, topTitleStripY, titleBlockRight, topTitleStripY);

  // Small title labels
  pdf.setFont("helvetica", "normal");
  pdf.setFontSize(5.5);

  pdf.text("CLIENT NAME & ADDRESS", clientX + 3, tbY + 5.5);
  pdf.text("PROJECT TITLE", projectX + 3, tbY + 5.5);
  pdf.text("SHEET TITLE", sheetX + 3, tbY + 5.5);

  // Main values
  pdf.setFont("helvetica", "bold");

  pdf.setFontSize(13);
  pdf.text(clientName, clientX + 8, tbY + 26);

  pdf.setFontSize(10);
  pdf.text(projectTitle, projectX + 20, tbY + 26);

  pdf.setFontSize(9.5);
  const sheetTitleLines = pdf.splitTextToSize(
    `${sheetTitle}\n${stageName}`,
    sheetW - 10
  );
  pdf.text(sheetTitleLines, sheetX + 8, tbY + 21);

  // Logo block
  pdf.setFontSize(16);
  pdf.text("INNOVIS", logoX + 6, tbY + 22);

  pdf.setFont("helvetica", "normal");
  pdf.setFontSize(5.5);
  pdf.text("WWW.INNOVIS.COM.AU", logoX + 9, tbY + 29);

  // Copyright footer
  pdf.setFont("helvetica", "normal");
  pdf.setFontSize(4.5);

  pdf.text(
    "© INNOVIS PTY LTD. This drawing is generated for construction sequencing review purposes only.",
    margin,
    pageHeight - 2.5
  );

}

export function exportStageImageToPdf(stageSheetData) {
  const pdf = createStagePdfDocument();

  addStageSheetToPdf(pdf, stageSheetData);

  const safeStageName = stageSheetData.stageName
    .replaceAll(" ", "_")
    .replace(/[^\w-]/g, "");

  pdf.save(`${safeStageName}_sequencing.pdf`);
}

export function exportMultipleStageImagesToPdf(stageSheets) {
  const pdf = createStagePdfDocument();

  stageSheets.forEach((stageSheet, index) => {
    if (index > 0) {
      pdf.addPage();
    }

    addStageSheetToPdf(pdf, stageSheet);
  });

  pdf.save("construction_sequence_all_stages.pdf");
}