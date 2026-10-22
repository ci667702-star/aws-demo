"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject } from "react";
import {
  Background,
  BackgroundVariant,
  ConnectionMode,
  Controls,
  MarkerType,
  MiniMap,
  Panel,
  ReactFlow,
  useReactFlow,
  type Connection as FlowConnection,
  type EdgeChange,
  type FinalConnectionState,
  type NodeChange,
  type OnDelete,
  type Viewport as FlowViewport,
  type XYPosition,
} from "@xyflow/react";
import { useTheme } from "next-themes";
import { toast } from "sonner";
import { MousePointerClick } from "lucide-react";
import { checkConnection } from "@/lib/engine/connection-rules";
import {
  isResourceType,
  RELATION_SPECS,
  RESOURCE_TYPE_INFO,
  type Project,
  type ResourceType,
} from "@/lib/engine/resource-models";
import { NODE_HEIGHT, NODE_WIDTH } from "@/lib/project/layout";
import {
  addResource,
  connectResources,
  deleteResources,
  disconnect,
  moveResources,
  type MutationResult,
} from "@/lib/project/mutations";
import { useEditorStore } from "@/lib/store/editor-store";
import { useProjectStore } from "@/lib/store/project-store";
import { useAnalysis } from "../analysis-context";
import {
  buildResourceNodeData,
  computeZones,
  DEFAULT_NODE_SIZE,
  edgeLabel,
  findFreePosition,
  isMembershipEdge,
  type PathState,
  type RelationFlowEdge,
  type ResourceFlowNode,
  type ZoneFlowNode,
} from "./canvas-model";
import { CanvasActionsProvider } from "./canvas-context";
import { EDGE_STROKES, RelationEdge } from "./relation-edge";
import { ResourceNode, ZoneNode } from "./resource-node";

export const RESOURCE_DRAG_TYPE = "application/x-aws-playground-resource";

export interface CanvasCommands {
  addAtCenter: (type: ResourceType) => void;
}

type FlowNode = ResourceFlowNode | ZoneFlowNode;

const nodeTypes = { resource: ResourceNode, zone: ZoneNode };
const edgeTypes = { relation: RelationEdge };

const MINIMAP_COLORS: Record<string, string> = {
  networking: "#0ea5e9",
  security: "#f43f5e",
  compute: "#f59e0b",
  "load-balancing": "#8b5cf6",
  database: "#10b981",
};

function notifyResult(r: MutationResult, success?: string) {
  if (!r.ok) {
    toast.error(r.error, r.hint ? { description: r.hint } : undefined);
    return;
  }
  if (success) toast.success(success, r.notes.length ? { description: r.notes.join(" ") } : undefined);
  else for (const n of r.notes) toast.info(n);
}

