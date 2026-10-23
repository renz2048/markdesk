import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from "react";

const MIN_SCALE = 0.05;
const MAX_SCALE = 8;
const ZOOM_STEP = 1.2;

// 双击事件目标是 <img> 时返回其地址，供图片查看浮层使用；其余目标返回
// null。src 用元素属性（已解析为绝对地址），markdesk-resource: 与
// http(s)/data: 均可原样传给浮层（CSP img-src 已放行）。
export function imageViewerTarget(
  target: EventTarget | null,
): { src: string; alt: string } | null {
  if (target instanceof HTMLImageElement && target.src) {
    return { src: target.src, alt: target.alt };
  }
  return null;
}

// 全屏图片查看浮层：双击打开、双击或 Esc/点击背景关闭，滚轮缩放；
// 放大超出视口后容器自然出现滚动条。
export function ImageViewer({
  src,
  alt,
  onClose,
}: {
  src: string;
  alt: string;
  onClose(): void;
}) {
  // null 表示适配视口模式；数值表示相对原始尺寸的缩放倍数。
  const [scale, setScale] = useState<number | null>(null);
  const [natural, setNatural] = useState<{ width: number } | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    // React 将 wheel 以 passive 方式挂载导致 preventDefault 无效，
    // 这里用原生监听阻止浮层背后的编辑区跟着滚动。
    const handleWheel = (event: WheelEvent): void => {
      event.preventDefault();
      const image = imageRef.current;
      if (!image || !image.naturalWidth) return;
      const current = image.clientWidth / image.naturalWidth;
      const factor = event.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP;
      setScale(Math.min(MAX_SCALE, Math.max(MIN_SCALE, current * factor)));
    };
    container.addEventListener("wheel", handleWheel, { passive: false });
    return () => container.removeEventListener("wheel", handleWheel);
  }, []);

  const handleBackdropClick = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>) => {
      if (event.target === event.currentTarget) onClose();
    },
    [onClose],
  );

  return (
    <div
      className="image-viewer"
      data-testid="image-viewer"
      role="dialog"
      aria-modal="true"
      aria-label="图片查看器"
      ref={containerRef}
      onClick={handleBackdropClick}
    >
      <img
        ref={imageRef}
        src={src}
        alt={alt}
        title="双击关闭 · 滚轮缩放"
        data-testid="image-viewer-image"
        data-fit={scale === null ? "true" : "false"}
        style={
          scale === null
            ? undefined
            : {
                // naturalWidth 在图片加载前不可用，退化为百分比宽度。
                width: natural
                  ? `${Math.round(natural.width * scale)}px`
                  : `${scale * 100}%`,
              }
        }
        onLoad={(event) => {
          const image = event.currentTarget;
          if (image.naturalWidth) {
            setNatural({ width: image.naturalWidth });
          }
        }}
        onDoubleClick={onClose}
        draggable={false}
      />
      <button
        type="button"
        className="image-viewer-close"
        data-testid="image-viewer-close"
        aria-label="关闭图片查看器"
        title="关闭 (Esc)"
        onClick={onClose}
      >
        ×
      </button>
    </div>
  );
}
