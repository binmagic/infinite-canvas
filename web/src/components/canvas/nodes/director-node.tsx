// Director node: embeds the MONOFORM previs studio (white-model storyboarding tool) as a canvas node.
// The card is a display-only placeholder; clicking it opens a Modal with the MONOFORM iframe (autoOpenPanel).
// The iframe scopes its own project storage with ?key=<nodeId>, and MONOFORM posts exported PNG/MP4 blobs
// back to the host via postMessage, which the panel turns into new image/video nodes on the canvas.
import { useEffect, useRef } from "react";
import { Clapperboard } from "lucide-react";
import { Modal } from "antd";
import { useTranslation } from "react-i18next";

import { uploadImage } from "@/services/image-storage";
import { uploadMediaFile } from "@/services/file-storage";
import { imageMetadata, videoMetadata } from "@/lib/canvas/canvas-node-factory";
import { fitNodeSize } from "@/lib/canvas/canvas-node-size";
import type { CanvasNodeContext } from "@/types/canvas-plugin";

const iconClass = "size-5";

export function DirectorNodeContent({ ctx }: { ctx: CanvasNodeContext }) {
    const { t } = useTranslation();
    return (
        <div className="pointer-events-none flex h-full w-full flex-col items-center justify-center gap-2 p-4 text-center">
            <span className="grid size-11 place-items-center rounded-2xl" style={{ background: ctx.theme.toolbar.activeBg, color: ctx.theme.node.muted }}>
                <Clapperboard className={iconClass} />
            </span>
            <span className="text-sm font-semibold" style={{ color: ctx.theme.node.text }}>
                {t("canvas.nodeTypes.director")}
            </span>
            <span className="text-xs opacity-55">{t("canvas.director.openHint")}</span>
        </div>
    );
}

export function DirectorPanel({ ctx, onClose }: { ctx: CanvasNodeContext; onClose: () => void }) {
    const { t } = useTranslation();
    const onExportRef = useRef(async (kind: "image" | "video", blob: Blob) => {
        const base = ctx.node.position;
        const offset = { x: base.x + ctx.node.width + 32, y: base.y };
        try {
            if (kind === "image") {
                const image = await uploadImage(blob);
                const size = fitNodeSize(image.width, image.height);
                ctx.applyOps([{ type: "add_node", nodeType: "image", position: offset, width: size.width, height: size.height, metadata: imageMetadata(image) }]);
            } else {
                const video = await uploadMediaFile(blob, "director");
                const size = fitNodeSize(video.width || 420, video.height || 236, 420, 420);
                ctx.applyOps([{ type: "add_node", nodeType: "video", position: offset, width: size.width, height: size.height, metadata: videoMetadata(video) }]);
            }
        } catch {
            // Export upload failures are silently dropped; the user can retry the export from MONOFORM.
        }
    });

    useEffect(() => {
        const handler = (event: MessageEvent) => {
            const data = event.data as { source?: string; type?: string; kind?: "image" | "video"; blob?: Blob } | undefined;
            if (!data || data.source !== "monoform" || data.type !== "export") return;
            if ((data.kind === "image" || data.kind === "video") && data.blob) void onExportRef.current(data.kind, data.blob);
        };
        window.addEventListener("message", handler);
        return () => window.removeEventListener("message", handler);
    }, []);

    return (
        <Modal
            open
            onCancel={onClose}
            footer={null}
            width="min(96vw, 1280px)"
            centered
            destroyOnHidden
            title={t("canvas.director.title")}
            styles={{ body: { height: "min(84vh, 820px)", padding: 0, overflow: "hidden" } }}
        >
            <iframe
                src={`${import.meta.env.BASE_URL}monoform/index.html?key=${ctx.node.id}`}
                title="MONOFORM"
                className="h-full w-full border-0"
                allow="camera; microphone; clipboard-write; download; fullscreen"
            />
        </Modal>
    );
}
