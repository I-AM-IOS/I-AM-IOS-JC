/**
 * planespace/react — React integration for planespace.
 *
 * Provides a hook and a component for safely mounting planespace
 * within the React lifecycle, including StrictMode and SSR compatibility.
 *
 * @example
 *   // Hook usage
 *   function Hero() {
 *     const { ref, viewer, frameCount } = usePlanespace({ maxAngle: 8 });
 *     return (
 *       <section ref={ref}>
 *         <h1 data-z="60">Foreground</h1>
 *         <div data-z="-200">Background</div>
 *       </section>
 *     );
 *   }
 *
 * @example
 *   // Component usage
 *   <PlanespaceScene maxAngle={8} inputMode="mouse">
 *     <h1 data-z="60">Title</h1>
 *   </PlanespaceScene>
 */
import { useEffect, useRef, useState, useCallback } from 'react';
import { Planespace } from '../src/index.js';

/**
 * usePlanespace — React hook that manages the full planespace lifecycle.
 *
 * @param {import('../src/index.js').PlanespaceOptions} options
 * @returns {{
 *   ref: React.RefObject,
 *   ps: Planespace | null,
 *   viewer: { x: number, y: number },
 *   mounted: boolean,
 *   frameCount: number,
 *   pause: () => void,
 *   resume: () => void,
 * }}
 */
export function usePlanespace(options = {}) {
  const ref = useRef(null);
  const psRef = useRef(null);
  const [mounted, setMounted] = useState(false);
  const [viewer, setViewer] = useState({ x: 0, y: 0 });
  const [frameCount, setFrameCount] = useState(0);

  useEffect(() => {
    // SSR guard
    if (typeof window === 'undefined') return;

    const root = ref.current;
    if (!root) return;

    const ps = new Planespace(options);
    psRef.current = ps;

    let frameOff;

    ps.mount(root).then(() => {
      setMounted(true);
      frameOff = ps.on('frame', ({ rx, ry, frameCount: fc }) => {
        setViewer({ x: rx, y: ry });
        setFrameCount(fc);
      });
    });

    return () => {
      frameOff?.();
      ps.unmount();
      psRef.current = null;
      setMounted(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const pause = useCallback(() => psRef.current?.pause(), []);
  const resume = useCallback(() => psRef.current?.resume(), []);
  const setViewerPos = useCallback((x, y) => psRef.current?.setViewer(x, y), []);

  return {
    ref,
    ps: psRef.current,
    viewer,
    mounted,
    frameCount,
    pause,
    resume,
    setViewer: setViewerPos,
  };
}

/**
 * PlanespaceScene — drop-in component that wraps children with planespace depth.
 *
 * All planespace options can be passed as props.
 *
 * @param {{ children: React.ReactNode } & PlanespaceOptions} props
 *
 * @example
 *   <PlanespaceScene maxAngle={8} inputMode="mouse" debug={false}>
 *     <h1 data-z="60">Title</h1>
 *     <img data-z="-200" src="bg.jpg" />
 *   </PlanespaceScene>
 */
export function PlanespaceScene({
  children,
  className,
  style,
  onReady,
  onFrame,
  // Extract all planespace options
  inputMode,
  maxAngle,
  lerpFactor,
  inputDeadzone,
  depthAttr,
  depthRange,
  layers,
  warpMode,
  shader,
  compositor,
  perspective,
  outputCanvas,
  outputZIndex,
  gyro,
  debug,
  ...rest
}) {
  const psOptions = {
    inputMode,
    maxAngle,
    lerpFactor,
    inputDeadzone,
    depthAttr,
    depthRange,
    layers,
    warpMode,
    shader,
    compositor,
    perspective,
    outputCanvas,
    outputZIndex,
    gyro,
    debug,
  };

  // Remove undefined values so defaults kick in
  Object.keys(psOptions).forEach(k => psOptions[k] === undefined && delete psOptions[k]);

  const { ref, mounted } = usePlanespace(psOptions);

  // Fire user callbacks
  const psRef = useRef(null);
  useEffect(() => {
    if (!mounted || !psRef.current) return;
    if (onReady) psRef.current.on('ready', onReady);
    if (onFrame) psRef.current.on('frame', onFrame);
  }, [mounted, onReady, onFrame]);

  return (
    <div
      ref={ref}
      className={className}
      style={{ position: 'relative', ...style }}
      data-planespace={mounted ? 'active' : 'pending'}
      {...rest}
    >
      {children}
    </div>
  );
}

export default Planespace;
