// @vitest-environment jsdom
import { act } from "react";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ImageViewer,
  imageViewerTarget,
} from "../../src/main/components/ImageViewer";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function renderViewer(onClose: () => void = vi.fn()): HTMLImageElement {
  act(() => {
    root.render(
      createElement(ImageViewer, {
        src: "https://example.test/a.png",
        alt: "示例图",
        onClose,
      }),
    );
  });
  return container.querySelector(
    '[data-testid="image-viewer-image"]',
  ) as HTMLImageElement;
}

describe("imageViewerTarget", () => {
  it("returns the resolved src and alt for image targets", () => {
    const image = document.createElement("img");
    image.src = "https://example.test/a.png";
    image.alt = "示例";
    expect(imageViewerTarget(image)).toEqual({
      src: "https://example.test/a.png",
      alt: "示例",
    });
  });

  it("ignores non-image targets and images without src", () => {
    expect(imageViewerTarget(document.createElement("p"))).toBeNull();
    expect(imageViewerTarget(document.createElement("img"))).toBeNull();
  });
});

describe("ImageViewer", () => {
  it("renders the image in a modal dialog", () => {
    const image = renderViewer();
    expect(
      container.querySelector('[data-testid="image-viewer"]'),
    ).toBeTruthy();
    expect(
      container
        .querySelector('[data-testid="image-viewer"]')
        ?.getAttribute("role"),
    ).toBe("dialog");
    expect(image.getAttribute("src")).toBe("https://example.test/a.png");
    expect(image.getAttribute("alt")).toBe("示例图");
    expect(image.getAttribute("data-fit")).toBe("true");
  });

  it("closes on Escape", () => {
    const onClose = vi.fn();
    renderViewer(onClose);
    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes from the close button and the backdrop", () => {
    const onClose = vi.fn();
    renderViewer(onClose);
    act(() => {
      container
        .querySelector('[data-testid="image-viewer-close"]')
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onClose).toHaveBeenCalledTimes(1);
    act(() => {
      container
        .querySelector('[data-testid="image-viewer"]')
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("closes the viewer when the image is double-clicked", () => {
    const onClose = vi.fn();
    const image = renderViewer(onClose);
    act(() => {
      image.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("zooms with the mouse wheel based on the rendered scale", () => {
    const image = renderViewer();
    Object.defineProperty(image, "naturalWidth", { value: 1000 });
    Object.defineProperty(image, "clientWidth", { value: 500 });
    act(() => {
      container
        .querySelector('[data-testid="image-viewer"]')
        ?.dispatchEvent(
          new WheelEvent("wheel", {
            bubbles: true,
            cancelable: true,
            deltaY: -100,
          }),
        );
    });
    expect(image.getAttribute("data-fit")).toBe("false");
    // 当前 0.5 倍 × 1.2 步进 = 0.6 倍。
    expect(image.style.width).toBe("60%");
  });
});
