"use client";

/**
 * 리소스 맵: 샌드박스의 리소스와 관계를 다이어그램으로 보여 준다 (AWS VPC 리소스 맵과 같은 읽기 전용 보기).
 * 리소스 생성·연결은 각 서비스 콘솔에서 하고, 여기서는 배치 이동과 경로 표시만 한다.
 */
import { useCallback, useMemo, useState } from "react";
import {
  Background,
  BackgroundVariant,
  Controls,
  MarkerType,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  type NodeChange,
  type XYPosition,
} from "@xyflow/react";
import { useTheme } from "next-themes";
import { simulateWithTopology, type SimulationResult } from "@/lib/engine/connectivity-engine";
import { RELATION_SPECS, RESOURCE_TYPE_INFO } from "@/lib/engine/resource-models";
import { displayName } from "@/lib/engine/topology-engine";
import { autoLayout, moveResources } from "@/lib/project/mutations";
import { useProjectStore } from "@/lib/store/project-store";
import { useAnalysis } from "../analysis-context";
import { useConsoleProjectId, useProject } from "../console-context";
import { useConsoleUi } from "../console-store";
import {
  buildResourceNodeData,
  computeZones,
  DEFAULT_NODE_SIZE,
  edgeLabel,
  isMembershipEdge,
  type PathState,
  type RelationFlowEdge,
  type ResourceFlowNode,
  type ZoneFlowNode,
} from "../map/canvas-model";
import { EDGE_STROKES, RelationEdge } from "../map/relation-edge";
import { ResourceNode, ZoneNode } from "../map/resource-node";
import { href, navigate, resourceHref, resourcePath, useHashLocation } from "../router";
import { Button, ButtonLink } from "../ui/button";
import { Checkbox, SelectInput } from "../ui/form";
import { Container, EmptyState, PageHeader } from "../ui/layout";
import { InfoLink } from "../ui/links";
import { OutcomeStatus } from "./reachability";

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

export function ResourceMapPage() {
  return (
    <ReactFlowProvider>
      <ResourceMap />
    </ReactFlowProvider>
  );
}