export function ArchitectureCanvas({
  projectId,
  commandsRef,
}: {
  projectId: string;
  commandsRef: MutableRefObject<CanvasCommands | null>;
}) {
  const project = useProjectStore((s) => s.projects[projectId]) as Project;
  const apply = useProjectStore((s) => s.apply);
  const setStoreViewport = useProjectStore((s) => s.setViewport);
  const analysis = useAnalysis();
  const { resolvedTheme } = useTheme();
  const rf = useReactFlow<FlowNode, RelationFlowEdge>();
  const wrapperRef = useRef<HTMLDivElement>(null);

  const selectedResourceIds = useEditorStore((s) => s.selectedResourceIds);
  const selectedConnectionIds = useEditorStore((s) => s.selectedConnectionIds);
  const setSelection = useEditorStore((s) => s.setSelection);
  const focusRequest = useEditorStore((s) => s.focusRequest);
  const highlight = useEditorStore((s) => s.highlight);
  const showZones = useEditorStore((s) => s.showZones);
  const showMembershipEdges = useEditorStore((s) => s.showMembershipEdges);

  const [measured, setMeasured] = useState<Record<string, { width: number; height: number }>>({});
  const [dragPositions, setDragPositions] = useState<Record<string, XYPosition>>({});

  // ------------------------------------------------------------ 경로 하이라이트
  const pathInfo = useMemo(() => {
    const map = new Map<string, { order: number; state: PathState }>();
    if (!highlight) return map;
    const unique = [...new Set(highlight.resourceIds)];
    const finished = highlight.playhead >= highlight.resourceIds.length;
    const reached = new Set(highlight.resourceIds.slice(0, highlight.playhead));
    unique.forEach((id, order) => {
      const failed = finished && highlight.failedResourceIds.includes(id);
      map.set(id, { order, state: failed ? "failed" : reached.has(id) ? "active" : "pending" });
    });
    if (finished) {
      for (const id of highlight.failedResourceIds) if (!map.has(id)) map.set(id, { order: -1, state: "failed" });
    }
    return map;
  }, [highlight]);

  const activeConnections = useMemo(() => {
    const set = new Set<string>();
    if (!highlight) return set;
    const finished = highlight.playhead >= highlight.resourceIds.length;
    const reached = new Set(highlight.resourceIds.slice(0, highlight.playhead));
    for (const id of highlight.connectionIds) {
      const c = project.connections.find((x) => x.id === id);
      if (!c) continue;
      if (finished || (reached.has(c.sourceResourceId) && reached.has(c.targetResourceId))) set.add(id);
    }
    return set;
  }, [highlight, project.connections]);

  // ------------------------------------------------------------ 노드 / 영역 / 연결선
  const resourceNodes = useMemo<ResourceFlowNode[]>(
    () =>
      project.resources.map((r) => {
        const p = pathInfo.get(r.id);
        return {
          id: r.id,
          type: "resource",
          position: dragPositions[r.id] ?? r.position,
          data: buildResourceNodeData(
            analysis.topology,
            r,
            analysis.health,
            analysis.findingsByResource.get(r.id),
            p?.state ?? null,
            p && p.order >= 0 ? p.order : null,
          ),
          selected: selectedResourceIds.includes(r.id),
          measured: measured[r.id],
          zIndex: 1,
        };
      }),
    [project.resources, dragPositions, analysis, pathInfo, selectedResourceIds, measured],
  );

  const zoneBoxes = useMemo(() => {
    if (!showZones) return [];
    const positions = new Map(resourceNodes.map((n) => [n.id, n.position]));
    return computeZones(analysis.topology, positions, (id) => measured[id] ?? DEFAULT_NODE_SIZE);
  }, [showZones, resourceNodes, analysis.topology, measured]);

  const zoneNodes = useMemo<ZoneFlowNode[]>(
    () =>
      zoneBoxes.map((z) => ({
        id: z.id,
        type: "zone",
        position: { x: z.x, y: z.y },
        data: { kind: z.kind, label: z.label, detail: z.detail, tone: z.tone },
        width: z.width,
        height: z.height,
        measured: { width: z.width, height: z.height },
        draggable: false,
        selectable: false,
        connectable: false,
        deletable: false,
        focusable: false,
        zIndex: z.kind === "vpc" ? -2 : -1,
      })),
    [zoneBoxes],
  );

  const nodes = useMemo<FlowNode[]>(() => [...zoneNodes, ...resourceNodes], [zoneNodes, resourceNodes]);

  const edges = useMemo<RelationFlowEdge[]>(
    () =>
      project.connections
        .filter((c) => showMembershipEdges || !isMembershipEdge(c) || selectedConnectionIds.includes(c.id))
        .map((c) => {
          const spec = RELATION_SPECS[c.relationType];
          const pathActive = activeConnections.has(c.id);
          const directional = spec.category === "route" || spec.category === "traffic";
          return {
            id: c.id,
            type: "relation",
            source: c.sourceResourceId,
            target: c.targetResourceId,
            selected: selectedConnectionIds.includes(c.id),
            className: pathActive ? "path-active" : undefined,
            markerEnd: directional
              ? { type: MarkerType.ArrowClosed, width: 14, height: 14, color: pathActive ? "#0284c7" : EDGE_STROKES[spec.category].color }
              : undefined,
            data: {
              connection: c,
              category: spec.category,
              label: edgeLabel(c, analysis.topology),
              alwaysShowLabel: directional,
              pathActive,
              faded: spec.category === "membership",
            },
          };
        }),
    [project.connections, showMembershipEdges, selectedConnectionIds, activeConnections, analysis.topology],
  );

  // ------------------------------------------------------------ 변경 처리
  const onNodesChange = useCallback(
    (changes: NodeChange<FlowNode>[]) => {
      const dims: Record<string, { width: number; height: number }> = {};
      const pos: Record<string, XYPosition> = {};
      const state = useEditorStore.getState();
      const selected = new Set(state.selectedResourceIds);
      let selectionChanged = false;
      for (const c of changes) {
        if (c.type === "dimensions" && c.dimensions) dims[c.id] = c.dimensions;
        else if (c.type === "position" && c.position && !c.id.startsWith("zone:")) pos[c.id] = c.position;
        else if (c.type === "select" && !c.id.startsWith("zone:")) {
          selectionChanged = true;
          if (c.selected) selected.add(c.id);
          else selected.delete(c.id);
        }
      }
      if (Object.keys(dims).length) {
        setMeasured((m) => {
          let changed = false;
          for (const [id, d] of Object.entries(dims)) {
            if (m[id]?.width !== d.width || m[id]?.height !== d.height) changed = true;
          }
          return changed ? { ...m, ...dims } : m;
        });
      }
      if (Object.keys(pos).length) setDragPositions((p) => ({ ...p, ...pos }));
      if (selectionChanged) setSelection([...selected], useEditorStore.getState().selectedConnectionIds);
    },
    [setSelection],
  );

  const onEdgesChange = useCallback(
    (changes: EdgeChange<RelationFlowEdge>[]) => {
      const selected = new Set(useEditorStore.getState().selectedConnectionIds);
      let changed = false;
      for (const c of changes) {
        if (c.type !== "select") continue;
        changed = true;
        if (c.selected) selected.add(c.id);
        else selected.delete(c.id);
      }
      if (changed) setSelection(useEditorStore.getState().selectedResourceIds, [...selected]);
    },
    [setSelection],
  );

  const onNodeDragStop = useCallback(
    (_event: MouseEvent | TouchEvent, _node: FlowNode, dragged: FlowNode[]) => {
      const positions: Record<string, XYPosition> = {};
      for (const n of dragged) if (n.type === "resource") positions[n.id] = n.position;
      if (!Object.keys(positions).length) return;
      apply(projectId, dragged.length > 1 ? `리소스 ${dragged.length}개 이동` : "리소스 이동", (p) => moveResources(p, positions));
      setDragPositions((prev) => {
        const next = { ...prev };
        for (const id of Object.keys(positions)) delete next[id];
        return next;
      });
    },
    [apply, projectId],
  );

  const deleteElements = useCallback(
    (resourceIds: string[], connectionIds: string[]) => {
      if (!resourceIds.length && !connectionIds.length) return;
      const label = resourceIds.length ? `리소스 ${resourceIds.length}개 삭제` : `연결 ${connectionIds.length}개 삭제`;
      const r = apply(projectId, label, (p) => {
        let next = p;
        const notes: string[] = [];
        const edgesLeft = connectionIds.filter((id) => next.connections.some((c) => c.id === id));
        if (edgesLeft.length) {
          const d = disconnect(next, edgesLeft);
          if (!d.ok) return d;
          next = d.project;
        }
        if (resourceIds.length) {
          const d = deleteResources(next, resourceIds);
          if (!d.ok) return d;
          next = d.project;
          notes.push(...d.notes);
        }
        return { ok: true, project: next, notes };
      });
      notifyResult(r, `${label} 완료`);
      if (r.ok) setSelection([], []);
    },
    [apply, projectId, setSelection],
  );

  const onDelete: OnDelete<FlowNode, RelationFlowEdge> = useCallback(
    ({ nodes: deletedNodes, edges: deletedEdges }) => {
      deleteElements(
        deletedNodes.filter((n) => n.type === "resource").map((n) => n.id),
        deletedEdges.map((e) => e.id),
      );
    },
    [deleteElements],
  );

  const onConnect = useCallback(
    (c: FlowConnection) => {
      if (!c.source || !c.target) return;
      const r = apply(projectId, "연결 생성", (p) => connectResources(p, c.source, c.target));
      if (r.ok && r.createdId) {
        const conn = r.project.connections.find((x) => x.id === r.createdId);
        notifyResult(r, conn ? `연결됨: ${RELATION_SPECS[conn.relationType].description.split(".")[0]}` : "연결됨");
      } else notifyResult(r);
    },
    [apply, projectId],
  );

  const isValidConnection = useCallback(
    (c: FlowConnection | RelationFlowEdge) =>
      !!c.source && !!c.target && c.source !== c.target && !c.target.startsWith("zone:") && checkConnection(project, c.source, c.target).ok,
    [project],
  );

  const onConnectEnd = useCallback(
    (_event: MouseEvent | TouchEvent, state: FinalConnectionState) => {
      if (state.isValid !== false || !state.fromNode || !state.toNode) return;
      if (state.toNode.id.startsWith("zone:") || state.toNode.id === state.fromNode.id) return;
      const check = checkConnection(project, state.fromNode.id, state.toNode.id);
      if (!check.ok) toast.error(`연결할 수 없습니다: ${check.reason}`, check.hint ? { description: check.hint } : undefined);
    },
    [project],
  );

  // ------------------------------------------------------------ 리소스 추가
  const addResourceAt = useCallback(
    (type: ResourceType, position: XYPosition, containerId: string | null) => {
      const info = RESOURCE_TYPE_INFO[type];
      let createdName = "";
      const r = apply(projectId, `${info.label} 추가`, (p) => {
        const added = addResource(p, type, position);
        if (!added.ok || !added.createdId) return added;
        let next = added.project;
        const notes: string[] = [];
        createdName = next.resources.find((x) => x.id === added.createdId)?.name ?? "";
        if (containerId) {
          const c = connectResources(next, added.createdId, containerId);
          if (c.ok) {
            next = c.project;
            const container = next.resources.find((x) => x.id === containerId);
            notes.push(`${container?.name ?? ""}에 연결했습니다.`, ...c.notes);
          }
        }
        return { ok: true, project: next, notes, createdId: added.createdId };
      });
      notifyResult(r, `${info.label} ${createdName} 추가됨`);
      if (r.ok && r.createdId) setSelection([r.createdId], []);
    },
    [apply, projectId, setSelection],
  );

  const containerAt = useCallback(
    (point: XYPosition): string | null => {
      const hit = [...zoneBoxes]
        .sort((a, b) => (a.kind === b.kind ? a.width * a.height - b.width * b.height : a.kind === "subnet" ? -1 : 1))
        .find((z) => point.x >= z.x && point.x <= z.x + z.width && point.y >= z.y && point.y <= z.y + z.height);
      return hit?.resourceId ?? null;
    },
    [zoneBoxes],
  );

  const onDragOver = useCallback((e: React.DragEvent) => {
    if (e.dataTransfer.types.includes(RESOURCE_DRAG_TYPE)) {
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
    }
  }, []);

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      const type = e.dataTransfer.getData(RESOURCE_DRAG_TYPE);
      if (!isResourceType(type)) return;
      e.preventDefault();
      const point = rf.screenToFlowPosition({ x: e.clientX, y: e.clientY });
      addResourceAt(type, { x: point.x - NODE_WIDTH / 2, y: point.y - NODE_HEIGHT / 2 }, containerAt(point));
    },
    [rf, addResourceAt, containerAt],
  );

  useEffect(() => {
    commandsRef.current = {
      addAtCenter: (type) => {
        const rect = wrapperRef.current?.getBoundingClientRect();
        const center = rect
          ? rf.screenToFlowPosition({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 })
          : { x: 0, y: 0 };
        const selected = useEditorStore.getState().selectedResourceIds;
        const container = selected.length === 1 ? project.resources.find((r) => r.id === selected[0]) : undefined;
        // 선택한 리소스가 있으면 그 아래에, 없으면 화면 중앙에 두되 기존 노드와 겹치지 않게 한다
        const anchor = container
          ? { x: container.position.x, y: container.position.y + NODE_HEIGHT + 48 }
          : { x: center.x - NODE_WIDTH / 2, y: center.y - NODE_HEIGHT / 2 };
        const occupied = project.resources.map((r) => ({ ...r.position, ...(measured[r.id] ?? DEFAULT_NODE_SIZE) }));
        addResourceAt(type, findFreePosition(anchor, occupied), container?.id ?? null);
      },
    };
    return () => {
      commandsRef.current = null;
    };
  }, [commandsRef, rf, addResourceAt, project.resources, measured]);

  // ------------------------------------------------------------ 포커스 / 뷰포트
  useEffect(() => {
    if (!focusRequest) return;
    const ids = focusRequest.ids.filter((id) => project.resources.some((r) => r.id === id));
    if (!ids.length) return;
    void rf.fitView({ nodes: ids.map((id) => ({ id })), duration: 350, padding: 0.8, maxZoom: 1.2 });
    // focusRequest가 바뀔 때만 이동한다
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusRequest?.nonce]);

  const onMoveEnd = useCallback(
    (_e: MouseEvent | TouchEvent | null, viewport: FlowViewport) => setStoreViewport(projectId, viewport),
    [projectId, setStoreViewport],
  );

  const actions = useMemo(() => ({ deleteConnections: (ids: string[]) => deleteElements([], ids) }), [deleteElements]);

  return (
    <CanvasActionsProvider value={actions}>
      <div ref={wrapperRef} className="relative h-full w-full" data-testid="architecture-canvas">
        <ReactFlow<FlowNode, RelationFlowEdge>
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onNodeDragStop={onNodeDragStop}
          onConnect={onConnect}
          onConnectEnd={onConnectEnd}
          isValidConnection={isValidConnection}
          onDelete={onDelete}
          onDrop={onDrop}
          onDragOver={onDragOver}
          onMoveEnd={onMoveEnd}
          connectionMode={ConnectionMode.Loose}
          connectionRadius={28}
          defaultViewport={project.viewport ?? undefined}
          fitView={!project.viewport}
          fitViewOptions={{ padding: 0.2, maxZoom: 1.1 }}
          minZoom={0.15}
          maxZoom={2}
          deleteKeyCode={["Backspace", "Delete"]}
          multiSelectionKeyCode={["Meta", "Control"]}
          selectionKeyCode="Shift"
          colorMode={resolvedTheme === "dark" ? "dark" : "light"}
          attributionPosition="top-right"
          elevateNodesOnSelect={false}
          aria-label="아키텍처 캔버스"
        >
          <Background variant={BackgroundVariant.Dots} gap={18} size={1} />
          <Controls showInteractive={false} position="bottom-left" aria-label="캔버스 확대/축소" />
          <MiniMap
            pannable
            zoomable
            position="bottom-right"
            className="hidden md:block"
            nodeColor={(n) =>
              n.type === "zone" ? "transparent" : MINIMAP_COLORS[RESOURCE_TYPE_INFO[(n as ResourceFlowNode).data.resource.type].category]
            }
            nodeStrokeColor={(n) => (n.type === "zone" ? "#94a3b8" : "transparent")}
            ariaLabel="미니맵"
          />
          {project.resources.length === 0 && (
            <Panel position="top-center" className="pointer-events-none mt-16">
              <div className="flex max-w-sm flex-col items-center gap-2 rounded-xl border border-dashed bg-background/90 p-6 text-center shadow-sm">
                <MousePointerClick className="size-6 text-muted-foreground" aria-hidden />
                <p className="font-medium">빈 캔버스입니다</p>
                <p className="text-sm text-muted-foreground">
                  왼쪽 팔레트에서 VPC부터 끌어다 놓거나 클릭해 추가하세요. 리소스 아래/위의 연결점을 드래그하면 관계를 만들 수 있습니다.
                </p>
              </div>
            </Panel>
          )}
        </ReactFlow>
      </div>
    </CanvasActionsProvider>
  );
}
