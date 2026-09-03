import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { Button, Input, Modal, Tooltip } from "antd";
import { ArrowUpRight, Redo2, RotateCcw, Type, Undo2, WandSparkles, X, ZoomIn, ZoomOut } from "lucide-react";
import { useTranslation } from "react-i18next";

import { randomId } from "@/lib/utils";
import { readImageMeta } from "@/lib/image-utils";
import { useImageEditorViewport } from "@/components/canvas/use-image-editor-viewport";

export type CanvasImageAnnotationEditPayload = {
    prompt: string;
    annotatedDataUrl: string;
};

type AnnotationTool = "arrow" | "text";
type Point = { x: number; y: number };
type ArrowAnnotation = { id: string; kind: "arrow"; from: Point; to: Point };
type TextAnnotation = { id: string; kind: "text"; at: Point; text: string };
type Annotation = ArrowAnnotation | TextAnnotation;

const annotationColor = "#ef4444";

export function CanvasNodeAnnotationEditDialog({ dataUrl, open, onClose, onConfirm }: { dataUrl: string; open: boolean; onClose: () => void; onConfirm: (payload: CanvasImageAnnotationEditPayload) => void }) {
    const { t } = useTranslation();
    const previewCanvasRef = useRef<HTMLCanvasElement>(null);
    const drawingRef = useRef<{ active: boolean; from: Point | null }>({ active: false, from: null });
    const historyRef = useRef<Annotation[]>([]);
    const redoRef = useRef<Annotation[]>([]);
    const [image, setImage] = useState<{ width: number; height: number } | null>(null);
    const [prompt, setPrompt] = useState("");
    const [tool, setTool] = useState<AnnotationTool>("arrow");
    const [annotations, setAnnotations] = useState<Annotation[]>([]);
    const [historySize, setHistorySize] = useState(0);
    const [redoSize, setRedoSize] = useState(0);
    const [error, setError] = useState("");
    const [submitting, setSubmitting] = useState(false);
    const [textDraft, setTextDraft] = useState<{ id: string; at: Point; text: string } | null>(null);
    const viewport = useImageEditorViewport(image, open);

    useEffect(() => {
        if (!open) return;
        setPrompt("");
        setTool("arrow");
        setAnnotations([]);
        setHistorySize(0);
        setRedoSize(0);
        setError("");
        setSubmitting(false);
        setTextDraft(null);
        historyRef.current = [];
        redoRef.current = [];
        drawingRef.current = { active: false, from: null };
        void readImageMeta(dataUrl).then(setImage);
    }, [dataUrl, open]);

    const pushAnnotation = useCallback((annotation: Annotation) => {
        historyRef.current = [...historyRef.current, annotation];
        redoRef.current = [];
        setAnnotations([...historyRef.current]);
        setHistorySize(historyRef.current.length);
        setRedoSize(0);
        setError("");
    }, []);

    const undoAnnotation = useCallback(() => {
        if (drawingRef.current.active || !historyRef.current.length) return;
        const last = historyRef.current[historyRef.current.length - 1];
        historyRef.current = historyRef.current.slice(0, -1);
        redoRef.current = [...redoRef.current, last];
        setAnnotations([...historyRef.current]);
        setHistorySize(historyRef.current.length);
        setRedoSize(redoRef.current.length);
        setError("");
    }, []);

    const redoAnnotation = useCallback(() => {
        if (drawingRef.current.active || !redoRef.current.length) return;
        const last = redoRef.current[redoRef.current.length - 1];
        redoRef.current = redoRef.current.slice(0, -1);
        historyRef.current = [...historyRef.current, last];
        setAnnotations([...historyRef.current]);
        setHistorySize(historyRef.current.length);
        setRedoSize(redoRef.current.length);
        setError("");
    }, []);

    const resetAnnotations = useCallback(() => {
        historyRef.current = [];
        redoRef.current = [];
        setAnnotations([]);
        setHistorySize(0);
        setRedoSize(0);
        setTextDraft(null);
        setError("");
    }, []);

    useEffect(() => {
        if (!open) return;
        const handleKeyDown = (event: KeyboardEvent) => {
            const target = event.target instanceof Element ? event.target : null;
            if (target?.closest("input,textarea,[contenteditable=true]")) return;
            const key = event.key.toLowerCase();
            const modifier = (event.metaKey || event.ctrlKey) && !event.altKey;
            const isUndo = modifier && !event.shiftKey && key === "z";
            const isRedo = modifier && ((event.shiftKey && key === "z") || (!event.shiftKey && key === "y"));
            if (!isUndo && !isRedo) return;
            event.preventDefault();
            event.stopPropagation();
            event.stopImmediatePropagation();
            if (isRedo) redoAnnotation();
            else undoAnnotation();
        };
        window.addEventListener("keydown", handleKeyDown, true);
        return () => window.removeEventListener("keydown", handleKeyDown, true);
    }, [open, redoAnnotation, undoAnnotation]);

    const startDraw = (event: ReactPointerEvent<HTMLCanvasElement>) => {
        if (event.button !== 0) return;
        const point = readCanvasPoint(event.currentTarget, event.clientX, event.clientY);
        if (tool === "text") {
            setTextDraft({ id: randomId(), at: point, text: "" });
            return;
        }
        event.preventDefault();
        event.stopPropagation();
        event.currentTarget.setPointerCapture(event.pointerId);
        drawingRef.current = { active: true, from: point };
    };

    const moveDraw = (event: ReactPointerEvent<HTMLCanvasElement>) => {
        if (!drawingRef.current.active || !drawingRef.current.from) return;
        event.preventDefault();
        const to = readCanvasPoint(event.currentTarget, event.clientX, event.clientY);
        drawAnnotationsPreview(previewCanvasRef.current, [...annotations, { id: "__draft__", kind: "arrow", from: drawingRef.current.from, to }]);
    };

    const stopDraw = (event: ReactPointerEvent<HTMLCanvasElement>) => {
        if (!drawingRef.current.active || !drawingRef.current.from) return;
        const from = drawingRef.current.from;
        drawingRef.current = { active: false, from: null };
        if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
        const to = readCanvasPoint(event.currentTarget, event.clientX, event.clientY);
        if (Math.hypot(to.x - from.x, to.y - from.y) < 4) {
            drawAnnotationsPreview(previewCanvasRef.current, annotations);
            return;
        }
        pushAnnotation({ id: randomId(), kind: "arrow", from, to });
    };

    useEffect(() => {
        drawAnnotationsPreview(previewCanvasRef.current, annotations);
    }, [annotations, image]);

    const confirmTextDraft = () => {
        if (!textDraft) return;
        const text = textDraft.text.trim();
        setTextDraft(null);
        if (!text) return;
        pushAnnotation({ id: textDraft.id, kind: "text", at: textDraft.at, text });
    };

    const submit = async () => {
        const nextPrompt = prompt.trim();
        const canvas = previewCanvasRef.current;
        if (!nextPrompt) return setError(t("canvas.editors.annotatePromptRequired"));
        if (!canvas || !annotations.length) return setError(t("canvas.editors.annotateRequired"));
        setSubmitting(true);
        try {
            const annotatedDataUrl = await buildAnnotatedImage(dataUrl, canvas, image);
            onConfirm({ prompt: nextPrompt, annotatedDataUrl });
        } finally {
            setSubmitting(false);
        }
    };

    return (
        <Modal title={null} open={open && Boolean(dataUrl)} onCancel={onClose} footer={null} width={980} centered destroyOnHidden transitionName="" maskTransitionName="">
            <div className="grid gap-5 lg:grid-cols-[minmax(360px,1fr)_320px]" data-canvas-no-zoom>
                <div
                    ref={viewport.viewportRef}
                    {...viewport.panHandlers}
                    className={`relative h-[min(68vh,720px)] min-h-[360px] rounded-xl border border-black/10 bg-transparent dark:border-white/10 ${viewport.scrollClassName} ${viewport.isPanning ? "cursor-grabbing" : viewport.spacePressed ? "cursor-grab" : ""}`}
                >
                    <div className="relative" style={viewport.contentStyle}>
                        <div className="absolute isolate overflow-hidden rounded-lg bg-transparent select-none [backface-visibility:hidden] [contain:layout_paint] [transform:translateZ(0)]" style={viewport.stageStyle}>
                            {image ? (
                                <div className="absolute left-0 top-0 [backface-visibility:hidden]" style={viewport.mediaStyle}>
                                    <img src={dataUrl} alt="" className="absolute inset-0 block h-full w-full bg-transparent object-contain" draggable={false} />
                                    <canvas
                                        ref={previewCanvasRef}
                                        width={image.width}
                                        height={image.height}
                                        className="absolute inset-0 h-full w-full touch-none"
                                        onPointerDown={startDraw}
                                        onPointerMove={moveDraw}
                                        onPointerUp={stopDraw}
                                        onPointerCancel={stopDraw}
                                        onContextMenu={(event) => event.preventDefault()}
                                    />
                                    {textDraft ? (
                                        <div className="absolute z-10 -translate-x-1/2 -translate-y-1/2" style={{ left: textDraft.at.x * viewport.imageScale, top: textDraft.at.y * viewport.imageScale }}>
                                            <Input
                                                autoFocus
                                                size="small"
                                                value={textDraft.text}
                                                placeholder={t("canvas.editors.annotateTextPlaceholder")}
                                                style={{ width: 160 }}
                                                onChange={(event) => setTextDraft({ ...textDraft, text: event.target.value })}
                                                onBlur={confirmTextDraft}
                                                onKeyDown={(event) => {
                                                    if (event.key === "Enter") confirmTextDraft();
                                                    if (event.key === "Escape") setTextDraft(null);
                                                }}
                                            />
                                        </div>
                                    ) : null}
                                </div>
                            ) : null}
                        </div>
                    </div>
                </div>

                <div className="flex min-h-[360px] flex-col gap-5">
                    <div>
                        <h2 className="text-xl font-semibold">{t("canvas.editors.annotateTitle")}</h2>
                        <div className="mt-2 text-sm opacity-60">{image ? `${image.width} x ${image.height}px` : t("canvas.editors.loading")}</div>
                        <div className="mt-2 text-xs leading-5 opacity-55">{t("canvas.editors.annotateHint")}</div>
                    </div>

                    <div className="grid grid-cols-2 gap-2">
                        <Button type={tool === "arrow" ? "primary" : "default"} icon={<ArrowUpRight className="size-4" />} onClick={() => setTool("arrow")}>
                            {t("canvas.editors.arrowTool")}
                        </Button>
                        <Button type={tool === "text" ? "primary" : "default"} icon={<Type className="size-4" />} onClick={() => setTool("text")}>
                            {t("canvas.editors.textTool")}
                        </Button>
                    </div>

                    <div className="flex items-center justify-between rounded-lg border border-black/10 px-2 py-1 dark:border-white/10">
                        <Tooltip title={t("canvas.editors.undoAnnotateTitle")}>
                            <Button type="text" icon={<Undo2 className="size-4" />} disabled={!historySize} aria-label={t("canvas.editors.undoAnnotate")} onClick={undoAnnotation} />
                        </Tooltip>
                        <Tooltip title={t("canvas.editors.redoAnnotateTitle")}>
                            <Button type="text" icon={<Redo2 className="size-4" />} disabled={!redoSize} aria-label={t("canvas.editors.redoAnnotate")} onClick={redoAnnotation} />
                        </Tooltip>
                        <div className="flex items-center gap-1">
                            <Tooltip title={t("canvas.editors.zoomOut")}>
                                <Button type="text" icon={<ZoomOut className="size-4" />} disabled={!viewport.canZoomOut} aria-label={t("canvas.editors.zoomOut")} onClick={viewport.zoomOut} />
                            </Tooltip>
                            <button type="button" className="min-w-14 text-center text-xs font-semibold tabular-nums opacity-70" onClick={viewport.resetZoom}>
                                {Math.round(viewport.zoom * 100)}%
                            </button>
                            <Tooltip title={t("canvas.editors.zoomIn")}>
                                <Button type="text" icon={<ZoomIn className="size-4" />} disabled={!viewport.canZoomIn} aria-label={t("canvas.editors.zoomIn")} onClick={viewport.zoomIn} />
                            </Tooltip>
                        </div>
                    </div>

                    <div className="space-y-2">
                        <div className="text-sm font-medium opacity-75">{t("canvas.editors.editInstructions")}</div>
                        <Input.TextArea
                            rows={6}
                            value={prompt}
                            status={error && !prompt.trim() ? "error" : undefined}
                            placeholder={t("canvas.editors.annotatePlaceholder")}
                            onChange={(event) => {
                                setPrompt(event.target.value);
                                setError("");
                            }}
                        />
                        {error ? <div className="text-xs font-medium text-[#ef4444]">{error}</div> : null}
                    </div>

                    <div className="mt-auto flex items-center justify-between gap-2">
                        <Button icon={<RotateCcw className="size-4" />} onClick={resetAnnotations}>
                            {t("canvas.editors.reset")}
                        </Button>
                        <div className="flex items-center gap-2">
                            <Button icon={<X className="size-4" />} onClick={onClose}>
                                {t("canvas.editors.cancel")}
                            </Button>
                            <Button type="primary" icon={<WandSparkles className="size-4" />} loading={submitting} onClick={submit}>
                                {t("canvas.editors.aiEdit")}
                            </Button>
                        </div>
                    </div>
                </div>
            </div>
        </Modal>
    );
}

