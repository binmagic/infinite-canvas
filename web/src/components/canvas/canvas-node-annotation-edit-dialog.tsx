import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { Button, Input, Modal, Segmented, Tooltip } from "antd";
import { Redo2, RotateCcw, Undo2, WandSparkles, X, ZoomIn, ZoomOut } from "lucide-react";
import { useTranslation } from "react-i18next";

import { randomId } from "@/lib/utils";
import { readImageMeta } from "@/lib/image-utils";
import { useImageEditorViewport } from "@/components/canvas/use-image-editor-viewport";

export type CanvasImageAnnotationEditPayload = {
    prompt: string;
    annotatedDataUrl: string;
};

type Point = { x: number; y: number };
type ArrowHandle = "from" | "to";
type ArrowDash = "draw" | "dashed" | "dotted" | "solid";
type ArrowSize = "s" | "m" | "l" | "xl";
type ArrowheadShape = "none" | "arrow" | "triangle" | "square" | "dot" | "diamond" | "inverted" | "bar";
type ArrowKind = "arc" | "elbow";
type ArrowStyleField = "color" | "dash" | "size" | "arrowheadStart" | "arrowheadEnd" | "arrowKind";

type ArrowAnnotation = {
    id: string;
    kind: "arrow";
    from: Point;
    to: Point;
    color: string;
    dash: ArrowDash;
    size: ArrowSize;
    arrowheadStart: ArrowheadShape;
    arrowheadEnd: ArrowheadShape;
    arrowKind: ArrowKind;
    description: string;
};
type Annotation = ArrowAnnotation;

type CanvasGeometry = {
    padX: number;
    padY: number;
    canvasWidth: number;
    canvasHeight: number;
    imageOffsetX: number;
    imageOffsetY: number;
    imageWidth: number;
    imageHeight: number;
};

type DragMode = { mode: "move-endpoint"; arrowId: string; handle: ArrowHandle } | { mode: "draw"; from: Point };
type DragPreview = { arrowId: string; handle: ArrowHandle; point: Point };
type DrawOptions = { dragPreview?: DragPreview | null; selectedArrowId?: string | null };

// tldraw 5.1.1 default 12-color palette (light theme), replicated so the arrow style
// controls below match Cowart's (tldraw's) default style panel exactly.
const tldrawColorPalette = [
    { id: "black", hex: "#1d1d1d" },
    { id: "grey", hex: "#9fa8b2" },
    { id: "light-violet", hex: "#e085f4" },
    { id: "violet", hex: "#ae3ec9" },
    { id: "blue", hex: "#4465e9" },
    { id: "light-blue", hex: "#4ba1f1" },
    { id: "yellow", hex: "#f1ac4b" },
    { id: "orange", hex: "#e16919" },
    { id: "green", hex: "#099268" },
    { id: "light-green", hex: "#4cb05e" },
    { id: "light-red", hex: "#f87777" },
    { id: "red", hex: "#e03131" },
] as const;
const defaultArrowColor = "#e03131";
const arrowSizeScale: Record<ArrowSize, number> = { s: 0.6, m: 1, l: 1.6, xl: 2.4 };
const PADDING_RATIO = 0.4;
const ENDPOINT_HIT_SCREEN_PX = 10;

// Dialog unmounts on close (parent renders it conditionally), so drafts must live
// outside component state to survive a close/reopen without an explicit save.
const annotationDraftStore = new Map<string, Annotation[]>();

function computePaddedCanvasSize(image: { width: number; height: number }): CanvasGeometry {
    const padX = Math.round(image.width * PADDING_RATIO);
    const padY = Math.round(image.height * PADDING_RATIO);
    return {
        padX,
        padY,
        canvasWidth: image.width + padX * 2,
        canvasHeight: image.height + padY * 2,
        imageOffsetX: padX,
        imageOffsetY: padY,
        imageWidth: image.width,
        imageHeight: image.height,
    };
}

function pct(part: number, whole: number) {
    return `${(part / Math.max(1, whole)) * 100}%`;
}

function buildDashOptions(t: (key: string) => string) {
    return [
        { label: t("canvas.editors.arrowDashDraw"), value: "draw" },
        { label: t("canvas.editors.arrowDashDashed"), value: "dashed" },
        { label: t("canvas.editors.arrowDashDotted"), value: "dotted" },
        { label: t("canvas.editors.arrowDashSolid"), value: "solid" },
    ];
}
function buildSizeOptions(t: (key: string) => string) {
    return [
        { label: t("canvas.editors.arrowSizeS"), value: "s" },
        { label: t("canvas.editors.arrowSizeM"), value: "m" },
        { label: t("canvas.editors.arrowSizeL"), value: "l" },
        { label: t("canvas.editors.arrowSizeXL"), value: "xl" },
    ];
}
function buildArrowKindOptions(t: (key: string) => string) {
    return [
        { label: t("canvas.editors.arrowKindArc"), value: "arc" },
        { label: t("canvas.editors.arrowKindElbow"), value: "elbow" },
    ];
}

