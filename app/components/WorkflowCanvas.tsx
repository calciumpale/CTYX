'use client';

import { useEffect, useId, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react';
import { BookOpen, Bot, Check, CircleAlert, GitBranch, Grip, Hand, Maximize, Minus, MoveRight, Plus, ScanLine, ShieldCheck, Square, Trash2, X } from 'lucide-react';
import { AGENTS, type AgentId, type FlowEdge, type FlowNode, type NodeType, type TraceStep, type Workflow } from '../lib/types';
import { autoLayoutWorkflow, canConnectNodes } from '../lib/workflow-graph';
import './workflow-canvas.css';

type Point = { x: number; y: number };
type Camera = Point & { zoom: number };
type NodeMove = { id: string; pointerId: number; client: Point; origin: Point; position: Point; moved: boolean };
type Pan = { pointerId: number; client: Point; camera: Point };
type ConnectionDrag = { from: string; client: Point; moved: boolean };
export interface WorkflowCanvasProps {
  workflow: Workflow;
  readOnly?: boolean;
  selectedNodeId: string | null;
  onSelectNode: (id: string) => void;
  onChange: (workflow: Workflow) => void;
  statuses?: Record<string, TraceStep['status']>;
  onAddNode?: (type: NodeType, position: Point) => void;
  toolbarPrefix?: ReactNode;
  toolbarBadge?: ReactNode;
}

const WIDTH = 188;
const HEIGHT = 116;
const TYPES: Record<NodeType, { name: string; description: string; icon: typeof Bot }> = {
  start: { name: '任务输入', description: '接收用户输入', icon: MoveRight },
  intent: { name: '意图识别', description: '判断任务并分配路径', icon: GitBranch },
  knowledge: { name: '知识检索', description: '检索已生效的业务知识', icon: BookOpen },
  agent: { name: '领域专家', description: '调用一位领域专家', icon: Bot },
  review: { name: '人工审核', description: '暂停执行，等待管理者确认', icon: ShieldCheck },
  output: { name: '结果输出', description: '汇总路径中的执行结果', icon: Square },
};
const STATUS_LABELS: Record<TraceStep['status'], string> = { success: '已完成', warning: '待确认', error: '执行失败', skipped: '已跳过' };
const clampZoom = (zoom: number) => Math.max(.25, Math.min(2, zoom));
const edgeKey = (edge: FlowEdge) => `${edge.from}\0${edge.to}`;
const editableTarget = (target: EventTarget | null) => target instanceof HTMLElement && Boolean(target.closest('input, textarea, select, [contenteditable="true"]'));
const curve = (from: Point, to: Point) => {
  if (to.x < from.x - 20 && Math.abs(to.y - from.y) >= 80) {
    const dy = to.y > from.y ? 1 : -1;
    const midY = Math.round((from.y + to.y) / 2);
    const r = 14;
    const rx = from.x + 22;
    const lx = Math.max(8, to.x - 22);
    return `M ${from.x} ${from.y} L ${rx - r} ${from.y} Q ${rx} ${from.y} ${rx} ${from.y + dy * r} L ${rx} ${midY - dy * r} Q ${rx} ${midY} ${rx - r} ${midY} L ${lx + r} ${midY} Q ${lx} ${midY} ${lx} ${midY + dy * r} L ${lx} ${to.y - dy * r} Q ${lx} ${to.y} ${lx + r} ${to.y} L ${to.x} ${to.y}`;
  }
  const bend = Math.max(52, Math.abs(to.x - from.x) * .44);
  return `M ${from.x} ${from.y} C ${from.x + bend} ${from.y}, ${to.x - bend} ${to.y}, ${to.x} ${to.y}`;
};
const summary = (node: FlowNode) => node.type === 'agent'
  ? AGENTS.find(agent => agent.id === node.agentId)?.name ?? '尚未选择专家'
  : node.type === 'knowledge'
    ? node.knowledgeIds === undefined ? '按问题检索生效资料' : node.knowledgeIds.length ? `已选择 ${node.knowledgeIds.length} 条资料` : '尚未选择资料'
    : TYPES[node.type].description;
const branchLabel = (condition: FlowEdge['condition']) => condition === 'default' ? '默认路径' : AGENTS.find(agent => agent.id === condition)?.name ?? '';

export function WorkflowCanvas({ workflow, readOnly = false, selectedNodeId, onSelectNode, onChange, statuses = {}, onAddNode, toolbarPrefix, toolbarBadge }: WorkflowCanvasProps) {
  const viewport = useRef<HTMLDivElement>(null);
  const cameraRef = useRef<Camera>({ x: 36, y: 60, zoom: 1 });
  const [camera, setCameraState] = useState<Camera>({ x: 36, y: 60, zoom: 1 });
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [movingNode, setMovingNode] = useState<{ id: string; position: Point } | null>(null);
  const move = useRef<NodeMove | null>(null);
  const pan = useRef<Pan | null>(null);
  const [panning, setPanning] = useState(false);
  const [connection, setConnection] = useState<string | null>(null);
  const connectionRef = useRef<string | null>(null);
  const connectionDrag = useRef<ConnectionDrag | null>(null);
  const [connectionEnd, setConnectionEnd] = useState<Point | null>(null);
  const [selectedEdge, setSelectedEdge] = useState<string | null>(null);
  const [message, setMessageState] = useState('');
  const [messageError, setMessageError] = useState(false);
  const [dropActive, setDropActive] = useState(false);
  const initialPositioned = useRef(false);
  const previousSelected = useRef('');
  const suppressClick = useRef(false);
  const uniqueId = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const arrowId = `flow-arrow-${uniqueId}`;
  const baseNodes = workflow.nodes;
  const visibleNodes = baseNodes.map(node => movingNode?.id === node.id ? { ...node, ...movingNode.position } : node);
  const nodeMap = new Map(visibleNodes.map(node => [node.id, node]));
  const selectedEdgeData = workflow.edges.find(edge => edgeKey(edge) === selectedEdge);

  const setCamera = (next: Camera) => { cameraRef.current = next; setCameraState(next); };
  const setMessage = (text: string, error = false) => { setMessageState(text); setMessageError(error); };
  const worldPoint = (client: Point): Point => {
    const rect = viewport.current!.getBoundingClientRect();
    const view = cameraRef.current;
    return { x: (client.x - rect.left - view.x) / view.zoom, y: (client.y - rect.top - view.y) / view.zoom };
  };
  const cancelConnection = () => {
    setConnection(null); connectionRef.current = null; connectionDrag.current = null; setConnectionEnd(null);
  };
  const selectNode = (id: string) => { setSelectedEdge(null); onSelectNode(id); };
  const fit = () => {
    const rect = viewport.current?.getBoundingClientRect();
    if (!rect || !baseNodes.length) return;
    const left = Math.min(...baseNodes.map(node => node.x)) - 22;
    const top = Math.min(...baseNodes.map(node => node.y));
    const right = Math.max(...baseNodes.map(node => node.x + WIDTH)) + 22;
    const bottom = Math.max(...baseNodes.map(node => node.y + HEIGHT));
    const zoom = Math.min(1, clampZoom(Math.min((rect.width - 40) / (right - left), (rect.height - 72) / (bottom - top))));
    setCamera({ x: Math.round((rect.width - (right - left) * zoom) / 2 - left * zoom), y: Math.round((rect.height - (bottom - top) * zoom) / 2 - top * zoom), zoom });
  };
  const zoomAt = (zoom: number, anchor?: Point) => {
    const rect = viewport.current?.getBoundingClientRect();
    if (!rect) return;
    const current = cameraRef.current;
    const point = anchor ?? { x: rect.width / 2, y: rect.height / 2 };
    const nextZoom = clampZoom(zoom);
    setCamera({ zoom: nextZoom, x: point.x - (point.x - current.x) * nextZoom / current.zoom, y: point.y - (point.y - current.y) * nextZoom / current.zoom });
  };

  useEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const observer = new ResizeObserver(entries => {
      const { width, height } = entries[0].contentRect;
      setSize({ width, height });
    });
    observer.observe(element);
    // A non-passive listener keeps trackpad navigation inside the canvas.
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      const current = cameraRef.current;
      if (event.ctrlKey || event.metaKey) {
        const rect = element.getBoundingClientRect();
        const anchor = { x: event.clientX - rect.left, y: event.clientY - rect.top };
        const zoom = clampZoom(current.zoom * Math.exp(-event.deltaY * .008));
        setCamera({ zoom, x: anchor.x - (anchor.x - current.x) * zoom / current.zoom, y: anchor.y - (anchor.y - current.y) * zoom / current.zoom });
      } else {
        setCamera({ ...current, x: current.x - (event.shiftKey ? event.deltaY : event.deltaX), y: current.y - (event.shiftKey ? event.deltaX : event.deltaY) });
      }
    };
    element.addEventListener('wheel', wheel, { passive: false });
    return () => { observer.disconnect(); element.removeEventListener('wheel', wheel); };
  }, []);

  useEffect(() => {
    initialPositioned.current = false;
    previousSelected.current = '';
    move.current = null; pan.current = null; connectionDrag.current = null;
    // Different workflows have separate graphs; transient gestures never cross that boundary.
    connectionRef.current = null;
    const frame = requestAnimationFrame(() => {
      setMovingNode(null); setPanning(false); setConnection(null); setConnectionEnd(null); setSelectedEdge(null); setMessageState(''); setMessageError(false);
    });
    return () => cancelAnimationFrame(frame);
  }, [workflow.id]);

  useEffect(() => {
    if (!size.width || !size.height) return;
    const selected = baseNodes.find(node => node.id === selectedNodeId);
    let frame = 0;
    if (!initialPositioned.current) {
      frame = requestAnimationFrame(() => {
        if (baseNodes.length) {
          const left = Math.min(...baseNodes.map(node => node.x)) - 22;
          const top = Math.min(...baseNodes.map(node => node.y));
          const right = Math.max(...baseNodes.map(node => node.x + WIDTH)) + 22;
          const bottom = Math.max(...baseNodes.map(node => node.y + HEIGHT));
          const zoom = Math.min(1, clampZoom(Math.min((size.width - 40) / (right - left), (size.height - 72) / (bottom - top))));
          setCamera({ x: Math.round((size.width - (right - left) * zoom) / 2 - left * zoom), y: Math.round((size.height - (bottom - top) * zoom) / 2 - top * zoom), zoom });
        }
        initialPositioned.current = true;
        previousSelected.current = selectedNodeId ?? '';
      });
    } else if (selected && previousSelected.current !== selectedNodeId) {
      const current = cameraRef.current;
      const x = selected.x * current.zoom + current.x;
      const y = selected.y * current.zoom + current.y;
      if (x < 24 || y < 24 || x + WIDTH * current.zoom > size.width - 24 || y + HEIGHT * current.zoom > size.height - 24) {
        frame = requestAnimationFrame(() => setCamera({ ...current, x: size.width / 2 - (selected.x + WIDTH / 2) * current.zoom, y: size.height / 2 - (selected.y + HEIGHT / 2) * current.zoom }));
      }
      previousSelected.current = selectedNodeId ?? '';
    }
    return () => cancelAnimationFrame(frame);
  }, [workflow.id, baseNodes, selectedNodeId, size]);

  const connect = (from: string, to: string) => {
    if (readOnly) return;
    const valid = canConnectNodes(workflow, from, to);
    if (!valid.ok) { setMessage(valid.error!, true); return; }
    const source = workflow.nodes.find(node => node.id === from)!;
    const outgoing = workflow.edges.filter(edge => edge.from === from);
    const used = new Set(outgoing.map(edge => edge.condition));
    const options: (AgentId | 'default')[] = ['default', ...AGENTS.map(agent => agent.id)];
    const condition = source.type === 'intent' && outgoing.some(edge => edge.condition !== undefined) ? options.find(option => !used.has(option)) : undefined;
    if (source.type === 'intent' && outgoing.some(edge => edge.condition !== undefined) && condition === undefined) { setMessage('这个意图节点的条件已用完，请先调整现有分支。', true); return; }
    const edge: FlowEdge = { from, to, ...(condition ? { condition } : {}) };
    onChange({ ...workflow, edges: [...workflow.edges, edge] });
    setSelectedEdge(edgeKey(edge));
    cancelConnection();
    setMessage(`已连接“${source.label}”与“${workflow.nodes.find(node => node.id === to)!.label}”。`);
  };
  const beginConnection = (from: string, client?: Point) => {
    if (readOnly) return;
    if (connectionRef.current === from && !client) { cancelConnection(); return; }
    connectionRef.current = from; setConnection(from); setSelectedEdge(null); setMessage('');
    const node = nodeMap.get(from)!;
    setConnectionEnd({ x: node.x + WIDTH + 100, y: node.y + HEIGHT / 2 });
    connectionDrag.current = client ? { from, client, moved: false } : null;
  };
  const deleteEdge = () => {
    if (readOnly || !selectedEdgeData) return;
    onChange({ ...workflow, edges: workflow.edges.filter(edge => edgeKey(edge) !== selectedEdge) });
    setSelectedEdge(null); setMessage('连接已删除，节点仍保留在画布上。');
  };
  const handleKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (editableTarget(event.target) || event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.key === 'Escape') { cancelConnection(); setSelectedEdge(null); setMessage(''); return; }
    if ((event.key === 'Delete' || event.key === 'Backspace') && selectedEdgeData && !readOnly) { event.preventDefault(); deleteEdge(); }
  };
  const handleNodeKey = (event: KeyboardEvent<HTMLElement>, node: FlowNode) => {
    if (event.target !== event.currentTarget) return;
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); selectNode(node.id); return; }
    if (readOnly || event.metaKey || event.ctrlKey || event.altKey) return;
    const direction: Record<string, Point> = { ArrowLeft: { x: -1, y: 0 }, ArrowRight: { x: 1, y: 0 }, ArrowUp: { x: 0, y: -1 }, ArrowDown: { x: 0, y: 1 } };
    const vector = direction[event.key];
    if (!vector) return;
    event.preventDefault(); event.stopPropagation();
    const distance = event.shiftKey ? 48 : 12;
    selectNode(node.id);
    onChange({ ...workflow, nodes: baseNodes.map(item => item.id === node.id ? { ...item, x: Math.max(12, item.x + vector.x * distance), y: Math.max(12, item.y + vector.y * distance) } : item) });
  };
  const startNodeMove = (event: PointerEvent<HTMLElement>, node: FlowNode) => {
    if (event.button !== 0 || (event.target as HTMLElement).closest('button')) return;
    event.stopPropagation();
    selectNode(node.id);
    event.currentTarget.focus({ preventScroll: true });
    if (readOnly) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    move.current = { id: node.id, pointerId: event.pointerId, client: { x: event.clientX, y: event.clientY }, origin: { x: node.x, y: node.y }, position: { x: node.x, y: node.y }, moved: false };
  };
  const handlePointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (move.current?.pointerId === event.pointerId) {
      const active = move.current;
      const dx = (event.clientX - active.client.x) / cameraRef.current.zoom;
      const dy = (event.clientY - active.client.y) / cameraRef.current.zoom;
      if (!active.moved && Math.hypot(dx, dy) < 3) return;
      active.moved = true;
      active.position = { x: Math.max(12, Math.round(active.origin.x + dx)), y: Math.max(12, Math.round(active.origin.y + dy)) };
      setMovingNode({ id: active.id, position: active.position });
    } else if (pan.current?.pointerId === event.pointerId) {
      const active = pan.current;
      setCamera({ ...cameraRef.current, x: active.camera.x + event.clientX - active.client.x, y: active.camera.y + event.clientY - active.client.y });
    }
    if (connectionRef.current) {
      setConnectionEnd(worldPoint({ x: event.clientX, y: event.clientY }));
      const active = connectionDrag.current;
      if (active && Math.hypot(event.clientX - active.client.x, event.clientY - active.client.y) > 4) active.moved = true;
    }
  };
  const endGesture = (event: PointerEvent<HTMLDivElement>, cancelled = false) => {
    const active = move.current;
    if (active?.pointerId === event.pointerId) {
      if (!cancelled && active.moved && !readOnly) {
        onChange({ ...workflow, nodes: baseNodes.map(node => node.id === active.id ? { ...node, ...active.position } : node) });
        suppressClick.current = true;
      }
      move.current = null; setMovingNode(null);
    }
    if (pan.current?.pointerId === event.pointerId) { pan.current = null; setPanning(false); }
    const connecting = connectionDrag.current;
    if (connecting?.moved && !cancelled) {
      const target = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>('[data-flow-input]');
      if (target?.dataset.flowInput) connect(connecting.from, target.dataset.flowInput);
    }
    connectionDrag.current = null;
    if (cancelled) cancelConnection();
  };

  return <section className="flow-canvas" aria-label="工作流画布" onKeyDown={handleKey}>
    <div className="flow-canvas-toolbar">
      <div className="flow-canvas-toolbar-group">{toolbarPrefix}<span className="flow-canvas-caption"><GitBranch size={14} /><strong>工作流画布</strong><span className="flow-canvas-separator">·</span>{workflow.nodes.length} 个节点<span className="flow-canvas-separator">·</span>{workflow.edges.length} 条连接</span>{toolbarBadge}{readOnly && <span className="flow-canvas-readonly">只读</span>}</div>
      <div className="flow-canvas-toolbar-group"><button type="button" onClick={() => zoomAt(camera.zoom - .1)} disabled={camera.zoom <= .25} title="缩小画布" aria-label="缩小画布"><Minus size={15} /></button><button type="button" className="flow-canvas-zoom" onClick={() => zoomAt(1)} title="重置为 100%">{Math.round(camera.zoom * 100)}%</button><button type="button" onClick={() => zoomAt(camera.zoom + .1)} disabled={camera.zoom >= 2} title="放大画布" aria-label="放大画布"><Plus size={15} /></button><span className="flow-canvas-toolbar-divider" /><button type="button" onClick={fit} title="适应全部节点" aria-label="适应画布"><Maximize size={15} /><span>适应</span></button>{!readOnly && <button type="button" onClick={() => { cancelConnection(); onChange(autoLayoutWorkflow(workflow)); setMessage('节点已整理，原有连线与分支均已保留。'); }} title="整理位置并保留所有连线"><ScanLine size={15} /><span>自动整理</span></button>}</div>
    </div>
    <div ref={viewport} className={`flow-canvas-viewport${panning ? ' is-panning' : ''}${dropActive ? ' is-drop-active' : ''}`} tabIndex={0} role="region" aria-label="节点编辑区域，拖动空白处平移，方向键移动节点" onPointerMove={handlePointerMove} onPointerUp={event => endGesture(event)} onPointerCancel={event => endGesture(event, true)}
      onPointerDown={event => {
        if (event.button !== 0 && event.button !== 1) return;
        if ((event.target as HTMLElement).closest('[data-flow-node], button, [data-flow-edge]')) return;
        viewport.current?.focus({ preventScroll: true });
        event.currentTarget.setPointerCapture(event.pointerId);
        const current = cameraRef.current;
        pan.current = { pointerId: event.pointerId, client: { x: event.clientX, y: event.clientY }, camera: { x: current.x, y: current.y } };
        setPanning(true); setSelectedEdge(null);
      }}
      onDragOver={event => { if (!readOnly && onAddNode && event.dataTransfer.types.includes('application/x-ctai-node-type')) { event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; setDropActive(true); } }}
      onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setDropActive(false); }}
      onDrop={event => {
        event.preventDefault(); setDropActive(false);
        if (readOnly || !onAddNode) return;
        const type = event.dataTransfer.getData('application/x-ctai-node-type');
        if (!Object.hasOwn(TYPES, type)) return;
        const point = worldPoint({ x: event.clientX, y: event.clientY });
        onAddNode(type as NodeType, { x: Math.max(12, Math.round(point.x - WIDTH / 2)), y: Math.max(12, Math.round(point.y - 28)) });
      }}>
      <div className="flow-canvas-world" style={{ transform: `translate(${camera.x}px, ${camera.y}px) scale(${camera.zoom})` }}>
        <svg className="flow-canvas-edges" width={Math.max(1, ...visibleNodes.map(node => node.x + WIDTH + 120))} height={Math.max(1, ...visibleNodes.map(node => node.y + HEIGHT + 120))} aria-label="节点之间的连接">
          <defs><marker id={arrowId} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M 1 1 L 9 5 L 1 9" fill="none" stroke="context-stroke" strokeWidth="1.4" /></marker></defs>
          {workflow.edges.map(edge => {
            const from = nodeMap.get(edge.from), to = nodeMap.get(edge.to);
            if (!from || !to) return null;
            const start = { x: from.x + WIDTH, y: from.y + HEIGHT / 2 }, end = { x: to.x, y: to.y + HEIGHT / 2 };
            const key = edgeKey(edge), selected = key === selectedEdge;
            const label = branchLabel(edge.condition);
            return <g key={key} data-flow-edge="true" className={`flow-canvas-edge${selected ? ' is-selected' : ''}`}>
              <path className="flow-canvas-edge-hit" d={curve(start, end)} tabIndex={0} role="button" aria-label={`选择连接：${from.label} 到 ${to.label}${label ? `，${label}` : ''}`} onPointerDown={event => event.stopPropagation()} onClick={() => { setSelectedEdge(key); cancelConnection(); }} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setSelectedEdge(key); cancelConnection(); } }} />
              <path className="flow-canvas-edge-line" d={curve(start, end)} markerEnd={`url(#${arrowId})`} />
              {label && <g className="flow-canvas-edge-label" transform={`translate(${(start.x + end.x) / 2},${(start.y + end.y) / 2 - 13})`}><rect x={-39} y={-10} width={78} height={20} rx={5} /><text textAnchor="middle" dominantBaseline="central">{label}</text></g>}
            </g>;
          })}
          {connection && connectionEnd && nodeMap.get(connection) && <path className="flow-canvas-pending-edge" d={curve({ x: nodeMap.get(connection)!.x + WIDTH, y: nodeMap.get(connection)!.y + HEIGHT / 2 }, connectionEnd)} />}
        </svg>
        {visibleNodes.map(node => {
          const meta = TYPES[node.type], Icon = meta.icon, status = statuses[node.id];
          return <article key={node.id} data-flow-node={node.id} data-node-type={node.type} className={`flow-canvas-node${selectedNodeId === node.id ? ' is-selected' : ''}${movingNode?.id === node.id ? ' is-dragging' : ''}${status ? ` has-status-${status}` : ''}`} style={{ left: node.x, top: node.y, width: WIDTH, height: HEIGHT }} tabIndex={0} aria-label={`${node.label}，${meta.name}${status ? `，${STATUS_LABELS[status]}` : ''}`} aria-current={selectedNodeId === node.id ? 'true' : undefined} onFocus={event => { if (event.target === event.currentTarget) selectNode(node.id); }} onPointerDown={event => startNodeMove(event, node)} onKeyDown={event => handleNodeKey(event, node)} onClick={event => { if ((event.target as HTMLElement).closest('button')) return; if (suppressClick.current) { suppressClick.current = false; return; } selectNode(node.id); }}>
            <div className="flow-canvas-node-kind"><span className="flow-canvas-node-icon"><Icon size={14} /></span><span>{meta.name}</span>{!readOnly && <Grip size={12} className="flow-canvas-node-grip" />}</div>
            <strong title={node.label}>{node.label}</strong>
            <div className="flow-canvas-node-summary" title={summary(node)}>{summary(node)}</div>
            {status && <span className={`flow-canvas-node-status status-${status}`}>{status === 'success' ? <Check size={10} /> : status === 'error' ? <CircleAlert size={10} /> : null}{STATUS_LABELS[status]}</span>}
            {node.type !== 'start' && <button type="button" data-flow-input={node.id} className={`flow-canvas-port flow-canvas-input${connection ? ' is-ready' : ''}`} disabled={readOnly} aria-label={`连接到 ${node.label} 的输入端口`} title={connection ? `连接到 ${node.label}` : `${node.label} · 输入`} onPointerDown={event => event.stopPropagation()} onClick={() => { if (connectionRef.current) connect(connectionRef.current, node.id); else { selectNode(node.id); setMessage('先点击前一个节点右侧的输出端口，再点击这里。'); } }} />}
            {node.type !== 'output' && <button type="button" data-flow-output={node.id} className={`flow-canvas-port flow-canvas-output${connection === node.id ? ' is-connecting' : ''}`} disabled={readOnly} aria-label={`从 ${node.label} 的输出端口开始连接`} aria-pressed={connection === node.id} title={`${node.label} · 输出，点击或拖动以连接`} onPointerDown={event => { if (event.button !== 0) return; event.stopPropagation(); beginConnection(node.id, { x: event.clientX, y: event.clientY }); }} onClick={event => { if (event.detail === 0) beginConnection(node.id); }} />}
          </article>;
        })}
      </div>
      {!workflow.nodes.length && <div className="flow-canvas-empty"><GitBranch size={28} /><strong>从一个节点开始</strong><span>{readOnly ? '这个工作流还没有节点。' : '从左侧拖入节点，或点击节点名称添加。'}</span></div>}
      {dropActive && <div className="flow-canvas-drop-hint"><Plus size={18} />松开以添加节点</div>}
    </div>
    {selectedEdgeData && <div className="flow-canvas-selection" role="group" aria-label="所选连接"><span>{nodeMap.get(selectedEdgeData.from)?.label}<MoveRight size={13} />{nodeMap.get(selectedEdgeData.to)?.label}</span>{selectedEdgeData.condition && <small>{branchLabel(selectedEdgeData.condition)}</small>}{!readOnly && <button type="button" onClick={deleteEdge}><Trash2 size={13} />删除连接</button>}<button type="button" aria-label="取消选择连接" onClick={() => setSelectedEdge(null)}><X size={13} /></button></div>}
    <div className={`flow-canvas-footer${connection ? ' is-connecting' : ''}${messageError ? ' is-error' : ''}`}>
      <div role="status" aria-live="polite">{messageError ? <><CircleAlert size={13} /><span>{message}</span>{connection && <button type="button" onClick={cancelConnection}>取消 <kbd>Esc</kbd></button>}</> : connection ? <><GitBranch size={13} /><span>连接中：点击目标节点的输入端口</span><button type="button" onClick={cancelConnection}>取消 <kbd>Esc</kbd></button></> : message ? <><Check size={13} /><span>{message}</span></> : <><Hand size={13} /><span>拖动空白处平移 · 双指缩放{!readOnly ? ' · 点击端口连接节点' : ''}</span></>}</div>
      <span className="flow-canvas-key-hint">{!readOnly ? '方向键移动节点' : '点击节点查看配置'}</span>
    </div>
  </section>;
}
