import { useEffect, useRef, type InputHTMLAttributes } from "react";

type AdjustmentRangeProps = Pick<InputHTMLAttributes<HTMLInputElement>, "min" | "max" | "step" | "disabled" | "aria-label"> & {
  value: number;
  onValueChange: (value: number) => void;
};
type Gesture = {
  id: number;
  contacts: Set<number>;
  x: number;
  y: number;
  axis: "pending" | "horizontal" | "vertical";
  initial: number;
  candidate: number;
  committed: number;
};
const INTENT_DISTANCE = 6;

/** Keep native range semantics while reserving vertical touch movement for the sheet. */
export function AdjustmentRange({ value, onValueChange, disabled, ...props }: AdjustmentRangeProps) {
  const gestureRef = useRef<Gesture | null>(null);
  const valueRef = useRef(value);
  valueRef.current = value;
  useEffect(() => () => { gestureRef.current = null; }, []);

  const classifyIntent = (gesture: Gesture, x: number, y: number) => {
    if (gesture.axis !== "pending") return;
    const dx = Math.abs(x - gesture.x), dy = Math.abs(y - gesture.y);
    if (Math.max(dx, dy) < INTENT_DISTANCE) return;
    gesture.axis = dx > dy ? "horizontal" : "vertical";
  };
  const restore = (input: HTMLInputElement) => { input.value = String(valueRef.current); };
  const publish = (gesture: Gesture, next: number) => {
    if (next === gesture.committed) return;
    gesture.committed = next;
    onValueChange(next);
  };
  const cancel = (input: HTMLInputElement) => {
    const gesture = gestureRef.current;
    gestureRef.current = null;
    if (gesture != null) {
      publish(gesture, gesture.initial);
      input.value = String(gesture.initial);
    }
  };
  const cancelPointer = (input: HTMLInputElement, id: number) => {
    const gesture = gestureRef.current;
    if (gesture == null || !gesture.contacts.delete(id)) return;
    publish(gesture, gesture.initial);
    gesture.axis = "vertical";
    gesture.candidate = gesture.initial;
    if (gesture.contacts.size === 0) gestureRef.current = null;
    input.value = String(gesture.initial);
  };
  return <input {...props} type="range" value={value} disabled={disabled}
    onPointerDown={(event) => {
      if (disabled || (event.pointerType !== "touch" && event.pointerType !== "pen")) return;
      const previous = gestureRef.current;
      if (previous != null) {
        previous.contacts.add(event.pointerId);
        publish(previous, previous.initial);
        previous.axis = "vertical";
        previous.candidate = previous.initial;
        restore(event.currentTarget);
        return;
      }
      gestureRef.current = {
        id: event.pointerId, contacts: new Set([event.pointerId]), x: event.clientX, y: event.clientY,
        axis: event.isPrimary ? "pending" : "vertical",
        initial: valueRef.current, candidate: valueRef.current, committed: valueRef.current,
      };
      // Pointer capture does not suppress pan-y: a browser scroll cancels this gesture.
      event.currentTarget.setPointerCapture?.(event.pointerId);
    }}
    onPointerMove={(event) => {
      const gesture = gestureRef.current;
      if (gesture == null || gesture.id !== event.pointerId) return;
      classifyIntent(gesture, event.clientX, event.clientY);
    }}
    onChange={(event) => {
      if (disabled) return;
      const next = Number(event.currentTarget.value);
      const gesture = gestureRef.current;
      if (gesture == null) {
        onValueChange(next);
      } else {
        gesture.candidate = next;
        if (gesture.axis === "horizontal") publish(gesture, next);
        else restore(event.currentTarget);
      }
    }}
    onPointerUp={(event) => {
      const gesture = gestureRef.current;
      if (gesture == null || !gesture.contacts.delete(event.pointerId) || gesture.contacts.size > 0) return;
      gestureRef.current = null;
      // A browser can omit moves or release beyond the last delivered move.
      classifyIntent(gesture, event.clientX, event.clientY);
      if (gesture.axis !== "vertical") publish(gesture, gesture.candidate);
      restore(event.currentTarget);
    }}
    onPointerCancel={(event) => { cancelPointer(event.currentTarget, event.pointerId); }}
    onLostPointerCapture={(event) => { cancelPointer(event.currentTarget, event.pointerId); }}
    onKeyDown={(event) => { cancel(event.currentTarget); }}
    onBlur={(event) => { cancel(event.currentTarget); }}
  />;
}