function readCanvasPoint(canvas: HTMLCanvasElement, clientX: number, clientY: number) {
    const rect = canvas.getBoundingClientRect();
    return {
        x: ((clientX - rect.left) / Math.max(1, rect.width)) * canvas.width,
        y: ((clientY - rect.top) / Math.max(1, rect.height)) * canvas.height,
    };
}

function drawArrow(context: CanvasRenderingContext2D, from: Point, to: Point, lineWidth: number) {
    const angle = Math.atan2(to.y - from.y, to.x - from.x);
    const headLength = Math.max(12, lineWidth * 4);
    context.lineWidth = lineWidth;
    context.lineCap = "round";
    context.strokeStyle = annotationColor;
    context.fillStyle = annotationColor;
    context.beginPath();
    context.moveTo(from.x, from.y);
    context.lineTo(to.x, to.y);
    context.stroke();
    context.beginPath();
    context.moveTo(to.x, to.y);
    context.lineTo(to.x - headLength * Math.cos(angle - Math.PI / 6), to.y - headLength * Math.sin(angle - Math.PI / 6));
    context.lineTo(to.x - headLength * Math.cos(angle + Math.PI / 6), to.y - headLength * Math.sin(angle + Math.PI / 6));
    context.closePath();
    context.fill();
}

function drawAnnotationText(context: CanvasRenderingContext2D, annotation: TextAnnotation, fontSize: number) {
    context.font = `600 ${fontSize}px sans-serif`;
    context.textBaseline = "middle";
    const padding = fontSize * 0.4;
    const width = context.measureText(annotation.text).width + padding * 2;
    const height = fontSize + padding * 2;
    context.fillStyle = annotationColor;
    context.fillRect(annotation.at.x - width / 2, annotation.at.y - height / 2, width, height);
    context.fillStyle = "#fff";
    context.textAlign = "center";
    context.fillText(annotation.text, annotation.at.x, annotation.at.y);
    context.textAlign = "start";
}