function ArrowStyleControls({
    t,
    color,
    dash,
    size,
    arrowKind,
    onChange,
}: {
    t: (key: string) => string;
    color: string;
    dash: ArrowDash;
    size: ArrowSize;
    arrowKind: ArrowKind;
    onChange: (key: ArrowStyleField, value: string) => void;
}) {
    return (
        <div className="space-y-2.5">
            <div className="grid grid-cols-4 gap-1.5">
                {tldrawColorPalette.map((entry) => (
                    <button
                        key={entry.id}
                        type="button"
                        aria-label={t("canvas.editors.arrowColorLabel")}
                        className={`size-5 rounded-full border-2 ${color === entry.hex ? "border-[#2563eb]" : "border-transparent"}`}
                        style={{ backgroundColor: entry.hex }}
                        onClick={() => onChange("color", entry.hex)}
                    />
                ))}
            </div>
            <Segmented block size="small" value={dash} options={buildDashOptions(t)} onChange={(value) => onChange("dash", String(value))} />
            <Segmented block size="small" value={size} options={buildSizeOptions(t)} onChange={(value) => onChange("size", String(value))} />
            <Segmented block size="small" value={arrowKind} options={buildArrowKindOptions(t)} onChange={(value) => onChange("arrowKind", String(value))} />
        </div>
    );
}

export function clearAnnotationDraft(nodeId: string) {
    annotationDraftStore.delete(nodeId);
}

