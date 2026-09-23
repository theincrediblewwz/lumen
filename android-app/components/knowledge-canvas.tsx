import { Fragment, useCallback, useEffect, useMemo, useRef } from 'react';
import { Animated as NativeAnimated, Pressable, Text, useWindowDimensions, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  runOnJS,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import Svg, { Circle, Defs, Line, Pattern, Rect } from 'react-native-svg';

import { calculateFocalZoom, clampCanvasScale, shouldApplyPinchUpdate } from '@/components/canvas-transform';
import { getDirectHierarchy, getPersistedBoardBounds, GRAPH_NODE_HEIGHT, GRAPH_NODE_WIDTH } from '@/components/hierarchy-layout';
import { colors, edgeReviewColor, radii, statusColor, statusSoftColor } from '@/theme/tokens';
import type { KnowledgeEdge, KnowledgeNode } from '@/types/domain';

export type FocusPreset = 'coral' | 'blue' | 'green' | 'amber';

const focusColors: Record<FocusPreset, string> = {
  coral: colors.coral,
  blue: colors.blue,
  green: colors.green,
  amber: colors.amber,
};

const MARCH_DASH_LENGTH = 10;
const MARCH_DASH_GAP = 7;
const MARCH_CYCLE = MARCH_DASH_LENGTH + MARCH_DASH_GAP;

function MarchingEdge({
  x1,
  y1,
  x2,
  y2,
  color,
  dashOffset,
  reducedMotion,
}: {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  color: string;
  dashOffset: NativeAnimated.Value;
  reducedMotion: boolean;
}) {
  const deltaX = x2 - x1;
  const deltaY = y2 - y1;
  const length = Math.max(1, Math.hypot(deltaX, deltaY));
  const angle = Math.atan2(deltaY, deltaX);

  return (
    <View
      pointerEvents="none"
      style={{
        position: 'absolute',
        left: (x1 + x2) / 2 - length / 2,
        top: (y1 + y2) / 2 - 3,
        width: length,
        height: 8,
        overflow: 'hidden',
        transform: [{ rotate: `${angle}rad` }],
      }}
    >
      <NativeAnimated.View
        style={{
          position: 'absolute',
          left: -MARCH_CYCLE,
          top: 1,
          width: length + MARCH_CYCLE * 2,
          height: 7,
          borderTopWidth: 5,
          borderTopColor: color,
          borderStyle: 'dashed',
          transform: [{ translateX: reducedMotion ? 0 : dashOffset }],
        }}
      />
    </View>
  );
}

type Props = {
  nodes: KnowledgeNode[];
  edges: KnowledgeEdge[];
  selectedId: string | null;
  onSelectNode: (node: KnowledgeNode) => void;
  onSelectEdge: (edge: KnowledgeEdge) => void;
  onClearSelection: () => void;
  onLongPressNode: (node: KnowledgeNode) => void;
  focusPreset?: FocusPreset;
  fitRequest?: number;
  focusNodeId?: string | null;
  focusRequest?: number;
  movingNodeId?: string | null;
  showLearningMarks?: boolean;
  onPreviewMove?: (id:string,x:number,y:number)=>void;
  onMoveNode?: (id:string,x:number,y:number)=>void;
};

export function KnowledgeCanvas({
  nodes,
  edges,
  selectedId,
  onSelectNode,
  onSelectEdge,
  onClearSelection,
  onLongPressNode,
  focusPreset = 'coral',
  fitRequest = 0,
  focusNodeId = null,
  focusRequest = 0,
  movingNodeId = null,
  showLearningMarks = false,
  onPreviewMove,
  onMoveNode,
}: Props) {
  const { width } = useWindowDimensions();
  const reducedMotion = useReducedMotion();
  const initialScale = Math.min(0.56, (width - 34) / 860);
  const translateX = useSharedValue(0);
  const translateY = useSharedValue(26);
  const scale = useSharedValue(initialScale);
  const startX = useSharedValue(0);
  const startY = useSharedValue(0);
  const startScale = useSharedValue(initialScale);
  const pinchStartX = useSharedValue(0);
  const pinchStartY = useSharedValue(0);
  const pinchStartFocalX = useSharedValue(0);
  const pinchStartFocalY = useSharedValue(0);
  const activePinchTouches = useSharedValue(0);
  const viewportWidth = useSharedValue(width);
  const viewportHeight = useSharedValue(0);
  const dashOffset = useRef(new NativeAnimated.Value(0)).current;
  const dashAnimation = useRef<NativeAnimated.CompositeAnimation | null>(null);
  const hasFitted = useRef(false);
  const appliedFitRequest = useRef(fitRequest);
  const appliedFocusRequest = useRef('');

  const board = useMemo(() => getPersistedBoardBounds(nodes), [nodes]);
  const nodeMap = useMemo(() => new Map(nodes.map((node) => [node.id, node])), [nodes]);
  const hierarchy = useMemo(() => getDirectHierarchy(selectedId, edges), [edges, selectedId]);
  const hasNodeSelection = nodes.some((node) => node.id === selectedId);
  const focusColor = focusColors[focusPreset];
  const downstreamColor = focusPreset === 'blue' ? colors.coral : colors.blue;

  const stopMarchingAnimation = useCallback(() => {
    dashAnimation.current?.stop();
    dashAnimation.current = null;
    dashOffset.stopAnimation();
  }, [dashOffset]);

  const startMarchingAnimation = useCallback(() => {
    stopMarchingAnimation();
    dashOffset.setValue(0);
    if (!hasNodeSelection || reducedMotion || movingNodeId || !showLearningMarks) return;
    const animation = NativeAnimated.loop(
      NativeAnimated.timing(dashOffset, {
        toValue: MARCH_CYCLE,
        duration: 850,
        easing: (value) => value,
        useNativeDriver: true,
      }),
    );
    dashAnimation.current = animation;
    animation.start();
  }, [dashOffset, hasNodeSelection, reducedMotion, movingNodeId, showLearningMarks, stopMarchingAnimation]);

  useEffect(() => {
    startMarchingAnimation();
    return stopMarchingAnimation;
  }, [startMarchingAnimation, stopMarchingAnimation]);

  const pan = Gesture.Pan()
    .maxPointers(1)
    .minDistance(3)
    .onBegin(() => {
      runOnJS(stopMarchingAnimation)();
      const moving = nodes.find(n=>n.id===movingNodeId);
      startX.value = moving ? moving.x : translateX.value;
      startY.value = moving ? moving.y : translateY.value;
    })
    .onUpdate((event) => {
      if (movingNodeId && onPreviewMove) {
        runOnJS(onPreviewMove)(movingNodeId,startX.value+event.translationX/scale.value,startY.value+event.translationY/scale.value);
      } else {
        translateX.value = startX.value + event.translationX;
        translateY.value = startY.value + event.translationY;
      }
    })
    .onEnd((event,success)=>{
      if (movingNodeId && onMoveNode) runOnJS(onMoveNode)(movingNodeId,startX.value+(success?event.translationX/scale.value:0),startY.value+(success?event.translationY/scale.value:0));
    })
    .onFinalize(() => {
      runOnJS(startMarchingAnimation)();
    });

  const pinch = Gesture.Pinch()
    .enabled(!movingNodeId)
    .onTouchesDown((event) => {
      activePinchTouches.value = event.numberOfTouches;
    })
    .onTouchesMove((event) => {
      activePinchTouches.value = event.numberOfTouches;
    })
    .onTouchesUp((event) => {
      activePinchTouches.value = event.numberOfTouches;
    })
    .onTouchesCancelled(() => {
      activePinchTouches.value = 0;
    })
    .onStart((event) => {
      runOnJS(stopMarchingAnimation)();
      startScale.value = scale.value;
      pinchStartX.value = translateX.value;
      pinchStartY.value = translateY.value;
      pinchStartFocalX.value = event.focalX;
      pinchStartFocalY.value = event.focalY;
    })
    .onUpdate((event) => {
      if (!shouldApplyPinchUpdate(activePinchTouches.value)) return;
      const next = calculateFocalZoom({
        startTranslateX: pinchStartX.value,
        startTranslateY: pinchStartY.value,
        startScale: startScale.value,
        startFocalX: pinchStartFocalX.value,
        startFocalY: pinchStartFocalY.value,
        currentFocalX: event.focalX,
        currentFocalY: event.focalY,
        scaleFactor: event.scale,
      });
      scale.value = next.scale;
      translateX.value = next.translateX;
      translateY.value = next.translateY;
    })
    .onFinalize(() => {
      activePinchTouches.value = 0;
      runOnJS(startMarchingAnimation)();
    });

  const boardPositionStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: translateX.value + board.minX * scale.value }, { translateY: translateY.value + board.minY * scale.value }],
  }));
  const boardScaleStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
  }));

  const fit = useCallback((nextWidth = viewportWidth.value, nextHeight = viewportHeight.value, immediate = false) => {
    if (!nextWidth || !nextHeight || !nodes.length) return;
    const minX = Math.min(...nodes.map((node) => node.x));
    const minY = Math.min(...nodes.map((node) => node.y));
    const maxX = Math.max(...nodes.map((node) => node.x + GRAPH_NODE_WIDTH));
    const maxY = Math.max(...nodes.map((node) => node.y + GRAPH_NODE_HEIGHT));
    const contentWidth = Math.max(1, maxX - minX);
    const contentHeight = Math.max(1, maxY - minY);
    const nextScale = clampCanvasScale(Math.min(0.92, (nextWidth - 32) / contentWidth, (nextHeight - 48) / contentHeight));
    const nextX = (nextWidth - contentWidth * nextScale) / 2 - minX * nextScale;
    const nextY = (nextHeight - contentHeight * nextScale) / 2 - minY * nextScale;
    if (immediate) {
      scale.value = nextScale;
      translateX.value = nextX;
      translateY.value = nextY;
      return;
    }
    scale.value = withTiming(nextScale, { duration: 260 });
    translateX.value = withTiming(nextX, { duration: 260 });
    translateY.value = withTiming(nextY, { duration: 260 });
  }, [nodes, scale, translateX, translateY, viewportHeight, viewportWidth]);

  const focusNode = useCallback((nodeId: string) => {
    const target = nodeMap.get(nodeId);
    const nextWidth = viewportWidth.value;
    const nextHeight = viewportHeight.value;
    if (!target || !nextWidth || !nextHeight) return;
    const nextScale = Math.max(scale.value, 0.72);
    const centerX = (target.x + GRAPH_NODE_WIDTH / 2) * nextScale;
    const centerY = (target.y + GRAPH_NODE_HEIGHT / 2) * nextScale;
    scale.value = withTiming(nextScale, { duration: 260 });
    translateX.value = withTiming(nextWidth / 2 - centerX, { duration: 260 });
    translateY.value = withTiming(nextHeight / 2 - centerY, { duration: 260 });
  }, [nodeMap, scale, translateX, translateY, viewportHeight, viewportWidth]);

  useEffect(() => {
    if (!hasFitted.current || appliedFitRequest.current === fitRequest) return;
    appliedFitRequest.current = fitRequest;
    fit();
  }, [fitRequest, fit]);

  useEffect(() => {
    if (!hasFitted.current || !focusNodeId || focusRequest === 0) return;
    const request = `${focusNodeId}:${focusRequest}`;
    if (appliedFocusRequest.current === request || !nodeMap.has(focusNodeId)) return;
    appliedFocusRequest.current = request;
    focusNode(focusNodeId);
  }, [focusNode, focusNodeId, focusRequest, nodeMap]);

  return (
    <View
      onLayout={(event) => {
        const nextWidth = event.nativeEvent.layout.width;
        const nextHeight = event.nativeEvent.layout.height;
        viewportWidth.value = nextWidth;
        viewportHeight.value = nextHeight;
        if (!hasFitted.current) {
          hasFitted.current = true;
          fit(nextWidth, nextHeight, true);
        }
      }}
      style={{ flex: 1, overflow: 'hidden', backgroundColor: '#FAFAF9' }}
    >
      <Svg pointerEvents="none" width="100%" height="100%" style={{ position: 'absolute' }}>
        <Defs><Pattern id="canvas-dots" width={24} height={24} patternUnits="userSpaceOnUse"><Circle cx={12} cy={12} r={0.7} fill="#DEDCD7" /></Pattern></Defs>
        <Rect width="100%" height="100%" fill="url(#canvas-dots)" />
      </Svg>
      <GestureDetector gesture={Gesture.Simultaneous(pan, pinch)}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="图谱空白区域"
          accessibilityHint="取消当前节点或关系选择"
          onPress={onClearSelection}
          style={{ flex: 1 }}
        >
          <Animated.View style={[{ position: 'absolute', width: board.boardWidth, height: board.boardHeight }, boardPositionStyle]}>
            <Animated.View
              style={[
                { width: board.boardWidth, height: board.boardHeight, transformOrigin: '0 0' },
                boardScaleStyle,
              ]}
            >
          <Svg width={board.boardWidth} height={board.boardHeight} style={{ position: 'absolute' }}>
            {edges.map((edge) => {
              const source = nodeMap.get(edge.sourceId);
              const target = nodeMap.get(edge.targetId);
              if (!source || !target) return null;
               const x1 = source.x - board.minX + GRAPH_NODE_WIDTH / 2;
               const y1 = source.y - board.minY + GRAPH_NODE_HEIGHT / 2;
               const x2 = target.x - board.minX + GRAPH_NODE_WIDTH / 2;
               const y2 = target.y - board.minY + GRAPH_NODE_HEIGHT / 2;
               const selected = edge.id === selectedId;
               const directIncoming = hierarchy.incomingEdgeIds.has(edge.id);
               const directOutgoing = hierarchy.outgoingEdgeIds.has(edge.id);
               const direct = directIncoming || directOutgoing;
               const reviewColor = edgeReviewColor[edge.reviewStatus];
               const edgeColor = directIncoming ? colors.inkMuted : directOutgoing ? downstreamColor : reviewColor;
               const visualProps = {
                 x1,
                 y1,
                 x2,
                 y2,
                 stroke: edgeColor,
                 strokeWidth: selected ? 6 : direct ? 5 : 2.5,
                 strokeDasharray: direct || edge.reviewStatus === 'unverified' ? '10 7' : undefined,
                 opacity: hasNodeSelection && !direct ? 0.28 : 1,
                 pointerEvents: 'none' as const,
               };
              return (
                <Fragment key={edge.id}>
                  <Line
                    key={`${edge.id}-target`}
                    x1={x1}
                    y1={y1}
                    x2={x2}
                    y2={y2}
                    stroke="rgba(0, 0, 0, 0.001)"
                    strokeWidth={34}
                    onPress={() => onSelectEdge(edge)}
                  />
                  {hasNodeSelection && direct ? null : <Line key={edge.id} {...visualProps} />}
                </Fragment>
              );
            })}
          </Svg>

          {hasNodeSelection ? (
            <View
              pointerEvents="none"
              style={{ position: 'absolute', width: board.boardWidth, height: board.boardHeight }}
            >
              {edges.map((edge) => {
                const directIncoming = hierarchy.incomingEdgeIds.has(edge.id);
                const directOutgoing = hierarchy.outgoingEdgeIds.has(edge.id);
                if (!directIncoming && !directOutgoing) return null;
                const source = nodeMap.get(edge.sourceId);
                const target = nodeMap.get(edge.targetId);
                if (!source || !target) return null;
                return (
                  <MarchingEdge
                    key={`march-${edge.id}`}
                    x1={source.x - board.minX + GRAPH_NODE_WIDTH / 2}
                    y1={source.y - board.minY + GRAPH_NODE_HEIGHT / 2}
                    x2={target.x - board.minX + GRAPH_NODE_WIDTH / 2}
                    y2={target.y - board.minY + GRAPH_NODE_HEIGHT / 2}
                    color={directIncoming ? colors.inkMuted : downstreamColor}
                    dashOffset={dashOffset}
                    reducedMotion={reducedMotion || !showLearningMarks}
                  />
                );
              })}
            </View>
          ) : null}

          {nodes.map((node) => {
             const selected = node.id === selectedId;
             const directParent = hierarchy.incomingNodeIds.has(node.id);
             const directChild = hierarchy.outgoingNodeIds.has(node.id);
             const subdued = hasNodeSelection && !selected && !directParent && !directChild;
             const borderColor = selected
               ? focusColor
               : directParent
                 ? colors.white
                 : directChild
                   ? downstreamColor
                   : statusColor[node.status];
             return (
              <Pressable
                key={node.id}
                accessibilityRole="button"
                accessibilityState={{ selected }}
                accessibilityLabel={`${node.title}，重要程度 ${node.importance}。长按可管理节点`}
                onPress={() => onSelectNode(node)}
                onLongPress={() => onLongPressNode(node)}
                delayLongPress={520}
                style={({ pressed }) => ({
                  position: 'absolute',
                  left: node.x - board.minX,
                  top: node.y - board.minY,
                  width: GRAPH_NODE_WIDTH,
                  minHeight: GRAPH_NODE_HEIGHT,
                  borderRadius: radii.medium,
                  borderCurve: 'continuous',
                  borderWidth: showLearningMarks ? selected ? 6 : directParent ? 5 : directChild ? 4 : 1.5 : selected ? 2.5 : 1,
                  borderLeftWidth: showLearningMarks ? undefined : selected ? 4 : 3,
                  borderColor: showLearningMarks || selected || directChild ? borderColor : '#E1DFDA',
                  borderLeftColor: selected ? focusColor : statusColor[node.status],
                  backgroundColor: showLearningMarks ? statusSoftColor[node.status] : colors.white,
                  padding: 13,
                  flexDirection: 'row',
                  gap: 11,
                  opacity: pressed ? 0.78 : subdued ? 0.34 : 1,
                })}
              >
                {showLearningMarks ? <View
                  style={{
                    width: 34,
                    height: 34,
                    borderRadius: 17,
                    alignItems: 'center',
                    justifyContent: 'center',
                    backgroundColor: statusColor[node.status],
                  }}
                >
                  <Text style={{ color: colors.white, fontWeight: '800', fontSize: 15, fontVariant: ['tabular-nums'] }}>
                    {node.importance}
                  </Text>
                </View> : null}
                <View style={{ flex: 1, gap: 3 }}>
                  <Text numberOfLines={2} style={{ color: colors.ink, fontSize: 15, fontWeight: '800', lineHeight: 19 }}>
                    {node.title}
                  </Text>
                  <Text numberOfLines={1} style={{ color: colors.inkMuted, fontSize: 11.5 }}>
                    {node.subtitle}
                  </Text>
                </View>
              </Pressable>
            );
          })}
            </Animated.View>
          </Animated.View>
        </Pressable>
      </GestureDetector>
    </View>
  );
}