function ResourceMap() {
  const projectId = useConsoleProjectId();
  const project = useProject();
  const analysis = useAnalysis();
  const { query } = useHashLocation();
  const { resolvedTheme } = useTheme();
  const runs = useConsoleUi((s) => s.runs);
  const [showZones, setShowZones] = useState(true);
  const [showMembership, setShowMembership] = useState(false);
  const [hideTerminated, setHideTerminated] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [measured, setMeasured] = useState<Record<string, { width: number; height: number }>>({});
  const [dragPositions, setDragPositions] = useState<Record<string, XYPosition>>({});

  const pathId = query.get("path");
  const path = project.networkPaths.find((p) => p.id === pathId);
  const result: SimulationResult | null = useMemo(() => {
    if (!path) return null;
    return runs[path.id]?.result ?? simulateWithTopology(analysis.topology, path.request);
  }, [path, runs, analysis.topology]);

  const pathInfo = useMemo(() => {
    const map = new Map<string, { order: number; state: PathState }>();
    if (!result) return map;
    const ids = [...new Set(result.path.filter((h) => h.resourceId).map((h) => h.resourceId!))];
    ids.forEach((id, order) => map.set(id, { order, state: result.failure?.resourceIds.includes(id) ? "failed" : "active" }));
    for (const id of result.failure?.resourceIds ?? []) if (!map.has(id)) map.set(id, { order: -1, state: "failed" });
    return map;
  }, [result]);

  const activeConnections = useMemo(() => {
    const set = new Set<string>();
    if (!result) return set;
    for (const s of result.steps) for (const c of s.connectionIds) set.add(c);
    const ids = result.path.filter((h) => h.resourceId).map((h) => h.resourceId!);
    for (let i = 0; i + 1 < ids.length; i++) {
      for (const c of project.connections) {
        if ((c.sourceResourceId === ids[i] && c.targetResourceId === ids[i + 1]) || (c.sourceResourceId === ids[i + 1] && c.targetResourceId === ids[i])) set.add(c.id);
      }
    }
    return set;
  }, [result, project.connections]);

  const visibleResources = useMemo(
    () => project.resources.filter((r) => !(hideTerminated && r.type === "ec2" && r.config.state === "terminated")),
    [project.resources, hideTerminated],
  );

  const resourceNodes = useMemo<ResourceFlowNode[]>(
    () =>
      visibleResources.map((r) => {
        const p = pathInfo.get(r.id);
        return {
          id: r.id,
          type: "resource",
          position: dragPositions[r.id] ?? r.position,
          data: buildResourceNodeData(analysis.topology, r, analysis.health, analysis.findingsByResource.get(r.id), p?.state ?? (result ? "pending" : null), p && p.order >= 0 ? p.order : null),
          selected: selectedId === r.id,
          measured: measured[r.id],
          connectable: false,
          deletable: false,
          zIndex: 1,
        };
      }),
    [visibleResources, dragPositions, analysis, pathInfo, result, selectedId, measured],
  );

  const zoneNodes = useMemo<ZoneFlowNode[]>(() => {
    if (!showZones) return [];
    const positions = new Map(resourceNodes.map((n) => [n.id, n.position]));
    return computeZones(analysis.topology, positions, (id) => measured[id] ?? DEFAULT_NODE_SIZE).map((z) => ({
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
    }));
  }, [showZones, resourceNodes, analysis.topology, measured]);

  const nodes = useMemo<FlowNode[]>(() => [...zoneNodes, ...resourceNodes], [zoneNodes, resourceNodes]);
  const visibleIds = useMemo(() => new Set(visibleResources.map((r) => r.id)), [visibleResources]);

  const edges = useMemo<RelationFlowEdge[]>(
    () =>
      project.connections
        .filter((c) => visibleIds.has(c.sourceResourceId) && visibleIds.has(c.targetResourceId))
        .filter((c) => showMembership || !isMembershipEdge(c) || activeConnections.has(c.id))
        .map((c) => {
          const spec = RELATION_SPECS[c.relationType];
          const pathActive = activeConnections.has(c.id);
          const directional = spec.category === "route" || spec.category === "traffic";
          return {
            id: c.id,
            type: "relation",
            source: c.sourceResourceId,
            target: c.targetResourceId,
            selectable: false,
            deletable: false,
            className: pathActive ? "path-active" : undefined,
            markerEnd: directional ? { type: MarkerType.ArrowClosed, width: 14, height: 14, color: pathActive ? "#0284c7" : EDGE_STROKES[spec.category].color } : undefined,
            data: { connection: c, category: spec.category, label: edgeLabel(c, analysis.topology), alwaysShowLabel: directional, pathActive, faded: spec.category === "membership" || (!!result && !pathActive) },
          };
        }),
    [project.connections, visibleIds, showMembership, activeConnections, analysis.topology, result],
  );

  const onNodesChange = useCallback((changes: NodeChange<FlowNode>[]) => {
    const dims: Record<string, { width: number; height: number }> = {};
    const pos: Record<string, XYPosition> = {};
    for (const c of changes) {
      if (c.type === "dimensions" && c.dimensions) dims[c.id] = c.dimensions;
      else if (c.type === "position" && c.position && !c.id.startsWith("zone:")) pos[c.id] = c.position;
      else if (c.type === "select" && !c.id.startsWith("zone:") && c.selected) setSelectedId(c.id);
    }
    if (Object.keys(dims).length) {
      setMeasured((m) => {
        const changed = Object.entries(dims).some(([id, d]) => m[id]?.width !== d.width || m[id]?.height !== d.height);
        return changed ? { ...m, ...dims } : m;
      });
    }
    if (Object.keys(pos).length) setDragPositions((p) => ({ ...p, ...pos }));
  }, []);

  const onNodeDragStop = useCallback(
    (_e: MouseEvent | TouchEvent, _n: FlowNode, dragged: FlowNode[]) => {
      const positions: Record<string, XYPosition> = {};
      for (const n of dragged) if (n.type === "resource") positions[n.id] = n.position;
      if (!Object.keys(positions).length) return;
      useProjectStore.getState().apply(projectId, "리소스 맵 배치 이동", (p) => moveResources(p, positions));
      setDragPositions((prev) => {
        const next = { ...prev };
        for (const id of Object.keys(positions)) delete next[id];
        return next;
      });
    },
    [projectId],
  );

  const selected = selectedId ? analysis.topology.get(selectedId) : undefined;

  return (
    <div className="flex h-full flex-col gap-4">
      <PageHeader
        title="리소스 맵"
        info={<InfoLink topic="resource-map" />}
        description="리소스와 관계를 한눈에 봅니다. 노드를 두 번 클릭하면 해당 리소스의 콘솔 페이지로 이동합니다. 리소스를 만들거나 연결하려면 각 서비스 콘솔을 사용하세요."
        actions={
          <Button
            onClick={() => useProjectStore.getState().apply(projectId, "리소스 맵 자동 정렬", (p) => autoLayout(p))}
            disabled={!project.resources.length}
          >
            자동 정렬
          </Button>
        }
      />
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-sm">
        <Checkbox checked={showZones} onChange={setShowZones}>
          VPC/서브넷 영역 표시
        </Checkbox>
        <Checkbox checked={showMembership} onChange={setShowMembership}>
          소속 관계선 표시
        </Checkbox>
        <Checkbox checked={hideTerminated} onChange={setHideTerminated}>
          종료된 인스턴스 숨기기
        </Checkbox>
        <div className="flex items-center gap-2">
          <span className="text-aws-text-2">경로 표시</span>
          <SelectInput
            aria-label="표시할 분석 경로"
            className="w-64"
            value={pathId ?? ""}
            onChange={(v) => navigate("/map", { replace: true, query: { path: v || null } })}
            placeholder="표시 안 함"
            options={project.networkPaths.map((p) => ({ value: p.id, label: p.name || p.id }))}
          />
        </div>
        {result && (
          <span className="flex items-center gap-2">
            <OutcomeStatus outcome={result.outcome} />
            <a className="text-aws-link hover:underline" href={href(`/vpc/reachability/${path!.id}`)}>
              분석 세부 정보
            </a>
          </span>
        )}
      </div>
      {project.resources.length === 0 ? (
        <Container>
          <EmptyState title="표시할 리소스가 없습니다" description="VPC부터 직접 만들어 보세요." action={<ButtonLink href={href("/vpc/vpcs/create")}>VPC 생성</ButtonLink>} />
        </Container>
      ) : (
        <div className="relative h-[calc(100dvh-16rem)] min-h-[420px] overflow-hidden rounded-2xl border border-aws-border bg-aws-surface" data-testid="resource-map">
          <ReactFlow<FlowNode, RelationFlowEdge>
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            edgeTypes={edgeTypes}
            onNodesChange={onNodesChange}
            onNodeDragStop={onNodeDragStop}
            onNodeDoubleClick={(_e, n) => {
              const r = analysis.topology.get(n.id);
              if (r) navigate(resourcePath(r.type, r.id));
            }}
            onPaneClick={() => setSelectedId(null)}
            nodesConnectable={false}
            edgesFocusable={false}
            deleteKeyCode={null}
            colorMode={resolvedTheme === "dark" ? "dark" : "light"}
            fitView
            fitViewOptions={{ padding: 0.15 }}
            minZoom={0.15}
            attributionPosition="top-right"
          >
            <Background variant={BackgroundVariant.Dots} gap={18} size={1} />
            <Controls showInteractive={false} />
            <MiniMap pannable zoomable nodeColor={(n) => (n.type === "resource" ? MINIMAP_COLORS[RESOURCE_TYPE_INFO[(n as ResourceFlowNode).data.resource.type].category] : "transparent")} />
          </ReactFlow>
          {selected && (
            <div className="absolute bottom-3 left-3 z-10 max-w-xs rounded-xl border border-aws-border bg-aws-surface p-3 text-sm shadow-lg">
              <p className="text-xs text-aws-text-2">{RESOURCE_TYPE_INFO[selected.type].label}</p>
              <p className="font-bold break-all">{displayName(selected)}</p>
              <p className="font-mono text-xs text-aws-text-2">{selected.id}</p>
              <a href={resourceHref(selected.type, selected.id)} className="mt-2 inline-block font-bold text-aws-link hover:underline">
                콘솔에서 열기 →
              </a>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