function drawAnnotationsPreview(canvas: HTMLCanvasElement | null, annotations: Annotation[]) {
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;
    context.clearRect(0, 0, canvas.width, canvas.height);
    const lineWidth = Math.max(3, Math.round(canvas.width / 220));
    const fontSize = Math.max(16, Math.round(canvas.width / 40));
    annotations.forEach((annotation) => {
        if (annotation.kind === "arrow") drawArrow(context, annotation.from, annotation.to, lineWidth);
        else drawAnnotationText(context, annotation, fontSize);
    });
}

function loadImageElement(dataUrl: string) {
    return new Promise<HTMLImageElement>((resolve, reject) => {
        const image = new Image();
        image.onload = () => resolve(image);
        image.onerror = () => reject(new Error("image load failed"));
        image.src = dataUrl;
    });
}

async function buildAnnotatedImage(dataUrl: string, annotationCanvas: HTMLCanvasElement, image: { width: number; height: number } | null) {
    const source = await loadImageElement(dataUrl);
    const canvas = document.createElement("canvas");
    canvas.width = image?.width || source.naturalWidth || annotationCanvas.width;
    canvas.height = image?.height || source.naturalHeight || annotationCanvas.height;
    const context = canvas.getContext("2d");
    if (!context) return dataUrl;
    context.drawImage(source, 0, 0, canvas.width, canvas.height);
    context.drawImage(annotationCanvas, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/png");
}
