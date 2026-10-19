// Should a dropdown close when focus leaves it? Not while a pointer press that started inside it is still
// in progress: Safari/iOS don't focus links or buttons on press (and no browser focuses the menu's header or
// padding), so the blur arrives with no relatedTarget before the click, and closing then drops the click.
// Outside presses are closed by the document pointerdown listener; keyboard Tab still closes via blur.
export function shouldCloseOnBlur({ open, focusStaysInside, pressInside }) {
  return !!open && !focusStaysInside && !pressInside;
}

// How long after the press ends to keep treating it as "inside". A tap's compatibility mouse events and the
// resulting focus change arrive after pointerup/touchend, so touch (and pen) need a short grace period.
export function pressEndDelay(pointerType) {
  return pointerType === 'mouse' ? 0 : 500;
}
