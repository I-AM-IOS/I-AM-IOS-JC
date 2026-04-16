import type { ReactNode, CSSProperties, RefObject } from 'react';
import type { Planespace, PlanespaceOptions, FrameEvent } from '../../types/index.js';

export interface UsePlanespaceReturn {
  /** Attach to the root element: <section ref={ref}> */
  ref: RefObject<HTMLElement>;
  /** Planespace instance, or null before mount. */
  ps: Planespace | null;
  /** Current smoothed viewer position (-1..1). */
  viewer: { x: number; y: number };
  /** Whether planespace is mounted and active. */
  mounted: boolean;
  /** Total frames rendered. */
  frameCount: number;
  pause: () => void;
  resume: () => void;
  setViewer: (x: number, y: number) => void;
}

/**
 * React hook for managing the planespace lifecycle.
 *
 * @example
 *   const { ref, viewer } = usePlanespace({ maxAngle: 8 });
 *   return <section ref={ref}><h1 data-z="60">Title</h1></section>;
 */
export declare function usePlanespace(options?: PlanespaceOptions): UsePlanespaceReturn;

export interface PlanespaceSceneProps extends PlanespaceOptions {
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
  onReady?: () => void;
  onFrame?: (e: FrameEvent) => void;
}

/**
 * Drop-in component wrapper.
 *
 * @example
 *   <PlanespaceScene maxAngle={8}>
 *     <h1 data-z="60">Title</h1>
 *   </PlanespaceScene>
 */
export declare function PlanespaceScene(props: PlanespaceSceneProps): JSX.Element;
