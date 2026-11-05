import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";

export interface VideoPresentation {
  fit: "contain" | "cover" | "fill";
  zoom: number;
  panX: number;
  panY: number;
}

const DEFAULT_PRESENTATION: VideoPresentation = { fit: "contain", zoom: 1, panX: 0, panY: 0 };

/** Session-local presentation belongs to content/file, not a replaceable video. */
export function useVideoPresentation(owner: string) {
  // A new token also rejects callbacks from an earlier A -> B -> A session.
  const token = useMemo(() => ({ owner }), [owner]);
  const committedToken = useRef(token);
  const [scoped, setScoped] = useState({ token, value: DEFAULT_PRESENTATION });
  useLayoutEffect(() => {
    committedToken.current = token;
    setScoped((current) => current.token === token
      ? current
      : { token, value: DEFAULT_PRESENTATION });
  }, [token]);
  const change = useCallback((patch: Partial<VideoPresentation>) => {
    if (committedToken.current !== token) return;
    setScoped((current) => {
      if (committedToken.current !== token) return current;
      const value = current.token === token ? current.value : DEFAULT_PRESENTATION;
      return { token, value: { ...value, ...patch } };
    });
  }, [token]);
  return [scoped.token === token ? scoped.value : DEFAULT_PRESENTATION, change] as const;
}