export function CanvasNodeAnnotationEditDialog({
    nodeId,
    dataUrl,
    open,
    onClose,
    onConfirm,
}: {
    nodeId: string;
    dataUrl: string;
    open: boolean;
    onClose: () => void;
    onConfirm: (payload: CanvasImageAnnotationEditPayload) => void;
}) {
    const { t } = useTranslation();
    const previewCanvasRef = useRef<HTMLCanvasElement>(null);
    const dragModeRef = useRef<DragMode | null>(null);
    const dragAbortRef = useRef<AbortController | null>(null);
    const dragPreviewRef = useRef<DragPreview | null>(null);
    const historyRef = useRef<Annotation[]>([]);
    const redoRef = useRef<Annotation[]>([]);
    const [image, setImage] = useState<{ width: number; height: number } | null>(null);
    const [drawColor, setDrawColor] = useState<string>(defaultArrowColor);
    const [drawDash, setDrawDash] = useState<ArrowDash>("solid");
    const [drawSize, setDrawSize] = useState<ArrowSize>("m");
    const [drawArrowheadStart, setDrawArrowheadStart] = useState<ArrowheadShape>("none");
    const [drawArrowheadEnd, setDrawArrowheadEnd] = useState<ArrowheadShape>("triangle");
    const [drawArrowKind, setDrawArrowKind] = useState<ArrowKind>("arc");
    const [annotations, setAnnotations] = useState<Annotation[]>([]);
    const [selectedArrowId, setSelectedArrowId] = useState<string | null>(null);
    const [editingArrowId, setEditingArrowId] = useState<string | null>(null);
    const [historySize, setHistorySize] = useState(0);
    const [redoSize, setRedoSize] = useState(0);
    const [error, setError] = useState("");
    const [submitting, setSubmitting] = useState(false);
    const canvasGeometry = useMemo(() => (image ? computePaddedCanvasSize(image) : null), [image]);
    const viewport = useImageEditorViewport(canvasGeometry ? { width: canvasGeometry.canvasWidth, height: canvasGeometry.canvasHeight } : null, open);

    // Written directly at each mutation site (not via a reactive effect): an effect
    // mirroring `annotations` back into the store would still see the pre-load value
    // on the render that just restored a draft, wiping it before the next render lands.
    const persistDraft = useCallback(
        (list: Annotation[]) => {
            if (list.length) annotationDraftStore.set(nodeId, list);
            else annotationDraftStore.delete(nodeId);
        },
        [nodeId],
    );

    useEffect(() => {
        if (!open) return;
        const draft = annotationDraftStore.get(nodeId) || [];
        setDrawColor(defaultArrowColor);
        setDrawDash("solid");
        setDrawSize("m");
        setDrawArrowheadStart("none");
        setDrawArrowheadEnd("triangle");
        setDrawArrowKind("arc");
        setAnnotations(draft);
        setSelectedArrowId(null);
        setEditingArrowId(null);
        setHistorySize(draft.length);
        setRedoSize(0);
        setError("");
        setSubmitting(false);
        historyRef.current = draft;
        redoRef.current = [];
        dragModeRef.current = null;
        dragPreviewRef.current = null;
        dragAbortRef.current?.abort();
        void readImageMeta(dataUrl).then(setImage);
    }, [nodeId, dataUrl, open]);

    useEffect(() => {
        if (!open) dragAbortRef.current?.abort();
        return () => dragAbortRef.current?.abort();
    }, [open]);

    const arrowAnnotations = useMemo(() => annotations.filter((item): item is ArrowAnnotation => item.kind === "arrow"), [annotations]);
    const selectedArrow = selectedArrowId ? arrowAnnotations.find((item) => item.id === selectedArrowId) : undefined;
    const activeColor = selectedArrow ? selectedArrow.color : drawColor;
    const activeDash = selectedArrow ? selectedArrow.dash : drawDash;
    const activeSize = selectedArrow ? selectedArrow.size : drawSize;
    const activeArrowKind = selectedArrow ? selectedArrow.arrowKind : drawArrowKind;

    const pushAnnotation = useCallback(
        (annotation: Annotation) => {
            historyRef.current = [...historyRef.current, annotation];
            redoRef.current = [];
            setAnnotations([...historyRef.current]);
            setHistorySize(historyRef.current.length);
            setRedoSize(0);
            setError("");
            persistDraft(historyRef.current);
        },
        [persistDraft],
    );

    const undoAnnotation = useCallback(() => {
        if (dragModeRef.current || !historyRef.current.length) return;
        const last = historyRef.current[historyRef.current.length - 1];
        historyRef.current = historyRef.current.slice(0, -1);
        redoRef.current = [...redoRef.current, last];
        setAnnotations([...historyRef.current]);
        setHistorySize(historyRef.current.length);
        setRedoSize(redoRef.current.length);
        setSelectedArrowId((current) => (current === last.id ? null : current));
        setEditingArrowId((current) => (current === last.id ? null : current));
        setError("");
        persistDraft(historyRef.current);
    }, [persistDraft]);

    const redoAnnotation = useCallback(() => {
        if (dragModeRef.current || !redoRef.current.length) return;
        const last = redoRef.current[redoRef.current.length - 1];
        redoRef.current = redoRef.current.slice(0, -1);
        historyRef.current = [...historyRef.current, last];
        setAnnotations([...historyRef.current]);
        setHistorySize(historyRef.current.length);
        setRedoSize(redoRef.current.length);
        setError("");
        persistDraft(historyRef.current);
    }, [persistDraft]);

    const resetAnnotations = useCallback(() => {
        historyRef.current = [];
        redoRef.current = [];
        setAnnotations([]);
        setSelectedArrowId(null);
        setEditingArrowId(null);
        setHistorySize(0);
        setRedoSize(0);
        setError("");
        persistDraft([]);
    }, [persistDraft]);

    const updateArrow = useCallback(
        (id: string, patch: Partial<Pick<ArrowAnnotation, "color" | "dash" | "size" | "arrowheadStart" | "arrowheadEnd" | "arrowKind" | "description">>) => {
            historyRef.current = historyRef.current.map((item) => (item.id === id && item.kind === "arrow" ? { ...item, ...patch } : item));
            setAnnotations([...historyRef.current]);
            persistDraft(historyRef.current);
        },
        [persistDraft],
    );

    const deleteArrow = useCallback(
        (id: string) => {
            if (dragModeRef.current) return;
            if (!historyRef.current.some((item) => item.id === id)) return;
            historyRef.current = historyRef.current.filter((item) => item.id !== id);
            redoRef.current = [];
            setAnnotations([...historyRef.current]);
            setHistorySize(historyRef.current.length);
            setRedoSize(0);
            setSelectedArrowId((current) => (current === id ? null : current));
            setEditingArrowId((current) => (current === id ? null : current));
            persistDraft(historyRef.current);
        },
        [persistDraft],
    );

    const applyArrowField = (key: ArrowStyleField, value: string) => {
        if (selectedArrow) {
            updateArrow(selectedArrow.id, { [key]: value } as Partial<ArrowAnnotation>);
            return;
        }
        if (key === "color") setDrawColor(value);
        else if (key === "dash") setDrawDash(value as ArrowDash);
        else if (key === "size") setDrawSize(value as ArrowSize);
        else if (key === "arrowheadStart") setDrawArrowheadStart(value as ArrowheadShape);
        else if (key === "arrowheadEnd") setDrawArrowheadEnd(value as ArrowheadShape);
        else setDrawArrowKind(value as ArrowKind);
    };

    useEffect(() => {
        if (!open) return;
        const handleKeyDown = (event: KeyboardEvent) => {
            const target = event.target instanceof Element ? event.target : null;
            if (target?.closest("input,textarea,[contenteditable=true]")) return;
            if (event.key === "Escape" && selectedArrowId) {
                event.preventDefault();
                setSelectedArrowId(null);
                setEditingArrowId(null);
                return;
            }
            if ((event.key === "Delete" || event.key === "Backspace") && selectedArrowId) {
                event.preventDefault();
                event.stopPropagation();
                event.stopImmediatePropagation();
                deleteArrow(selectedArrowId);
                return;
            }
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
    }, [open, redoAnnotation, undoAnnotation, selectedArrowId, deleteArrow]);

    const beginEndpointDrag = useCallback(
        (arrowId: string, handle: ArrowHandle) => {
            dragAbortRef.current?.abort();
            const controller = new AbortController();
            dragAbortRef.current = controller;
            dragModeRef.current = { mode: "move-endpoint", arrowId, handle };
            const move = (moveEvent: PointerEvent) => {
                const canvas = previewCanvasRef.current;
                if (!canvas) return;
                const point = readCanvasPoint(canvas, moveEvent.clientX, moveEvent.clientY);
                dragPreviewRef.current = { arrowId, handle, point };
                drawAnnotationsPreview(canvas, historyRef.current, { dragPreview: dragPreviewRef.current, selectedArrowId: arrowId });
            };
            const stop = () => {
                const preview = dragPreviewRef.current;
                dragPreviewRef.current = null;
                dragModeRef.current = null;
                controller.abort();
                if (!preview) return;
                historyRef.current = historyRef.current.map((item) => (item.id === preview.arrowId && item.kind === "arrow" ? { ...item, [preview.handle]: preview.point } : item));
                redoRef.current = [];
                setAnnotations([...historyRef.current]);
                setHistorySize(historyRef.current.length);
                setRedoSize(0);
                persistDraft(historyRef.current);
            };
            document.addEventListener("pointermove", move, { signal: controller.signal });
            document.addEventListener("pointerup", stop, { signal: controller.signal });
            document.addEventListener("pointercancel", stop, { signal: controller.signal });
        },
        [persistDraft],
    );

    const startDraw = (event: ReactPointerEvent<HTMLCanvasElement>) => {
        if (event.button !== 0) return;
        const point = readCanvasPoint(event.currentTarget, event.clientX, event.clientY);
        const radius = ENDPOINT_HIT_SCREEN_PX / Math.max(0.0001, viewport.imageScale);
        const endpointHit = hitTestArrowEndpoint(point, annotations, radius);
        if (endpointHit) {
            event.preventDefault();
            event.stopPropagation();
            setSelectedArrowId(endpointHit.arrowId);
            setEditingArrowId(endpointHit.handle === "from" ? endpointHit.arrowId : null);
            beginEndpointDrag(endpointHit.arrowId, endpointHit.handle);
            return;
        }
        const bodyHit = hitTestArrowBody(point, annotations, radius);
        if (bodyHit) {
            event.preventDefault();
            event.stopPropagation();
            setSelectedArrowId(bodyHit);
            setEditingArrowId(null);
            return;
        }
        event.preventDefault();
        event.stopPropagation();
        setSelectedArrowId(null);
        setEditingArrowId(null);
        event.currentTarget.setPointerCapture(event.pointerId);
        dragModeRef.current = { mode: "draw", from: point };
    };

    const moveDraw = (event: ReactPointerEvent<HTMLCanvasElement>) => {
        const mode = dragModeRef.current;
        if (!mode || mode.mode !== "draw") return;
        event.preventDefault();
        const to = readCanvasPoint(event.currentTarget, event.clientX, event.clientY);
        const draft: ArrowAnnotation = {
            id: "__draft__",
            kind: "arrow",
            from: mode.from,
            to,
            color: drawColor,
            dash: drawDash,
            size: drawSize,
            arrowheadStart: drawArrowheadStart,
            arrowheadEnd: drawArrowheadEnd,
            arrowKind: drawArrowKind,
            description: "",
        };
        drawAnnotationsPreview(previewCanvasRef.current, [...annotations, draft], { selectedArrowId });
    };

    const stopDraw = (event: ReactPointerEvent<HTMLCanvasElement>) => {
        const mode = dragModeRef.current;
        if (!mode || mode.mode !== "draw") return;
        const from = mode.from;
        dragModeRef.current = null;
        if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
        const to = readCanvasPoint(event.currentTarget, event.clientX, event.clientY);
        if (Math.hypot(to.x - from.x, to.y - from.y) < 4) {
            drawAnnotationsPreview(previewCanvasRef.current, annotations, { selectedArrowId });
            return;
        }
        const arrow: ArrowAnnotation = {
            id: randomId(),
            kind: "arrow",
            from,
            to,
            color: drawColor,
            dash: drawDash,
            size: drawSize,
            arrowheadStart: drawArrowheadStart,
            arrowheadEnd: drawArrowheadEnd,
            arrowKind: drawArrowKind,
            description: "",
        };
        pushAnnotation(arrow);
        setEditingArrowId(arrow.id);
    };

    useEffect(() => {
        if (dragModeRef.current) return;
        drawAnnotationsPreview(previewCanvasRef.current, annotations, { selectedArrowId });
    }, [annotations, canvasGeometry, selectedArrowId]);

    const submit = async () => {
        const canvas = previewCanvasRef.current;
        if (!canvas || !annotations.length || !canvasGeometry) return setError(t("canvas.editors.annotateRequired"));
        setSubmitting(true);
        try {
            const combinedPrompt = buildCombinedPrompt(arrowAnnotations, t("canvas.editors.annotateDefaultInstruction"));
            const annotatedDataUrl = await buildAnnotatedImage(dataUrl, canvas, canvasGeometry);
            annotationDraftStore.delete(nodeId);
            onConfirm({ prompt: combinedPrompt, annotatedDataUrl });
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
                            {image && canvasGeometry ? (
                                <div className="absolute left-0 top-0 [backface-visibility:hidden]" style={viewport.mediaStyle}>
                                    <div
                                        className="absolute overflow-hidden"
                                        style={{
                                            left: pct(canvasGeometry.imageOffsetX, canvasGeometry.canvasWidth),
                                            top: pct(canvasGeometry.imageOffsetY, canvasGeometry.canvasHeight),
                                            width: pct(canvasGeometry.imageWidth, canvasGeometry.canvasWidth),
                                            height: pct(canvasGeometry.imageHeight, canvasGeometry.canvasHeight),
                                        }}
                                    >
                                        <img src={dataUrl} alt="" className="absolute inset-0 block h-full w-full bg-transparent object-contain select-none" draggable={false} />
                                        <div className="pointer-events-none absolute inset-0 border border-dashed border-black/25 dark:border-white/25" />
                                    </div>
                                    <canvas
                                        ref={previewCanvasRef}
                                        width={canvasGeometry.canvasWidth}
                                        height={canvasGeometry.canvasHeight}
                                        className="absolute inset-0 h-full w-full touch-none"
                                        onPointerDown={startDraw}
                                        onPointerMove={moveDraw}
                                        onPointerUp={stopDraw}
                                        onPointerCancel={stopDraw}
                                        onContextMenu={(event) => event.preventDefault()}
                                    />
                                    {arrowAnnotations.map((arrow, arrowIndex) => {
                                        const anchor = computeArrowLabelAnchor(arrow);
                                        const fontSize = Math.round(12 * arrowSizeScale[arrow.size]);
                                        const order = arrowIndex + 1;
                                        const orderPrefix = `${order}. `;
                                        if (editingArrowId === arrow.id) {
                                            const layout = computeAnnotationBoxLayout({
                                                anchor,
                                                canvasGeometry,
                                                imageScale: viewport.imageScale,
                                                text: orderPrefix + arrow.description,
                                                fontSize,
                                                minWidth: 24,
                                                maxWidth: 260,
                                                horizontalPadding: 18,
                                            });
                                            return (
                                                <div
                                                    key={arrow.id}
                                                    className="absolute z-10 -translate-y-1/2"
                                                    style={{ left: layout.left, top: layout.top, width: layout.width }}
                                                    onPointerDown={(event) => event.stopPropagation()}
                                                >
                                                    <Input
                                                        autoFocus
                                                        size="small"
                                                        value={arrow.description}
                                                        prefix={<span style={{ color: arrow.color, fontSize, fontWeight: 700 }}>{order}</span>}
                                                        style={{ width: "100%", color: arrow.color, fontSize, borderColor: "#7dd3fc" }}
                                                        onChange={(event) => updateArrow(arrow.id, { description: event.target.value })}
                                                    />
                                                </div>
                                            );
                                        }
                                        if (!arrow.description.trim()) return null;
                                        const layout = computeAnnotationBoxLayout({
                                            anchor,
                                            canvasGeometry,
                                            imageScale: viewport.imageScale,
                                            text: orderPrefix + arrow.description,
                                            fontSize,
                                            minWidth: 0,
                                            maxWidth: 220,
                                            horizontalPadding: 16,
                                        });
                                        return (
                                            <div
                                                key={arrow.id}
                                                role="button"
                                                className="absolute z-10 -translate-y-1/2 cursor-pointer truncate rounded-md px-2 py-0.5 font-semibold text-white shadow-sm"
                                                style={{ left: layout.left, top: layout.top, width: layout.width, backgroundColor: arrow.color, fontSize }}
                                                onPointerDown={(event) => {
                                                    event.stopPropagation();
                                                    setEditingArrowId(arrow.id);
                                                }}
                                            >
                                                {orderPrefix}
                                                {arrow.description}
                                            </div>
                                        );
                                    })}
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

                    <div className="rounded-lg border border-black/10 px-2.5 py-2.5 dark:border-white/10">
                        <ArrowStyleControls
                            t={t}
                            color={activeColor}
                            dash={activeDash}
                            size={activeSize}
                            arrowKind={activeArrowKind}
                            onChange={applyArrowField}
                        />
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

                    {error ? <div className="text-xs font-medium text-[#ef4444]">{error}</div> : null}

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

function distanceToSegment(point: Point, a: Point, b: Point) {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const lengthSq = dx * dx + dy * dy;
    const t = lengthSq === 0 ? 0 : Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSq));
    const projX = a.x + t * dx;
    const projY = a.y + t * dy;
    return Math.hypot(point.x - projX, point.y - projY);
}

function hitTestArrowEndpoint(point: Point, list: Annotation[], radius: number): { arrowId: string; handle: ArrowHandle } | null {
    for (let index = list.length - 1; index >= 0; index -= 1) {
        const item = list[index];
        if (item.kind !== "arrow") continue;
        if (Math.hypot(point.x - item.to.x, point.y - item.to.y) <= radius) return { arrowId: item.id, handle: "to" };
        if (Math.hypot(point.x - item.from.x, point.y - item.from.y) <= radius) return { arrowId: item.id, handle: "from" };
    }
    return null;
}

function hitTestArrowBody(point: Point, list: Annotation[], tolerance: number) {
    for (let index = list.length - 1; index >= 0; index -= 1) {
        const item = list[index];
        if (item.kind === "arrow" && distanceToSegment(point, item.from, item.to) <= tolerance) return item.id;
    }
    return null;
}

function resolveLineWidth(canvasWidth: number, size: ArrowSize) {
    const base = Math.max(3, Math.round(canvasWidth / 220));
    return Math.max(1, Math.round(base * arrowSizeScale[size]));
}

function computeArrowLabelAnchor(arrow: ArrowAnnotation): Point {
    const dx = arrow.to.x - arrow.from.x;
    const dy = arrow.to.y - arrow.from.y;
    const len = Math.hypot(dx, dy) || 1;
    const offset = 18 + 6 * arrowSizeScale[arrow.size];
    return { x: arrow.from.x - (dx / len) * offset, y: arrow.from.y - (dy / len) * offset };
}

let labelMeasureContext: CanvasRenderingContext2D | null = null;
function measureLabelTextWidth(text: string, fontSize: number) {
    if (typeof document === "undefined") return text.length * fontSize * 0.6;
    if (!labelMeasureContext) labelMeasureContext = document.createElement("canvas").getContext("2d");
    if (!labelMeasureContext) return text.length * fontSize * 0.6;
    labelMeasureContext.font = `600 ${fontSize}px sans-serif`;
    return labelMeasureContext.measureText(text || " ").width;
}

function computeAnnotationBoxLayout(params: {
    anchor: Point;
    canvasGeometry: CanvasGeometry;
    imageScale: number;
    text: string;
    fontSize: number;
    minWidth: number;
    maxWidth: number;
    horizontalPadding: number;
}) {
    const { anchor, canvasGeometry, imageScale, text, fontSize, minWidth, maxWidth, horizontalPadding } = params;
    const measured = measureLabelTextWidth(text, fontSize) + horizontalPadding;
    const width = Math.max(minWidth, Math.min(maxWidth, measured));
    const screenX = anchor.x * imageScale;
    const screenY = anchor.y * imageScale;
    const containerWidth = canvasGeometry.canvasWidth * imageScale;
    let left = screenX - width / 2;
    if (left < 0) left = 0;
    if (left + width > containerWidth) left = Math.max(0, containerWidth - width);
    return { left, top: screenY, width };
}

function angleFromTo(a: Point, b: Point) {
    return Math.atan2(b.y - a.y, b.x - a.x);
}

function computeArcControlPoint(from: Point, to: Point, bendRatio = 0.12) {
    const mx = (from.x + to.x) / 2;
    const my = (from.y + to.y) / 2;
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const len = Math.hypot(dx, dy) || 1;
    const nx = -dy / len;
    const ny = dx / len;
    const offset = len * bendRatio;
    return { x: mx + nx * offset, y: my + ny * offset };
}

function computeElbowMidpoint(from: Point, to: Point) {
    return Math.abs(to.x - from.x) >= Math.abs(to.y - from.y) ? { x: to.x, y: from.y } : { x: from.x, y: to.y };
}

function resolveArrowGeometry(from: Point, to: Point, kind: ArrowKind) {
    if (kind === "elbow") {
        const mid = computeElbowMidpoint(from, to);
        return { nearFrom: mid, nearTo: mid };
    }
    const control = computeArcControlPoint(from, to);
    return { nearFrom: control, nearTo: control };
}

function computeArrowMidpoint(from: Point, to: Point, kind: ArrowKind): Point {
    if (kind === "elbow") return computeElbowMidpoint(from, to);
    // Quadratic bezier evaluated at t = 0.5, so the badge lands on the drawn curve
    // rather than on the straight chord between the endpoints.
    const control = computeArcControlPoint(from, to);
    return { x: (from.x + 2 * control.x + to.x) / 4, y: (from.y + 2 * control.y + to.y) / 4 };
}

function applyDashPattern(context: CanvasRenderingContext2D, dash: ArrowDash, lineWidth: number) {
    if (dash === "dashed") context.setLineDash([lineWidth * 2.5, lineWidth * 2]);
    else if (dash === "dotted") context.setLineDash([lineWidth * 0.6, lineWidth * 1.4]);
    else context.setLineDash([]);
}

function drawArrowShaft(context: CanvasRenderingContext2D, from: Point, to: Point, kind: ArrowKind, dash: ArrowDash, lineWidth: number, color: string) {
    context.lineWidth = lineWidth;
    context.lineCap = "round";
    context.lineJoin = "round";
    context.strokeStyle = color;
    applyDashPattern(context, dash, lineWidth);
    // "draw" mimics tldraw's hand-drawn look by stroking a second, slightly offset, translucent pass.
    const passes = dash === "draw" ? [{ dx: 0, dy: 0, alpha: 1 }, { dx: 1, dy: 1, alpha: 0.45 }] : [{ dx: 0, dy: 0, alpha: 1 }];
    passes.forEach(({ dx, dy, alpha }) => {
        context.globalAlpha = alpha;
        context.beginPath();
        if (kind === "arc") {
            const control = computeArcControlPoint(from, to);
            context.moveTo(from.x + dx, from.y + dy);
            context.quadraticCurveTo(control.x + dx, control.y + dy, to.x + dx, to.y + dy);
        } else {
            const mid = computeElbowMidpoint(from, to);
            context.moveTo(from.x + dx, from.y + dy);
            context.lineTo(mid.x + dx, mid.y + dy);
            context.lineTo(to.x + dx, to.y + dy);
        }
        context.stroke();
    });
    context.globalAlpha = 1;
    context.setLineDash([]);
}

function drawArrowheadShape(context: CanvasRenderingContext2D, tip: Point, angle: number, shape: ArrowheadShape, lineWidth: number, color: string) {
    if (shape === "none") return;
    const headLength = Math.max(10, lineWidth * 3.4);
    const headWidth = headLength * 0.62;
    const dirX = Math.cos(angle);
    const dirY = Math.sin(angle);
    const perpX = -dirY;
    const perpY = dirX;
    const backX = tip.x - dirX * headLength;
    const backY = tip.y - dirY * headLength;
    const leftX = backX + perpX * headWidth;
    const leftY = backY + perpY * headWidth;
    const rightX = backX - perpX * headWidth;
    const rightY = backY - perpY * headWidth;

    context.fillStyle = color;
    context.strokeStyle = color;
    context.lineWidth = Math.max(1, lineWidth * 0.9);
    context.lineCap = "round";
    context.lineJoin = "round";
    context.setLineDash([]);

    if (shape === "arrow") {
        context.beginPath();
        context.moveTo(leftX, leftY);
        context.lineTo(tip.x, tip.y);
        context.lineTo(rightX, rightY);
        context.stroke();
    } else if (shape === "triangle") {
        context.beginPath();
        context.moveTo(tip.x, tip.y);
        context.lineTo(leftX, leftY);
        context.lineTo(rightX, rightY);
        context.closePath();
        context.fill();
    } else if (shape === "inverted") {
        const innerX = tip.x - dirX * headLength * 0.55;
        const innerY = tip.y - dirY * headLength * 0.55;
        context.beginPath();
        context.moveTo(innerX, innerY);
        context.lineTo(leftX, leftY);
        context.lineTo(rightX, rightY);
        context.closePath();
        context.fill();
    } else if (shape === "square") {
        const centerX = tip.x - dirX * headWidth * 0.7;
        const centerY = tip.y - dirY * headWidth * 0.7;
        const half = headWidth * 0.7;
        context.save();
        context.translate(centerX, centerY);
        context.rotate(angle);
        context.fillRect(-half, -half, half * 2, half * 2);
        context.restore();
    } else if (shape === "diamond") {
        const centerX = tip.x - dirX * headWidth * 0.9;
        const centerY = tip.y - dirY * headWidth * 0.9;
        const half = headWidth * 0.9;
        context.save();
        context.translate(centerX, centerY);
        context.rotate(angle + Math.PI / 4);
        context.fillRect(-half * 0.7, -half * 0.7, half * 1.4, half * 1.4);
        context.restore();
    } else if (shape === "dot") {
        const centerX = tip.x - dirX * headWidth * 0.75;
        const centerY = tip.y - dirY * headWidth * 0.75;
        context.beginPath();
        context.arc(centerX, centerY, headWidth * 0.75, 0, Math.PI * 2);
        context.fill();
    } else if (shape === "bar") {
        const centerX = tip.x - dirX * headWidth * 0.3;
        const centerY = tip.y - dirY * headWidth * 0.3;
        context.beginPath();
        context.moveTo(centerX + perpX * headWidth, centerY + perpY * headWidth);
        context.lineTo(centerX - perpX * headWidth, centerY - perpY * headWidth);
        context.stroke();
    }
}

// The badge is stroked onto the annotation canvas (not the HTML overlay) so it is
// carried into the exported PNG, giving the model a visual anchor for the numbered
// instruction lines built by buildCombinedPrompt.
function drawArrowOrderBadge(context: CanvasRenderingContext2D, center: Point, order: number, lineWidth: number, color: string) {
    const label = String(order);
    const radius = Math.max(9, lineWidth * 2.2);
    const fontSize = Math.round(radius * 1.35);
    context.save();
    context.setLineDash([]);
    context.globalAlpha = 1;
    context.beginPath();
    context.arc(center.x, center.y, radius, 0, Math.PI * 2);
    context.fillStyle = color;
    context.fill();
    context.lineWidth = Math.max(1.5, lineWidth * 0.5);
    context.strokeStyle = "#ffffff";
    context.stroke();
    context.fillStyle = "#ffffff";
    context.font = `700 ${fontSize}px sans-serif`;
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.fillText(label, center.x, center.y + fontSize * 0.04);
    context.restore();
}

function drawArrowAnnotation(context: CanvasRenderingContext2D, arrow: ArrowAnnotation, lineWidth: number, order?: number) {
    drawArrowShaft(context, arrow.from, arrow.to, arrow.arrowKind, arrow.dash, lineWidth, arrow.color);
    const geometry = resolveArrowGeometry(arrow.from, arrow.to, arrow.arrowKind);
    const endAngle = angleFromTo(geometry.nearTo, arrow.to);
    const startAngle = angleFromTo(geometry.nearFrom, arrow.from);
    drawArrowheadShape(context, arrow.to, endAngle, arrow.arrowheadEnd, lineWidth, arrow.color);
    drawArrowheadShape(context, arrow.from, startAngle, arrow.arrowheadStart, lineWidth, arrow.color);
    if (order) drawArrowOrderBadge(context, computeArrowMidpoint(arrow.from, arrow.to, arrow.arrowKind), order, lineWidth, arrow.color);
}

function drawSelectionRing(context: CanvasRenderingContext2D, from: Point, to: Point, lineWidth: number) {
    const radius = Math.max(10, lineWidth * 2.5);
    context.save();
    context.setLineDash([4, 4]);
    context.lineWidth = Math.max(1.5, lineWidth * 0.4);
    context.strokeStyle = "rgba(37, 99, 235, .9)";
    [from, to].forEach((point) => {
        context.beginPath();
        context.arc(point.x, point.y, radius, 0, Math.PI * 2);
        context.stroke();
    });
    context.restore();
}

function drawAnnotationsPreview(canvas: HTMLCanvasElement | null, annotations: Annotation[], options?: DrawOptions) {
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;
    context.clearRect(0, 0, canvas.width, canvas.height);
    const dragPreview = options?.dragPreview;
    const selectedArrowId = options?.selectedArrowId;
    // Order matches buildCombinedPrompt: 1-based position among arrows, so a badge
    // always names the same arrow as its numbered instruction line.
    let order = 0;
    annotations.forEach((annotation) => {
        if (annotation.kind === "arrow") order += 1;
        const isDragging = dragPreview?.arrowId === annotation.id;
        const from = isDragging && dragPreview.handle === "from" ? dragPreview.point : annotation.from;
        const to = isDragging && dragPreview.handle === "to" ? dragPreview.point : annotation.to;
        const lineWidth = resolveLineWidth(canvas.width, annotation.size);
        drawArrowAnnotation(context, { ...annotation, from, to }, lineWidth, order);
        if (annotation.id === selectedArrowId) drawSelectionRing(context, from, to, lineWidth);
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

async function buildAnnotatedImage(dataUrl: string, annotationCanvas: HTMLCanvasElement, geometry: CanvasGeometry) {
    const source = await loadImageElement(dataUrl);
    const canvas = document.createElement("canvas");
    canvas.width = geometry.canvasWidth;
    canvas.height = geometry.canvasHeight;
    const context = canvas.getContext("2d");
    if (!context) return dataUrl;
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(source, geometry.imageOffsetX, geometry.imageOffsetY, geometry.imageWidth, geometry.imageHeight);
    context.drawImage(annotationCanvas, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/png");
}

function buildCombinedPrompt(arrows: ArrowAnnotation[], fallbackInstruction: string) {
    const lines = arrows
        .map((arrow, index) => ({ index, text: arrow.description.trim() }))
        .filter((entry) => entry.text)
        .map((entry) => `${entry.index + 1}. ${entry.text}`);
    if (!lines.length) return fallbackInstruction;
    return lines.join("\n");
}
