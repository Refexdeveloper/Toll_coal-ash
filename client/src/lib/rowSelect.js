export function toggleId(current, id) {
  const next = new Set(current);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

export function toggleAll(current, ids) {
  const next = new Set(current);
  const allOn = ids.length > 0 && ids.every((id) => next.has(id));
  ids.forEach((id) => {
    if (allOn) next.delete(id);
    else next.add(id);
  });
  return next;
}

export function allChecked(current, ids) {
  return ids.length > 0 && ids.every((id) => current.has(id));
}
